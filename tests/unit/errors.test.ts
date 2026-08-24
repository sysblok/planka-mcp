import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  PlankaError,
  PlankaInputError,
  formatInputError,
  formatMissingArgsError,
  isZodError,
  parseInput,
} from "../../src/errors.js";
import { findMissingRequiredArgs, getTool } from "../../src/tools/index.js";

const schema = z.object({ cardId: z.string().min(1, "cardId is required") });

describe("actionable input errors", () => {
  it("keeps input failures out of the PlankaError catch blocks", () => {
    // Tools catch PlankaError to report API failures. If PlankaInputError were
    // a subclass, every tool would swallow it before the dispatcher could turn
    // it into a message that names the tool and the field.
    const error = new PlankaInputError([], { cardId: "" });
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PlankaError);
    expect(isZodError(error)).toBe(false);
  });

  it("reports the tool, the field, its declared type and what arrived", () => {
    let thrown: unknown;
    try {
      parseInput(schema, { cardId: "" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PlankaInputError);
    const message = formatInputError(
      "planka_get_card",
      thrown as PlankaInputError,
      {
        properties: { cardId: { type: "string", description: "The card ID" } },
        required: ["cardId"],
      }
    );

    expect(message).toContain("Invalid arguments for planka_get_card");
    expect(message).toContain("cardId (string)");
    expect(message).toContain("The card ID");
    expect(message).toContain('received: ""');
    expect(message).toContain("Required fields for planka_get_card: cardId");
  });

  it("names missing required fields before the handler runs", () => {
    const tool = getTool("planka_add_comment");
    expect(tool).toBeDefined();

    const missing = findMissingRequiredArgs(tool!, { cardId: "card-1" });
    expect(missing).toEqual(["text"]);

    const message = formatMissingArgsError(
      "planka_add_comment",
      missing,
      { cardId: "card-1" },
      tool!.inputSchema
    );
    expect(message).toContain("missing required field(s): text");
    expect(message).toContain('Arguments received: {"cardId":"card-1"}');
  });
});
