# planka-mcp

Control a Planka 2.x board from Claude Code through 15 MCP tools.
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
> nothing on Planka 2.x. Read [the four silent-failure gotchas](docs/planka-2x-gotchas.md)
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
git clone https://github.com/<YOUR_GITHUB_USER>/planka-mcp.git
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

## The 15 tools

IDs are strings. Start with `planka_get_structure`, then use IDs returned by
Planka; do not guess them.

| Tool | What it does |
|---|---|
| `planka_get_structure` | Lists visible projects, boards, and lists |
| `planka_get_board` | Reads one board with its lists, cards, labels, and optional task counts |
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
| `planka_manage_lists` | Creates, updates, or deletes board lists |

Every input field and a complete payload for every tool are in
[Tools reference](docs/tools.md).

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
up after itself:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"
export PLANKA_SMOKE_BOARD_ID="1234567890123456789"
npm run test:smoke
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. Release identity
is centralized in [project.identity.json](project.identity.json); update it and
run `npm run sync:identity` before publishing under your own namespace.
