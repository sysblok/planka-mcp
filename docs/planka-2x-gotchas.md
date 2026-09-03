# Planka 2.x compatibility gotchas

The older published package can fail without throwing. That is worse than a loud
error because an agent may make a workflow decision from false state.

This fork fixes five known incompatibilities and verifies the dangerous writes.

## 1. Comments appear empty

**Old behavior:** read `included.comments` from `GET /api/cards/:cardId`.

**Planka 2.x behavior:** comments live at:

```text
GET /api/cards/:cardId/comments
```

The old request returns HTTP 200, but the comments array is absent or empty. The MCP
then reports zero comments without an error. This fork calls the dedicated endpoint
for both `planka_get_comments` and the comments included by `planka_get_card`.

Why it matters: comments often contain the newest decision or closing evidence.

Upstream fix proposed in [PR #5](https://github.com/gogogadgetbytes/planka-mcp/pull/5).

## 2. `labelIds` is silently discarded

**Old schema:** only declared `addLabelIds`.

MCP clients commonly send this natural payload:

```json
{
  "cardId": "<CARD_ID>",
  "labelIds": ["<LABEL_ID>"]
}
```

Unknown properties were discarded during validation. The handler then counted an
empty request and could return a successful result without touching the card.

This fork:

- accepts `labelIds` and `addLabelIds`;
- merges and deduplicates them;
- rejects an empty label operation;
- re-reads the card after the operation;
- returns `added`, `removed`, `alreadyPresent`, `notPresent`, `failed`, and
  `finalLabelIds` from observed state.

## 3. Removing a label uses criteria syntax

The junction record returned by Planka has its own ID, but Planka 2.x deletion is
addressed by label criteria:

```text
DELETE /api/cards/:cardId/card-labels/labelId:<labelId>
```

Deleting by the junction-record ID returns 404 and leaves the label attached. This
fork uses the criteria URL and then verifies the final card state.

## 4. Label colors are an open read contract

Planka adds colors over time. A closed Zod enum on responses means one unfamiliar
color rejects the entire `planka_get_board` response.

This fork uses `z.string()` for label colors returned by Planka. Write paths remain
validated against the currently documented Planka 2.x colors.

Upstream fix proposed in [PR #1](https://github.com/gogogadgetbytes/planka-mcp/pull/1).

## 5. A long column truncates in silence

**Planka 2.x behavior:** `GET /api/lists/:listId/cards` returns at most 50 cards
per page and **ignores `?limit=`**. There is no `total` in the response and no
flag saying more exist.

A column holding 77 cards answers with 50 of them, HTTP 200, and nothing else.
Read as-is, that is a board with 27 cards fewer than it has, and an agent will
happily conclude a card does not exist.

The cursor is **composite**. Both parts are required, and they come from the last
card of the previous page:

```text
GET /api/lists/<LIST_ID>/cards?before[id]=<LAST_CARD_ID>&before[listChangedAt]=<LAST_CARD_listChangedAt>
```

This fork follows that cursor until a page comes back short, capped at 20 pages,
and the page size is **derived from the first response, never assumed**: an
instance answering 20 per page would otherwise stop on page one and report a
third of the column as the whole of it. When pagination stops early, or when the
last card has no `listChangedAt` and no cursor can be built, the result carries
`truncated: true` with a note. It says it did not see everything rather than
pretending it did.

`planka_find_cards` with a `listId` avoids the cursor entirely: `GET
/api/lists/:id` returns **every card of the column in one response**, so the
answer is `truncated: false` by construction and `total` is the real size of the
column. Verified on Planka 2.2.1 against a column of 159 cards — one request
where the cursor needed four.

Why it matters: an incomplete list looks exactly like a complete one.

## 6. The `item` a write returns is not the state of the entity

**Planka 2.x behavior:** a write answers `200` with the item it *thinks* it
wrote, and that echo can disagree with the database.

Measured against Planka 2.2.1:

| Write | What it answers | What is true afterwards |
|---|---|---|
| `PATCH /api/cards/:id {isSubscribed:true}` | `200`, `item.isSubscribed: **null**` | re-reading the card says `true` |
| `POST /api/lists/:id/cards` | `200` with `{item}` and **no `included`** | the card exists, but its tasks/labels are not in the answer |
| `DELETE /api/cards/:id` | `200` with `{item}` of the deleted card | a later `GET` answers `404` JSON — that 404 is the proof |
| `PATCH` with an empty body | `200` with the untouched item | nothing changed |

So a `success: true` built out of the write's own response proves only that the
request was accepted. The empty PATCH is the sharpest case: the tool reported a
change that never happened.

This fork writes and then **re-reads**, and reports `verified: true|false`
(`src/operations/verify.ts`). The DELETE body is kept rather than discarded,
because the deleted item carries the parent id (`cardId`, `boardId`) the
confirmation read needs. Deletes are confirmed either by a 404 on the entity or
by its absence from the parent.

Corollary for tasks: there is no `GET /api/tasks/:id` in 2.x, so a task can only
be verified through its card — which is why `planka_update_task` and
`planka_delete_task` take an optional `cardId` and say
`verificationUnavailable` when it is missing, instead of claiming success.

## 7. Deleting a list deletes its cards

**Planka 2.x behavior:** `DELETE /api/lists/:id` removes the column **and every
card in it**, with no warning and no undo.

The tool description and the docs now say so out loud, and `planka_manage_lists`
confirms the deletion by re-reading the board. There is no server-side guard:
move the cards out first.

## Related Planka 2.x traps

### Board-level card and label endpoints do not exist

These two routes look like they should exist, and they do not:

```text
GET /api/boards/:boardId/cards
GET /api/boards/:boardId/labels
```

Planka does not 404 them. The web server answers with the single-page app's HTML
and **status 200**, so a client that only checks `response.ok` sees a success and
then fails while parsing, or worse, treats the result as an empty collection.

Cards and labels are reachable per list (`GET /api/lists/:listId/cards`) or in
the board payload itself (`GET /api/boards/:boardId`, whose `included` carries
every card, label, and card-label link).

### Per-list `search` and `labelIds` really do filter server-side

Verified against Planka 2.x on 2026-08-24, `GET /api/lists/:listId/cards`
accepts:

- `?search=<text>` — matches the card **name and description**, case-insensitive;
- `?labelIds=<labelId>` — restricts to cards carrying that label.

Both are per list, not per board. Since enumerating a board's columns, or
resolving a label name to its ID, needs a `GET /api/boards/:boardId` anyway, and
that single call already carries every card with its description and label
links, this fork filters board-level searches locally over that one request.
Issuing one search per list would be N extra round-trips for data already in
hand. What stays small in `planka_find_cards` and `planka_board_summary` is the
**output**, which is what a model pays for.

### The board read has no archive and no trash

`GET /api/boards/:id` carries every card of the FINITE lists — the ones typed
`active` or `closed`. The `archive` and `trash` lists come back with
`name: null`, `position: null` and **without a single card**. There is no
parameter to include them, and no `GET /api/boards/:id/cards` to ask again.

So every read built on the board show — `planka_board_summary`,
`planka_find_cards` without a `listId`, `planka_get_board`, `planka_list_lists` —
describes the **visible** board, not everything Planka stores. A card someone
archived is not "gone": it is outside what these tools can see. They all say so
with `excludesArchived: true` rather than letting a zero pass for a fact.

Verified on Planka 2.2.1: a board whose show reports 185 cards across 8 named
columns also carries two nameless lists (`archive`, `trash`) with no cards
attached to them anywhere in the payload.

### A projectId where a boardId goes returns a bare 404

Project IDs and board IDs are both strings of digits. Nothing in either one says
which it is. Passing a project ID to a board tool produces
`GET /api/boards/<projectId>` and a naked `404`, which does not hint that the ID
belongs to a different kind of entity.

This fork diagnoses that 404 before reporting it:

- if the ID is a project with exactly one board, it resolves to that board and
  the call proceeds;
- if it is a project with several boards, the error says so and lists them with
  their IDs and names;
- if it is a project with no boards, the error says that instead;
- if it is neither a project nor a board, the error says so and lists the boards
  the account can actually see.

### Creating lists requires `type`

Planka 2.x requires all three fields:

```json
{
  "name": "Pending",
  "position": 65536,
  "type": "active"
}
```

Valid write types are `active` and `closed`. Board responses can also contain
internal `archive` and `trash` lists; read schemas must tolerate them.

### Creating cards requires a card type

The server sends `type: "project"` by default when creating a card. Callers do not
need to know this Planka-specific requirement.

### Authentication redirects can turn into HTML

Use the final HTTPS origin. An HTTP URL may redirect the authentication POST, lose
its body, and return an HTML page. `setup.sh` uses `redirect: manual` and reports this
case explicitly before writing configuration.

## Why the smoke test uses the raw API

A valid JSON-RPC result proves only that the MCP handler returned. It does not prove
Planka persisted the change.

`npm run test:smoke` builds the server, starts it over stdio, and drives all 24
tools through real MCP calls — 64 named checks. Every write is then cross-checked
against the raw Planka HTTP API: a tool that reports success on something that
never landed fails here. It creates a uniquely prefixed card, list, labels, tasks,
comments, and an attachment, exercises the scoped reads against the sizes the raw
board actually returns, feeds a project ID to a board tool to confirm the 404 gets
explained, and deletes everything it made in a `finally` — over raw HTTP, so
cleanup does not depend on the component under test.

`PLANKA_SMOKE_FAIL_AFTER=<n>` injects a failure after check `n`, which is how the
cleanup path itself is verified.

This is the regression defense for silent failures.
