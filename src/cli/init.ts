/**
 * `planka-mcp init` — write the MCP config for one client, or print it.
 *
 * Design rules, all of them learned the hard way:
 *
 * - **Never clobber.** Every emitter merges: an existing `planka` entry is
 *   reported and left alone rather than overwritten, and unrelated servers in
 *   the same file are preserved byte for byte.
 * - **`--dry-run` and `--client print` write nothing** and need no credentials,
 *   so the command is safe to run just to see what it would do.
 * - **The API key is preferred** over email + password: no login, no token
 *   refresh, and no sign-in rate limit when ten agents start at once.
 * - **No secret ever reaches a shareable artifact.** The Cursor deeplink and
 *   every printed snippet carry placeholders; only files under the user's home
 *   get the real value, and those are written 0600.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { PlankaClient } from "../client.js";
import { PACKAGE_NAME, SERVER_VERSION } from "../identity.generated.js";

export const CLIENTS = ["claude", "codex", "cursor", "vscode", "print"] as const;
export type Client = (typeof CLIENTS)[number];

export interface InitOptions {
  client: Client;
  dryRun: boolean;
  baseUrl?: string;
  apiKey?: string;
  email?: string;
  password?: string;
  boardId?: string;
  /** Where the VS Code config goes. Defaults to the current directory. */
  projectDir: string;
  help: boolean;
}

export interface ServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

const KEY_PLACEHOLDER = "<your-planka-api-key>";
const URL_PLACEHOLDER = "https://planka.example.com";

export const USAGE = `planka-mcp init — configure this MCP server in your client

Usage:
  npx ${PACKAGE_NAME} init [--client <name>] [options]

Clients:
  claude    Claude Code (claude mcp add, user scope)
  codex     Codex CLI (~/.codex/config.toml)
  cursor    Cursor (~/.cursor/mcp.json) and an "Add to Cursor" deeplink
  vscode    VS Code (.vscode/mcp.json, secret asked at startup)
  print     print every snippet, write nothing (default without a TTY)

Options:
  --base-url <url>     Planka origin, e.g. https://planka.example.com
  --api-key <key>      Planka API key (recommended)
  --email <email>      Agent email, only if you have no API key
  --password <pass>    Agent password, only if you have no API key
  --board <id>         Default board ID (PLANKA_DEFAULT_BOARD_ID)
  --project-dir <dir>  Where to write .vscode/mcp.json (default: cwd)
  --dry-run            Print what would be written, change nothing
  -h, --help           This text

With no flags and a terminal attached, init asks for what it needs.`;

/** Flags in, options out. Unknown flags are an error, not a silent no-op. */
export function parseInitArgs(argv: string[]): InitOptions {
  const options: InitOptions = {
    client: "print",
    dryRun: false,
    projectDir: process.cwd(),
    help: false,
  };
  let clientGiven = false;

  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${flag} needs a value.`);
    }
    return next;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--client": {
        const raw = value(index, flag);
        if (!(CLIENTS as readonly string[]).includes(raw)) {
          throw new Error(
            `Unknown client: ${raw}. Choose one of: ${CLIENTS.join(", ")}.`
          );
        }
        options.client = raw as Client;
        clientGiven = true;
        index += 1;
        break;
      }
      case "--base-url":
        options.baseUrl = value(index, flag);
        index += 1;
        break;
      case "--api-key":
        options.apiKey = value(index, flag);
        index += 1;
        break;
      case "--email":
        options.email = value(index, flag);
        index += 1;
        break;
      case "--password":
        options.password = value(index, flag);
        index += 1;
        break;
      case "--board":
        options.boardId = value(index, flag);
        index += 1;
        break;
      case "--project-dir":
        options.projectDir = resolve(value(index, flag));
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${flag}. Run init --help.`);
    }
  }

  // Without --client and without a terminal to ask on, printing is the only
  // honest default: writing someone's config from a script they did not aim is
  // exactly the invasiveness this command is supposed to avoid.
  if (!clientGiven && !process.stdin.isTTY) options.client = "print";
  return options;
}

/**
 * The server entry every client gets, in MCP's `{command, args, env}` shape.
 * `redacted` swaps the secret for a placeholder — that is the version that goes
 * into anything printed, linked or committed.
 */
export function serverSpec(
  options: Pick<InitOptions, "baseUrl" | "apiKey" | "email" | "password" | "boardId">,
  redacted = false
): ServerSpec {
  const env: Record<string, string> = {
    PLANKA_BASE_URL: options.baseUrl || URL_PLACEHOLDER,
  };
  if (options.apiKey || !(options.email && options.password)) {
    env.PLANKA_API_KEY = redacted
      ? KEY_PLACEHOLDER
      : options.apiKey || KEY_PLACEHOLDER;
  } else {
    env.PLANKA_AGENT_EMAIL = options.email!;
    env.PLANKA_AGENT_PASSWORD = redacted ? "<your-planka-password>" : options.password!;
  }
  if (options.boardId) env.PLANKA_DEFAULT_BOARD_ID = options.boardId;

  return {
    command: "npx",
    args: ["-y", `${PACKAGE_NAME}@${SERVER_VERSION}`],
    env,
  };
}

/** `claude mcp add …`, ready to paste. */
export function claudeMcpAddCommand(spec: ServerSpec): string {
  const envFlags = Object.entries(spec.env)
    .map(([key, val]) => `  --env ${key}=${val} \\`)
    .join("\n");
  return [
    "claude mcp add --scope user --transport stdio planka \\",
    envFlags,
    `  -- ${spec.command} ${spec.args.join(" ")}`,
  ].join("\n");
}

/** The `[mcp_servers.planka]` block for `~/.codex/config.toml`. */
export function codexTomlBlock(spec: ServerSpec): string {
  const envLines = Object.entries(spec.env)
    .map(([key, val]) => `${key} = ${JSON.stringify(val)}`)
    .join(", ");
  return [
    "[mcp_servers.planka]",
    `command = ${JSON.stringify(spec.command)}`,
    `args = [${spec.args.map((a) => JSON.stringify(a)).join(", ")}]`,
    `env = { ${envLines} }`,
    "",
  ].join("\n");
}

/**
 * Cursor's install deeplink. The base64 payload is the SERVER OBJECT ONLY —
 * `{command, args, env}` with no name wrapper — and it never carries a real
 * key: a deeplink ends up in browser history and in READMEs.
 */
export function cursorDeeplink(spec: ServerSpec): string {
  const config = Buffer.from(JSON.stringify(spec)).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=planka&config=${config}`;
}

/** VS Code badge URL. Same payload, url-encoded instead of base64. */
export function vscodeBadgeUrl(spec: ServerSpec): string {
  const config = encodeURIComponent(JSON.stringify({ ...spec, type: "stdio" }));
  return `https://insiders.vscode.dev/redirect/mcp/install?name=planka&config=${config}`;
}

/**
 * `.vscode/mcp.json`. The secret is an `inputs` promptString with
 * `password: true`, so VS Code asks for it at startup and the committed file
 * holds no credential.
 */
export function vscodeConfig(options: Pick<InitOptions, "baseUrl" | "boardId">) {
  const env: Record<string, string> = {
    PLANKA_BASE_URL: options.baseUrl || URL_PLACEHOLDER,
    PLANKA_API_KEY: "${input:planka_api_key}",
  };
  if (options.boardId) env.PLANKA_DEFAULT_BOARD_ID = options.boardId;
  return {
    inputs: [
      {
        id: "planka_api_key",
        type: "promptString",
        description: "Planka API key (X-Api-Key) for the agent user",
        password: true,
      },
    ],
    servers: {
      planka: {
        type: "stdio",
        command: "npx",
        args: ["-y", `${PACKAGE_NAME}@${SERVER_VERSION}`],
        env,
      },
    },
  };
}

/**
 * Merge a server entry into an `{mcpServers: …}` document without touching
 * anything else. An existing `planka` entry wins: this command never silently
 * replaces a config the user tuned by hand.
 */
export function mergeMcpJson(
  document: unknown,
  spec: ServerSpec,
  key = "mcpServers"
): { document: Record<string, unknown>; added: boolean } {
  const base: Record<string, unknown> =
    document && typeof document === "object" && !Array.isArray(document)
      ? { ...(document as Record<string, unknown>) }
      : {};
  const servers =
    base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
      ? { ...(base[key] as Record<string, unknown>) }
      : {};
  if (servers.planka) {
    base[key] = servers;
    return { document: base, added: false };
  }
  servers.planka = { type: "stdio", ...spec };
  base[key] = servers;
  return { document: base, added: true };
}

/**
 * Append the Codex block to an existing config.toml. Present already = leave it
 * alone. TOML is edited as text on purpose: no parser here means no chance of
 * rewriting (and reformatting, and losing the comments of) somebody's config.
 */
export function mergeCodexToml(
  current: string,
  block: string
): { text: string; added: boolean } {
  if (/^\s*\[mcp_servers\.planka\]\s*$/m.test(current)) {
    return { text: current, added: false };
  }
  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  const separator = current.trim().length === 0 ? "" : "\n";
  return { text: `${current}${prefix}${separator}${block}`, added: true };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`Cannot parse ${path}: ${(error as Error).message}`);
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * The connection smoke that `scripts/setup.mjs` has always run, reduced to its
 * useful half: one authenticated GET. It proves the base URL is the API origin
 * (not an SPA or a proxy page) and that the credential works, before anything
 * is written. Never fatal — a config that cannot be verified is still worth
 * writing, as long as we say so.
 */
export async function checkConnection(
  options: Pick<InitOptions, "baseUrl" | "apiKey" | "email" | "password">,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; detail: string }> {
  if (!options.baseUrl) return { ok: false, detail: "no base URL given" };
  if (!options.apiKey && !(options.email && options.password)) {
    return { ok: false, detail: "no credentials given" };
  }
  const env: NodeJS.ProcessEnv = { PLANKA_BASE_URL: options.baseUrl };
  if (options.apiKey) env.PLANKA_API_KEY = options.apiKey;
  else {
    env.PLANKA_AGENT_EMAIL = options.email;
    env.PLANKA_AGENT_PASSWORD = options.password;
  }
  try {
    const client = new PlankaClient(env, fetchImpl);
    const me = await client.get<{ item?: { name?: string; username?: string } }>(
      "/api/users/me"
    );
    const who = me?.item?.username || me?.item?.name || "the agent user";
    return { ok: true, detail: `authenticated as ${who}` };
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}

type Ask = (question: string, secret?: boolean) => Promise<string>;

/** Fill in whatever is missing, but only when there is a terminal to ask on. */
async function promptMissing(options: InitOptions, ask: Ask): Promise<void> {
  if (options.client === "print") return;
  if (!options.baseUrl) {
    options.baseUrl =
      (await ask("Planka base URL (https://…)")) || undefined;
  }
  if (!options.apiKey && !(options.email && options.password)) {
    options.apiKey = (await ask("Planka API key (blank to use email + password)", true)) || undefined;
    if (!options.apiKey) {
      options.email = (await ask("Agent email or username")) || undefined;
      options.password = (await ask("Agent password", true)) || undefined;
    }
  }
  if (!options.boardId) {
    options.boardId = (await ask("Default board ID (optional)")) || undefined;
  }
}

function printAll(options: InitOptions, log: (line: string) => void): void {
  const spec = serverSpec(options, true);
  log("# Claude Code (user scope)");
  log(claudeMcpAddCommand(spec));
  log("");
  log("# Claude Code / Codex plugin (skills included)");
  log("/plugin marketplace add omnicoreos/planka-mcp");
  log("/plugin install planka@planka-mcp");
  log("");
  log("# Codex CLI — append to ~/.codex/config.toml");
  log(codexTomlBlock(spec));
  log("# Cursor — open this link (it carries no credential; Cursor asks)");
  log(cursorDeeplink(spec));
  log("");
  log("# VS Code — .vscode/mcp.json (the key is asked at startup)");
  log(JSON.stringify(vscodeConfig(options), null, 2));
}

export interface RunInitDeps {
  log?: (line: string) => void;
  ask?: Ask;
  /** Skips the network check. Tests and --dry-run never touch Planka. */
  check?: typeof checkConnection;
}

/** Entry point. Returns the process exit code; never throws for user error. */
export async function runInit(
  argv: string[],
  deps: RunInitDeps = {}
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let options: InitOptions;
  try {
    options = parseInitArgs(argv);
  } catch (error) {
    log(`init: ${(error as Error).message}`);
    return 2;
  }

  if (options.help) {
    log(USAGE);
    return 0;
  }

  if (deps.ask && !options.dryRun) await promptMissing(options, deps.ask);

  if (options.client === "print") {
    printAll(options, log);
    return 0;
  }

  // The smoke: real credentials, one authenticated GET, before writing.
  if (!options.dryRun) {
    const check = deps.check ?? checkConnection;
    const result = await check(options);
    log(
      result.ok
        ? `Planka reachable: ${result.detail}.`
        : `Warning: could not verify the connection (${result.detail}). Writing the config anyway — fix the credentials and rerun to verify.`
    );
  }

  const spec = serverSpec(options);
  const redacted = serverSpec(options, true);

  switch (options.client) {
    case "claude": {
      const command = claudeMcpAddCommand(spec);
      if (options.dryRun) {
        log("Would run:");
        log(claudeMcpAddCommand(redacted));
        return 0;
      }
      const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
      if (probe.error) {
        log("Claude Code is not on PATH. Run this once it is installed:");
        log(command);
        return 0;
      }
      const args = [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        "planka",
        ...Object.entries(spec.env).flatMap(([key, val]) => [
          "--env",
          `${key}=${val}`,
        ]),
        "--",
        spec.command,
        ...spec.args,
      ];
      const added = spawnSync("claude", args, { encoding: "utf8" });
      if (added.status !== 0) {
        log(
          `claude mcp add failed: ${(added.stderr || added.stdout || "unknown error").trim()}`
        );
        return 1;
      }
      log("Claude Code user configuration updated. Restart Claude Code.");
      return 0;
    }

    case "codex": {
      const block = codexTomlBlock(spec);
      const path = resolve(homedir(), ".codex", "config.toml");
      if (options.dryRun) {
        log(`Would append to ${path}:`);
        log(codexTomlBlock(redacted));
        return 0;
      }
      let current = "";
      try {
        current = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const merged = mergeCodexToml(current, block);
      if (!merged.added) {
        log(`${path} already has [mcp_servers.planka]. Left untouched; replace it by hand with:`);
        log(block);
        return 0;
      }
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, merged.text, { mode: 0o600 });
      log(`Appended [mcp_servers.planka] to ${path}. Restart Codex.`);
      return 0;
    }

    case "cursor": {
      const path = resolve(homedir(), ".cursor", "mcp.json");
      if (options.dryRun) {
        log(`Would merge into ${path}:`);
        log(JSON.stringify(mergeMcpJson(undefined, redacted).document, null, 2));
        log("");
        log("Deeplink (no credential inside):");
        log(cursorDeeplink(redacted));
        return 0;
      }
      const merged = mergeMcpJson(await readJsonFile(path), spec);
      if (!merged.added) {
        log(`${path} already has an "planka" server. Left untouched.`);
      } else {
        await writePrivateJson(path, merged.document);
        log(`Merged into ${path} (0600). Restart Cursor.`);
      }
      log("");
      log("Share this instead of the file — it carries no credential:");
      log(cursorDeeplink(redacted));
      return 0;
    }

    case "vscode": {
      const path = resolve(options.projectDir, ".vscode", "mcp.json");
      const config = vscodeConfig(options);
      if (options.dryRun) {
        log(`Would write ${path}:`);
        log(JSON.stringify(config, null, 2));
        return 0;
      }
      const existing = await readJsonFile(path);
      if (
        existing &&
        typeof existing === "object" &&
        (existing as Record<string, any>).servers?.planka
      ) {
        log(`${path} already has a "planka" server. Left untouched.`);
        return 0;
      }
      const base = (existing as Record<string, any>) ?? {};
      const document = {
        ...base,
        inputs: [
          ...((base.inputs as unknown[]) ?? []).filter(
            (input) => (input as { id?: string }).id !== "planka_api_key"
          ),
          ...config.inputs,
        ],
        servers: { ...(base.servers ?? {}), ...config.servers },
      };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);
      log(`Wrote ${path}. VS Code asks for the API key on first start.`);
      return 0;
    }
  }
  return 0;
}
