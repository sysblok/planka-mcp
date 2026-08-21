import { describe, expect, it } from "vitest";
import {
  LabelColorSchema,
  LabelSchema,
  ListSchema,
} from "../../src/schemas/entities.js";
import {
  CreateCardSchema,
  CreateListSchema,
} from "../../src/schemas/requests.js";

const timestamps = {
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: null,
};

describe("Planka 2.x schemas", () => {
  it("accepts backend label colors that the client does not know", () => {
    const label = LabelSchema.parse({
      id: "label-1",
      boardId: "board-1",
      name: "Future",
      color: "a-future-planka-color",
      position: 65536,
      ...timestamps,
    });

    expect(label.color).toBe("a-future-planka-color");
  });

  it("accepts the current Planka 2.x french-coast color on writes", () => {
    expect(LabelColorSchema.parse("french-coast")).toBe("french-coast");
  });

  it("adds Planka 2.x defaults when constructing cards and lists", () => {
    expect(CreateCardSchema.parse({ listId: "list-1", name: "First card" }))
      .toMatchObject({ position: 65536, type: "project" });
    expect(CreateListSchema.parse({ boardId: "board-1", name: "Pending" }))
      .toMatchObject({ position: 65536, type: "active" });
  });

  it("parses both active and closed list types", () => {
    for (const type of ["active", "closed"] as const) {
      expect(
        ListSchema.parse({
          id: `list-${type}`,
          boardId: "board-1",
          name: type,
          position: 65536,
          type,
          ...timestamps,
        }).type
      ).toBe(type);
    }
  });
});
