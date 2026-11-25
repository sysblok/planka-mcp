/**
 * planka_set_custom_field: a field that exists can always be written; one that
 * does not comes back as a readable "no such field" with the real choices.
 *
 * Runs through the tool handler against a mocked client that keeps the
 * values in memory, so the verification re-read sees what the write did.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { get: mocks.get, patch: mocks.patch, delete: mocks.delete },
}));

import { setCustomFieldTool } from "../../src/tools/custom-fields.js";
import { clearBoardNamesCache } from "../../src/operations/cards.js";
import { resetPolicyCache } from "../../src/config/policy.js";

const ts = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: null };
const card = {
  id: "card-1",
  boardId: "board-1",
  listId: "list-1",
  name: "Архив Винер",
  type: "project",
  position: 1,
  ...ts,
};

type Value = { cardId: string; customFieldGroupId: string; customFieldId: string; content: string };

interface World {
  cardGroups: unknown[];
  cardFields: unknown[];
  boardGroups: unknown[];
  boardFields: unknown[];
  project?: { baseCustomFieldGroups: unknown[]; customFields: unknown[] };
  values: Value[];
  /** When false, a PATCH answers 200 and changes nothing. */
  writesLand: boolean;
}

let world: World;

const VALUE_PATH =
  /^\/api\/cards\/card-1\/custom-field-values\/customFieldGroupId:([^:]+):customFieldId:([^:]+)$/;

function install() {
  mocks.get.mockImplementation(async (path: string) => {
    if (path === "/api/cards/card-1") {
      return {
        item: card,
        included: {
          customFieldGroups: world.cardGroups,
          customFields: world.cardFields,
          customFieldValues: world.values.map((v, i) => ({ id: `cfv-${i}`, ...v })),
        },
      };
    }
    if (path === "/api/boards/board-1") {
      return {
        item: { id: "board-1", projectId: "p-1", name: "СБъ. Редакция", position: 1, ...ts },
        included: {
          lists: [{ id: "list-1", boardId: "board-1", name: "Готово", position: 1, type: "active", ...ts }],
          labels: [],
          customFieldGroups: world.boardGroups,
          customFields: world.boardFields,
        },
      };
    }
    if (path === "/api/projects/p-1" && world.project) {
      return { item: { id: "p-1", name: "Sysblok" }, included: world.project };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mocks.patch.mockImplementation(async (path: string, body: { content: string }) => {
    const m = VALUE_PATH.exec(path);
    if (!m) throw new Error(`unexpected PATCH ${path}`);
    const [, customFieldGroupId, customFieldId] = m;
    const v = { cardId: "card-1", customFieldGroupId, customFieldId, content: body.content };
    if (world.writesLand) {
      world.values = world.values.filter(
        (x) => !(x.customFieldGroupId === customFieldGroupId && x.customFieldId === customFieldId)
      );
      world.values.push(v);
    }
    return { item: v };
  });
  mocks.delete.mockImplementation(async (path: string) => {
    const m = VALUE_PATH.exec(path);
    if (!m) throw new Error(`unexpected DELETE ${path}`);
    const [, g, f] = m;
    const gone = world.values.find((x) => x.customFieldGroupId === g && x.customFieldId === f);
    world.values = world.values.filter((x) => x !== gone);
    return { item: gone };
  });
}

/** The «Редакция» shape: one board-level group with a "Google Doc" field. */
function editorialBoard(): World {
  return {
    cardGroups: [],
    cardFields: [],
    boardGroups: [{ id: "cfg-pub", boardId: "board-1", name: "Публикация", position: 1 }],
    boardFields: [
      { id: "cf-doc", customFieldGroupId: "cfg-pub", name: "Google Doc", position: 1 },
      { id: "cf-editor", customFieldGroupId: "cfg-pub", name: "Редактор", position: 2 },
    ],
    values: [],
    writesLand: true,
  };
}

const DOC = "https://docs.google.com/document/d/1yZk/edit";

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const boardReads = () =>
  mocks.get.mock.calls.filter(([p]) => p === "/api/boards/board-1").length;

beforeEach(() => {
  mocks.get.mockReset();
  mocks.patch.mockReset();
  mocks.delete.mockReset();
  clearBoardNamesCache();
  resetPolicyCache();
  world = editorialBoard();
  install();
});

afterEach(() => {
  delete process.env.PLANKA_PROTECTED_LIST_IDS;
  delete process.env.PLANKA_ALLOWED_BOARD_IDS;
  resetPolicyCache();
});

describe("planka_set_custom_field writes a field that exists", () => {
  it("fills a board-level field by name, case-insensitively, and verifies it", async () => {
    const result = await setCustomFieldTool.handler({
      cardId: "card-1",
      field: "google doc",
      content: DOC,
    });
    const body = payload(result);

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({
      success: true,
      verified: true,
      changed: true,
      previousContent: null,
      // The field as get_card shows it, holding the value read back.
      field: { group: "Публикация", field: "Google Doc", content: DOC, scope: "board", groupId: "cfg-pub", fieldId: "cf-doc" },
    });
    expect(body).not.toHaveProperty("content");
    expect(body).not.toHaveProperty("previous");
    expect(mocks.patch).toHaveBeenCalledWith(
      "/api/cards/card-1/custom-field-values/customFieldGroupId:cfg-pub:customFieldId:cf-doc",
      { content: DOC }
    );
  });

  it("accepts the fieldId as well as the name", async () => {
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "cf-editor", content: "Аня" })
    );
    expect(body.verified).toBe(true);
    expect(body.field.field).toBe("Редактор");
  });

  it("finds a field created after the board was cached, instead of denying it", async () => {
    // First call caches a board without "Google Doc"...
    world.boardFields = [world.boardFields[1]];
    await setCustomFieldTool.handler({ cardId: "card-1", field: "Редактор", content: "Аня" });
    // ...then someone adds the field in Planka's UI.
    world.boardFields = editorialBoard().boardFields;

    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC })
    );
    expect(body.verified).toBe(true);
    expect(body.field.fieldId).toBe("cf-doc");
  });

  it("uses the cached board when the field resolves, so a write costs no board read", async () => {
    await setCustomFieldTool.handler({ cardId: "card-1", field: "Редактор", content: "Аня" });
    const before = boardReads();
    await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC });
    expect(boardReads()).toBe(before);
  });

  it("writes a card-level field from a project template through the card's own group", async () => {
    world = {
      ...editorialBoard(),
      boardGroups: [],
      boardFields: [],
      cardGroups: [{ id: "cfg-card", cardId: "card-1", baseCustomFieldGroupId: "bcfg-1", name: null, position: 1 }],
      project: {
        baseCustomFieldGroups: [{ id: "bcfg-1", projectId: "p-1", name: "Шаблон статьи" }],
        customFields: [{ id: "cf-base", baseCustomFieldGroupId: "bcfg-1", name: "Google Doc", position: 1 }],
      },
    };

    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC })
    );
    expect(body.verified).toBe(true);
    expect(body.field).toMatchObject({ group: "Шаблон статьи", scope: "card", groupId: "cfg-card", fieldId: "cf-base" });
    expect(mocks.patch.mock.calls[0][0]).toBe(
      "/api/cards/card-1/custom-field-values/customFieldGroupId:cfg-card:customFieldId:cf-base"
    );
  });
});

describe("planka_set_custom_field refuses a field that does not exist", () => {
  it("says so and lists the fields the card does have, after a fresh read", async () => {
    const result = await setCustomFieldTool.handler({ cardId: "card-1", field: "Ссылка", content: DOC });
    const body = payload(result);

    expect(result.isError).toBe(true);
    expect(body.success).toBe(false);
    expect(body.error).toBe("custom_field_not_found");
    expect(body.message).toMatch(/no custom field "Ссылка"/);
    expect(body.message).toMatch(/never creates one/);
    expect(body.availableFields.map((f: { field: string }) => f.field)).toEqual(["Google Doc", "Редактор"]);
    expect(mocks.patch).not.toHaveBeenCalled();
    // Never "no such field" off the cache alone.
    expect(boardReads()).toBe(2);
  });

  it("names the case of a card with no custom fields at all", async () => {
    world.boardGroups = [];
    world.boardFields = [];
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC })
    );
    expect(body.error).toBe("custom_field_not_found");
    expect(body.message).toMatch(/has no custom fields at all/);
    expect(body.availableFields).toEqual([]);
  });

  it("ignores another card's own group on the same board", async () => {
    world.boardGroups.push({ id: "cfg-other", cardId: "card-2", name: "Чужое", position: 1 });
    world.boardFields.push({ id: "cf-other", customFieldGroupId: "cfg-other", name: "Чужое поле", position: 1 });
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Чужое поле", content: "x" })
    );
    expect(body.error).toBe("custom_field_not_found");
  });

  it("refuses a group that does not have the field", async () => {
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", group: "Нет такой", content: DOC })
    );
    expect(body.error).toBe("custom_field_not_found");
    expect(body.message).toMatch(/in group "Нет такой"/);
  });
});

describe("planka_set_custom_field never guesses", () => {
  beforeEach(() => {
    world.cardGroups = [{ id: "cfg-card", cardId: "card-1", name: "Своё", position: 1 }];
    world.cardFields = [{ id: "cf-doc-2", customFieldGroupId: "cfg-card", name: "Google Doc", position: 1 }];
  });

  it("refuses a name that is in two groups and lists both", async () => {
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC })
    );
    expect(body.error).toBe("custom_field_ambiguous");
    expect(body.candidates.map((c: { groupId: string }) => c.groupId)).toEqual(["cfg-pub", "cfg-card"]);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("writes once the group is named", async () => {
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", group: "своё", content: DOC })
    );
    expect(body.verified).toBe(true);
    expect(body.field.fieldId).toBe("cf-doc-2");
  });
});

describe("planka_set_custom_field clears and stays honest", () => {
  it("clears with null through DELETE and confirms it is gone", async () => {
    world.values = [{ cardId: "card-1", customFieldGroupId: "cfg-pub", customFieldId: "cf-doc", content: DOC }];
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: null })
    );
    expect(body).toMatchObject({ success: true, verified: true, changed: true, previousContent: DOC, field: { content: null } });
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/cards/card-1/custom-field-values/customFieldGroupId:cfg-pub:customFieldId:cf-doc"
    );
  });

  it("treats clearing an empty field, or rewriting the same value, as done without a write", async () => {
    const cleared = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: "" })
    );
    expect(cleared).toMatchObject({ success: true, changed: false });

    world.values = [{ cardId: "card-1", customFieldGroupId: "cfg-pub", customFieldId: "cf-doc", content: DOC }];
    const same = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC })
    );
    expect(same).toMatchObject({ success: true, changed: false });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("reports a write that answered 200 but did not land", async () => {
    world.writesLand = false;
    const result = await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC });
    const body = payload(result);
    expect(result.isError).toBe(true);
    // The re-read wins over Planka's 200 echo: the field is still empty.
    expect(body).toMatchObject({ success: false, verified: false, changed: false, field: { content: null } });
  });

  it("falls back to Planka's echo, never a placeholder, when the re-read fails", async () => {
    await setCustomFieldTool.handler({ cardId: "card-1", field: "Редактор", content: "Аня" });
    const get = mocks.get.getMockImplementation()!;
    let cardReads = 0;
    mocks.get.mockImplementation(async (path: string) => {
      // The resolving read passes, the verification re-read blows up.
      if (path === "/api/cards/card-1" && ++cardReads > 1) throw new Error("socket hang up");
      return get(path);
    });

    const result = await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC });
    const body = payload(result);
    expect(result.isError).toBe(true);
    expect(body.verified).toBe(false);
    expect(body.verificationError).toMatch(/could not be re-read/);
    expect(body.field.content).toBe(DOC);
  });

  it("refuses content over Planka's 512 characters before any request", async () => {
    const body = payload(
      await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: "x".repeat(513) })
    );
    expect(body.error).toBe("content_too_long");
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("respects PLANKA_PROTECTED_LIST_IDS", async () => {
    process.env.PLANKA_PROTECTED_LIST_IDS = "list-1";
    resetPolicyCache();
    const result = await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/protected by PLANKA_PROTECTED_LIST_IDS/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("respects PLANKA_ALLOWED_BOARD_IDS", async () => {
    process.env.PLANKA_ALLOWED_BOARD_IDS = "board-9";
    resetPolicyCache();
    const result = await setCustomFieldTool.handler({ cardId: "card-1", field: "Google Doc", content: DOC });
    expect(result.isError).toBe(true);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});
