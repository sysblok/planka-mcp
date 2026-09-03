import { describe, expect, it } from "vitest";
import {
  claudeMcpAddCommand,
  codexTomlBlock,
  cursorDeeplink,
  checkConnection,
  mergeCodexToml,
  mergeMcpJson,
  parseInitArgs,
  runInit,
  serverSpec,
  vscodeConfig,
} from "../../src/cli/init.js";
import { PACKAGE_NAME, SERVER_VERSION } from "../../src/identity.generated.js";

const pin = `${PACKAGE_NAME}@${SERVER_VERSION}`;
const creds = {
  baseUrl: "https://planka.example.com",
  apiKey: "secret-key",
  boardId: "9",
};

function collect() {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("parseInitArgs", () => {
  it("reads every flag", () => {
    const options = parseInitArgs([
      "--client", "codex",
      "--base-url", "https://p.example.com",
      "--api-key", "k",
      "--board", "7",
      "--dry-run",
    ]);
    expect(options).toMatchObject({
      client: "codex",
      baseUrl: "https://p.example.com",
      apiKey: "k",
      boardId: "7",
      dryRun: true,
    });
  });

  it("rejects an unknown client by naming the valid ones", () => {
    expect(() => parseInitArgs(["--client", "emacs"])).toThrow(
      /Unknown client: emacs\. Choose one of: claude, codex, cursor, vscode, print\./
    );
  });

  it("rejects an unknown flag and a flag with no value", () => {
    expect(() => parseInitArgs(["--nope"])).toThrow(/Unknown option: --nope/);
    expect(() => parseInitArgs(["--api-key"])).toThrow(/--api-key needs a value/);
    expect(() => parseInitArgs(["--api-key", "--dry-run"])).toThrow(
      /--api-key needs a value/
    );
  });
});

describe("serverSpec", () => {
  it("pins the published package to the version in package.json", () => {
    expect(serverSpec(creds).args).toEqual(["-y", pin]);
  });

  it("prefers the API key and falls back to email + password", () => {
    expect(serverSpec(creds).env.PLANKA_API_KEY).toBe("secret-key");
    const login = serverSpec({
      baseUrl: creds.baseUrl,
      email: "agent@example.com",
      password: "pw",
    });
    expect(login.env).toMatchObject({
      PLANKA_AGENT_EMAIL: "agent@example.com",
      PLANKA_AGENT_PASSWORD: "pw",
    });
    expect(login.env.PLANKA_API_KEY).toBeUndefined();
  });

  it("redacts every secret when asked, keeping the rest intact", () => {
    const redacted = serverSpec(creds, true);
    expect(redacted.env.PLANKA_API_KEY).toBe("<your-planka-api-key>");
    expect(redacted.env.PLANKA_BASE_URL).toBe(creds.baseUrl);
    expect(redacted.env.PLANKA_DEFAULT_BOARD_ID).toBe("9");
    expect(
      serverSpec({ baseUrl: creds.baseUrl, email: "a@b.c", password: "pw" }, true).env
        .PLANKA_AGENT_PASSWORD
    ).toBe("<your-planka-password>");
  });
});

describe("emitters", () => {
  it("builds a claude mcp add command with one --env per variable", () => {
    const command = claudeMcpAddCommand(serverSpec(creds));
    expect(command).toContain("claude mcp add --scope user --transport stdio planka");
    expect(command).toContain("--env PLANKA_BASE_URL=https://planka.example.com");
    expect(command).toContain("--env PLANKA_API_KEY=secret-key");
    expect(command).toContain(`-- npx -y ${pin}`);
  });

  it("builds a TOML block Codex can read", () => {
    const block = codexTomlBlock(serverSpec(creds));
    expect(block).toContain("[mcp_servers.planka]");
    expect(block).toContain('command = "npx"');
    expect(block).toContain(`args = ["-y", "${pin}"]`);
    expect(block).toContain('PLANKA_API_KEY = "secret-key"');
  });

  it("puts only {command,args,env} in the Cursor deeplink, with no name wrapper", () => {
    const url = cursorDeeplink(serverSpec(creds, true));
    expect(url.startsWith("cursor://anysphere.cursor-deeplink/mcp/install?name=planka&config=")).toBe(true);
    const payload = JSON.parse(
      Buffer.from(url.split("config=")[1], "base64").toString("utf8")
    );
    expect(Object.keys(payload).sort()).toEqual(["args", "command", "env"]);
    expect(payload.env.PLANKA_API_KEY).toBe("<your-planka-api-key>");
  });

  it("never leaks a real credential into a deeplink", () => {
    expect(cursorDeeplink(serverSpec(creds, true))).not.toContain(
      Buffer.from("secret-key").toString("base64").slice(0, 8)
    );
  });

  it("asks VS Code for the key instead of writing it to the file", () => {
    const config = vscodeConfig(creds);
    expect(config.servers.planka.env.PLANKA_API_KEY).toBe("${input:planka_api_key}");
    expect(config.inputs[0]).toMatchObject({
      id: "planka_api_key",
      type: "promptString",
      password: true,
    });
    expect(JSON.stringify(config)).not.toContain("secret-key");
  });
});

describe("non-destructive merges", () => {
  it("adds planka next to existing servers", () => {
    const { document, added } = mergeMcpJson(
      { mcpServers: { other: { command: "x" } }, somethingElse: 1 },
      serverSpec(creds)
    );
    expect(added).toBe(true);
    expect(document.somethingElse).toBe(1);
    expect((document.mcpServers as any).other).toEqual({ command: "x" });
    expect((document.mcpServers as any).planka.type).toBe("stdio");
  });

  it("leaves an existing planka entry alone", () => {
    const existing = { mcpServers: { planka: { command: "mine" } } };
    const { document, added } = mergeMcpJson(existing, serverSpec(creds));
    expect(added).toBe(false);
    expect((document.mcpServers as any).planka).toEqual({ command: "mine" });
  });

  it("survives a missing or malformed document", () => {
    expect(mergeMcpJson(undefined, serverSpec(creds)).added).toBe(true);
    expect(mergeMcpJson("garbage", serverSpec(creds)).added).toBe(true);
  });

  it("appends the Codex block once, preserving what is already there", () => {
    const original = '[mcp_servers.other]\ncommand = "x"\n';
    const block = codexTomlBlock(serverSpec(creds));
    const first = mergeCodexToml(original, block);
    expect(first.added).toBe(true);
    expect(first.text.startsWith(original)).toBe(true);
    expect(mergeCodexToml(first.text, block).added).toBe(false);
    expect(mergeCodexToml("", block).text).toBe(block);
  });
});

describe("checkConnection", () => {
  it("reports who it authenticated as", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ item: { username: "agent" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    await expect(checkConnection(creds, fetchImpl)).resolves.toEqual({
      ok: true,
      detail: "authenticated as agent",
    });
  });

  it("reports the failure instead of throwing", async () => {
    const fetchImpl = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const result = await checkConnection(creds, fetchImpl);
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });

  it("says what is missing when there is nothing to check", async () => {
    await expect(checkConnection({})).resolves.toMatchObject({ ok: false });
    await expect(checkConnection({ baseUrl: creds.baseUrl })).resolves.toEqual({
      ok: false,
      detail: "no credentials given",
    });
  });
});

describe("runInit", () => {
  it("prints every client snippet and touches nothing", async () => {
    const out = collect();
    expect(await runInit(["--client", "print"], { log: out.log })).toBe(0);
    const text = out.text();
    expect(text).toContain("claude mcp add");
    expect(text).toContain("[mcp_servers.planka]");
    expect(text).toContain("cursor://anysphere.cursor-deeplink");
    expect(text).toContain("${input:planka_api_key}");
    expect(text).toContain("/plugin install planka@planka-mcp");
  });

  it("works with no credentials at all", async () => {
    const out = collect();
    expect(await runInit(["--client", "print"], { log: out.log })).toBe(0);
    expect(out.text()).toContain("<your-planka-api-key>");
  });

  it("shows what it would do without writing or calling Planka", async () => {
    const out = collect();
    let checked = false;
    const code = await runInit(
      ["--client", "codex", "--dry-run", "--base-url", creds.baseUrl, "--api-key", "k"],
      {
        log: out.log,
        check: async () => {
          checked = true;
          return { ok: true, detail: "" };
        },
      }
    );
    expect(code).toBe(0);
    expect(checked).toBe(false);
    expect(out.text()).toContain("Would append to");
    expect(out.text()).not.toContain('PLANKA_API_KEY = "k"');
  });

  it("answers --help and refuses a bad flag with a non-zero code", async () => {
    const help = collect();
    expect(await runInit(["--help"], { log: help.log })).toBe(0);
    expect(help.text()).toContain("planka-mcp init");
    const bad = collect();
    expect(await runInit(["--client", "emacs"], { log: bad.log })).toBe(2);
    expect(bad.text()).toContain("Unknown client");
  });
});
