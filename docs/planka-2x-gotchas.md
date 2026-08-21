# Planka 2.x compatibility gotchas

The older published package can fail without throwing. That is worse than a loud
error because an agent may make a workflow decision from false state.

This fork fixes four known incompatibilities and verifies the dangerous writes.

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

## Related Planka 2.x traps

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

`npm run test:smoke` starts the built MCP server and then:

1. reads the selected board through MCP;
2. creates a temporary card through MCP;
3. adds and removes a label through MCP;
4. checks both states against the raw board API;
5. writes and re-reads a comment through MCP and raw API;
6. deletes the card through MCP and confirms raw absence;
7. removes any temporary label created by the test.

This is the regression defense for silent failures.
