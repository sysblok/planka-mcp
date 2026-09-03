#!/usr/bin/env bash
#
# Thin alias for `planka-mcp init --client claude`, kept because the README has
# been pointing at it since 0.1. Everything it used to do by hand now lives in
# the published binary, so a clone and an npx install take the same path.
#
# The interactive board picker and the full write smoke still live in
# scripts/setup.mjs: run `node scripts/setup.mjs` for those.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "setup: Node.js 18 or newer is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "setup: Node.js 18 or newer is required (found $(node --version))." >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
  echo "Building the MCP server..."
  (cd "$ROOT_DIR" && npm ci && npm run build)
fi

exec node "$ROOT_DIR/dist/index.js" init --client claude "$@"
