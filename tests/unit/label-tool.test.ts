import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  setCardLabels: vi.fn(),
  createLabel: vi.fn(),
  updateLabel: vi.fn(),
  deleteLabel: vi.fn(),
}));

vi.mock("../../src/operations/labels.js", () => mocks);

import { setCardLabelsTool } from "../../src/tools/labels.js";

describe("planka_set_card_labels", () => {
  beforeEach(() => mocks.setCardLabels.mockReset());

  it("merges and deduplicates labelIds with addLabelIds", async () => {
    mocks.setCardLabels.mockResolvedValue({
      added: ["label-1", "label-2"],
      alreadyPresent: [],
      removed: [],
      notPresent: [],
      failed: [],
      finalLabelIds: ["label-1", "label-2"],
    });

    const result = await setCardLabelsTool.handler({
      cardId: "card-1",
      labelIds: ["label-1", "label-2"],
      addLabelIds: ["label-1"],
    });

    expect(mocks.setCardLabels).toHaveBeenCalledWith(
      "card-1",
      ["label-1", "label-2"],
      []
    );
    expect(result.isError).toBeUndefined();
  });

  it("fails loudly when the request contains no label operation", async () => {
    const result = await setCardLabelsTool.handler({ cardId: "card-1" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/nothing to do/i);
  });
});
