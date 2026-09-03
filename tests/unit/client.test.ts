import { describe, expect, it, vi } from "vitest";
import {
  PlankaClient,
  createRequestInit,
  getConfig,
} from "../../src/client.js";

describe("PlankaClient", () => {
  it("builds JSON requests without leaking credentials into the URL", () => {
    const init = createRequestInit("POST", {
      token: "token-value",
      body: { emailOrUsername: "agent@example.com", password: "secret" },
    });

    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token-value",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      emailOrUsername: "agent@example.com",
      password: "secret",
    });
  });

  it("normalizes the base URL and reports missing environment variables", () => {
    expect(
      getConfig({
        PLANKA_BASE_URL: "https://planka.example.com///",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      }).baseUrl
    ).toBe("https://planka.example.com");

    expect(() => getConfig({ PLANKA_BASE_URL: "https://planka.example.com" }))
      .toThrow(/PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD/);
  });

  it("explains the HTTP-to-HTTPS redirect failure when auth returns HTML", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    ) as unknown as typeof fetch;
    const client = new PlankaClient(
      {
        PLANKA_BASE_URL: "http://planka.example.com",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      },
      fetchMock
    );

    await expect(client.get("/api/projects")).rejects.toThrow(
      /redirects to HTTPS.*drop the POST body/i
    );
  });

  it("authenticates once and builds an authorized API request", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ item: "jwt-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      ) as unknown as typeof fetch;
    const client = new PlankaClient(
      {
        PLANKA_BASE_URL: "https://planka.example.com/",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      },
      fetchMock
    );

    await expect(client.get("/api/projects")).resolves.toEqual({ items: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://planka.example.com/api/projects"
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer jwt-token" },
    });
  });
});

describe("PlankaClient with an API key", () => {
  const env = {
    PLANKA_BASE_URL: "https://planka.example.com",
    PLANKA_API_KEY: "abcd1234_0123456789abcdef0123456789abcdef",
  };

  it("accepts an API key instead of email + password", () => {
    expect(getConfig(env)).toEqual({
      baseUrl: "https://planka.example.com",
      apiKey: "abcd1234_0123456789abcdef0123456789abcdef",
    });
  });

  it("refuses an API key AND a password: Planka would ignore one of them", () => {
    expect(() =>
      getConfig({
        ...env,
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      })
    ).toThrow(/Conflicting Planka credentials/);
  });

  it("lists both authentication options when no credential is set", () => {
    expect(() => getConfig({ PLANKA_BASE_URL: "https://planka.example.com" }))
      .toThrow(/EITHER PLANKA_API_KEY .* OR the pair PLANKA_AGENT_EMAIL, PLANKA_AGENT_PASSWORD/);
  });

  it("never sends Authorization together with X-Api-Key", () => {
    const init = createRequestInit("GET", { apiKey: "k", token: "t" });
    expect(init.headers).toEqual({ "X-Api-Key": "k" });
  });

  it("sends X-Api-Key on API requests and never logs in", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    ) as unknown as typeof fetch;
    const client = new PlankaClient(env, fetchMock);

    await client.get("/api/projects");

    expect(fetchMock).toHaveBeenCalledTimes(1); // no POST /api/access-tokens
    const [url, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(url).toBe("https://planka.example.com/api/projects");
    expect(init.headers["X-Api-Key"]).toBe(env.PLANKA_API_KEY);
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("downloads binaries with the API key and does not retry a 401 it cannot fix", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("nope", { status: 401 })
    ) as unknown as typeof fetch;
    const client = new PlankaClient(env, fetchMock);

    await expect(client.getBinary("/attachments/1/download/x.png")).rejects.toThrow();
    // With an API key there is no token to refresh: one attempt, no loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = (fetchMock as unknown as vi.Mock).mock.calls[0];
    expect(init.headers["X-Api-Key"]).toBe(env.PLANKA_API_KEY);
    expect(init.headers.Cookie).toBeUndefined();
  });
});

describe("PlankaClient binary downloads with a token", () => {
  it("retries a 401 once with a fresh token", async () => {
    const authResponse = () =>
      new Response(JSON.stringify({ item: "jwt-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(new Response("nope", { status: 401 }))
      .mockResolvedValueOnce(authResponse())
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "image/png" },
        })
      ) as unknown as typeof fetch;

    const client = new PlankaClient(
      {
        PLANKA_BASE_URL: "https://planka.example.com",
        PLANKA_AGENT_EMAIL: "agent@example.com",
        PLANKA_AGENT_PASSWORD: "secret",
      },
      fetchMock
    );

    const result = await client.getBinary("/attachments/1/download/x.png");

    expect(result.mimeType).toBe("image/png");
    expect(result.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
