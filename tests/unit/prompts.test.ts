import { describe, expect, it } from "vitest";
import { PROMPTS, getPrompt, listPrompts } from "../../src/prompts.js";

describe("prompts/list", () => {
  it("exposes the three session prompts with unique names", () => {
    const names = listPrompts().map((prompt) => prompt.name);
    expect(names).toEqual([
      "planka-open-session",
      "planka-close-card",
      "planka-board-triage",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("describes every argument and marks only cardId as required", () => {
    for (const prompt of listPrompts()) {
      expect(prompt.description).toBeTruthy();
      for (const argument of prompt.arguments) {
        expect(argument.description).toBeTruthy();
        expect(typeof argument.required).toBe("boolean");
      }
    }
    const required = PROMPTS.flatMap((prompt) =>
      prompt.arguments.filter((a) => a.required).map((a) => `${prompt.name}.${a.name}`)
    );
    expect(required).toEqual(["planka-close-card.cardId"]);
  });
});

describe("prompts/get", () => {
  it("returns one user message of text", () => {
    const result = getPrompt("planka-open-session");
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content.type).toBe("text");
    expect(result.messages[0].content.text.length).toBeGreaterThan(100);
  });

  it("steers every prompt to the cheap reads and away from get_board", () => {
    for (const prompt of PROMPTS) {
      const text = prompt.render({ cardId: "1" });
      // get_board may only appear as a prohibition, never as a suggestion.
      for (const match of text.matchAll(/.{0,20}planka_get_board/g)) {
        expect(match[0]).toContain("Do not call ");
      }
    }
    expect(getPrompt("planka-open-session").messages[0].content.text).toContain(
      "planka_board_summary"
    );
    expect(getPrompt("planka-board-triage").messages[0].content.text).toContain(
      "planka_find_cards"
    );
  });

  it("uses the boardId when given and stays generic when not", () => {
    const withBoard = getPrompt("planka-open-session", { boardId: "123" });
    expect(withBoard.messages[0].content.text).toContain("on board 123");
    const without = getPrompt("planka-open-session");
    expect(without.messages[0].content.text).not.toContain("on board");
    expect(without.messages[0].content.text).toContain("planka_get_structure");
  });

  it("interpolates the card and asks before moving when no list is given", () => {
    const asked = getPrompt("planka-close-card", { cardId: "42" });
    expect(asked.messages[0].content.text).toContain("card 42");
    expect(asked.messages[0].content.text).toContain("ask me before moving");
    const told = getPrompt("planka-close-card", { cardId: "42", listId: "7" });
    expect(told.messages[0].content.text).toContain("planka_move_card to list 7");
  });

  it("refuses a missing required argument by name", () => {
    expect(() => getPrompt("planka-close-card")).toThrow(
      "Prompt planka-close-card needs: cardId."
    );
  });

  it("names the alternatives for an unknown prompt", () => {
    expect(() => getPrompt("nope")).toThrow(/Unknown prompt: nope\. Available:/);
  });
});
