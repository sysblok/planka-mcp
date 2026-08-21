import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ post: vi.fn() }));

vi.mock("../../src/client.js", () => ({
  plankaClient: { post: mocks.post },
}));

import { createList } from "../../src/operations/lists.js";

describe("createList", () => {
  beforeEach(() => mocks.post.mockReset());

  it("sends the required Planka 2.x list type", async () => {
    mocks.post.mockResolvedValue({
      item: {
        id: "list-1",
        boardId: "board-1",
        name: "Pending",
        position: 65536,
        type: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: null,
      },
    });

    await createList({ boardId: "board-1", name: "Pending" });
    expect(mocks.post).toHaveBeenCalledWith("/api/boards/board-1/lists", {
      name: "Pending",
      position: 65536,
      type: "active",
    });
  });
});
