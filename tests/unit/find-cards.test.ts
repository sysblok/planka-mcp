import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { get: mocks.get },
}));

import { findCards, makeMatcher } from "../../src/operations/boards.js";
import { findCardsTool, listCardsTool, listListsTool } from "../../src/tools/queries.js";
import { getBoardTool, getStructureTool } from "../../src/tools/navigation.js";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-02-02T00:00:00.000Z",
};

const lists = [
  {
    id: "list-todo",
    boardId: "board-1",
    name: "🧊 Pendientes",
    position: 100,
    type: "active",
    ...timestamps,
  },
  {
    id: "list-done",
    boardId: "board-1",
    name: "Merged",
    position: 200,
    type: "closed",
    ...timestamps,
  },
];

const labels = [
  {
    id: "label-go",
    boardId: "board-1",
    name: "decidido",
    color: "berry-red",
    position: 1,
    ...timestamps,
  },
  {
    id: "label-voice",
    boardId: "board-1",
    name: "zona:voz",
    color: "navy-blue",
    position: 2,
    ...timestamps,
  },
];

const cards = [
  {
    id: "card-1",
    boardId: "board-1",
    listId: "list-todo",
    name: "Ship the webhook",
    type: "project",
    position: 1,
    description: "x".repeat(500),
    commentsTotal: 4,
    ...timestamps,
  },
  {
    id: "card-2",
    boardId: "board-1",
    listId: "list-todo",
    name: "Rename the queue",
    type: "project",
    position: 2,
    dueDate: "2026-12-31T12:00:00.000Z",
    ...timestamps,
  },
  {
    id: "card-3",
    boardId: "board-1",
    listId: "list-done",
    name: "Old work",
    type: "project",
    position: 1,
    ...timestamps,
  },
];

const cardLabels = [
  { id: "cl-1", cardId: "card-1", labelId: "label-go", ...timestamps },
  { id: "cl-2", cardId: "card-2", labelId: "label-voice", ...timestamps },
];

const cardMemberships = [
  { id: "cm-1", cardId: "card-1", userId: "user-1", ...timestamps },
];

const users = [
  { id: "user-1", name: "Pablo", ...timestamps },
  { id: "user-2", name: "Agent", ...timestamps },
];

const taskLists = [
  { id: "tl-1", cardId: "card-1", name: "Checks", position: 1, ...timestamps },
];

const tasks = [
  {
    id: "t-1",
    taskListId: "tl-1",
    name: "one",
    position: 1,
    isCompleted: true,
    ...timestamps,
  },
  {
    id: "t-2",
    taskListId: "tl-1",
    name: "two",
    position: 2,
    isCompleted: false,
    assigneeUserId: "user-2",
    ...timestamps,
  },
];

const boardPayload = {
  item: {
    id: "board-1",
    projectId: "project-1",
    name: "Web",
    position: 65536,
    ...timestamps,
  },
  included: {
    lists,
    labels,
    cards,
    cardLabels,
    cardMemberships,
    taskLists,
    tasks,
    users,
  },
};

/** GET /api/lists/:id — the list show: every card of ONE column, no cursor. */
const listShowPayload = {
  item: lists[0],
  included: {
    cards: cards.filter((c) => c.listId === "list-todo"),
    cardLabels,
    cardMemberships,
    taskLists,
    tasks,
    users,
  },
};

function route(path: string) {
  if (path === "/api/lists/list-todo") return listShowPayload;
  if (path.startsWith("/api/boards/")) return boardPayload;
  if (path === "/api/projects") {
    return {
      items: [
        {
          id: "project-1",
          name: "OmnicoreOS",
          ...timestamps,
        },
      ],
      included: { boards: [boardPayload.item] },
    };
  }
  throw new Error(`unexpected GET ${path}`);
}

const text = (result: { content: { text: string }[] }) =>
  JSON.parse(result.content[0].text);

describe("findCards on the list path", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation(async (path: string) => route(path));
  });

  it("reads one column with the list show: one page, honest total", async () => {
    const result = await findCards({ listId: "list-todo" });

    expect(result.source).toBe("list");
    expect(result.truncated).toBe(false);
    expect(result.excludesArchived).toBeUndefined();
    expect(result.total).toBe(2);
    expect(result.list).toEqual({ id: "list-todo", name: "🧊 Pendientes" });

    // The list show, plus one board read for the label names.
    expect(mocks.get.mock.calls.map((c) => c[0])).toEqual([
      "/api/lists/list-todo",
      "/api/boards/board-1",
    ]);
  });

  it("skips the board read when label names are not wanted", async () => {
    const result = await findCards({ listId: "list-todo", withLabels: false });

    expect(mocks.get).toHaveBeenCalledTimes(1);
    expect(result.labelsResolved).toBe(false);
    expect(result.matches[0].labels).toBeUndefined();
  });

  it("digests a card without repeating the column on every match", async () => {
    const result = await findCards({ listId: "list-todo" });

    expect(result.matches[0]).toEqual({
      id: "card-1",
      labels: ["decidido"],
      members: ["Pablo"],
      name: "Ship the webhook",
      tasks: "1/2",
      commentsTotal: 4,
      updatedAt: timestamps.updatedAt,
    });
    expect(result.labelsResolved).toBe(true);
    // listId/list are not duplicated per card: the column is on the response.
    expect(result.matches[0]).not.toHaveProperty("listId");
    expect(result.matches[0]).not.toHaveProperty("listName");
    expect(result.matches[0]).not.toHaveProperty("description");
  });

  it("returns every field on detail: full", async () => {
    const result = await findCards({ listId: "list-todo", detail: "full" });

    expect(result.matches[0]).toMatchObject({
      id: "card-1",
      listId: "list-todo",
      boardId: "board-1",
      labelIds: ["label-go"],
      position: 1,
      type: "project",
      createdAt: timestamps.createdAt,
    });
    // full means full: the description is not clipped.
    expect(result.matches[0].description).toHaveLength(500);
  });

  it("clips descriptions to descriptionChars, and to nothing by default", async () => {
    const off = await findCards({ listId: "list-todo" });
    expect(off.matches[0].description).toBeUndefined();

    const preview = await findCards({
      listId: "list-todo",
      withDescription: true,
    });
    expect(preview.matches[0].description).toHaveLength(201); // 200 + ellipsis

    const short = await findCards({
      listId: "list-todo",
      descriptionChars: 10,
    });
    expect(short.matches[0].description).toHaveLength(11);
  });

  it("filters by labelIds and by userIds, members or task assignees", async () => {
    await expect(
      findCards({ listId: "list-todo", labelIds: ["label-voice"] })
    ).resolves.toMatchObject({ total: 1, matches: [{ id: "card-2" }] });

    await expect(
      findCards({ listId: "list-todo", userIds: ["user-1"] })
    ).resolves.toMatchObject({ total: 1, matches: [{ id: "card-1" }] });

    // user-2 is nobody's member; it is the assignee of a task on card-1.
    await expect(
      findCards({ listId: "list-todo", userIds: ["user-2"] })
    ).resolves.toMatchObject({ total: 1, matches: [{ id: "card-1" }] });

    await expect(
      findCards({ listId: "list-todo", userIds: ["user-nobody"] })
    ).resolves.toMatchObject({ total: 0 });
  });

  it("accepts labelFilter as an alias of labelName", async () => {
    const byAlias = await findCards({
      listId: "list-todo",
      labelFilter: "DECIDIDO",
    });
    expect(byAlias).toMatchObject({ total: 1, matches: [{ id: "card-1" }] });
  });
});

describe("findCards on the board path", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation(async (path: string) => route(path));
  });

  it("flags that archive and trash are not part of the answer", async () => {
    const result = await findCards({ boardId: "board-1", query: "the" });

    expect(result.source).toBe("board");
    expect(result.excludesArchived).toBe(true);
    expect(result.truncated).toBeUndefined();
  });

  it("names the column on every match when the results span columns", async () => {
    const result = await findCards({ boardId: "board-1", query: "/.*" });

    expect(result.total).toBe(3);
    expect(result.matches.map((m) => m.listName)).toEqual([
      "🧊 Pendientes",
      "🧊 Pendientes",
      "Merged",
    ]);
    // A card carrying no label carries no `labels` key at all.
    expect(result.matches[2]).not.toHaveProperty("labels");
    expect(result.labelsResolved).toBe(true);
  });

  it("resolves listName to a column, and warns when it matches none", async () => {
    const hit = await findCards({ boardId: "board-1", listName: "pendientes" });
    expect(hit.total).toBe(2);
    expect(hit.list).toEqual({ id: "list-todo", name: "🧊 Pendientes" });
    expect(hit.matches[0]).not.toHaveProperty("listName");

    const miss = await findCards({ boardId: "board-1", listName: "probalo" });
    expect(miss.total).toBe(0);
    expect(miss.warnings.join(" ")).toContain("probalo");
    expect(miss.warnings.join(" ")).toContain("Merged");
  });
});

describe("query semantics", () => {
  it("ANDs the tokens, ignoring case and accents", () => {
    const match = makeMatcher("Signing SECRET");
    expect(match("waiting on the signing secret")).toBe(true);
    expect(match("signing only")).toBe(false);
  });

  it("treats a leading slash as a regular expression", () => {
    const match = makeMatcher("/^ship .*hook$");
    expect(match("Ship the webhook")).toBe(true);
    expect(match("hook the ship")).toBe(false);
  });

  it("says the regex is broken instead of matching nothing", () => {
    expect(() => makeMatcher("/[unclosed")).toThrow(
      /Invalid regular expression/
    );
  });
});

describe("aliases and deprecations", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation(async (path: string) => route(path));
  });

  it("planka_list_cards is planka_find_cards with listId", async () => {
    expect(listCardsTool.handler).toBe(findCardsTool.handler);
    expect(listCardsTool.description).toMatch(/Alias of planka_find_cards/);
    expect(listCardsTool.inputSchema.required).toEqual(["listId"]);

    const payload = text(await listCardsTool.handler({ listId: "list-todo" }));
    expect(payload).toMatchObject({ source: "list", truncated: false, total: 2 });
  });

  it("planka_list_lists is planka_board_summary with cardsFrom: []", async () => {
    const payload = text(await listListsTool.handler({ boardId: "board-1" }));

    expect(payload.lists).toEqual([
      { id: "list-todo", name: "🧊 Pendientes", type: "active", cardCount: 2 },
      { id: "list-done", name: "Merged", type: "closed", cardCount: 1 },
    ]);
    expect(payload.totalCards).toBe(3);
    expect(payload.excludesArchived).toBe(true);
    expect(payload).not.toHaveProperty("cards");
  });

  it("planka_get_board says it is deprecated and reports what it clipped", async () => {
    expect(getBoardTool.description).toMatch(
      /^DEPRECATED: use planka_board_summary \+ planka_find_cards/
    );

    const clipped = text(
      await getBoardTool.handler({ boardId: "board-1", limit: 2 })
    );
    expect(clipped).toMatchObject({
      totalCards: 3,
      returnedCards: 2,
      truncated: true,
      excludesArchived: true,
    });
    expect(clipped.lists.flatMap((l: { cards: unknown[] }) => l.cards)).toHaveLength(2);

    const whole = text(await getBoardTool.handler({ boardId: "board-1" }));
    expect(whole.returnedCards).toBe(3);
    expect(whole).not.toHaveProperty("truncated");
  });
});

describe("planka_get_structure", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockImplementation(async (path: string) => route(path));
  });

  it("costs one board read per board when it returns the columns", async () => {
    const payload = text(await getStructureTool.handler({}));

    expect(payload[0].boards[0].lists).toHaveLength(2);
    expect(mocks.get.mock.calls.map((c) => c[0])).toEqual([
      "/api/projects",
      "/api/boards/board-1",
    ]);
  });

  it("answers projects and boards in a single request with withLists: false", async () => {
    const payload = text(await getStructureTool.handler({ withLists: false }));

    expect(payload[0].boards[0]).toEqual({ id: "board-1", name: "Web" });
    expect(mocks.get.mock.calls.map((c) => c[0])).toEqual(["/api/projects"]);
  });
});
