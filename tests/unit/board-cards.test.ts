import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { get: mocks.get },
}));

import { getCardsForList } from "../../src/operations/boards.js";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

function card(index: number) {
  return {
    id: `card-${index}`,
    boardId: "board-1",
    listId: "list-1",
    name: `Card ${index}`,
    type: "project",
    position: index,
    listChangedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    ...timestamps,
  };
}

const page = (from: number, count: number) => ({
  items: Array.from({ length: count }, (_, i) => card(from + i)),
  included: {},
});

describe("getCardsForList", () => {
  beforeEach(() => mocks.get.mockReset());

  it("follows Planka's composite cursor instead of stopping at 50 cards", async () => {
    mocks.get
      .mockResolvedValueOnce(page(1, 50))
      .mockResolvedValueOnce(page(51, 27));

    const result = await getCardsForList({ listId: "list-1", withLabels: false });

    expect(result.cards).toHaveLength(77);
    expect(result.truncated).toBe(false);
    expect(mocks.get).toHaveBeenNthCalledWith(1, "/api/lists/list-1/cards");
    expect(mocks.get.mock.calls[1][0]).toBe(
      "/api/lists/list-1/cards?before%5Bid%5D=card-50&before%5BlistChangedAt%5D=2026-01-01T00%3A00%3A50.000Z"
    );
  });

  it("reports truncation instead of silently dropping cards", async () => {
    mocks.get.mockResolvedValue({
      items: Array.from({ length: 50 }, (_, i) => ({
        ...card(i + 1),
        listChangedAt: null,
      })),
      included: {},
    });

    const result = await getCardsForList({ listId: "list-1", withLabels: false });
    expect(result.cards).toHaveLength(50);
    expect(result.truncated).toBe(true);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("stops after one page when the list is shorter than a page", async () => {
    mocks.get.mockResolvedValueOnce(page(1, 3));
    const result = await getCardsForList({ listId: "list-1", withLabels: false });
    expect(result.cards).toHaveLength(3);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
