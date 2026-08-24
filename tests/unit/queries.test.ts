import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { get: mocks.get },
}));

import {
  findCards,
  getBoardListCounts,
  getBoardSummary,
  listCards,
} from "../../src/operations/boards.js";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

const boardPayload = {
  item: {
    id: "board-1",
    projectId: "project-1",
    name: "Agent Work",
    position: 65536,
    ...timestamps,
  },
  included: {
    lists: [
      {
        id: "list-decide",
        boardId: "board-1",
        name: "🤔 Necesita tu decisión",
        position: 65536,
        type: "active",
        ...timestamps,
      },
      {
        id: "list-done",
        boardId: "board-1",
        name: "Merged",
        position: 131072,
        type: "closed",
        ...timestamps,
      },
      {
        id: "list-trash",
        boardId: "board-1",
        name: null,
        position: null,
        type: "trash",
        ...timestamps,
      },
    ],
    labels: [
      {
        id: "label-go",
        boardId: "board-1",
        name: "decidido",
        color: "berry-red",
        position: 65536,
        ...timestamps,
      },
    ],
    cards: [
      {
        id: "card-1",
        boardId: "board-1",
        listId: "list-decide",
        name: "Ship the webhook",
        type: "project",
        position: 1,
        description: "Waiting on the signing secret",
        ...timestamps,
      },
      {
        id: "card-2",
        boardId: "board-1",
        listId: "list-decide",
        name: "Rename the queue",
        type: "project",
        position: 2,
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
    ],
    cardLabels: [
      {
        id: "card-label-1",
        cardId: "card-2",
        labelId: "label-go",
        ...timestamps,
      },
    ],
  },
};

describe("scoped board reads", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue(boardPayload);
  });

  it("counts cards per column without returning any card", async () => {
    const result = await getBoardListCounts({ boardId: "board-1" });

    // The nameless trash list is not a board column.
    expect(result.lists).toEqual([
      { id: "list-decide", name: "🤔 Necesita tu decisión", type: "active", cardCount: 2 },
      { id: "list-done", name: "Merged", type: "closed", cardCount: 1 },
    ]);
    expect(result.totalCards).toBe(3);
  });

  it("picks the decision column by name and flags the unblocked cards first", async () => {
    const summary = await getBoardSummary({ boardId: "board-1" });

    expect(summary.cardsFrom).toEqual(["🤔 Necesita tu decisión"]);
    expect(summary.highlightedCount).toBe(1);
    expect(summary.cards[0]).toMatchObject({ id: "card-2", highlighted: true });
    expect(summary.cards.every((card) => card.description === undefined)).toBe(
      true
    );
  });

  it("searches names and descriptions, accent- and case-insensitively", async () => {
    await expect(
      findCards({ boardId: "board-1", query: "SIGNING secret" })
    ).resolves.toMatchObject({ total: 1, matches: [{ id: "card-1" }] });

    await expect(
      findCards({ boardId: "board-1", labelName: "DECIDIDO" })
    ).resolves.toMatchObject({ total: 1, matches: [{ id: "card-2" }] });
  });

  it("says which labels exist when the requested one does not", async () => {
    const result = await findCards({ boardId: "board-1", labelName: "ghost" });
    expect(result.total).toBe(0);
    expect(result.warning).toContain("decidido");
  });

  it("refuses an unfiltered search instead of returning the whole board", async () => {
    await expect(findCards({ boardId: "board-1" })).rejects.toThrow(
      /at least one filter/i
    );
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("reports what it clipped when paginating a list", async () => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({
      items: boardPayload.included.cards.slice(0, 2),
      included: {},
    });

    const first = await listCards({
      listId: "list-decide",
      withLabels: false,
      limit: 1,
    });
    expect(first).toMatchObject({
      total: 2,
      returned: 1,
      offset: 0,
      hasMore: true,
      nextOffset: 1,
    });

    const second = await listCards({
      listId: "list-decide",
      withLabels: false,
      limit: 1,
      offset: 1,
    });
    expect(second).toMatchObject({ returned: 1, hasMore: false });
    expect(second.cards[0].id).not.toBe(first.cards[0].id);
    expect(second.nextOffset).toBeUndefined();
  });
});
