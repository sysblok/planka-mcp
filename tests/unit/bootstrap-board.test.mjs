import { describe, expect, it, vi } from "vitest";
import { bootstrapBoard } from "../../scripts/bootstrap-board.mjs";

function fakeApi({ lists = [], labels = [], cards = [] } = {}) {
  const state = {
    board: { id: "board-1", name: "Agent Work" },
    lists: [...lists],
    labels: [...labels],
    cards: [...cards],
  };
  return {
    state,
    getBoard: vi.fn(async () => ({
      item: state.board,
      included: {
        lists: state.lists,
        labels: state.labels,
        cards: state.cards,
        cardLabels: [],
      },
    })),
    createList: vi.fn(async (boardId, name, position, type) => {
      const item = {
        id: `list-${state.lists.length + 1}`,
        boardId,
        name,
        position,
        type,
      };
      state.lists.push(item);
      return { item };
    }),
    createLabel: vi.fn(async (boardId, name, color, position) => {
      const item = {
        id: `label-${state.labels.length + 1}`,
        boardId,
        name,
        color,
        position,
      };
      state.labels.push(item);
      return { item };
    }),
  };
}

describe("bootstrapBoard", () => {
  it("creates the workflow once and is idempotent on rerun", async () => {
    const api = fakeApi();
    const first = await bootstrapBoard(api, { boardId: "board-1" });
    expect(first).toMatchObject({ listCount: 6, labelCount: 11 });
    expect(api.createList).toHaveBeenCalledTimes(6);
    expect(api.createList).toHaveBeenCalledWith(
      "board-1",
      "Merged",
      393216,
      "closed"
    );
    expect(api.createLabel).toHaveBeenCalledTimes(11);

    const second = await bootstrapBoard(api, { boardId: "board-1" });
    expect(second.createdLists).toEqual([]);
    expect(second.createdLabels).toEqual([]);
    expect(api.createList).toHaveBeenCalledTimes(6);
    expect(api.createLabel).toHaveBeenCalledTimes(11);
  });

  it("refuses to alter an unrelated populated board unless forced", async () => {
    const api = fakeApi({
      lists: [{ id: "list-1", name: "Sales", type: "active" }],
      cards: [{ id: "card-1", listId: "list-1" }],
    });

    await expect(
      bootstrapBoard(api, { boardId: "board-1" })
    ).rejects.toThrow(/not empty.*--force/i);
    expect(api.createList).not.toHaveBeenCalled();
  });
});
