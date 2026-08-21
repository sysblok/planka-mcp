#!/usr/bin/env bash

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

echo "Planka MCP setup"
echo

DEFAULT_URL="${PLANKA_BASE_URL:-https://planka.example.com}"
read -r -p "Planka base URL [$DEFAULT_URL]: " INPUT_URL
export PLANKA_BASE_URL="${INPUT_URL:-$DEFAULT_URL}"

DEFAULT_EMAIL="${PLANKA_AGENT_EMAIL:-}"
if [[ -n "$DEFAULT_EMAIL" ]]; then
  read -r -p "Agent email or username [$DEFAULT_EMAIL]: " INPUT_EMAIL
  export PLANKA_AGENT_EMAIL="${INPUT_EMAIL:-$DEFAULT_EMAIL}"
else
  read -r -p "Agent email or username: " PLANKA_AGENT_EMAIL
  export PLANKA_AGENT_EMAIL
fi

if [[ -z "${PLANKA_AGENT_PASSWORD:-}" ]]; then
  read -r -s -p "Agent password: " PLANKA_AGENT_PASSWORD
  echo
  export PLANKA_AGENT_PASSWORD
else
  echo "Using PLANKA_AGENT_PASSWORD from the environment."
fi

if [[ ! -f "$ROOT_DIR/dist/index.js" ]]; then
  echo
  echo "Building the MCP server..."
  (cd "$ROOT_DIR" && npm ci && npm run build)
fi

exec node "$ROOT_DIR/scripts/setup.mjs"
