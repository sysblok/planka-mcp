import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS } from "../../src/instructions.js";

/**
 * The instructions are a FIXED per-session cost: every client that reads them
 * pays for them on every conversation, on top of tools/list. The budget is the
 * point of this file.
 */
describe("server instructions", () => {
  it("fits the per-session budget", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeGreaterThanOrEqual(1500);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(2500);
    // Hard ceiling, restated so a future edit cannot quietly raise the range.
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(3000);
  });

  it("opens with a self-contained first 512 characters", () => {
    // Some clients truncate. The head alone has to say what the server is,
    // how to open a session, and where IDs come from.
    const head = SERVER_INSTRUCTIONS.slice(0, 512);
    expect(head).toContain("Planka");
    expect(head).toContain("planka_board_summary");
    expect(head).toContain("planka_get_board");
    expect(head).toMatch(/ID/);
    // The first paragraph must end before the cut.
    const firstBreak = SERVER_INSTRUCTIONS.indexOf("\n\n");
    expect(firstBreak).toBeGreaterThan(0);
    expect(firstBreak).toBeLessThan(512);
  });

  it("carries the house rules that no single tool description can", () => {
    expect(SERVER_INSTRUCTIONS).toContain("planka_get_comments");
    expect(SERVER_INSTRUCTIONS).toContain("Resource not found");
    expect(SERVER_INSTRUCTIONS).toContain("404");
    expect(SERVER_INSTRUCTIONS).toContain("hasMore");
    expect(SERVER_INSTRUCTIONS).toContain("finalLabelIds");
  });

  it("starts and ends without stray whitespace", () => {
    expect(SERVER_INSTRUCTIONS).toBe(SERVER_INSTRUCTIONS.trim());
  });
});
