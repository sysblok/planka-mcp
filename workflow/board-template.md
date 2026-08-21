# Board template

Create the optional workflow on an empty board:

```bash
export PLANKA_BASE_URL="https://planka.example.com"
export PLANKA_AGENT_EMAIL="agent@example.com"
export PLANKA_AGENT_PASSWORD="<YOUR_PASSWORD>"

node scripts/bootstrap-board.mjs --board-id "<BOARD_ID>"
```

Or create the board inside a project and then bootstrap it:

```bash
node scripts/bootstrap-board.mjs \
  --project-id "<PROJECT_ID>" \
  --board-name "Agent Work"
```

The command is idempotent. It fills missing template lists and labels. It refuses to
alter an unrelated populated board unless you pass `--force` deliberately.

## Lists

| Order | Name | Repository invariant |
|---:|---|---|
| 1 | `Pending` | No branch or worktree exists |
| 2 | `Needs your decision` | A human answer is required |
| 3 | `In worktree` | Branch and worktree exist |
| 4 | `Test it` | Human proof is required before merge |
| 5 | `Review in main` | Merged; final integrated proof is pending |
| 6 | `Merged` | Integrated and verified |

`Merged` is created as a Planka `closed` list. The others are `active` lists.

## Labels

| Label | Meaning |
|---|---|
| `needs-decision` | Implementation is blocked on one human choice |
| `decided` | Human decision is in the comments |
| `tested-ok` | Human approved the integrated result |
| `fast-track` | Repository-defined lightweight path |
| `standard` | Normal verification path |
| `serial` | Never run beside another worktree |
| `zone:frontend` | Frontend ownership boundary |
| `zone:backend` | Backend ownership boundary |
| `zone:data` | Data/schema boundary |
| `zone:infra` | Infrastructure/global-state boundary |
| `zone:shared-ui` | Shared design-system boundary |

Rename or add zones to match your repository. The important contract is that two
cards with the same zone do not run concurrently.

## Card description

```markdown
## What is happening
One or two sentences from the user's point of view.

## How to see it
Exact reproduction steps or the place to inspect.

## Where it lives
- path/to/likely-file.ts
- path/to/related-test.ts

## Done means
Observable acceptance criteria.

## Risk
Nearby behavior or data that could regress.

<!-- agent-work
branch: agent/short-slug
worktree: .worktrees/short-slug
port:
plan:
-->
```

The description captures current scope. Comments preserve decisions, attempts,
evidence, and handoffs over time.

## Decision request

Ask one question, not a questionnaire:

```markdown
🚧 Decision needed

Should an archived item remain visible to administrators, or disappear for every
role? This changes the access boundary, so implementation is paused.
```

The human replies in a comment and applies `decided`.

## Closing comment

```markdown
✅ Ready for review

**Changed:** Export now reports a useful timeout instead of hanging.

**Where to check:** Settings → Exports → Start export

**Prove it:** Start an export against the slow test fixture and confirm it stops with the timeout message.

**Risk:** Normal exports and retry behavior share the same request path.

**Verified:** unit tests ✅ · typecheck ✅ · manual slow-fixture check ✅

**Commit:** abc1234
```
