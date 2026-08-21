# Tools reference

The server exposes exactly 15 tools. Tool results are MCP text content containing
formatted JSON. On an expected Planka error, the result has `isError: true` and a
human-readable message instead of a false success.

## Before your first call

- All Planka IDs are strings, even when they contain only digits.
- Discover IDs with `planka_get_structure` and `planka_get_board`.
- Dates use ISO 8601, for example `2026-09-01T17:00:00.000Z`.
- Omit optional fields you do not want to change. Use `null` only where the schema
  explicitly allows it.
- Destructive tools really delete data. Ask for confirmation in your agent prompt
  when that matters.

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

Only `listId` and `name` are required. The result reports `tasksCreated`,
`labelsAttached`, and any individual `labelErrors`.

### `planka_get_card`

Reads full card details, including tasks, comments, labels, and attachments.

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

### `planka_move_card`

Moves a card to a list and optionally assigns its numeric position.

```json
{
  "cardId": "5234567890123456789",
  "listId": "6234567890123456789",
  "position": 65536
}
```

If `position` is omitted, Planka decides the final position.

### `planka_delete_card`

Permanently deletes a card.

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

### `planka_update_task`

Renames a task, changes completion, or does both.

```json
{
  "taskId": "7234567890123456789",
  "name": "Add and run a regression test",
  "isCompleted": true
}
```

### `planka_delete_task`

Deletes one checklist task.

```json
{
  "taskId": "7234567890123456789"
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

Writes validate colors against the Planka 2.x palette. Run
`planka_get_board` to see colors already in use. Unknown colors are accepted on
reads so one new upstream color cannot break the whole board response.

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

### `planka_get_comments`

Reads the dedicated comment collection for one card.

```json
{
  "cardId": "5234567890123456789"
}
```

This does not rely on `included.comments`, which is empty in affected Planka 2.x
responses even when the card has comments.

## Lists

### `planka_manage_lists`

Creates, updates, or deletes a board list. Creation sends an explicit Planka 2.x
list `type`; it defaults to `active`.

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

## Raw verification

Unit tests validate schemas and request construction without a network. The opt-in
smoke test starts the built MCP server over stdio and independently queries the raw
Planka API after every mutation:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="2234567890123456789"
npm run build
npm run test:smoke
```

It creates a uniquely named temporary card, adds and removes a label, writes and
re-reads a comment, deletes the card, and verifies that cleanup reached raw Planka
state. Use a writable non-critical board.
