import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

describe("release identity", () => {
  it("keeps npm and MCP Registry metadata synchronized", async () => {
    const [identity, packageJson, serverJson] = await Promise.all([
      readJson("project.identity.json"),
      readJson("package.json"),
      readJson("server.json"),
    ]);

    expect(packageJson.name).toBe(identity.packageName);
    expect(packageJson.mcpName).toBe(identity.mcpServerName);
    expect(serverJson.name).toBe(identity.mcpServerName);
    expect(serverJson.packages[0].identifier).toBe(identity.packageName);
    expect(serverJson.version).toBe(packageJson.version);
    expect(serverJson.packages[0].version).toBe(packageJson.version);
  });
});
