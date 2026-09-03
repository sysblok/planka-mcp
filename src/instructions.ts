/**
 * Server instructions sent in the `initialize` handshake
 * (`InitializeResult.instructions`).
 *
 * Both runtimes we care about read this field: Claude Code injects it into the
 * session system prompt, Codex CLI uses it as guidance alongside the tool list.
 * It is therefore a FIXED per-session cost, paid on top of `tools/list`.
 *
 * Two constraints drive the shape of the text:
 *
 * 1. The spec says instructions "should not duplicate information already in
 *    tool descriptions". So the prose shared by many tools lives here once, and
 *    each `description` keeps only what is specific to that tool.
 * 2. Some clients truncate. The first paragraph (< 512 chars) must stand on its
 *    own: what the server is, how to open a session, where IDs come from.
 *
 * Budget: 1500-2500 chars, hard ceiling 3000. Anything longer belongs in docs
 * or in an MCP resource, not here. `tests/unit/instructions.test.ts` enforces it.
 */
export const SERVER_INSTRUCTIONS = `Planka MCP reads and writes a Planka 2.x kanban board. Open every session with planka_board_summary: one call returns each column with its card count, every label, and the cards awaiting a decision. Never call planka_get_board, which dumps the whole board. Narrow from the summary: planka_list_lists for a board's shape, planka_list_cards for one column, planka_find_cards to search, planka_get_card for one card. Every ID is a string of digits and is never guessed.

IDs come from planka_get_structure or planka_board_summary. They look alike, so passing a label ID where a list ID belongs answers "Resource not found" rather than a type error.

Before acting on a card, read ALL of its comments with planka_get_comments. The description says how the card was born; the comments say where it stands today, and the last one usually wins. Skipping them means redoing work or repeating a discarded attempt.

Reads return digests, not full records: descriptions are off unless you ask (withDescription), results are capped (limit, offset), and every scoped read reports total/returned/hasMore/nextOffset so a clipped answer is never mistaken for a complete one. Ask for the detail only once you know which card you want.

Text search (query/search) matches card name and description, case- and accent-insensitive. Several tokens are ANDed, all must match. A leading "/" makes the rest a regular expression.

Writes re-read what they touched and report what actually landed. Trust the verified and finalLabelIds fields of the response, not the arguments you sent; a request that returns without them did not confirm anything.

Planka answers 404 where it means 403. A "not found" on a write, with an ID that read fine a moment ago, is almost always a missing permission for the agent user, not a wrong ID.`;
