# Optional worktree helper

`wt.sh` is a conservative example for running one agent worker per Git worktree.
It manages Git mechanics; it does not choose cards or decide that a merge is safe.

The script has no built-in port range, package manager, dev command, environment
copy, or dependency install. Configure only what your repository needs.

## Install

From your repository root:

```bash
mkdir -p scripts
cp workflow/worktrees/wt.sh scripts/wt.sh
chmod +x scripts/wt.sh
cp workflow/worktrees/wt.conf.example .agent-worktrees.conf
```

Review `.agent-worktrees.conf` before use. Commit the script and config if they are
part of your team's contract. Add `.worktrees/` to `.gitignore`.

## Commands

```bash
scripts/wt.sh new fix-export-timeout
scripts/wt.sh up fix-export-timeout
scripts/wt.sh list
scripts/wt.sh doctor
scripts/wt.sh merge fix-export-timeout
scripts/wt.sh kill fix-export-timeout
```

`merge` performs a local `--no-ff` merge and never pushes.

## Development command discovery

If `WT_DEV_COMMAND` is empty, the helper looks for a `dev` script in
`package.json` and chooses a command from the repository lockfile:

| Lockfile | Command |
|---|---|
| `package-lock.json` | `npm run dev` |
| `pnpm-lock.yaml` | `pnpm run dev` |
| `yarn.lock` | `yarn dev` |
| `bun.lock` or `bun.lockb` | `bun run dev` |

Set an explicit command for non-Node repositories or unusual scripts:

```bash
WT_DEV_COMMAND='make dev'
```

If the command needs a port, set `WT_PORT_START` and use `{port}` or read the `PORT`
environment variable:

```bash
WT_PORT_START=4100
WT_MAX_WORKTREES=4
WT_DEV_COMMAND='npm run dev -- --port {port}'
```

The numbers are examples in the config, not behavior compiled into the script.

## Environment safety

The helper does not copy `.env`. Parallel processes can duplicate queue consumers,
scheduled jobs, webhooks, billing calls, or production writes.

If a worktree needs environment values, create a reviewed safe template and opt in:

```bash
WT_ENV_TEMPLATE=.env.worktree
WT_ENV_TARGET=.env
```

Do not point `WT_ENV_TEMPLATE` at a production credential file. Disable background
workers and external side effects in the template itself.

## Dependency setup

Set `WT_INSTALL_COMMAND` when each worktree needs its own dependencies:

```bash
WT_INSTALL_COMMAND='npm ci'
```

Leave it empty when your repository has another supported strategy. The helper does
not symlink dependency directories because that is not safe for every package manager.

## Safety model

- Slugs accept only lowercase letters, numbers, and hyphens.
- The base tree and worker tree must be clean before merge.
- A worker must contain commits not yet in the base branch.
- A configured development port must be free before start and stopped before merge.
- Merges are serialized with an atomic directory lock that works on macOS and Linux.
- Conflicts are resolved in the worker branch, never half-applied in the base tree.
- `kill` preserves unmerged work unless `--force` is explicit.
- No command pushes.

`doctor` reports files modified by more than one live worktree. This is an early
warning, not a conflict resolver. The board's `zone:*` rule should prevent most of
these overlaps before Git sees them.
