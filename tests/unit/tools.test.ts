import { describe, expect, it } from "vitest";
import {
  allTools,
  getTool,
  getToolDefinitions,
} from "../../src/tools/index.js";
import { parsePolicy } from "../../src/config/policy.js";

describe("MCP tool registry", () => {
  it("publishes exactly 32 uniquely named tools", () => {
    const names = allTools.map((tool) => tool.name);
    expect(names).toHaveLength(32);
    expect(new Set(names).size).toBe(32);
  });

  it("publishes JSON schemas with required object roots", () => {
    for (const tool of allTools) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.inputSchema.properties, tool.name).toBeTypeOf("object");
    }
  });
});

describe("access policy applied to the registry", () => {
  const open = parsePolicy({});

  it("lists every tool when nothing is restricted", () => {
    expect(getToolDefinitions(open)).toHaveLength(32);
  });

  it("hides write tools in read-only mode", () => {
    const policy = parsePolicy({ PLANKA_READ_ONLY: "true" });
    const names = getToolDefinitions(policy).map((t) => t.name);

    expect(names).toHaveLength(14);
    expect(names).toContain("planka_board_summary");
    expect(names).not.toContain("planka_create_card");
    expect(names).not.toContain("planka_delete_card");
  });

  it("hides tools named in PLANKA_DISABLED_TOOLS", () => {
    const policy = parsePolicy({
      PLANKA_DISABLED_TOOLS: "get_board,planka_delete_card",
    });
    const names = getToolDefinitions(policy).map((t) => t.name);

    expect(names).toHaveLength(30);
    expect(names).not.toContain("planka_get_board");
    expect(names).not.toContain("planka_delete_card");
  });

  it("refuses a hidden tool at dispatch, not only in the listing", async () => {
    const policy = parsePolicy({ PLANKA_READ_ONLY: "true" });
    const tool = getTool("planka_create_card", policy);

    expect(tool).toBeDefined();
    const result = await tool!.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/read-only mode \(PLANKA_READ_ONLY=true\)/),
    });
  });

  it("still answers undefined for names that do not exist", () => {
    expect(getTool("planka_nope", open)).toBeUndefined();
  });

  it("drops boardId from required once a default board is configured", () => {
    const policy = parsePolicy({ PLANKA_DEFAULT_BOARD_ID: "1234" });
    const withDefault = new Map(
      getToolDefinitions(policy).map((t) => [t.name, t])
    );
    const withoutDefault = new Map(
      getToolDefinitions(open).map((t) => [t.name, t])
    );

    for (const name of [
      "planka_get_board",
      "planka_board_summary",
      "planka_list_lists",
    ]) {
      expect(withoutDefault.get(name)!.inputSchema.required, name).toContain(
        "boardId"
      );
      expect(withDefault.get(name)!.inputSchema.required, name).not.toContain(
        "boardId"
      );
      expect(
        (withDefault.get(name)!.inputSchema.properties.boardId as {
          description: string;
        }).description,
        name
      ).toMatch(/defaults to PLANKA_DEFAULT_BOARD_ID \(1234\)/);
    }

    // planka_find_cards never requires boardId: with a listId the list names
    // its own board. It still gets the note about the default.
    for (const map of [withoutDefault, withDefault]) {
      expect(map.get("planka_find_cards")!.inputSchema.required ?? []).not.toContain(
        "boardId"
      );
    }
    expect(
      (withDefault.get("planka_find_cards")!.inputSchema.properties.boardId as {
        description: string;
      }).description
    ).toMatch(/defaults to PLANKA_DEFAULT_BOARD_ID \(1234\)/);

    // The registry itself is untouched: the copy is what carries the policy.
    const original = allTools.find((t) => t.name === "planka_get_board")!;
    expect(original.inputSchema.required).toContain("boardId");
  });
});
