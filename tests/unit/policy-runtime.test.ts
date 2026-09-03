/**
 * The policy at RUNTIME, not only in the listing.
 *
 * Every case here is a hole the adversarial review found: the announced schema
 * and the executed one disagreeing (R1), a deprecated alias walking around
 * PLANKA_DISABLED_TOOLS (R2), and PLANKA_PROTECTED_LIST_IDS protecting a column
 * but not the cards inside it (N1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client.js")>();
  return {
    ...actual,
    plankaClient: {
      get: mocks.get,
      post: mocks.post,
      patch: mocks.patch,
      delete: mocks.del,
    },
  };
});

import {
  allTools,
  effectiveInputSchema,
  findMissingRequiredArgs,
  getTool,
} from "../../src/tools/index.js";
import { parsePolicy, resetPolicyCache } from "../../src/config/policy.js";
import { boardSummaryTool } from "../../src/tools/queries.js";
import { createListTool, manageListsTool } from "../../src/tools/lists.js";
import { addCommentTool } from "../../src/tools/comments.js";
import { manageCommentTool } from "../../src/tools/comments.js";
import { moveCardTool, deleteCardTool } from "../../src/tools/cards.js";
import { archiveCardTool } from "../../src/tools/card-ops.js";

const ts = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: null };
const parse = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text);
const textOf = (result: { content: Array<{ text: string }> }) =>
  result.content[0].text;

const byName = (name: string) => allTools.find((t) => t.name === name)!;

/** A board show reduced to what board_summary reads. */
function boardShow(boardId: string, lists: Array<Record<string, unknown>> = []) {
  return {
    item: {
      id: boardId,
      projectId: "project-1",
      name: "Board",
      position: 65536,
      ...ts,
    },
    included: {
      lists: lists.map((list) => ({
        boardId,
        position: 65536,
        type: "active",
        ...ts,
        ...list,
      })),
      cards: [],
      labels: [],
      cardLabels: [],
      cardMemberships: [],
      users: [],
      tasks: [],
      taskLists: [],
    },
  };
}

function cardShow(listId = "list-1") {
  return {
    item: {
      id: "card-1",
      boardId: "board-1",
      listId,
      name: "Card",
      position: 65536,
      type: "project",
      ...ts,
    },
    included: {
      cardLabels: [],
      cardMemberships: [],
      users: [],
      tasks: [],
      taskLists: [],
      attachments: [],
      customFields: [],
      customFieldValues: [],
    },
  };
}

function reset() {
  for (const mock of Object.values(mocks)) mock.mockReset();
  delete process.env.PLANKA_DEFAULT_BOARD_ID;
  delete process.env.PLANKA_DISABLED_TOOLS;
  delete process.env.PLANKA_PROTECTED_LIST_IDS;
  resetPolicyCache();
}

beforeEach(reset);
afterEach(reset);

describe("R1 — the schema that is announced is the schema that is enforced", () => {
  /** The five tools that carry boardId in `required`. */
  const withBoardId = [
    "planka_board_summary",
    "planka_list_lists",
    "planka_get_board",
    "planka_create_list",
    "planka_create_label",
  ];

  // Everything the five tools need EXCEPT boardId, so the only field the
  // check can complain about is the one under test.
  const args = { name: "New", color: "berry-red" };

  it("requires boardId when no default board is configured", () => {
    const policy = parsePolicy({});
    for (const name of withBoardId) {
      expect(findMissingRequiredArgs(byName(name), args, policy), name).toEqual([
        "boardId",
      ]);
    }
  });

  it("stops requiring it once PLANKA_DEFAULT_BOARD_ID is set", () => {
    const policy = parsePolicy({ PLANKA_DEFAULT_BOARD_ID: "999" });
    for (const name of withBoardId) {
      const tool = byName(name);
      // The listing says optional…
      expect(
        effectiveInputSchema(tool, policy).required ?? [],
        name
      ).not.toContain("boardId");
      // …and so does the runtime check. These used to disagree.
      expect(findMissingRequiredArgs(tool, args, policy), name).toEqual([]);
    }
  });

  it("planka_board_summary {} reaches Planka with a default board", async () => {
    process.env.PLANKA_DEFAULT_BOARD_ID = "999";
    resetPolicyCache();
    mocks.get.mockResolvedValue(
      boardShow("999", [{ id: "list-1", name: "Pending" }])
    );

    const body = parse(await boardSummaryTool.handler({}));

    expect(body.board).toEqual({ id: "999", name: "Board" });
    expect(mocks.get).toHaveBeenCalled();
  });

  it("planka_create_list {name} reaches Planka with a default board", async () => {
    process.env.PLANKA_DEFAULT_BOARD_ID = "999";
    resetPolicyCache();
    mocks.post.mockResolvedValue({
      item: {
        id: "list-9",
        boardId: "999",
        name: "New",
        position: 65536,
        type: "active",
        ...ts,
      },
    });
    mocks.get.mockResolvedValue(
      boardShow("999", [{ id: "list-9", name: "New" }])
    );

    const body = parse(await createListTool.handler({ name: "New" }));

    expect(body.success).toBe(true);
    expect(body.list.id).toBe("list-9");
    expect(mocks.post).toHaveBeenCalledWith("/api/boards/999/lists", expect.anything());
  });
});

describe("R2 — a deprecated alias is not a way around PLANKA_DISABLED_TOOLS", () => {
  it("refuses manage_lists delete when planka_delete_list is disabled", async () => {
    process.env.PLANKA_DISABLED_TOOLS = "planka_delete_list";
    resetPolicyCache();

    const result = await manageListsTool.handler({
      action: "delete",
      listId: "list-1",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/planka_delete_list is disabled/);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("refuses manage_comment delete when planka_delete_comment is disabled", async () => {
    process.env.PLANKA_DISABLED_TOOLS = "planka_delete_comment";
    resetPolicyCache();

    const result = await manageCommentTool.handler({
      action: "delete",
      commentId: "comment-1",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/planka_delete_comment is disabled/);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("refuses add_comment when planka_create_comment is disabled", async () => {
    process.env.PLANKA_DISABLED_TOOLS = "planka_create_comment";
    resetPolicyCache();

    const result = await addCommentTool.handler({
      cardId: "card-1",
      text: "hello",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/planka_create_comment is disabled/);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("still refuses the alias by its own name", async () => {
    process.env.PLANKA_DISABLED_TOOLS = "planka_manage_lists";
    resetPolicyCache();

    const tool = getTool("planka_manage_lists")!;
    const result = await tool.handler({ action: "delete", listId: "list-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/planka_manage_lists is disabled/);
  });
});

describe("N1 — PLANKA_PROTECTED_LIST_IDS protects the cards, not just the column", () => {
  beforeEach(() => {
    process.env.PLANKA_PROTECTED_LIST_IDS = "list-protected";
    resetPolicyCache();
  });

  it("refuses to move a card OUT of a protected column", async () => {
    mocks.get.mockResolvedValue(cardShow("list-protected"));

    const result = await moveCardTool.handler({
      cardId: "card-1",
      listId: "list-other",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/move cards out of/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("refuses to delete a card that lives in a protected column", async () => {
    mocks.get.mockResolvedValue(cardShow("list-protected"));

    const result = await deleteCardTool.handler({ cardId: "card-1" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/delete cards from/);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it("refuses to archive a card out of a protected column", async () => {
    mocks.get.mockResolvedValue(cardShow("list-protected"));

    const result = await archiveCardTool.handler({ cardId: "card-1" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/archive cards out of/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("costs no extra read when no list is protected", async () => {
    delete process.env.PLANKA_PROTECTED_LIST_IDS;
    resetPolicyCache();
    mocks.del.mockResolvedValue({ item: cardShow().item });
    mocks.get.mockRejectedValue(
      Object.assign(new Error("Card not found"), { status: 404 })
    );

    await deleteCardTool.handler({ cardId: "card-1" });

    // One read: the confirmation after the delete. No pre-read.
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
