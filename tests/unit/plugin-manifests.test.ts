/**
 * The plugin manifests are data, so nothing type-checks them and nothing fails
 * at runtime when they drift: a stale version pin installs the OLD server from
 * a NEW plugin, silently. These tests are the only guard.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, SERVER_VERSION } from "../../src/identity.generated.js";

const root = resolve(__dirname, "../..");
const read = (name: string) =>
  JSON.parse(readFileSync(resolve(root, name), "utf8"));
const readText = (name: string) => readFileSync(resolve(root, name), "utf8");

const pin = `${PACKAGE_NAME}@${SERVER_VERSION}`;

describe("Claude Code plugin", () => {
  const manifest = read(".claude-plugin/plugin.json");

  it("is named planka and points at the files that exist", () => {
    expect(manifest.name).toBe("planka");
    expect(manifest.skills).toBe("./workflow/skills/");
    expect(manifest.mcpServers).toBe("./.mcp.json");
    expect(manifest.hooks).toBe("./hooks/hooks.json");
    expect(() => readText("hooks/hooks.json")).not.toThrow();
    expect(() => readText("hooks/preflight.mjs")).not.toThrow();
  });

  it("tracks the package version", () => {
    expect(manifest.version).toBe(SERVER_VERSION);
  });

  it("asks for the credential instead of shipping one, and marks it sensitive", () => {
    expect(manifest.userConfig.planka_base_url.required).toBe(true);
    expect(manifest.userConfig.planka_api_key.sensitive).toBe(true);
    expect(Object.keys(manifest.userConfig)).toEqual([
      "planka_base_url",
      "planka_api_key",
      "planka_default_board_id",
    ]);
  });
});

describe(".mcp.json", () => {
  const mcp = read(".mcp.json");
  const codexMcp = read(".codex-plugin/mcp.json");

  it("pins the exact published version in both wrappers", () => {
    expect(mcp.mcpServers.planka.args).toEqual(["-y", pin]);
    expect(codexMcp.mcp_servers.planka.args).toEqual(["-y", pin]);
  });

  it("uses the wrapper key each runtime expects", () => {
    // Claude Code reads `mcpServers`; Codex reads a bare map or `mcp_servers`.
    // One file cannot be both without risking a server literally named
    // "mcpServers" on the Codex side, hence the two files.
    expect(Object.keys(mcp)).toEqual(["mcpServers"]);
    expect(Object.keys(codexMcp)).toEqual(["mcp_servers"]);
  });

  it("substitutes user config instead of hardcoding a credential", () => {
    const env = mcp.mcpServers.planka.env;
    expect(env.PLANKA_BASE_URL).toBe("${user_config.planka_base_url}");
    expect(env.PLANKA_API_KEY).toBe("${user_config.planka_api_key}");
  });

  it("contains no literal secret in any manifest", () => {
    for (const file of [
      ".mcp.json",
      ".codex-plugin/mcp.json",
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".codex-plugin/plugin.json",
      ".agents/plugins/marketplace.json",
    ]) {
      const text = readText(file);
      expect(text).not.toMatch(/PLANKA_(API_KEY|AGENT_PASSWORD)"\s*:\s*"(?!\$)[^"<]/);
    }
  });
});

describe("marketplaces", () => {
  it("offers the plugin from this very repository (Claude Code)", () => {
    const marketplace = read(".claude-plugin/marketplace.json");
    expect(marketplace.name).toBe("planka-mcp");
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins).toHaveLength(1);
    expect(marketplace.plugins[0]).toMatchObject({
      name: "planka",
      source: "./",
      version: SERVER_VERSION,
    });
  });

  it("offers the same plugin to Codex", () => {
    const marketplace = read(".agents/plugins/marketplace.json");
    expect(marketplace.plugins[0].name).toBe("planka");
    expect(marketplace.plugins[0].source).toEqual({ source: "local", path: "./" });
  });

  it("keeps the Codex manifest in step with the Claude one", () => {
    const codex = read(".codex-plugin/plugin.json");
    expect(codex.name).toBe("planka");
    expect(codex.version).toBe(SERVER_VERSION);
    expect(codex.skills).toBe("./workflow/skills/");
    expect(codex.mcpServers).toBe("./.codex-plugin/mcp.json");
  });
});

describe("skill frontmatter", () => {
  const skills = [
    "workflow/skills/planka-orchestrator/SKILL.md",
    "workflow/skills/planka-close-card/SKILL.md",
  ];

  // agentskills.io portable subset. A key outside it is silently ignored by
  // some runtimes and a hard error in others.
  const PORTABLE = new Set([
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "allowed-tools",
  ]);

  it.each(skills)("%s declares only portable frontmatter keys", (path) => {
    const text = readText(path);
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    expect(match).not.toBeNull();
    const keys = match![1]
      .split("\n")
      .filter((line) => /^[A-Za-z-]+:/.test(line))
      .map((line) => line.split(":")[0]);
    for (const key of keys) expect(PORTABLE).toContain(key);
    expect(keys).toContain("name");
    expect(keys).toContain("description");
    // `version:` is NOT portable — it belongs under metadata.
    expect(keys).not.toContain("version");
    expect(match![1]).toContain("metadata:");
  });

  it.each(skills)("%s teaches the current read surface", (path) => {
    const text = readText(path);
    expect(text).toContain("planka_get_comments");
    expect(text).not.toMatch(/Read the full board\./);
  });
});
