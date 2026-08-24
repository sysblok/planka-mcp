import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../../src/client.js", () => ({
  plankaClient: { delete: mocks.delete, post: mocks.post },
}));

vi.mock("../../src/operations/cards.js", () => ({
  getCard: vi.fn(),
}));

import {
  addLabelToCard,
  removeLabelFromCard,
} from "../../src/operations/labels.js";

describe("Planka 2.x card-label requests", () => {
  beforeEach(() => {
    mocks.delete.mockReset();
    mocks.post.mockReset();
  });

  it("deletes labels with Planka criteria syntax", async () => {
    mocks.delete.mockResolvedValue(undefined);
    await removeLabelFromCard({ cardId: "card-1", labelId: "label-1" });
    expect(mocks.delete).toHaveBeenCalledWith(
      "/api/cards/card-1/card-labels/labelId:label-1"
    );
  });

  it("adds labels with the board label id", async () => {
    mocks.post.mockResolvedValue({
      item: {
        id: "card-label-1",
        cardId: "card-1",
        labelId: "label-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: null,
      },
    });
    await addLabelToCard({ cardId: "card-1", labelId: "label-1" });
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/cards/card-1/card-labels",
      { labelId: "label-1" }
    );
  });
});
