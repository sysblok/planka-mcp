# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- `src/operations/verify.ts`: `verifiedWrite`, `verifiedDelete` and `goneOn404`,
  the single implementation of "write, re-read, report what landed". Until now
  the pattern lived hand-copied in two places and was missing from eleven writes.
- Every write reports `verified: true|false`, and `isError` when the re-read
  contradicts it or could not be made. New response fields: `verificationError`,
  `verificationUnavailable`, `partialFailure`, `notLanded`.
- `planka_move_card` accepts `boardId`, so a card can finally be moved between
  boards (the operation supported it; the tool did not expose it).
- `planka_update_task`, `planka_delete_task` and `planka_delete_attachment`
  accept an optional `cardId`, which is what makes their verification possible
  (Planka 2.x has no GET for a single task).
- `getCardLight()`: a card read without its comments, used for verification and
  by `planka_set_card_labels`, which was pulling every comment of a card twice
  only to compare label ids.
- 19 unit tests for the false greens: comments endpoint failing, partial task
  creation, deletes that do not delete, no-op PATCHes, a move that did not move,
  and labels that never attached. Suite: 45 → 64 tests.
- Smoke: a REAL move between two columns (temporary column created, card moved
  there and back, both directions cross-checked against the raw API) and
  `verified: true` assertions on every write.

### Changed

- **A `200` is no longer a success.** `planka_create_card`, `planka_update_card`,
  `planka_move_card`, `planka_delete_card`, `planka_create_tasks`,
  `planka_update_task`, `planka_delete_task`, `planka_manage_labels`,
  `planka_add_comment`, `planka_manage_comment`, `planka_manage_lists` and
  `planka_delete_attachment` now re-read before reporting.
- `planka_create_card` counts the tasks and labels **that are on the card**, not
  the ones requested, always returns `card.id` (even when a follow-up step
  fails, so a retry does not duplicate the card), and errors when every
  requested label failed to attach.
- `planka_update_card`, `planka_update_task`, `planka_manage_labels update` and
  `planka_manage_lists update` reject a request carrying only an id
  (`nothing to do`) instead of sending an empty PATCH and reporting success.
- `planka_manage_lists` says in its description and in the docs that deleting a
  list deletes every card in it.
- `PlankaClient.delete()` returns the response body instead of `void`: Planka
  2.x echoes the deleted item, and its parent id is what makes the confirmation
  read possible.
- Label `color` is a real JSON Schema `enum` of the 43 colors instead of a
  sentence in the description, so the client rejects a bad color before the
  call. (Measured: 599 chars against 580 — this is a correctness win, not a
  token saving.)
- Tool payloads are serialized without indentation (`JSON.stringify(x)`),
  27–46 % fewer characters on the read-heavy tools at zero information cost.
- Tool descriptions are shorter. The prose that was repeated across many of them
  — that IDs are strings, that `planka_get_board` is the expensive call, the
  meaning of `total`/`returned`/`hasMore` — now lives in the server
  instructions, as the spec asks. The sum of all descriptions went from 3658 to
  2093 characters; no `inputSchema` changed.
- `getToolDefinitions()` now propagates `title`, `annotations` and `_meta`. It
  previously mapped only name, description and schema, which would have dropped
  them from `tools/list` without any error.

### Fixed

- `planka_get_card` no longer swallows a failing comments endpoint into
  `comments: []`. A 403, a timeout or an HTML answer now surfaces as an error:
  "this card has no comments" and "I could not read them" are different facts,
  and on a board whose memory lives in the comments the difference is expensive.
- Server instructions in the `initialize` handshake
  (`InitializeResult.instructions`, `src/instructions.ts`). Claude Code injects
  them into the session system prompt and Codex CLI reads them alongside the
  tool list, so the guidance shared by many tools is stated once: open with
  `planka_board_summary` and never `planka_get_board`, IDs are strings of digits
  that come from `planka_get_structure` or `planka_board_summary`, read every
  comment on a card before acting, reads return digests with
  `total`/`returned`/`hasMore`, writes report `verified` and `finalLabelIds`,
  and Planka answers `404` where it means `403`. Budgeted at 1500-2500
  characters, with the first 512 self-contained for clients that truncate.
- Tool annotations on all twenty-four tools: a display `title` plus
  `readOnlyHint`, `destructiveHint`, `idempotentHint` and `openWorldHint`, every
  field written out rather than inherited. The spec defaults are pessimistic, so
  without them a conformant client had to treat `planka_get_comments` as being
  as destructive as `planka_delete_card`.
- The two Anthropic `_meta` keys Claude Code actually acts on:
  `anthropic/requiresUserInteraction` on `planka_delete_card`,
  `planka_delete_task`, `planka_delete_attachment`, `planka_manage_comment`,
  `planka_manage_lists` and `planka_manage_labels`, which forces the permission
  prompt even under an `allow` rule; and `anthropic/maxResultSizeChars` on
  `planka_view_attachment`, so a 3 MB base64 image is not clipped.
- Tests that keep all of the above honest: every registered tool must have an
  annotations entry (a new tool without one fails the suite), the tools marked
  as needing confirmation must carry the `_meta` flag, the instructions must fit
  their budget, and `tools/list` must return a fixed, snapshotted tool order.

## [0.2.0] - 2026-08-24

### Added

- Nine tools, bringing the server to twenty-four.
- Attachments: `planka_add_attachment` uploads a local file and re-reads the card
  to confirm it landed, `planka_get_attachments` lists what a card holds,
  `planka_view_attachment` returns content — images as MCP image content up to
  3 MB, text inline up to 50 KB, anything else as metadata and a URL — and
  `planka_delete_attachment` removes one.
- `planka_manage_comment`, to edit or delete an existing comment.
- Scoped reads that answer a narrower question than `planka_get_board` and return
  proportionally less text: `planka_list_lists` (columns and card counts),
  `planka_board_summary` (columns, labels, and the cards awaiting a decision),
  `planka_list_cards` (one column, paginated), and `planka_find_cards` (search by
  label, text, or column). Measured on a board of 100 cards, they return between
  16 and 56 times less than `planka_get_board`.
- Honest clipping on every scoped read: `total`, `returned`, `hasMore`, and
  `nextOffset`, so a partial answer is never mistaken for a complete one.
- Actionable input errors. A rejected call now names the tool, the field, the
  declared type and description, what was expected, and what actually arrived.
  Missing required fields are caught before the handler runs, and a Planka
  response that does not match the expected shape is labelled as an API mismatch
  rather than an argument problem.
- Diagnosis for a project ID passed where a board ID belongs. Both are strings of
  digits, and Planka answers the mistake with a bare 404. The server now resolves
  it automatically when the project has exactly one board, and otherwise explains
  what the ID is and lists the boards it could have meant.
- Documentation for the smoke test's optional environment variables:
  `PLANKA_SMOKE_LIST_ID` and `PLANKA_SMOKE_FAIL_AFTER`, which injects a failure to
  prove the cleanup path still runs.

### Changed

- The smoke test grew from a first-failure abort over seven tools to 64 named
  checks covering all twenty-four end to end, each write cross-checked against the
  raw Planka HTTP API. Cleanup runs in a `finally` and on `SIGINT`/`SIGTERM`, over
  raw HTTP so the safety net does not depend on the component under test.
- `npm run test:smoke` builds first, so it can no longer test a stale `dist/`.
- Internal operation signatures take a single input object everywhere, validated
  through one shared path. No tool payload changed.

### Fixed

- Long columns truncated in silence. `GET /api/lists/:id/cards` pages at 50 and
  ignores `?limit=`; its cursor is composite (`before[id]` plus
  `before[listChangedAt]`). A column of 77 cards returned 50 with no indication
  that 27 were missing. The cursor is now followed, and a read that still could
  not be completed reports `truncated: true` instead of looking complete.

## [0.1.0] - 2026-08-21

### Identity

- Working repository name: `planka-mcp`.
- Working npm identity: `@omnicoreos/planka-mcp`.
- `project.identity.json` is the source of truth for repository, package, binary,
  MCP Registry, and repository URL names. After changing it, run
  `npm run sync:identity`.

### Added

- Fifteen stdio MCP tools for Planka projects, boards, cards, tasks, comments,
  labels, and lists.
- Guided macOS/Linux setup with authentication validation, board selection,
  optional board bootstrap, Claude Code configuration, and real smoke verification.
- Unit tests for schemas, parsing, request construction, the dedicated comments
  endpoint, label criteria deletion, label aliases, list creation, and bootstrap
  idempotency.
- Opt-in smoke test that executes MCP tools and verifies every mutation against the
  raw Planka API before deleting its temporary card.
- Optional board, director/worker, and worktree methodology.
- English and Spanish documentation.

### Fixed from upstream

- Empty comments on Planka 2.x.
- Whole-board failures caused by new label colors.
- Silent no-op `labelIds` requests.
- Incorrect label-removal URL.
- Missing `type` in list creation.
- Internal `archive` and `trash` list types rejected on board reads.
