# Credits and fork history

This repository is a fork of
[`gogogadgetbytes/planka-mcp`](https://github.com/gogogadgetbytes/planka-mcp),
released under the MIT License. The original 2026 copyright notice remains in
[`LICENSE`](LICENSE). The additional contributor notice covers changes made in this
fork and the optional workflow documentation.

This is not presented as an original MCP implementation.

## Why this fork exists

The upstream repository is functionally abandoned. Its four commits are the initial
release plus registry housekeeping from 2026-02-03; there have been no code changes
since that release batch. Two compatibility pull requests remain open and unmerged:

- [PR #5: read comments from the Planka 2.x card-comments endpoint](https://github.com/gogogadgetbytes/planka-mcp/pull/5)
- [PR #1: accept backend label colors on read paths](https://github.com/gogogadgetbytes/planka-mcp/pull/1)

Both were still open when this fork was prepared on 2026-08-21.

## Compatibility work in this fork

This fork carries four Planka 2.x fixes:

1. Comments are read from `GET /api/cards/:cardId/comments` instead of an empty
   `included.comments` array.
2. `planka_set_card_labels` accepts the natural `labelIds` argument as well as
   `addLabelIds`, then verifies the final card state.
3. Label removal uses Planka's criteria path,
   `/card-labels/labelId:<labelId>`, instead of a junction-record ID.
4. Label colors returned by Planka are open-ended on read paths, so a new backend
   color cannot invalidate the whole board response.

It also sends the required `type` when creating Planka 2.x lists, accepts internal
`archive` and `trash` list types on reads, adds unit and raw-API-verified smoke tests,
and provides the optional board/worktree method under [`workflow/`](workflow/).

See [docs/planka-2x-gotchas.md](docs/planka-2x-gotchas.md) for the technical details.
