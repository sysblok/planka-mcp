# Tools reference

The server exposes exactly 24 tools. Tool results are MCP text content containing
JSON (minified — the indentation was pure token cost). On an expected Planka
error, the result has `isError: true` and a human-readable message instead of a
false success.

## Every write is verified

A `200` from Planka proves the request was accepted, not that the change is in
the database. So every write re-reads the entity and reports what LANDED, never
what was asked for. The response fields:

| Field | Meaning |
|---|---|
| `verified: true` | A re-read confirmed the change. This is the only real success. |
| `verified: false` + `isError` | The re-read contradicted the write, or the write could not be checked. Do not assume the write failed: read before retrying. |
| `verificationError` | The re-read itself failed. The write may or may not have landed. |
| `verificationUnavailable` | Verification was structurally impossible (a task or attachment whose card is unknown). Not an error, but not a proven success either. |
| `partialFailure` | A follow-up step failed (`planka_create_card` only). The card id is always present anyway. |
| `notLanded` | The fields, or the list, that the re-read says did not change. |

Verification costs one extra read per write — a card read for cards, tasks,
comments and attachments, and a board read for labels and lists.

## Before your first call

- All Planka IDs are strings, even when they contain only digits.
- Discover IDs with `planka_get_structure`, `planka_list_lists`, or
  `planka_get_board`.
- Reading a whole board is the expensive call. When you only need one column,
  one label, or the shape of the board, use a [scoped read](#scoped-reads).
- Dates use ISO 8601, for example `2026-09-01T17:00:00.000Z`.
- Omit optional fields you do not want to change. Use `null` only where the schema
  explicitly allows it.
- Destructive tools really delete data. Ask for confirmation in your agent prompt
  when that matters.

## Server instructions and annotations

Two things travel with `tools/list` and the `initialize` handshake, so a client
gets them without installing anything.

**Server instructions.** The `initialize` result carries an `instructions`
string (~1.8 kB). Claude Code injects it into the session system prompt and
Codex CLI reads it alongside the tool list. It holds the guidance that is shared
by many tools and therefore does not belong in any single description: open a
session with `planka_board_summary` and never `planka_get_board`, IDs are
strings of digits taken from `planka_get_structure` or `planka_board_summary`,
read every comment on a card before acting on it, reads return digests with
`total`/`returned`/`hasMore`, writes report `verified` and `finalLabelIds`, and
Planka answers `404` where it means `403`. The MCP spec asks that instructions
not duplicate tool descriptions, which is why the descriptions below are short.
Source: `src/instructions.ts`, budget enforced at 1500-2500 characters by
`tests/unit/instructions.test.ts`.

**Tool annotations.** Every tool publishes a `title` and all four behavioural
hints, spelled out rather than left to the spec defaults — which are pessimistic
(`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
`openWorldHint: true`) and would make `planka_get_comments` look as dangerous as
`planka_delete_card`. `openWorldHint` is `false` everywhere: the domain is one
configured Planka instance, not the open web.

| Group | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
|---|---|---|---|
| Reads (`get_*`, `list_*`, `find_cards`, `board_summary`) | `true` | `false` | `true` |
| Additive writes (`create_card`, `create_tasks`, `add_comment`, `add_attachment`) | `false` | `false` | `false` |
| Converging writes (`move_card`, `update_task`) | `false` | `false` | `true` |
| Data-losing writes (`update_card`, `set_card_labels`, every `delete_*`, `manage_comment`) | `false` | `true` | `true` |
| Multi-action managers (`manage_labels`, `manage_lists`) | `false` | `true` | `false` |

**Anthropic `_meta`.** Claude Code does not gate permissions on the standard
hints; it reads two `_meta` keys instead, and the server ships both:

- `anthropic/requiresUserInteraction: true` forces the permission prompt even
  under an `allow` rule — set on `planka_delete_card`, `planka_delete_task`,
  `planka_delete_attachment`, `planka_manage_comment`, `planka_manage_lists` and
  `planka_manage_labels`. The last three are marked whole because one of their
  actions deletes: a list takes its cards with it, a label disappears from every
  card that carried it.
- `anthropic/maxResultSizeChars: 4500000` on `planka_view_attachment`, so a
  base64 image up to 3 MB is not clipped by the default per-tool ceiling.

The map lives in `src/tools/annotations.ts`. A tool with no entry there fails
`tests/unit/annotations.test.ts`, and the same file pins the order of
`tools/list` so clients that cache it see a stable payload.

## Navigation

### `planka_get_structure`

Lists the project → board → list hierarchy visible to the agent user. Pass an
empty object to inspect everything:

```json
{}
```

Or restrict it to one project:

```json
{
  "projectId": "1234567890123456789"
}
```

### `planka_get_board`

Reads one board with its labels, lists, cards, and optional checklist counts.

```json
{
  "boardId": "2234567890123456789",
  "includeTaskCounts": true
}
```

Set `includeTaskCounts` to `false` for a smaller response. Labels include their
raw `color` string; reads intentionally accept colors added by newer Planka versions.

## Scoped reads

`planka_get_board` returns the whole board: every card, every description, every
label link. That is the right call when you really need all of it, and an
expensive one when you do not. The four tools in this section answer narrower
questions and return proportionally less text.

Measured against one real board holding 100 cards, in characters of tool
response:

| Call | Response size | Compared to `planka_get_board` |
|---|---|---|
| `planka_get_board` | 44,449 | baseline |
| `planka_list_lists` | 1,147 | 39x smaller |
| `planka_board_summary` | 2,737 | 16x smaller |
| `planka_find_cards` filtered by label | 2,421 | 18x smaller |
| `planka_find_cards` filtered by text | 795 | 56x smaller |

The gap widens as the board grows, because only `planka_get_board` grows with
the number of cards.

Which one to reach for:

| Question | Tool |
|---|---|
| What columns does this board have, and how full is each one? | `planka_list_lists` |
| What is on this board and what should I pick up first? | `planka_board_summary` |
| What is in this one column? | `planka_list_cards` |
| Which cards carry this label, or mention this text? | `planka_find_cards` |
| I need every card with every field, in one object | `planka_get_board` |

All four report how much they clipped (`total`, `returned`, `hasMore`,
`nextOffset`), so a partial answer is never mistaken for a complete one.

### `planka_list_lists`

Lists the columns of a board with the number of cards in each one, and no cards
at all. Use it to see the shape of a board before deciding which column to open.

```json
{
  "boardId": "2234567890123456789"
}
```

`planka_get_structure` returns the same column names but not the counts.
Archive and trash lists are excluded, because they are not board columns.

### `planka_board_summary`

One call that describes a board well enough to start working: every column with
its card count, every label, and the cards sitting in the column or columns that
are waiting on a decision. Cards already carrying the unblocking label are sorted
first and marked `highlighted: true`.

```json
{
  "boardId": "2234567890123456789",
  "cardsFrom": [
    "blocked"
  ],
  "highlightLabel": "ready",
  "limit": 50
}
```

Every field except `boardId` is optional, and the defaults are opinionated:

| Field | Default | What the default does |
|---|---|---|
| `cardsFrom` | `["decision", "decide", "blocked", "bloquead"]` | Picks the columns whose names contain one of these fragments |
| `highlightLabel` | `"decidido"` | Marks cards carrying a label with that exact name |
| `limit` | `50` | Caps returned cards; maximum `200` |

Those defaults come from the board layout this server was written against, which
is why one of them is Spanish. They are matching hints, not a requirement: pass
your own values and the tool behaves exactly the same on an English board.

```json
{
  "boardId": "2234567890123456789",
  "cardsFrom": [
    "blocked",
    "needs review"
  ],
  "highlightLabel": "approved"
}
```

`cardsFrom` entries match either an exact list ID or a fragment of a column
name, ignoring case and accents. `highlightLabel` must match a label name
exactly, again ignoring case and accents. The response echoes the columns it
actually selected in `cardsFrom` and the label it used in `highlightLabel`, so a
hint that matched nothing is visible instead of silent.

Card payload is deliberately minimal: `id`, `name`, `list`, `labels`. Follow up
with `planka_get_card` for one card rather than `planka_get_board` for all of
them.

### `planka_list_cards`

Reads the cards of one column: `id`, `name`, labels, checklist counts, and due
date. Descriptions are off by default because they are the expensive field.

```json
{
  "listId": "3234567890123456789",
  "limit": 25,
  "offset": 0
}
```

Filter the column by label name, or ask for description previews:

```json
{
  "listId": "3234567890123456789",
  "labelFilter": "ready",
  "withDescription": true,
  "limit": 50
}
```

| Field | Default | Notes |
|---|---|---|
| `withLabels` | `true` | Resolving label names costs one extra board read |
| `withDescription` | `false` | Adds a 200-character preview per card |
| `labelFilter` | none | Exact label name, case- and accent-insensitive; implies `withLabels` |
| `limit` | `25` | Maximum `200` |
| `offset` | `0` | Pass the previous response's `nextOffset` to page |

`limit` and `offset` clip the response, not the request: Planka's own list
endpoint accepts neither, so the server resolves the whole column through
Planka's cursor and pages the output. That is what makes `total` honest. If
pagination stops before the column is exhausted, the response carries
`truncated: true` and a note saying so.

Get list IDs from `planka_list_lists` or `planka_get_structure`.

### `planka_find_cards`

Searches a board's cards by label, by text, or by column, and returns only the
matches.

Sweep every card carrying a label:

```json
{
  "boardId": "2234567890123456789",
  "labelName": "ready"
}
```

Check whether a card about something already exists, before creating a
duplicate:

```json
{
  "boardId": "2234567890123456789",
  "query": "export timeout",
  "withDescription": true
}
```

Filters combine, and at least one of `labelName`, `query`, or `listId` is
required; an unfiltered search would just be a slower `planka_get_board`.

| Field | Default | Notes |
|---|---|---|
| `labelName` | none | Exact label name, case- and accent-insensitive |
| `query` | none | Substring matched against card name **and** description, case- and accent-insensitive |
| `listId` | none | Restricts the search to one column |
| `withDescription` | `false` | Adds a 200-character preview per match |
| `limit` | `25` | Maximum `200` |
| `offset` | `0` | Pass the previous response's `nextOffset` to page |

If the board has no label with the requested name, the response still succeeds
and carries a `warning` naming the labels that do exist. The same happens for a
`listId` that is not on the board.

## Cards

### `planka_create_card`

Creates a card. Tasks and labels are optional follow-up writes performed by the
same tool.

```json
{
  "listId": "3234567890123456789",
  "name": "Verify the export flow",
  "description": "Reproduce the timeout and record the expected result.",
  "tasks": [
    "Create a large sample",
    "Run the export",
    "Record the duration"
  ],
  "dueDate": "2026-09-01T17:00:00.000Z",
  "labelIds": [
    "4234567890123456789"
  ]
}
```

Only `listId` and `name` are required.

The result reports `tasksRequested` / `tasksCreated` and `labelsRequested` /
`labelsAttached` **counted from a re-read of the card**, plus `finalLabelIds`.
If a follow-up step fails the card is still created: `card.id` always comes
back, together with `partialFailure` (`tasks`, `tasksMissing`, `labelIds`) and
`isError`. Never retry a `planka_create_card` that errored without reading the
id it returned — that is how boards grow duplicates. Every label failing is an
error, not a `success: true` with zero labels.

### `planka_get_card`

Reads full card details, including tasks, comments, labels, and attachments.
If the comments endpoint fails, the tool ERRORS: it never reports an empty
comment list it could not actually read.

```json
{
  "cardId": "5234567890123456789"
}
```

### `planka_update_card`

Updates only the fields present in the request.

```json
{
  "cardId": "5234567890123456789",
  "name": "Verify and document the export flow",
  "description": "Timeout reproduced. Add the accepted duration to the docs.",
  "dueDate": null,
  "isCompleted": false
}
```

Use `null` to clear `description` or `dueDate`.

Passing only `cardId` is rejected (`nothing to do`): an empty PATCH used to
answer `success: true` without changing anything. The result re-reads the card
and lists in `notLanded` any field that did not actually change.

### `planka_move_card`

Moves a card to a list and optionally assigns its numeric position.

```json
{
  "cardId": "5234567890123456789",
  "listId": "6234567890123456789",
  "boardId": "2234567890123456789",
  "position": 65536
}
```

If `position` is omitted, the card goes to the end of the list. `boardId` is
only for moving a card to another board, and the `listId` must belong to it.

The card is re-read: if it did not end up in the requested list the result is
`verified: false` + `isError`, with the list it is actually in.

### `planka_delete_card`

Permanently deletes a card, with its tasks, comments and attachments. The
deletion is confirmed by re-reading the card: a 404 is the proof, and anything
else comes back as `verified: false` + `isError`.

```json
{
  "cardId": "5234567890123456789"
}
```

## Checklist tasks

### `planka_create_tasks`

Adds one or more checklist tasks to a card.

```json
{
  "cardId": "5234567890123456789",
  "tasks": [
    "Add a regression test",
    "Update the operator notes"
  ]
}
```

The result reports `tasksCreated` counted from a re-read of the card, not from
the request.

### `planka_update_task`

Renames a task, changes completion, or does both. Passing only `taskId` is
rejected (`nothing to do`).

```json
{
  "taskId": "7234567890123456789",
  "cardId": "5234567890123456789",
  "name": "Add and run a regression test",
  "isCompleted": true
}
```

`cardId` is optional but strongly recommended: Planka has no GET for a single
task, so the card is the only place the change can be verified. Without it the
result carries `verificationUnavailable` instead of a proven success.

### `planka_delete_task`

Deletes one checklist task. Same rule: pass `cardId` to have the deletion
confirmed against the card.

```json
{
  "taskId": "7234567890123456789",
  "cardId": "5234567890123456789"
}
```

## Labels

### `planka_manage_labels`

Creates, updates, or deletes a board label. The `action` determines which IDs
are required.

Create:

```json
{
  "action": "create",
  "boardId": "2234567890123456789",
  "name": "needs-decision",
  "color": "berry-red"
}
```

Update:

```json
{
  "action": "update",
  "labelId": "4234567890123456789",
  "name": "decision-needed",
  "color": "pumpkin-orange"
}
```

Delete:

```json
{
  "action": "delete",
  "labelId": "4234567890123456789"
}
```

`color` is a real JSON Schema `enum` of the 43 Planka 2.x colors, so a bad
color is rejected before the call leaves the client. Unknown colors are still
accepted on reads, so one new upstream color cannot break a board response.
Run `planka_board_summary` to see the colors already in use.

Every action is verified against a re-read of the board's labels: `update` with
only `labelId` is rejected (`nothing to do`), and a `delete` whose label is
still on the board comes back as `verified: false` + `isError`.

### `planka_set_card_labels`

Adds and removes labels, then re-reads the card and reports the verified final
state. `labelIds` is a supported alias for `addLabelIds`; if both are provided,
their values are merged.

```json
{
  "cardId": "5234567890123456789",
  "addLabelIds": [
    "4234567890123456789"
  ],
  "labelIds": [
    "8234567890123456789"
  ],
  "removeLabelIds": [
    "9234567890123456789"
  ]
}
```

The response distinguishes requested, added, removed, already present, already
absent, failed, and final label IDs. This makes silent no-op writes visible.

## Comments

### `planka_add_comment`

Adds a Markdown-capable comment through Planka 2.x's dedicated card action
endpoint.

```json
{
  "cardId": "5234567890123456789",
  "text": "Verification complete: unit tests and the manual export both passed."
}
```

The comment is re-read from the card before the tool reports success.

### `planka_get_comments`

Reads the dedicated comment collection for one card.

```json
{
  "cardId": "5234567890123456789"
}
```

This does not rely on `included.comments`, which is empty in affected Planka 2.x
responses even when the card has comments.

### `planka_manage_comment`

Edits or deletes an existing comment. Get comment IDs from
`planka_get_comments`.

Update:

```json
{
  "action": "update",
  "commentId": "1034567890123456789",
  "text": "Verification complete: unit tests and the manual export both passed."
}
```

Delete:

```json
{
  "action": "delete",
  "commentId": "1034567890123456789"
}
```

`text` is required for `update` and ignored for `delete`. Planka only lets the
authenticated user modify comments that user wrote, so an agent can correct its
own notes but not someone else's. Both actions re-read the card's comments
before reporting: an edit that did not stick, or a comment still present after
its delete, comes back as `verified: false` + `isError`.

## Lists

### `planka_manage_lists`

Creates, updates, or deletes a board list (column). Creation sends an explicit
Planka 2.x list `type`; it defaults to `active`.

> **DESTRUCTIVE — `delete` takes the cards with it.** Deleting a list deletes
> every card inside it, and Planka does not ask. Move the cards out first (see
> `planka_move_card`), or delete a column you created yourself. This cannot be
> undone.

Every action is verified against a re-read of the board: `update` with only
`listId` is rejected (`nothing to do`), and a `delete` whose list is still on
the board comes back as `verified: false` + `isError`.

Create:

```json
{
  "action": "create",
  "boardId": "2234567890123456789",
  "name": "Pending",
  "position": 65536,
  "type": "active"
}
```

Update:

```json
{
  "action": "update",
  "listId": "3234567890123456789",
  "name": "Ready",
  "position": 131072,
  "type": "active"
}
```

Delete:

```json
{
  "action": "delete",
  "listId": "3234567890123456789"
}
```

Only `active` and `closed` are accepted for list writes. Internal Planka list
types such as archive and trash remain readable.

## Attachments

Attachments carry the evidence a card needs to be understood later: a
screenshot of the bug, a before/after pair, a failing console. Prefer a code
block in a comment for stack traces, diffs, and logs; an image of text is
harder to read and impossible to search.

### `planka_add_attachment`

Uploads a local file to a card, then re-reads the card's attachments to confirm
it landed. The response carries `verified`, and the result is flagged as an
error when the re-read does not find the upload.

```json
{
  "cardId": "5234567890123456789",
  "filePath": "/home/user/screenshots/export-timeout.png",
  "name": "before-export-timeout.png"
}
```

`filePath` must be an absolute path on the machine running the MCP server.
`name` is optional and defaults to the file's basename; descriptive names such
as `before-...`, `after-...`, or `console-error-...` are worth the extra field.
The content type is derived from the extension, with `application/octet-stream`
as the fallback. A missing file returns `File not found: <path>` instead of an
opaque failure.

### `planka_get_attachments`

Lists what a card holds: `id`, `name`, `type`, `mimeType`, `size`, download
`url`, and `createdAt`.

```json
{
  "cardId": "5234567890123456789"
}
```

### `planka_view_attachment`

Returns an attachment's content rather than its metadata.

```json
{
  "cardId": "5234567890123456789",
  "attachmentId": "1134567890123456789"
}
```

`attachmentId` is optional when the card has exactly one attachment. With more
than one and no ID, the tool refuses and lists the available IDs and names
instead of guessing.

What comes back depends on the content type:

| Content type | Result |
|---|---|
| `image/*`, except `image/svg+xml` | MCP image content, so a model with vision actually sees it. Limited to 3 MB; larger images return the download URL instead |
| `text/*`, `application/json`, `image/svg+xml` | Inline text, clipped at 50 KB and marked `[truncated to 50KB]` when clipped |
| Anything else | Metadata and the download URL, with a note that it cannot be rendered inline |

### `planka_delete_attachment`

Permanently deletes one attachment.

```json
{
  "attachmentId": "1134567890123456789",
  "cardId": "5234567890123456789"
}
```

`cardId` is optional: Planka normally echoes the deleted attachment (which
carries its card), and that is what makes the deletion verifiable. Pass it when
you have it; if neither is available the result says
`verificationUnavailable` rather than claiming success.

## When arguments are wrong

Invalid input is reported as an error result naming the tool, the field, what
the schema expected, and what actually arrived. Three cases are distinguished
on purpose, because the right correction differs.

A required field that never arrived is caught before the handler runs:

```text
Invalid arguments for planka_create_tasks: missing required field(s): tasks.
  - tasks (array) — Task names to create
Required fields for planka_create_tasks: cardId, tasks
Arguments received: {"cardId":"5234567890123456789"}
```

A field that arrived with the wrong shape or value reports the received value
alongside the field's declared type and description:

```text
Invalid arguments for planka_find_cards:
  - (whole arguments object): give at least one filter: labelName, query or listId (an unfiltered search would return the whole board) (received: {"boardId":"2234567890123456789"})
Required fields for planka_find_cards: boardId
Arguments received: {"boardId":"2234567890123456789"}
```

A response from Planka that does not match the expected shape is labelled as
such, so it is not mistaken for a bad argument:

```text
PLANKA returned an unexpected response shape while running planka_get_board.
This is an API/server mismatch, not a problem with the arguments:
  - item.name: Expected string, received null
```

Long values are clipped in these messages. An unknown tool name is answered with
the list of tools the server actually exposes.

## Raw verification

Unit tests validate schemas, request construction, and error formatting without a
network: run them with `npm test`.

The opt-in smoke test is the other half. It starts the built MCP server over stdio,
drives all 24 tools through real MCP calls, and independently queries the raw
Planka HTTP API after every mutation, so a tool that reports success on something
that never landed is caught here. It runs 64 named checks.

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="2234567890123456789"
npm run test:smoke
```

`npm run test:smoke` builds first, so it cannot silently test a stale `dist/`.

| Variable | Required | What it does |
|---|---|---|
| `PLANKA_BASE_URL` | yes | Planka origin, the same one the MCP client uses |
| `PLANKA_AGENT_EMAIL` | yes | Agent account email or username |
| `PLANKA_AGENT_PASSWORD` | yes | Agent account password |
| `PLANKA_SMOKE_BOARD_ID` | yes | Board to run against. Use a writable, non-critical board |
| `PLANKA_SMOKE_LIST_ID` | no | Column where the scratch card is created. Without it, the test picks a scratch-looking column, falling back to the first one |
| `PLANKA_SMOKE_FAIL_AFTER` | no | Injects a failure after check `<n>`, to prove that cleanup still runs. Use it to verify the safety net, not the tools |
| `PLANKA_MCP_ENTRY` | no | Server entry point. Defaults to `dist/index.js` |
| `VERBOSE` | no | Set to `1` to print each check's payload |

Everything the test creates is prefixed and deleted in a `finally`, and on
`SIGINT`/`SIGTERM` too. Cleanup goes over raw HTTP on purpose: when a signal kills
the test process, the MCP server child dies with it, so the safety net cannot
depend on the thing under test.

Exit codes: `0` all checks passed, `1` a check failed, `2` a configuration
problem.
