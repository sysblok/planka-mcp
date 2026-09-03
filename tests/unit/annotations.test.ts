import { describe, expect, it } from "vitest";
import {
  allTools,
  getToolDefinitions,
  toolPresentation,
  TOOLS_REQUIRING_USER_INTERACTION,
} from "../../src/tools/index.js";

const HINT_FIELDS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

describe("tool annotations", () => {
  it("covers every registered tool", () => {
    // A new tool with no entry here fails the build instead of shipping with
    // the spec's pessimistic defaults (destructive: true, readOnly: false).
    const missing = allTools
      .map((tool) => tool.name)
      .filter((name) => !toolPresentation[name]);
    expect(missing).toEqual([]);
  });

  it("has no entry for a tool that does not exist", () => {
    const registered = new Set(allTools.map((tool) => tool.name));
    const orphans = Object.keys(toolPresentation).filter(
      (name) => !registered.has(name)
    );
    expect(orphans).toEqual([]);
  });

  it("spells out all four hints explicitly, never relying on a default", () => {
    for (const [name, presentation] of Object.entries(toolPresentation)) {
      expect(presentation.title, name).toBeTypeOf("string");
      expect(presentation.title.length, name).toBeGreaterThan(0);
      for (const field of HINT_FIELDS) {
        expect(presentation.annotations[field], `${name}.${field}`).toBeTypeOf(
          "boolean"
        );
      }
    }
  });

  it("never marks a read-only tool as destructive", () => {
    for (const [name, presentation] of Object.entries(toolPresentation)) {
      if (presentation.annotations.readOnlyHint) {
        expect(presentation.annotations.destructiveHint, name).toBe(false);
        expect(presentation.annotations.idempotentHint, name).toBe(true);
      }
    }
  });

  it("forces a user prompt on every destructive-by-name tool", () => {
    for (const name of TOOLS_REQUIRING_USER_INTERACTION) {
      const presentation = toolPresentation[name];
      expect(presentation, name).toBeDefined();
      expect(presentation._meta?.["anthropic/requiresUserInteraction"], name).toBe(
        true
      );
      expect(presentation.annotations.readOnlyHint, name).toBe(false);
      expect(presentation.annotations.destructiveHint, name).toBe(true);
    }
  });

  it("covers every delete_* tool with the confirmation flag", () => {
    const deleteTools = allTools
      .map((tool) => tool.name)
      .filter((name) => name.includes("delete"));
    for (const name of deleteTools) {
      expect(
        toolPresentation[name]?._meta?.["anthropic/requiresUserInteraction"],
        name
      ).toBe(true);
    }
  });

  it("raises the output ceiling for attachment viewing", () => {
    const meta = toolPresentation.planka_view_attachment?._meta;
    expect(meta?.["anthropic/maxResultSizeChars"]).toBeTypeOf("number");
    expect(
      meta?.["anthropic/maxResultSizeChars"] as number
    ).toBeGreaterThanOrEqual(4_000_000);
  });
});

describe("tools/list payload", () => {
  const definitions = getToolDefinitions();

  it("propagates title, annotations and _meta out of the registry", () => {
    // getToolDefinitions used to map only name/description/inputSchema, which
    // would drop everything above without any error.
    for (const definition of definitions) {
      expect(definition.title, definition.name).toBeTypeOf("string");
      expect(definition.annotations, definition.name).toBeDefined();
      for (const field of HINT_FIELDS) {
        expect(
          definition.annotations?.[field],
          `${definition.name}.${field}`
        ).toBeTypeOf("boolean");
      }
    }
    for (const name of TOOLS_REQUIRING_USER_INTERACTION) {
      const definition = definitions.find((entry) => entry.name === name);
      expect(
        definition?._meta?.["anthropic/requiresUserInteraction"],
        name
      ).toBe(true);
    }
  });

  it("returns tools in a stable, deterministic order", () => {
    // Clients cache tools/list and diff it; a reshuffle looks like a change.
    expect(definitions.map((definition) => definition.name)).toEqual([
      "planka_get_structure",
      "planka_get_board",
      "planka_list_cards",
      "planka_list_lists",
      "planka_board_summary",
      "planka_find_cards",
      "planka_create_card",
      "planka_get_card",
      "planka_update_card",
      "planka_move_card",
      "planka_delete_card",
      "planka_create_tasks",
      "planka_update_task",
      "planka_delete_task",
      "planka_manage_labels",
      "planka_set_card_labels",
      "planka_add_comment",
      "planka_get_comments",
      "planka_manage_comment",
      "planka_manage_lists",
      "planka_add_attachment",
      "planka_get_attachments",
      "planka_view_attachment",
      "planka_delete_attachment",
      "planka_card_history",
      "planka_board_activity",
      "planka_set_card_members",
      "planka_list_users",
      "planka_whoami",
      "planka_duplicate_card",
      "planka_archive_card",
      "planka_move_list_cards",
    ]);
  });

  it("is stable across repeated calls", () => {
    expect(getToolDefinitions().map((d) => d.name)).toEqual(
      definitions.map((d) => d.name)
    );
  });
});
