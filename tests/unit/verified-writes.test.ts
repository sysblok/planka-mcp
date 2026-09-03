/**
 * Verified writes — one test per "false green" the audit found.
 *
 * Everything is driven through the tool handlers against a mocked client, so
 * what is under test is exactly what an agent would see.
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

import { PlankaError, PlankaPermissionError } from "../../src/errors.js";
import {
  createCardTool,
  getCardTool,
  updateCardTool,
  moveCardTool,
  deleteCardTool,
} from "../../src/tools/cards.js";
import { updateTaskTool, deleteTaskTool } from "../../src/tools/tasks.js";
import { manageLabelsTool } from "../../src/tools/labels.js";
import { manageListsTool } from "../../src/tools/lists.js";
import { manageCommentTool } from "../../src/tools/comments.js";
import { deleteAttachmentTool } from "../../src/tools/attachments.js";

const ts = { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: null };

const card = {
  id: "card-1",
  boardId: "board-1",
  listId: "list-1",
  name: "Card",
  description: null,
  type: "project",
  position: 65536,
  ...ts,
};

const task = (id: string, name: string) => ({
  id,
  taskListId: "tl-1",
  name,
  position: 65536,
  isCompleted: false,
  ...ts,
});

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

const attachment = {
  id: "attachment-1",
  cardId: "card-1",
  name: "shot.png",
  type: "file",
  ...ts,
};

/** A `GET /api/cards/:id` body. */
function cardBody(over: Partial<typeof card> = {}, included: object = {}) {
  return { item: { ...card, ...over }, included };
}

/** A `GET /api/boards/:id` body. */
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

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
  mocks.del.mockReset();
});

describe("get_card never invents an empty comment list", () => {
  it("surfaces a 403 on the comments endpoint instead of reporting zero comments", async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path.endsWith("/comments")) {
        throw new PlankaPermissionError("Forbidden (GET /api/cards/card-1/comments)");
      }
      return cardBody();
    });

    // withComments is what makes get_card touch the comments endpoint at all.
    const result = await getCardTool.handler({
      cardId: "card-1",
      withComments: 5,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/Forbidden/);
    expect(result.content[0].text).not.toMatch(/"comments":\[\]/);
  });
});

describe("create_card reports what landed", () => {
  it("counts the tasks that are really on the card, not the ones requested", async () => {
    mocks.post.mockImplementation(async (path: string, body: any) => {
      if (path === "/api/lists/list-1/cards") return { item: card };
      if (path === "/api/cards/card-1/task-lists")
        return { item: { id: "tl-1", cardId: "card-1", name: "Tasks", position: 65536, ...ts } };
      if (path === "/api/task-lists/tl-1/tasks") {
        if (body.name === "one") return { item: task("task-1", "one") };
        throw new PlankaError("boom", "API_ERROR", 500);
      }
      throw new Error(`unexpected POST ${path}`);
    });
    mocks.get.mockImplementation(async () =>
      cardBody({}, { tasks: [task("task-1", "one")], taskLists: [] })
    );

    const result = await createCardTool.handler({
      listId: "list-1",
      name: "Card",
      tasks: ["one", "two", "three"],
    });

    const body = payload(result);
    expect(body.tasksRequested).toBe(3);
    expect(body.tasksCreated).toBe(1);
    expect(body.card.id).toBe("card-1");
    expect(result.isError).toBe(true);
  });

  it("still returns the card id when the tasks step blows up", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === "/api/lists/list-1/cards") return { item: card };
      throw new PlankaError("task-lists exploded", "API_ERROR", 500);
    });
    mocks.get.mockImplementation(async () => cardBody({}, { tasks: [] }));

    const result = await createCardTool.handler({
      listId: "list-1",
      name: "Card",
      tasks: ["one"],
    });

    const body = payload(result);
    expect(body.card.id).toBe("card-1");
    expect(body.partialFailure.tasks).toMatch(/task-lists exploded/);
    expect(result.isError).toBe(true);
  });

  it("fails when every requested label failed to attach", async () => {
    mocks.post.mockImplementation(async (path: string) => {
      if (path === "/api/lists/list-1/cards") return { item: card };
      if (path.endsWith("/card-labels")) {
        throw new PlankaError("Resource not found", "NOT_FOUND", 404);
      }
      throw new Error(`unexpected POST ${path}`);
    });
    mocks.get.mockImplementation(async () => cardBody({}, { cardLabels: [] }));

    const result = await createCardTool.handler({
      listId: "list-1",
      name: "Card",
      labelIds: ["nope-1", "nope-2"],
    });

    const body = payload(result);
    expect(body.labelsAttached).toBe(0);
    // Each failure carries its reason: a bad labelId and a 403 on the board
    // are otherwise indistinguishable.
    expect(body.partialFailure.labelIds).toEqual([
      { labelId: "nope-1", reason: expect.stringContaining("not found") },
      { labelId: "nope-2", reason: expect.stringContaining("not found") },
    ]);
    expect(result.isError).toBe(true);
  });
});

describe("move_card verifies the destination", () => {
  it("fails when the card is still in the old list", async () => {
    mocks.patch.mockResolvedValue({ item: { ...card, listId: "list-1" } });
    mocks.get.mockResolvedValue(cardBody({ listId: "list-1" }));

    const result = await moveCardTool.handler({
      cardId: "card-1",
      listId: "list-2",
    });

    const body = payload(result);
    expect(body.verified).toBe(false);
    expect(body.card.listId).toBe("list-1");
    expect(body.requestedListId).toBe("list-2");
    expect(result.isError).toBe(true);
  });

  it("passes when the card really moved", async () => {
    mocks.patch.mockResolvedValue({ item: { ...card, listId: "list-2" } });
    mocks.get.mockResolvedValue(cardBody({ listId: "list-2" }));

    const result = await moveCardTool.handler({
      cardId: "card-1",
      listId: "list-2",
    });

    expect(payload(result).verified).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});

describe("the four updates refuse a no-op PATCH", () => {
  it("update_card with only the id", async () => {
    const result = await updateCardTool.handler({ cardId: "card-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("update_task with only the id", async () => {
    const result = await updateTaskTool.handler({ taskId: "task-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("manage_labels update with only the id", async () => {
    const result = await manageLabelsTool.handler({
      action: "update",
      labelId: "label-1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it("manage_lists update with only the id", async () => {
    const result = await manageListsTool.handler({
      action: "update",
      listId: "list-1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/nothing to do/i);
    expect(mocks.patch).not.toHaveBeenCalled();
  });
});

describe("a delete that did not delete is not a success", () => {
  it("delete_card: the card still answers a read", async () => {
    mocks.del.mockResolvedValue({ item: card });
    mocks.get.mockResolvedValue(cardBody());

    const result = await deleteCardTool.handler({ cardId: "card-1" });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("delete_card: a 404 on re-read is the proof", async () => {
    mocks.del.mockResolvedValue({ item: card });
    mocks.get.mockRejectedValue(new PlankaError("Card not found", "NOT_FOUND", 404));

    const result = await deleteCardTool.handler({ cardId: "card-1" });

    expect(payload(result).verified).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it("delete_task: the task is still on the card", async () => {
    mocks.del.mockResolvedValue({ item: task("task-1", "one") });
    mocks.get.mockResolvedValue(cardBody({}, { tasks: [task("task-1", "one")] }));

    const result = await deleteTaskTool.handler({
      taskId: "task-1",
      cardId: "card-1",
    });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("delete_task without cardId says it could not verify, and does not claim it did", async () => {
    mocks.del.mockResolvedValue({ item: task("task-1", "one") });

    const result = await deleteTaskTool.handler({ taskId: "task-1" });
    const body = payload(result);

    // "I could not check" is NOT a success: the payload used to say
    // success:true next to verified:false and "delete not confirmed".
    expect(body.success).toBe(false);
    expect(body.verified).toBe(false);
    expect(result.isError).toBe(true);
    expect(body.verificationUnavailable).toMatch(/cardId/);
    expect(body.message).toMatch(/pass cardId/);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("update_task without cardId does not claim success either", async () => {
    mocks.patch.mockResolvedValue({ item: task("task-1", "renamed") });

    const result = await updateTaskTool.handler({
      taskId: "task-1",
      name: "renamed",
    });
    const body = payload(result);

    expect(body.success).toBe(false);
    expect(body.verified).toBe(false);
    expect(result.isError).toBe(true);
    // The returned fields are Planka's echo of the PATCH, and say so.
    expect(body.taskFromWriteEcho).toBe(true);
    expect(body.verificationUnavailable).toMatch(/cardId/);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("manage_labels delete: the label is still on the board", async () => {
    mocks.del.mockResolvedValue({ item: label });
    mocks.get.mockResolvedValue(boardBody({ labels: [label], lists: [] }));

    const result = await manageLabelsTool.handler({
      action: "delete",
      labelId: "label-1",
    });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("manage_lists delete: the list is still on the board", async () => {
    mocks.del.mockResolvedValue({ item: list });
    mocks.get.mockResolvedValue(boardBody({ labels: [], lists: [list] }));

    const result = await manageListsTool.handler({
      action: "delete",
      listId: "list-1",
    });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("manage_comment delete: the comment is still on the card", async () => {
    mocks.del.mockResolvedValue({ item: comment });
    mocks.get.mockResolvedValue({ items: [comment], included: { users: [] } });

    const result = await manageCommentTool.handler({
      action: "delete",
      commentId: "comment-1",
    });

    expect(payload(result).verified).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("delete_attachment: the attachment is still on the card", async () => {
    mocks.del.mockResolvedValue({ item: attachment });
    mocks.get.mockResolvedValue(cardBody({}, { attachments: [attachment] }));

    const result = await deleteAttachmentTool.handler({
      attachmentId: "attachment-1",
    });

    const body = payload(result);
    expect(body.verified).toBe(false);
    // The cardId came from the delete body, no extra argument needed.
    expect(body.cardId).toBe("card-1");
    expect(result.isError).toBe(true);
  });

  it("delete_attachment: gone from the card is a real success", async () => {
    mocks.del.mockResolvedValue({ item: attachment });
    mocks.get.mockResolvedValue(cardBody({}, { attachments: [] }));

    const result = await deleteAttachmentTool.handler({
      attachmentId: "attachment-1",
      cardId: "card-1",
    });

    expect(payload(result).verified).toBe(true);
    expect(result.isError).toBeUndefined();
  });
});
