# Troubleshooting

Match the symptom first. Each entry gives the observed behavior, the real cause, and
the fix.

## “The agent says the card has no comments, but I can see comments”

**Cause:** the old MCP reads `included.comments` from the card response. Planka 2.x
does not populate it, so HTTP succeeds with zero items.

**Fix:** make sure Claude Code runs this fork, restart Claude Code, and call
`planka_get_comments` again. Run the opt-in smoke test if the result is still
suspicious; it compares MCP output to `GET /api/cards/:id/comments`.

## “It says the label was added, but the card has no label”

**Cause:** the old tool schema knows `addLabelIds` but silently drops `labelIds`.

**Fix:** use this fork. It accepts both names and re-reads the card. Treat any result
with a non-empty `failed` array as an error.

## “Removing a label returns 404, or the label remains”

**Cause:** Planka 2.x deletes by `labelId:<labelId>` criteria, not by the ID of the
card-label junction record.

**Fix:** upgrade to this fork and pass the board label ID in `removeLabelIds`:

```json
{
  "cardId": "<CARD_ID>",
  "removeLabelIds": ["<LABEL_ID>"]
}
```

## “`planka_get_board` fails because one color is invalid”

**Cause:** the old response schema has a closed color enum. One newer Planka color
causes Zod to reject the entire board.

**Fix:** use this fork. Read paths accept backend color strings. Write paths still
validate known colors.

## “My credential is expired,” but the password works in the browser

**Cause:** `http://` redirects to `https://`. The authentication POST body can be
lost in the redirect, and the final response is HTML instead of the expected JSON
token.

**Fix:** set `PLANKA_BASE_URL` to the final HTTPS origin:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
```

Run `./scripts/setup.sh` again. It validates `POST /api/access-tokens` before writing
anything and calls out redirect/HTML responses directly.

## “Board not found” while creating a card, list, or label

**Cause:** Planka can answer 404 when the agent user lacks write permission. Instance
administrator access alone is not the same as board write access.

**Fix:** give the agent user both:

1. project manager access when it must create boards or manage project-level state;
2. board membership with role `editor` for card, list, label, task, and comment
   writes.

The board-membership route in Planka 2.x is:

```text
POST /api/boards/<BOARD_ID>/board-memberships
```

with a body containing `userId` and `role: "editor"`.

## “Creating a list returns `E_MISSING_OR_INVALID_PARAMS`”

**Cause:** Planka 2.x requires `type` as well as `name` and `position`. Older MCP
builds omit it.

**Fix:** use this fork. `planka_manage_lists` sends `type: "active"` by default and
also accepts `closed`.

## “The MCP tools do not appear in Claude Code”

**Cause:** MCP configuration is loaded at session startup. A project-scoped
`.mcp.json` may also be waiting for workspace trust and explicit approval.

**Fix:** close and restart Claude Code, approve the project when prompted, then run:

```bash
claude mcp list
claude mcp get planka
```

Inside Claude Code, `/mcp` shows connection details. A project server waiting for
approval appears as pending rather than connected.

## “`claude mcp add` says the server already exists”

**Cause:** a previous local or user-scoped entry has the same name.

**Fix:** `setup.sh` removes and recreates the user-scoped `planka` entry
idempotently. To do it manually:

```bash
claude mcp remove planka --scope user
claude mcp add --scope user --transport stdio planka -- \
  "$HOME/.local/bin/planka-mcp"
```

## “The smoke test says it was skipped”

**Cause:** the real smoke test is opt-in and one of its four environment variables is
missing.

**Fix:** set all required values and choose a writable board:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="<BOARD_ID>"
npm run test:smoke
```

The test creates and deletes a temporary card. Do not point it at a board where the
agent user must be read-only.

## “Authentication returns HTTP 502 or another HTML error page”

**Cause:** the reverse proxy or Planka service is unavailable. This is different from
an invalid JSON token response even though both can look like HTML to a client.

**Fix:** restore the Planka service, verify the final HTTPS URL in a browser, and
rerun setup. The setup script does not write configuration after failed validation.

## “Conflicting Planka credentials”

`PLANKA_API_KEY` is set **and** so is `PLANKA_AGENT_EMAIL` / `PLANKA_AGENT_PASSWORD`.
This is refused on purpose rather than guessed: Planka reads `Authorization`
first and ignores `x-api-key` whenever both headers arrive, so a stale password
would keep working and the key you thought was in use would be dead weight.

Pick one. Keep `PLANKA_API_KEY` and delete the email/password pair from the
client configuration — that is the whole point of moving to a key.

## “Missing Planka credentials”

The server has a `PLANKA_BASE_URL` but nothing to authenticate with. Set either
`PLANKA_API_KEY` (see *Authentication* in the README) **or** both
`PLANKA_AGENT_EMAIL` and `PLANKA_AGENT_PASSWORD`.

If you meant to use a key: it can only be issued by a Planka **admin**, with
`POST /api/users/<USER_ID>/api-key`, and the plaintext value appears exactly
once in `included.apiKey` of that response. There is no way to read it back
afterwards — Planka stores only the hash and the prefix. Issue a new one.

## “boardId X is not in PLANKA_ALLOWED_BOARD_IDS”

The board allowlist is doing its job. Either the agent picked the wrong id, or
the board legitimately belongs in scope and the operator should add it to
`PLANKA_ALLOWED_BOARD_IDS` (ids, comma-separated — names are not accepted, since
any editor can rename a board).

Remember the allowlist also filters `planka_get_structure`: if a board is missing
from the structure, it is either outside the allowlist or outside the Planka
user's board memberships. The second one is checked by Planka and answers 404.

## “boardId is required … PLANKA_DEFAULT_BOARD_ID is not set”

A tool was called without `boardId` and there is no default configured. Either
pass the id, or set `PLANKA_DEFAULT_BOARD_ID` — with it, `boardId` disappears
from every tool's `required` list and the default is used whenever the argument
is omitted.

## “Tool … is disabled / this server runs in read-only mode”

`PLANKA_DISABLED_TOOLS` or `PLANKA_READ_ONLY=true` switched that tool off. The
tool is also absent from `tools/list`, so an agent hitting this error is usually
working from a cached tool list or from a skill that names the tool by hand:
restarting the client resyncs the list.

Do not retry the call — it will be refused identically. Either the operator
re-enables the tool, or the change gets reported to a human instead of attempted.

## “list … is protected by PLANKA_PROTECTED_LIST_IDS”

A card was about to be created in, or moved into, a column the operator marked as
protected — or the column itself was about to be edited or deleted. This is a
client-side guard-rail, not a Planka permission (Planka has no per-list rights):
it exists so an agent does not close its own work. A human can still do it in the
Planka UI.

## “No project with id … is visible to this account”

`planka_get_structure` was given a `projectId` that this account cannot see. The
error lists the projects that *are* visible. Two causes, in order of likelihood:
the id belongs to a board rather than a project, or the Planka user has no board
membership inside that project. `PLANKA_ALLOWED_PROJECT_IDS` produces a different
message that names the variable.
