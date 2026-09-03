# planka-mcp

Control a Planka 2.x board from Claude Code through 24 MCP tools.
Writes are re-read and verified, so a reported success matches the board.
An optional workflow turns that board into durable memory for agent work.

[Leer en español](README.es.md)

```text
You talk to Claude Code
          │
          ▼
  planka-mcp (stdio) ─── HTTPS + JSON ───▶ Planka 2.x
          │                                  │
          └──── reads the result back ◀──────┘
```

> [!WARNING]
> The old `@gogogadgetbytes/planka-mcp` package can report success while doing
> nothing on Planka 2.x. Read [the five silent-failure gotchas](docs/planka-2x-gotchas.md)
> before replacing an existing installation.

## New to MCP? Read this first

MCP is a standard that lets Claude Code call tools provided by another program.
This repository runs a small local program that translates those tool calls into Planka API requests.
It needs Planka credentials because it acts as a dedicated Planka user, not as Claude itself.
The credentials stay on your machine and are never written into the project-level `.mcp.json` file.
Claude Code loads MCP servers when a session starts, so restart it after setup or configuration changes.

## Requirements

- Node.js 18 or newer and `npm`
- A reachable Planka 2.x instance
- A dedicated Planka user that can see the target project and board
- Claude Code installed and available as `claude`
- A project-manager role only if setup must create a board

Linux and macOS are supported. No Bun runtime is required.

## Install in 5 minutes

Clone the repository and run the guided installer:

```bash
git clone https://github.com/omnicoreos/planka-mcp.git
cd planka-mcp
./scripts/setup.sh
```

Setup asks for the Planka URL, agent email or username, and password. It validates
those credentials before writing configuration, lets you select or create a board,
and then runs a real create/label/comment/delete smoke test.

It offers two Claude Code configurations:

| Choice | Use it when | Where it lives |
|---|---|---|
| `claude mcp add` | You want the easiest personal setup | Claude Code user configuration |
| Project `.mcp.json` | A team should share the server entry | `<YOUR_PROJECT>/.mcp.json`, safe to commit |

In both cases, setup stores credentials outside Git in
`~/.config/planka-mcp/config.json` with mode `0600` and creates the private launcher
`~/.local/bin/planka-mcp`. A generated team configuration contains no password:

```json
{
  "mcpServers": {
    "planka": {
      "type": "stdio",
      "command": "${HOME}/.local/bin/planka-mcp",
      "args": []
    }
  }
}
```

The installer is safe to rerun. It updates the `planka` entry, reuses existing
workflow lists and labels, and deletes its temporary smoke-test card.

## Verify it works

First, inspect Claude Code's configuration:

```bash
claude mcp list
claude mcp get planka
```

Then fully restart Claude Code. If you chose `.mcp.json`, open Claude Code in that
project and approve the project-scoped server when prompted.

Ask Claude Code:

```text
Show me my Planka projects and boards. In the Pending list, create a card named
"MCP is working" with the description "Created from Claude Code", then read it back.
```

If Claude cannot see the tools, restart first and then follow
[Troubleshooting](docs/troubleshooting.md).

## Authentication

Two ways to authenticate, and they are mutually exclusive: setting both is a
configuration error, because Planka reads `Authorization` first and silently
ignores `x-api-key` when both arrive.

| | `PLANKA_API_KEY` (recommended) | `PLANKA_AGENT_EMAIL` + `PLANKA_AGENT_PASSWORD` |
|---|---|---|
| Sent as | `X-Api-Key: <prefix>_<secret>` on every request | `POST /api/access-tokens`, then `Authorization: Bearer` |
| Login round-trip | none | one per session, refreshed every 25 minutes |
| Sign-in rate limit | not subject to it | 10 logins per identity per 60 s — reached fast when several agents start at once |
| Password on disk | none | yes, in the client's configuration file |
| Attachment downloads | works | works |

### Recipe: a scoped agent user with an API key

Four steps, run by a Planka **admin**. The result is a user that can only ever
see the boards you name — enforced by Planka itself, not by this server.

1. **Create the user with the lowest global role.** In the Planka UI:
   *Administration → Users → Add user*, role **`boardUser`**. A `boardUser`
   cannot create projects and cannot grant itself memberships.

2. **Give it membership on the boards it should work on**, and only those:

   ```bash
   curl -X POST "$PLANKA_URL/api/boards/<BOARD_ID>/board-memberships" \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"userId":"<USER_ID>","role":"editor"}'
   ```

   Use `"role":"viewer"` for an agent that should read and comment but never
   create or move cards. `GET /api/projects` then returns only the projects
   derived from these memberships; every other board answers 404.

3. **Issue the API key** (admin-only endpoint). The key is shown **once**, in
   `included.apiKey`; Planka stores only its hash and prefix:

   ```bash
   curl -X POST "$PLANKA_URL/api/users/<USER_ID>/api-key" \
     -H "Authorization: Bearer $ADMIN_TOKEN"
   ```

4. **Configure the server with the key and nothing else.** Remove
   `PLANKA_AGENT_EMAIL` and `PLANKA_AGENT_PASSWORD`:

   ```json
   {
     "mcpServers": {
       "planka": {
         "command": "npx",
         "args": ["-y", "@omnicoreos/planka-mcp"],
         "env": {
           "PLANKA_BASE_URL": "https://planka.example.com",
           "PLANKA_API_KEY": "abcd1234_0123456789abcdef0123456789abcdef"
         }
       }
     }
   }
   ```

Rotating a key is step 3 again: issuing a new one invalidates the old.

## Scoping the server

An API key inherits its user's permissions — it carries no scopes of its own.
Scoping therefore happens in three layers, and each covers something the others
cannot.

```
Layer 1 · PLANKA          the only layer an agent cannot talk its way around
  boardUser + board memberships + the API key above
  ⇒ everything outside the allowed boards is 404/403 at the API

Layer 2 · THIS SERVER     ergonomics, and defence against the agent itself
  the environment variables below; they travel with the package,
  so Claude Code, Codex and Cursor all get the same rules

Layer 3 · THE CLIENT      survives a downgrade of this package
  .claude/settings.json deny/ask rules, Codex enabled_tools/disabled_tools
```

Layer 1 has real enforcement but cannot express "do not call `planka_get_board`,
it costs forty times more context". Layer 2 can, and reaches every runtime.
Layer 3 stays true even if this package is pinned back to an older version.

### Layer 2: the environment variables

| Variable | Value | What it does |
|---|---|---|
| `PLANKA_DEFAULT_BOARD_ID` | one board id | `boardId` becomes optional on every tool that takes one, and defaults to this board. Saves the `planka_get_structure` call an agent makes only to recover an id that never changes |
| `PLANKA_ALLOWED_BOARD_IDS` | comma-separated board ids | Boards outside the list are filtered out of `planka_get_structure`, and any call naming one is refused before the request leaves the process |
| `PLANKA_ALLOWED_PROJECT_IDS` | comma-separated project ids | Same, one level up |
| `PLANKA_READ_ONLY` | `true` or `1` | The fourteen write tools disappear from `tools/list` and are refused if called anyway |
| `PLANKA_DISABLED_TOOLS` | comma-separated tool names | Switches individual tools off. The `planka_` prefix is optional: `get_board` and `planka_get_board` mean the same thing |
| `PLANKA_PROTECTED_LIST_IDS` | comma-separated list ids | Refuses creating or moving cards **into** those lists, and editing or deleting the lists themselves |

**Allowlists are by id, never by name.** Any board editor can rename a board, so
a name-based allowlist is bypassed with one edit. Planka ids are stable.

Two notes on what these are and are not:

- `PLANKA_READ_ONLY` hides tools; it does not make the account read-only. Pair it
  with `"role":"viewer"` in step 2 above if that is what you actually need.
- `PLANKA_PROTECTED_LIST_IDS` is a guard-rail, not a permission: Planka has no
  per-list rights. It is the right tool for "do not move cards to *Merged* on
  your own", and the wrong one for anything security-critical.

Example — an agent that reads one board and comments, and nothing else:

```json
"env": {
  "PLANKA_BASE_URL": "https://planka.example.com",
  "PLANKA_API_KEY": "abcd1234_0123456789abcdef0123456789abcdef",
  "PLANKA_DEFAULT_BOARD_ID": "1234567890123456789",
  "PLANKA_ALLOWED_BOARD_IDS": "1234567890123456789",
  "PLANKA_DISABLED_TOOLS": "get_board",
  "PLANKA_PROTECTED_LIST_IDS": "9876543210987654321"
}
```

## The 24 tools

IDs are strings. Start with `planka_get_structure`, then use IDs returned by
Planka; do not guess them.

| Tool | What it does |
|---|---|
| `planka_get_structure` | Lists visible projects, boards, and lists |
| `planka_get_board` | Reads one board with its lists, cards, labels, and optional task counts |
| `planka_list_lists` | Lists a board's columns with card counts, and no cards |
| `planka_board_summary` | One-call briefing: columns, labels, and the cards waiting on a decision |
| `planka_list_cards` | Reads one column, paginated, without descriptions by default |
| `planka_find_cards` | Searches a board's cards by label, text, or column |
| `planka_create_card` | Creates a card and can attach tasks and labels |
| `planka_get_card` | Reads complete card details |
| `planka_update_card` | Updates title, description, due date, or completion |
| `planka_move_card` | Moves a card to another list or position |
| `planka_delete_card` | Permanently deletes a card |
| `planka_create_tasks` | Adds checklist tasks to a card |
| `planka_update_task` | Renames or completes a task |
| `planka_delete_task` | Deletes a task |
| `planka_manage_labels` | Creates, updates, or deletes board labels |
| `planka_set_card_labels` | Adds or removes labels and verifies the final state |
| `planka_add_comment` | Adds a comment through Planka 2.x's dedicated endpoint |
| `planka_get_comments` | Reads comments through the dedicated endpoint |
| `planka_manage_comment` | Edits or deletes an existing comment |
| `planka_manage_lists` | Creates, updates, or deletes board lists |
| `planka_add_attachment` | Uploads a local file to a card and verifies it landed |
| `planka_get_attachments` | Lists a card's attachments with type, size, and download URL |
| `planka_view_attachment` | Returns an attachment's content; images come back viewable |
| `planka_delete_attachment` | Deletes an attachment |

`planka_get_board` returns the entire board, which is often more than the
question needs. The four scoped reads answer narrower questions and return far
less text: measured on a board of 100 cards, `planka_list_lists` returned 39
times less than `planka_get_board`, `planka_board_summary` 16 times less, and
`planka_find_cards` between 18 and 56 times less depending on the filter. They
also report `total`, `returned`, and `hasMore`, so a clipped answer never looks
complete.

Every input field and a complete payload for every tool are in
[Tools reference](docs/tools.md).

## What the client learns on connect

The `initialize` handshake returns a short set of server instructions — how to
open a session, where IDs come from, why every comment on a card matters, and
that Planka answers `404` where it means `403`. Claude Code puts them in the
session system prompt and Codex CLI reads them alongside the tool list, so the
shared guidance is stated once instead of repeated in 24 tool descriptions.
Every tool also publishes a display title and all four MCP behavioural hints
explicitly, rather than inheriting the spec's pessimistic defaults, plus the two
`_meta` keys Claude Code acts on: a forced confirmation prompt on the tools that
delete data, and a raised output ceiling on `planka_view_attachment`. Details in
[Server instructions and annotations](docs/tools.md#server-instructions-and-annotations).

## Optional agent workflow

The MCP server works on its own. The optional method solves a different problem:
preserving why work exists, what changed, and what remains true between agent
sessions.

Adopt it in layers:

1. Use only the MCP tools.
2. Add the board states, card template, and human handshakes.
3. Add one worktree per card with a director coordinating workers.

Start with [A board that survives the session](workflow/README.md). The
[board template](workflow/board-template.md), copyable
[Claude Code skills](workflow/skills/), and optional
[worktree helper](workflow/worktrees/README.md) are independent pieces.

## Troubleshooting

- [Symptoms, causes, and exact fixes](docs/troubleshooting.md)
- [Why Planka 2.x breaks older MCP servers silently](docs/planka-2x-gotchas.md)
- [Complete tool payloads](docs/tools.md)

When reporting a bug, include the Planka version, Node version, the tool name,
and the error text. Never paste credentials or access tokens.

## Credits and license

This is an MIT-licensed fork of
[`gogogadgetbytes/planka-mcp`](https://github.com/gogogadgetbytes/planka-mcp),
not an original-from-scratch implementation. See [CREDITS.md](CREDITS.md) for
the upstream attribution, maintained fixes, and unanswered pull requests.

See [LICENSE](LICENSE) for the original and current contributor notices.

## Development

```bash
npm ci
npm run build
npm test
```

The real smoke test is opt-in because it mutates a writable board and then cleans
up after itself. It drives all 24 tools over stdio and cross-checks every write
against the raw Planka API — 64 named checks:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="1234567890123456789"
npm run test:smoke
```

`npm run test:smoke` builds first, so it cannot test a stale `dist/`. Four
optional variables tune it:

| Variable | What it does |
|---|---|
| `PLANKA_SMOKE_LIST_ID` | Column where the scratch card is created. Without it, a scratch-looking column is picked, falling back to the first one |
| `PLANKA_SMOKE_FAIL_AFTER` | Injects a failure after check `<n>`, to prove that cleanup still runs |
| `PLANKA_MCP_ENTRY` | Server entry point. Defaults to `dist/index.js` |
| `VERBOSE` | Set to `1` to print each check's payload |

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Release identity
is centralized in [project.identity.json](project.identity.json); update it and
run `npm run sync:identity` before publishing under your own namespace.
