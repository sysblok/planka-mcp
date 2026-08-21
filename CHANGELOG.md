# Changelog

All notable changes to this project are documented here.

## [0.1.0] - 2026-08-21

### Identity

- Working repository name: `planka-mcp`.
- Working npm identity: `@omnicoreos/planka-mcp`.
- `project.identity.json` is the source of truth for repository, package, binary,
  MCP Registry, and repository URL names. After changing it, run
  `npm run sync:identity`.

### Added

- Fifteen stdio MCP tools for Planka projects, boards, cards, tasks, comments,
  labels, and lists.
- Guided macOS/Linux setup with authentication validation, board selection,
  optional board bootstrap, Claude Code configuration, and real smoke verification.
- Unit tests for schemas, parsing, request construction, the dedicated comments
  endpoint, label criteria deletion, label aliases, list creation, and bootstrap
  idempotency.
- Opt-in smoke test that executes MCP tools and verifies every mutation against the
  raw Planka API before deleting its temporary card.
- Optional board, director/worker, and worktree methodology.
- English and Spanish documentation.

### Fixed from upstream

- Empty comments on Planka 2.x.
- Whole-board failures caused by new label colors.
- Silent no-op `labelIds` requests.
- Incorrect label-removal URL.
- Missing `type` in list creation.
- Internal `archive` and `trash` list types rejected on board reads.
