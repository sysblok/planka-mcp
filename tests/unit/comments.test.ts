import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { get: mocks.get },
}));

import { getCommentsForCard } from "../../src/operations/comments.js";

describe("getCommentsForCard", () => {
  beforeEach(() => mocks.get.mockReset());

  it("uses the dedicated Planka 2.x endpoint and enriches authors", async () => {
    mocks.get.mockResolvedValue({
      items: [
        {
          id: "comment-1",
          cardId: "card-1",
          userId: "user-1",
          text: "Decision",
          createdAt: "2026-01-02T00:00:00.000Z",
          updatedAt: null,
        },
      ],
      included: {
        users: [
          {
            id: "user-1",
            name: "Agent User",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: null,
          },
        ],
      },
    });

    await expect(getCommentsForCard("card-1")).resolves.toMatchObject([
      { id: "comment-1", authorName: "Agent User" },
    ]);
    expect(mocks.get).toHaveBeenCalledWith("/api/cards/card-1/comments");
  });
});
