# A board that survives the session

This is an optional working method built around the MCP server in this repository.
You do not need it to use the 15 Planka tools.

## The problem it solves

A fresh agent session does not know why a task exists, what was already tried, or
which decision unblocked it. That state usually lives in one person's head. The
result is repeated investigation, stale branches, and a human who has to reconstruct
every workstream on demand.

This proposal moves that state into a Planka board. The board is not a backlog that
the human must maintain. It is the durable handoff between conversations, agents,
branches, and worktrees.

Adopt it in layers:

1. Use only the MCP server.
2. Add the board states and card format.
3. Add parallel worktrees with a director and one worker per card.

Stop at the layer that helps. The method is a starting point, not a doctrine.

## Core rules

1. **The conversation is the input.** The human explains a bug or feature. The
   agent writes the card. The board mirrors work; it is not a form the human fills.
2. **Columns describe verifiable repository state.** A card in `In worktree` has a
   real branch and worktree. A card in `Merged` is in the base branch and verified.
3. **Read every comment before touching a card.** The description says how the task
   started. Comments say what is true now. The newest human decision wins.
4. **One writer per worktree.** In parallel mode, the worker assigned to a card is
   the only agent that edits its branch. The director coordinates and audits.
5. **Evidence travels with the card.** Checks, manual verification, remaining risk,
   and the commit or branch are recorded before a session ends.

## Board states

The bootstrap script creates these lists:

| List | Verifiable meaning | Owner of the transition |
|---|---|---|
| `Pending` | Described, but no branch or worktree exists | Director |
| `Needs your decision` | One concrete product or risk choice blocks work | Director puts it here; human unlocks it |
| `In worktree` | The metadata points to a live branch and worktree | Director |
| `Test it` | Pre-merge human judgment is genuinely required | Director after worker evidence |
| `Review in main` | Merged, but the final proof only exists on the integrated branch or environment | Director; human confirms |
| `Merged` | In the base branch, closure recorded, and required verification complete | Director |

Do not use columns as moods such as “almost done.” If repository state and board
state disagree, fix the board immediately.

## Human handshakes

### `decided`

For a card in `Needs your decision`, the human:

1. leaves a comment containing the decision;
2. applies the `decided` label.

The agent does not infer the decision from the label alone. It reads all comments,
treats the newest human decision as binding, rewrites the description so the chosen
scope is self-contained, and then moves the card to `Pending` or `In worktree`.

Only a human applies `decided`. Keep the label as durable provenance.

### `tested-ok`

For a card in `Review in main`, the human applies `tested-ok` after checking the
integrated behavior. The director then moves it to `Merged`. If the check fails, the
human comments with the observed behavior and the director creates or reopens a fix.

Only a human applies `tested-ok`.

## Card anatomy

Use the copyable template in [board-template.md](board-template.md). A useful card
answers five questions in ordinary language:

- What is happening?
- How can someone see or reproduce it?
- Where does it live?
- What proves it is done?
- What could this change break?

At the bottom, a machine-readable comment links the card to Git:

```html
<!-- agent-work
branch: agent/fix-export-timeout
worktree: .worktrees/fix-export-timeout
port: 4173
plan: docs/plans/fix-export-timeout.md
-->
```

Omit fields that do not apply. The card remains the source of truth for the
card-to-branch-to-worktree relationship.

## Labels are instructions

The template uses a deliberately small behavior vocabulary:

| Label | Agent behavior |
|---|---|
| `needs-decision` | Stop implementation and ask one concrete question |
| `decided` | Read the human decision in comments and prioritize the card |
| `tested-ok` | Human confirmed the post-merge check |
| `fast-track` | Small, low-risk change; use the repository's short verification path |
| `standard` | Normal planning, implementation, and verification path |
| `serial` | Run alone because it touches shared or irreversible state |
| `zone:*` | Mutual-exclusion key for parallel work |

Two cards with the same `zone:*` label never run in parallel. Tune zones to your
repository boundaries. The starter set is only an example.

Use `serial` for migrations, shared test fixtures, global infrastructure, or any
verification that mutates one shared environment.

## Director and workers

Parallel mode separates coordination from editing.

### Director

The director:

- reads the complete board and every candidate card's comments;
- chooses eligible cards, respecting `serial` and `zone:*` exclusions;
- creates branches and worktrees;
- writes the card metadata;
- gives each worker one bounded brief;
- audits evidence and decides the next board state;
- serializes merges and cleans worktrees.

In this contract, the director does not edit repository files. This keeps ownership
clear and makes a worker's evidence first-hand rather than reconstructed.

### Worker

One worker owns one card and one worktree. It:

- edits only that worktree;
- follows the repository's own instructions;
- runs the relevant checks;
- performs the acceptance steps from the card;
- captures visual evidence when the change is visual;
- commits its work;
- writes progress and closure only on its assigned card.

A worker does not select other cards, move unrelated cards, merge the base branch,
or invent human approval.

### Worker brief

A director should provide:

```text
Mission: one concrete outcome
Card: title, current description, and every relevant comment
Worktree: absolute path and branch
Acceptance: exact observable proof
Required checks: repository-specific commands
Do not: scope boundaries and external side effects
Output: commit, checks, manual proof, risks, and closing comment
```

If a worker needs correction, continue the same worker session when the runtime
supports it. Replacing it loses the context the board/worktree contract is trying to
preserve.

## Automatic progress and vetoes

Verified work may merge without another ceremony when all required evidence is
present and the repository allows it. Keep explicit vetoes for work where automated
confidence is not enough:

- access control, visibility, or security boundaries;
- destructive migrations or shared production-like data;
- money, billing, or irreversible external side effects;
- infrastructure that competes with a human's active environment;
- physical hardware or third-party approval that the worker cannot exercise.

A veto does not mean “never.” It means stop at `Test it` or `Review in main` with an
exact question or check. “Please test” without saying what remains uncertain is not
evidence.

## Closure evidence

The worker leaves a comment like this before handing the card back:

```markdown
✅ Ready for review

**Changed:** <one user-visible sentence>

**Where to check:** <URL, command, or exact path>

**Prove it:** <one concrete acceptance step>

**Risk:** <real nearby behavior that could regress>

**Verified:** <checks and manual evidence, with honest omissions>

**Commit:** <commit SHA>
```

The director audits the claim against the branch, checks, and attachments. It does
not silently upgrade “not tested” into “passed.”

## A safe cycle

1. Read the board and comments.
2. Prefer `decided` cards whose zones are free.
3. Apply `serial` and zone exclusions.
4. Create one worktree per selected card and update metadata.
5. Dispatch one worker per worktree.
6. Workers implement, verify, commit, and comment.
7. Director audits and chooses `Test it`, `Review in main`, or merge.
8. Merge one worktree at a time.
9. Confirm the board, base tree, and worktree inventory agree.

The optional [worktree helper](worktrees/README.md) automates the Git mechanics. It
does not decide whether a card is safe to run or merge.

## Start small

For a first trial, use one board and one card. Ask the agent to create a card from a
conversation, read it back, implement in one branch, and leave the closure comment.
Add parallelism only after that loop feels boring and reliable.
