import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client.js")>();
  return {
    ...actual,
    plankaClient: { get: mocks.get, post: mocks.post, patch: mocks.patch },
  };
});

import {
  archiveCardTool,
  duplicateCardTool,
  moveListCardsTool,
} from "../../src/tools/card-ops.js";

const parse = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text);

const ARCHIVE_ID = "1828711734106391560";

function card(overrides: Record<string, unknown> = {}) {
  return {
    id: "card-1",
    boardId: "board-1",
    listId: "list-1",
    name: "Card one",
    position: 65536,
    ...overrides,
  };
}

/** The board show, reduced to what the archive resolution reads. */
function boardShow() {
  return {
    item: { id: "board-1" },
    included: {
      lists: [
        { id: "list-1", name: "🧊 Pendientes", type: "active" },
        { id: ARCHIVE_ID, name: null, type: "archive" },
        { id: "trash-1", name: null, type: "trash" },
      ],
    },
  };
}

/** A list show with N cards, which is how a bulk move is counted. */
function listWith(count: number) {
  return { item: { id: "list-x" }, included: { cards: Array.from({ length: count }) } };
}

describe("planka_duplicate_card", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
  });

  it("copies, re-reads the copy and reports what it carries", async () => {
    mocks.post.mockResolvedValue({ item: card({ id: "card-2", name: "Card one (copia)" }) });
    mocks.get.mockResolvedValue({
      item: card({ id: "card-2", name: "Card one (copia)" }),
      included: {
        cardMemberships: [{ id: "m", cardId: "card-2", userId: "u-1" }],
        cardLabels: [{ labelId: "l-1" }],
        taskLists: [{}],
        tasks: [{}, {}],
        attachments: [],
      },
    });

    const payload = parse(await duplicateCardTool.handler({ cardId: "card-1" }));

    expect(mocks.post).toHaveBeenCalledWith("/api/cards/card-1/duplicate", {
      position: 65536,
    });
    expect(payload).toMatchObject({
      success: true,
      verified: true,
      card: { id: "card-2", listId: "list-1" },
      copied: { tasks: 2, labels: 1, members: 1, attachments: 0 },
    });
  });

  it("is an error when the copy did not land in the requested column", async () => {
    mocks.post.mockResolvedValue({ item: card({ id: "card-2" }) });
    mocks.get.mockResolvedValue({ item: card({ id: "card-2", listId: "list-1" }) });

    const result = await duplicateCardTool.handler({
      cardId: "card-1",
      listId: "list-9",
    });

    expect(result.isError).toBe(true);
    expect(parse(result).verified).toBe(false);
  });

  it("refuses a cross-board copy without a target column", async () => {
    const result = await duplicateCardTool.handler({
      cardId: "card-1",
      boardId: "board-2",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/needs the column/);
  });
});

describe("planka_archive_card", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
  });

  it("finds the board's archive column and proves the card landed there", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: card() }) // before
      .mockResolvedValueOnce(boardShow()) // archive list resolution
      .mockResolvedValueOnce({
        // after: position goes null, isClosed stays false
        item: card({ listId: ARCHIVE_ID, position: null, isClosed: false }),
      });
    mocks.patch.mockResolvedValue({ item: card({ listId: ARCHIVE_ID }) });

    const payload = parse(await archiveCardTool.handler({ cardId: "card-1" }));

    expect(mocks.patch).toHaveBeenCalledWith("/api/cards/card-1", {
      listId: ARCHIVE_ID,
    });
    expect(payload).toMatchObject({
      success: true,
      verified: true,
      archived: true,
      archiveListId: ARCHIVE_ID,
      previousListId: "list-1",
    });
    expect(payload.message).toContain("list-1");
  });

  it("is an error when the card is still in its column afterwards", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: card() })
      .mockResolvedValueOnce(boardShow())
      .mockResolvedValueOnce({ item: card() }); // never moved
    mocks.patch.mockResolvedValue({ item: card() });

    const result = await archiveCardTool.handler({ cardId: "card-1" });

    expect(result.isError).toBe(true);
    expect(parse(result).verified).toBe(false);
  });

  it("says the card is already archived instead of moving it again", async () => {
    mocks.get
      .mockResolvedValueOnce({
        item: card({ listId: ARCHIVE_ID, position: null, prevListId: "list-1" }),
      })
      .mockResolvedValueOnce(boardShow());

    const payload = parse(await archiveCardTool.handler({ cardId: "card-1" }));

    expect(mocks.patch).not.toHaveBeenCalled();
    expect(payload.alreadyArchived).toBe(true);
    expect(payload.message).toContain("list-1");
  });

  it("restores a card with a position, which Planka demands", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: card({ listId: ARCHIVE_ID, position: null }) })
      .mockResolvedValueOnce({ item: card({ listId: "list-1" }) });
    mocks.patch.mockResolvedValue({ item: card({ listId: "list-1" }) });

    const payload = parse(
      await archiveCardTool.handler({ cardId: "card-1", restoreToListId: "list-1" })
    );

    // Without `position` Planka answers "Position must be present": an
    // archived card has position null.
    expect(mocks.patch).toHaveBeenCalledWith("/api/cards/card-1", {
      listId: "list-1",
      position: 65536,
    });
    expect(payload).toMatchObject({
      verified: true,
      archived: false,
      restoredTo: "list-1",
      previousListId: ARCHIVE_ID,
    });
  });

  it("explains itself when the board exposes no archive column", async () => {
    mocks.get
      .mockResolvedValueOnce({ item: card() })
      .mockResolvedValueOnce({
        item: { id: "board-1" },
        included: { lists: [{ id: "list-1", name: "🧊", type: "active" }] },
      });

    const result = await archiveCardTool.handler({ cardId: "card-1" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no list of type "archive"/);
  });
});

describe("planka_move_list_cards", () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
    mocks.patch.mockReset();
  });

  it("counts both columns before and after", async () => {
    mocks.get
      .mockResolvedValueOnce(listWith(3)) // from, before
      .mockResolvedValueOnce(listWith(5)) // to, before
      .mockResolvedValueOnce(listWith(0)) // from, after
      .mockResolvedValueOnce(listWith(8)); // to, after
    mocks.post.mockResolvedValue({ item: {}, included: {} });

    const payload = parse(
      await moveListCardsTool.handler({ fromListId: "list-a", toListId: "list-b" })
    );

    expect(mocks.post).toHaveBeenCalledWith("/api/lists/list-a/move-cards", {
      listId: "list-b",
    });
    expect(payload).toMatchObject({
      success: true,
      verified: true,
      moved: 3,
      fromRemaining: 0,
      toTotal: 8,
    });
  });

  it("reports verified: false when the counts do not add up", async () => {
    mocks.get
      .mockResolvedValueOnce(listWith(3))
      .mockResolvedValueOnce(listWith(5))
      .mockResolvedValueOnce(listWith(1)) // one card stayed behind
      .mockResolvedValueOnce(listWith(7));
    mocks.post.mockResolvedValue({ item: {}, included: {} });

    const result = await moveListCardsTool.handler({
      fromListId: "list-a",
      toListId: "list-b",
    });
    const payload = parse(result);

    expect(result.isError).toBe(true);
    expect(payload.verified).toBe(false);
    expect(payload).toMatchObject({ moved: 2, fromRemaining: 1, expectedTotal: 8 });
  });

  it("does not call Planka for an empty column", async () => {
    mocks.get.mockResolvedValueOnce(listWith(0)).mockResolvedValueOnce(listWith(4));

    const payload = parse(
      await moveListCardsTool.handler({ fromListId: "list-a", toListId: "list-b" })
    );

    expect(mocks.post).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ verified: true, moved: 0, toTotal: 4 });
  });

  it("refuses moving a column into itself", async () => {
    const result = await moveListCardsTool.handler({
      fromListId: "list-a",
      toListId: "list-a",
    });
    expect(result.isError).toBe(true);
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
