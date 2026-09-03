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

import { PlankaError } from "../../src/errors.js";
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

  /** A list show: type, board, and the cards it holds. */
  function listShow(type: string, count: number, boardId = "board-1") {
    return {
      item: { id: "list-x", type, boardId },
      included: {
        cards: Array.from({ length: count }, (_, index) => ({
          id: `c-${index}`,
          position: (index + 1) * 65536,
        })),
      },
    };
  }

  it("moves card by card between ordinary columns, never through the bulk endpoint", async () => {
    // Planka's /move-cards only accepts closed -> archive and answers 403
    // "Not enough rights" for an active -> active call. Calling it here is the
    // regression this test exists for.
    mocks.get
      .mockResolvedValueOnce(listShow("active", 3)) // from, before
      .mockResolvedValueOnce(listShow("active", 5)) // to, before
      .mockResolvedValueOnce(listShow("active", 0)) // from, after
      .mockResolvedValueOnce(listShow("active", 8)); // to, after
    mocks.patch.mockResolvedValue({ item: {} });

    const payload = parse(
      await moveListCardsTool.handler({ fromListId: "list-a", toListId: "list-b" })
    );

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).toHaveBeenCalledTimes(3);
    // The position travels so the relative order survives the move.
    expect(mocks.patch).toHaveBeenNthCalledWith(1, "/api/cards/c-0", {
      listId: "list-b",
      position: 65536,
    });
    expect(payload).toMatchObject({
      success: true,
      verified: true,
      strategy: "perCard",
      moved: 3,
      fromRemaining: 0,
      toTotal: 8,
    });
  });

  it("uses Planka's bulk endpoint for the one case it accepts: closed to archive", async () => {
    mocks.get
      .mockResolvedValueOnce(listShow("closed", 2)) // from, before
      .mockRejectedValueOnce(new PlankaError("List not found", "E_NOT_FOUND", 404)) // archive: unreadable
      .mockResolvedValueOnce({
        // board show, to resolve the archive id
        item: { id: "board-1" },
        included: {
          lists: [
            { id: "list-a", name: "Done", type: "closed" },
            { id: ARCHIVE_ID, name: null, type: "archive" },
          ],
        },
      })
      .mockResolvedValueOnce(listShow("closed", 0)) // from, after
      .mockRejectedValueOnce(new PlankaError("List not found", "E_NOT_FOUND", 404)); // archive, after

    mocks.post.mockResolvedValue({ item: {}, included: { cards: [], actions: [] } });

    const payload = parse(
      await moveListCardsTool.handler({ fromListId: "list-a", toListId: ARCHIVE_ID })
    );

    expect(mocks.post).toHaveBeenCalledWith("/api/lists/list-a/move-cards", {
      listId: ARCHIVE_ID,
    });
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      verified: true,
      strategy: "bulk",
      moved: 2,
      fromRemaining: 0,
      toTotal: null,
    });
    expect(payload.toCountUnavailable).toMatch(/cannot be read/);
  });

  it("reports verified: false when the counts do not add up", async () => {
    mocks.get
      .mockResolvedValueOnce(listShow("active", 3))
      .mockResolvedValueOnce(listShow("active", 5))
      .mockResolvedValueOnce(listShow("active", 1)) // one card stayed behind
      .mockResolvedValueOnce(listShow("active", 7));
    mocks.patch.mockResolvedValue({ item: {} });

    const result = await moveListCardsTool.handler({
      fromListId: "list-a",
      toListId: "list-b",
    });
    const payload = parse(result);

    expect(result.isError).toBe(true);
    expect(payload.verified).toBe(false);
    expect(payload).toMatchObject({ moved: 2, fromRemaining: 1, expectedTotal: 8 });
  });

  it("names the card that refused to move instead of shrinking the success", async () => {
    mocks.get
      .mockResolvedValueOnce(listShow("active", 2))
      .mockResolvedValueOnce(listShow("active", 0))
      .mockResolvedValueOnce(listShow("active", 1))
      .mockResolvedValueOnce(listShow("active", 1));
    mocks.patch
      .mockResolvedValueOnce({ item: {} })
      .mockRejectedValueOnce(new PlankaError("Card not found", "E_NOT_FOUND", 404));

    const result = await moveListCardsTool.handler({
      fromListId: "list-a",
      toListId: "list-b",
    });
    const payload = parse(result);

    expect(result.isError).toBe(true);
    expect(payload.failed).toEqual([
      { cardId: "c-1", reason: expect.stringContaining("Card not found") },
    ]);
  });

  it("does not call Planka for an empty column", async () => {
    mocks.get
      .mockResolvedValueOnce(listShow("active", 0))
      .mockResolvedValueOnce(listShow("active", 4));

    const payload = parse(
      await moveListCardsTool.handler({ fromListId: "list-a", toListId: "list-b" })
    );

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.patch).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ verified: true, moved: 0, toTotal: 4 });
  });

  it("explains a source column Planka will not show", async () => {
    mocks.get.mockRejectedValueOnce(
      new PlankaError("List not found", "E_NOT_FOUND", 404)
    );

    const result = await moveListCardsTool.handler({
      fromListId: ARCHIVE_ID,
      toListId: "list-b",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/archive and trash/);
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
