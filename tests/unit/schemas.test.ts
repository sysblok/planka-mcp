import { describe, expect, it } from "vitest";
import {
  CardSchema,
  LabelColorSchema,
  LabelSchema,
  ListSchema,
  UserSchema,
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

  it("accepts Planka internal list types on read paths", () => {
    for (const type of ["archive", "trash"]) {
      expect(
        ListSchema.parse({
          id: `list-${type}`,
          boardId: "board-1",
          name: null,
          position: null,
          type,
          ...timestamps,
        }).type
      ).toBe(type);
    }
  });

  it("accepts imported rows with no creator or username", () => {
    // Cards and users migrated from other trackers come back with these
    // fields set to null, not omitted.
    expect(
      CardSchema.parse({
        id: "card-1",
        boardId: "board-1",
        listId: "list-1",
        creatorUserId: null,
        name: "Imported",
        position: 65536,
        type: "project",
        ...timestamps,
      }).creatorUserId
    ).toBeNull();
    expect(
      UserSchema.parse({ id: "user-1", username: null, name: "Imported", ...timestamps })
        .username
    ).toBeNull();
  });
});
