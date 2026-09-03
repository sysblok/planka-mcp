/**
 * One tool per action, with a real `required`.
 *
 * The `planka_manage_*` enum could not express "boardId is required when
 * action=create", so every branch was checked by hand — and that is where the
 * empty-PATCH false greens came from. These tests pin the replacement: the new
 * tools declare what they need, the generic presence check enforces it, and the
 * old names keep working as aliases.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
}));

vi.mock("../../src/client.js", () => ({
  plankaClient: {
    get: mocks.get,
    post: mocks.post,
    patch: mocks.patch,
    delete: mocks.del,
  },
}));

import {
  createLabelTool,
  updateLabelTool,
  deleteLabelTool,
  manageLabelsTool,
} from "../../src/tools/labels.js";
import {
  createListTool,
  updateListTool,
  deleteListTool,
  manageListsTool,
} from "../../src/tools/lists.js";
import {
  createCommentTool,
  updateCommentTool,
  deleteCommentTool,
  addCommentTool,
  manageCommentTool,
} from "../../src/tools/comments.js";
import {
  allTools,
  DEPRECATED_TOOL_NAMES,
  findMissingRequiredArgs,
  getToolDefinitions,
} from "../../src/tools/index.js";
import { parsePolicy, WRITE_TOOL_NAMES } from "../../src/config/policy.js";

const ts = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: null };

const label = {
  id: "label-1",
  boardId: "board-1",
  name: "decidido",
  color: "berry-red",
  position: 65536,
  ...ts,
};

const list = {
  id: "list-1",
  boardId: "board-1",
  name: "Pending",
  position: 65536,
  type: "active",
  ...ts,
};

const comment = {
  id: "comment-1",
  cardId: "card-1",
  userId: "user-1",
  text: "hello",
  ...ts,
};

function boardBody(included: object) {
  return {
    item: {
      id: "board-1",
      projectId: "project-1",
      name: "Board",
      position: 65536,
      ...ts,
    },
    included,
  };
}

function commentsBody(items: object[]) {
  return { items, included: { users: [] } };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.del.mockReset();
});

describe("label tools", () => {
  it("create_label writes, re-reads and reports what landed", async () => {
    mocks.post.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [label], lists: [] }));

    const result = await createLabelTool.handler({
      boardId: "board-1",
      name: "decidido",
      color: "berry-red",
    });
    const body = payload(result);

    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ success: true, verified: true });
    expect(body.label).toEqual({
      id: "label-1",
      name: "decidido",
      color: "berry-red",
      boardId: "board-1",
      position: 65536,
    });
    // No echo of the arguments beyond the digest of what is now on the board.
    expect(Object.keys(body).sort()).toEqual(["label", "success", "verified"]);
  });

  it("create_label refuses a color Planka does not have", async () => {
    const result = await createLabelTool.handler({
      boardId: "board-1",
      name: "x",
      color: "octarine",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Invalid color 'octarine'/);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("update_label with only the id changes nothing and says so", async () => {
    const result = await updateLabelTool.handler({ labelId: "label-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("update_label reports the board's copy, not the PATCH echo", async () => {
    mocks.patch.mockResolvedValue({ item: { ...label, name: "listo" } });
    mocks.get.mockResolvedValue(
      boardBody({ labels: [{ ...label, name: "listo" }], lists: [] })
    );

    const result = await updateLabelTool.handler({
      labelId: "label-1",
      name: "listo",
    });

    expect(payload(result)).toMatchObject({
      verified: true,
      label: { name: "listo" },
    });
  });

  it("delete_label that did not delete is not a success", async () => {
    mocks.del.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [label], lists: [] }));

    const result = await deleteLabelTool.handler({ labelId: "label-1" });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("delete_label confirms when the label is gone from the board", async () => {
    mocks.del.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [] }));

    const result = await deleteLabelTool.handler({ labelId: "label-1" });

    expect(payload(result)).toMatchObject({ success: true, verified: true });
    expect(result.isError).toBeUndefined();
  });
});

describe("list tools", () => {
  it("create_list writes and verifies against the board", async () => {
    mocks.post.mockResolvedValue({ item: list });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [list] }));

    const result = await createListTool.handler({
      boardId: "board-1",
      name: "Pending",
    });

    expect(payload(result)).toMatchObject({
      verified: true,
      list: { id: "list-1", name: "Pending" },
    });
  });

  it("update_list with only the id sends no PATCH", async () => {
    const result = await updateListTool.handler({ listId: "list-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("delete_list that did not delete is not a success", async () => {
    mocks.del.mockResolvedValue({ item: list });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [list] }));

    const result = await deleteListTool.handler({ listId: "list-1" });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("delete_list warns about the cards in its description", () => {
    expect(deleteListTool.description).toMatch(/every card/i);
    expect(deleteListTool.description).toMatch(/DESTRUCTIVE/);
  });
});

describe("comment tools", () => {
  it("create_comment verifies against the card's comments", async () => {
    mocks.post.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue(commentsBody([comment]));

    const result = await createCommentTool.handler({
      cardId: "card-1",
      text: "hello",
    });

    expect(payload(result)).toMatchObject({
      verified: true,
      cardId: "card-1",
      comment: { id: "comment-1", text: "hello" },
    });
  });

  it("create_comment that Planka did not store is not a success", async () => {
    mocks.post.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue(commentsBody([]));

    const result = await createCommentTool.handler({
      cardId: "card-1",
      text: "hello",
    });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("update_comment re-reads the card's comments", async () => {
    mocks.patch.mockResolvedValue({ item: { ...comment, text: "edited" } });
    mocks.get.mockResolvedValue(commentsBody([{ ...comment, text: "edited" }]));

    const result = await updateCommentTool.handler({
      commentId: "comment-1",
      text: "edited",
    });

    expect(payload(result)).toMatchObject({
      verified: true,
      comment: { text: "edited" },
    });
  });

  it("delete_comment that did not delete is not a success", async () => {
    mocks.del.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue(commentsBody([comment]));

    const result = await deleteCommentTool.handler({ commentId: "comment-1" });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });
});

describe("required is declared, not hand-checked", () => {
  const cases: Array<[string, Record<string, unknown>, string[]]> = [
    ["planka_create_label", { boardId: "b" }, ["name", "color"]],
    ["planka_update_label", {}, ["labelId"]],
    ["planka_delete_label", {}, ["labelId"]],
    ["planka_create_list", { boardId: "b" }, ["name"]],
    ["planka_update_list", {}, ["listId"]],
    ["planka_delete_list", {}, ["listId"]],
    ["planka_create_comment", { cardId: "c" }, ["text"]],
    ["planka_update_comment", { commentId: "c" }, ["text"]],
    ["planka_delete_comment", {}, ["commentId"]],
  ];

  it.each(cases)("%s rejects a call missing %o", (name, args, missing) => {
    const tool = allTools.find((t) => t.name === name)!;
    expect(tool, name).toBeDefined();
    expect(findMissingRequiredArgs(tool, args)).toEqual(missing);
  });

  it("every new tool is classified as a write", () => {
    for (const [name] of cases) {
      expect(WRITE_TOOL_NAMES.has(name), name).toBe(true);
    }
  });
});

describe("deprecated aliases still work", () => {
  it("manage_labels routes create to create_label", async () => {
    mocks.post.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [label], lists: [] }));

    const result = await manageLabelsTool.handler({
      action: "create",
      boardId: "board-1",
      name: "decidido",
      color: "berry-red",
    });

    expect(payload(result)).toMatchObject({
      verified: true,
      label: { id: "label-1" },
    });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/boards/board-1/labels",
      expect.objectContaining({ name: "decidido", color: "berry-red" })
    );
  });

  it("manage_labels routes update and delete too", async () => {
    mocks.patch.mockResolvedValue({ item: { ...label, name: "listo" } });
    mocks.get.mockResolvedValue(
      boardBody({ labels: [{ ...label, name: "listo" }], lists: [] })
    );
    expect(
      payload(
        await manageLabelsTool.handler({
          action: "update",
          labelId: "label-1",
          name: "listo",
        })
      ).verified
    ).toBe(true);

    mocks.del.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [] }));
    expect(
      payload(
        await manageLabelsTool.handler({ action: "delete", labelId: "label-1" })
      ).verified
    ).toBe(true);
  });

  it("manage_lists routes to the three list tools", async () => {
    mocks.post.mockResolvedValue({ item: list });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [list] }));
    expect(
      payload(
        await manageListsTool.handler({
          action: "create",
          boardId: "board-1",
          name: "Pending",
        })
      ).verified
    ).toBe(true);

    mocks.del.mockResolvedValue({ item: list });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [] }));
    expect(
      payload(
        await manageListsTool.handler({ action: "delete", listId: "list-1" })
      ).verified
    ).toBe(true);
  });

  it("manage_comment routes update and delete", async () => {
    mocks.patch.mockResolvedValue({ item: { ...comment, text: "edited" } });
    mocks.get.mockResolvedValue(commentsBody([{ ...comment, text: "edited" }]));
    expect(
      payload(
        await manageCommentTool.handler({
          action: "update",
          commentId: "comment-1",
          text: "edited",
        })
      ).verified
    ).toBe(true);

    mocks.del.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue(commentsBody([]));
    expect(
      payload(
        await manageCommentTool.handler({
          action: "delete",
          commentId: "comment-1",
        })
      ).verified
    ).toBe(true);
  });

  it("add_comment forwards to create_comment unchanged", async () => {
    mocks.post.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue(commentsBody([comment]));

    const result = await addCommentTool.handler({
      cardId: "card-1",
      text: "hello",
    });

    expect(payload(result).verified).toBe(true);
    expect(addCommentTool.inputSchema).toBe(createCommentTool.inputSchema);
  });

  it("borrows the target's required when the alias cannot declare it", async () => {
    const result = await manageLabelsTool.handler({
      action: "update",
      // labelId missing: the alias schema cannot require it per action.
    } as never);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/labelId is required/);
    expect(result.content[0].text).toMatch(/planka_update_label/);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("names an unknown action instead of falling through", async () => {
    const result = await manageCommentTool.handler({
      action: "create",
      commentId: "comment-1",
    } as never);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unknown action 'create'/);
    expect(result.content[0].text).toMatch(/update, delete/);
  });

  it("every alias opens its description with DEPRECATED", () => {
    for (const name of DEPRECATED_TOOL_NAMES) {
      const tool = allTools.find((t) => t.name === name)!;
      expect(tool, name).toBeDefined();
      expect(tool.description.startsWith("DEPRECATED"), name).toBe(true);
    }
  });
});

describe("PLANKA_HIDE_DEPRECATED", () => {
  it("keeps the deprecated tools listed by default", () => {
    const names = getToolDefinitions(parsePolicy({})).map((t) => t.name);
    for (const name of DEPRECATED_TOOL_NAMES) {
      expect(names, name).toContain(name);
    }
    expect(names).toHaveLength(41);
  });

  it("drops exactly the deprecated tools when set", () => {
    const policy = parsePolicy({ PLANKA_HIDE_DEPRECATED: "true" });
    const names = getToolDefinitions(policy).map((t) => t.name);

    expect(names).toHaveLength(41 - DEPRECATED_TOOL_NAMES.size);
    for (const name of DEPRECATED_TOOL_NAMES) {
      expect(names, name).not.toContain(name);
    }
    // The replacements are untouched.
    expect(names).toContain("planka_create_label");
    expect(names).toContain("planka_create_comment");
    expect(names).toContain("planka_delete_list");
  });

  it("rejects a value that is neither true nor false", () => {
    expect(() => parsePolicy({ PLANKA_HIDE_DEPRECATED: "yes" })).toThrow(
      /PLANKA_HIDE_DEPRECATED/
    );
  });
});
