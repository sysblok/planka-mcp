import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../src/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client.js")>();
  return { ...actual, plankaClient: { get: mocks.get } };
});

import { summarizeAction } from "../../src/operations/actions.js";
import { boardActivityTool, cardHistoryTool } from "../../src/tools/activity.js";

const USER = { id: "user-1", name: "Claude" };

/** An action shaped exactly like Planka 2.2.1 returns one. */
function action(overrides: Record<string, unknown> = {}) {
  return {
    id: "action-1",
    type: "moveCard",
    createdAt: "2026-09-03T02:50:42.309Z",
    boardId: "board-1",
    cardId: "card-1",
    userId: "user-1",
    data: {
      card: { name: "Retirar nginx" },
      fromList: { id: "list-a", name: "🔨 En worktree", type: "active" },
      toList: { id: "list-b", name: "👁 Miralo en main", type: "active" },
    },
    ...overrides,
  };
}

function page(items: unknown[]) {
  return { items, included: { users: [USER] } };
}

const parse = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0].text);

describe("summarizeAction", () => {
  beforeEach(() => mocks.get.mockReset());

  it("writes one human line per event type", () => {
    expect(summarizeAction(action() as never)).toBe(
      'moved the card from "🔨 En worktree" to "👁 Miralo en main"'
    );
    expect(
      summarizeAction(
        action({
          type: "createCard",
          data: { card: { name: "x" }, list: { id: "l", name: "🧊 Pendientes" } },
        }) as never
      )
    ).toBe('created the card in "🧊 Pendientes"');
    expect(
      summarizeAction(
        action({
          type: "addMemberToCard",
          data: { card: { name: "x" }, user: { id: "u", name: "Fede" } },
        }) as never
      )
    ).toBe('added member "Fede"');
    expect(
      summarizeAction(
        action({
          type: "completeTask",
          data: { card: { name: "x" }, task: { id: "t", name: "lint verde" } },
        }) as never
      )
    ).toBe('completed task "lint verde"');
  });

  it("names an unknown event type instead of dropping it", () => {
    expect(summarizeAction(action({ type: "renameCard" }) as never)).toMatch(
      /renameCard/
    );
  });
});

describe("planka_card_history", () => {
  beforeEach(() => mocks.get.mockReset());

  it("returns a digest with resolved user names", async () => {
    mocks.get.mockResolvedValue(page([action(), action({ id: "action-0", type: "createCard", data: { card: { name: "Retirar nginx" }, list: { name: "🧊 Pendientes" } } })]));

    const payload = parse(await cardHistoryTool.handler({ cardId: "card-1" }));

    expect(mocks.get).toHaveBeenCalledWith("/api/cards/card-1/actions");
    expect(payload.returned).toBe(2);
    expect(payload.cardName).toBe("Retirar nginx");
    expect(payload.events[0]).toMatchObject({
      id: "action-1",
      type: "moveCard",
      user: "Claude",
    });
    expect(payload.hasMore).toBe(false);
  });

  it("caps at limit and hands back a cursor", async () => {
    mocks.get.mockResolvedValue(
      page([action({ id: "a3" }), action({ id: "a2" }), action({ id: "a1" })])
    );

    const payload = parse(
      await cardHistoryTool.handler({ cardId: "card-1", limit: 2 })
    );

    expect(payload.returned).toBe(2);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextBeforeId).toBe("a2");
  });

  it("passes beforeId through as the cursor", async () => {
    mocks.get.mockResolvedValue(page([]));
    const payload = parse(
      await cardHistoryTool.handler({ cardId: "card-1", beforeId: "a9" })
    );
    expect(mocks.get).toHaveBeenCalledWith("/api/cards/card-1/actions?beforeId=a9");
    // An empty history must say WHY it can be empty.
    expect(payload.note).toMatch(/comments, renames/);
  });
});

describe("planka_board_activity", () => {
  beforeEach(() => mocks.get.mockReset());

  it("stops at `since` and never reports truncation", async () => {
    mocks.get.mockResolvedValue(
      page([
        action({ id: "a3", createdAt: "2026-09-03T10:00:00.000Z" }),
        action({ id: "a2", createdAt: "2026-09-03T09:00:00.000Z" }),
        action({ id: "a1", createdAt: "2026-09-01T09:00:00.000Z", cardId: "card-2" }),
      ])
    );

    const payload = parse(
      await boardActivityTool.handler({
        boardId: "board-1",
        since: "2026-09-03T00:00:00.000Z",
      })
    );

    expect(payload.returned).toBe(2);
    expect(payload.truncated).toBe(false);
    expect(payload.cardsTouched).toBe(1);
    expect(payload.cards[0].cardId).toBe("card-1");
    expect(payload.cards[0].events).toHaveLength(2);
  });

  it("walks a second page when the first one is full", async () => {
    const full = Array.from({ length: 50 }, (_, index) =>
      action({ id: `p1-${index}`, createdAt: "2026-09-03T10:00:00.000Z" })
    );
    mocks.get
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([action({ id: "p2-0" })]));

    const payload = parse(
      await boardActivityTool.handler({ boardId: "board-1", limit: 200 })
    );

    expect(payload.pagesFetched).toBe(2);
    expect(payload.scanned).toBe(51);
    expect(payload.returned).toBe(51);
    expect(payload.truncated).toBe(false);
    expect(mocks.get).toHaveBeenLastCalledWith(
      "/api/boards/board-1/actions?beforeId=p1-49"
    );
  });

  it("filters by type", async () => {
    mocks.get.mockResolvedValue(
      page([action({ id: "a2" }), action({ id: "a1", type: "createCard" })])
    );

    const payload = parse(
      await boardActivityTool.handler({ boardId: "board-1", types: ["createCard"] })
    );

    expect(payload.returned).toBe(1);
    expect(payload.cards[0].events[0].type).toBe("createCard");
  });

  it("rejects a `since` that is not a date", async () => {
    const result = await boardActivityTool.handler({
      boardId: "board-1",
      since: "yesterday",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/ISO 8601/);
  });
});
