import { describe, expect, it } from "vitest";
import { allTools } from "../../src/tools/index.js";

describe("MCP tool registry", () => {
  it("publishes exactly 20 uniquely named tools", () => {
    const names = allTools.map((tool) => tool.name);
    expect(names).toHaveLength(20);
    expect(new Set(names).size).toBe(20);
  });

  it("publishes JSON schemas with required object roots", () => {
    for (const tool of allTools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf("object");
    }
  });
});
