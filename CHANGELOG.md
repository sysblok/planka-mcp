# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added

- **API key authentication.** `PLANKA_API_KEY` sends `X-Api-Key` on every
  request — JSON calls, multipart uploads and binary attachment downloads alike
  — with no login round-trip and no token refresh. It also sidesteps Planka's
  sign-in rate limit of ten logins per identity per minute, which several agents
  starting at once will otherwise hit. Configuration is now API key XOR
  email/password: setting both is refused rather than guessed, because Planka
  reads `Authorization` first and silently ignores `x-api-key` when both arrive.
- **Access policy driven by environment variables**, in `src/config/policy.ts`:
  `PLANKA_DEFAULT_BOARD_ID`, `PLANKA_ALLOWED_BOARD_IDS`,
  `PLANKA_ALLOWED_PROJECT_IDS`, `PLANKA_READ_ONLY`, `PLANKA_DISABLED_TOOLS` and
  `PLANKA_PROTECTED_LIST_IDS`. Allowlists are by id, never by name: a name is one
  edit away from being someone else's.
- **`boardId` is now optional** on every tool that takes one, whenever
  `PLANKA_DEFAULT_BOARD_ID` is configured. It is removed from the tool's
  `required` list and the description says where the default comes from, so an
  agent stops calling `planka_get_structure` just to recover an id that never
  changes.
- **`PLANKA_READ_ONLY` and `PLANKA_DISABLED_TOOLS` hide tools and refuse them.**
  Hidden tools disappear from `tools/list`, and calling one anyway returns an
  error that names the variable responsible and says not to retry — hiding alone
  is not enough for a client working from a cached list.
- **Allowlist filtering in `planka_get_structure`**, so an agent never sees the
  boards and projects it may not touch, and a `projectId` that does not exist now
  answers with the visible projects instead of an empty array.
- `server.json`: the new environment variables, plus `title`, `websiteUrl` and
  `icons` for the MCP Registry listing. `PLANKA_AGENT_EMAIL` and
  `PLANKA_AGENT_PASSWORD` are no longer marked required.
- README (English and Spanish): *Authentication* — including the four-step recipe
  for a scoped `boardUser` with an API key — and *Scoping the server*, with the
  three-layer model and the variable matrix. New entries in
  `docs/troubleshooting.md` for every new error message.

### Fixed

- Binary attachment downloads now retry once on a 401 with a fresh token, the way
  every other request already did. Before, an expired token during a download
  surfaced as a bare authentication failure.
- A `200` carrying the SPA's HTML instead of JSON — what Planka answers for any
  path it does not route, and what an `http://` base URL redirected to `https://`
  ends up producing — is now reported as such on every request, not only during
  login.

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
