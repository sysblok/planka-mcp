#!/usr/bin/env bash

set -euo pipefail

die() {
  echo "wt: $*" >&2
  exit 1
}

info() {
  echo "  $*"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INITIAL_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$INITIAL_ROOT" ]] || die "not inside a Git repository"
COMMON_DIR="$(git -C "$INITIAL_ROOT" rev-parse --path-format=absolute --git-common-dir)"
REPO_ROOT="$(dirname "$COMMON_DIR")"

CONFIG_FILE="$REPO_ROOT/.agent-worktrees.conf"
if [[ -f "$CONFIG_FILE" ]]; then
  # This file is repository configuration and executes as shell syntax. Review it
  # before trusting a cloned repository, just like any other executable script.
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
fi

detect_base_branch() {
  local remote current
  remote="$(git -C "$REPO_ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)"
  if [[ -n "$remote" ]]; then
    echo "${remote#origin/}"
  elif git -C "$REPO_ROOT" show-ref --verify --quiet refs/heads/main; then
    echo "main"
  elif git -C "$REPO_ROOT" show-ref --verify --quiet refs/heads/master; then
    echo "master"
  else
    current="$(git -C "$REPO_ROOT" branch --show-current)"
    [[ -n "$current" ]] || die "cannot determine a base branch"
    echo "$current"
  fi
}

WT_BASE_BRANCH="${WT_BASE_BRANCH:-$(detect_base_branch)}"
WT_ROOT="${WT_ROOT:-.worktrees}"
WT_BRANCH_PREFIX="${WT_BRANCH_PREFIX:-agent/}"
WT_MAX_WORKTREES="${WT_MAX_WORKTREES:-4}"
WT_PORT_START="${WT_PORT_START:-}"
WT_DEV_COMMAND="${WT_DEV_COMMAND:-}"
WT_INSTALL_COMMAND="${WT_INSTALL_COMMAND:-}"
WT_ENV_TEMPLATE="${WT_ENV_TEMPLATE:-}"
WT_ENV_TARGET="${WT_ENV_TARGET:-.env}"

[[ "$WT_ROOT" = /* ]] || WT_ROOT="$REPO_ROOT/$WT_ROOT"
[[ "$WT_MAX_WORKTREES" =~ ^[1-9][0-9]*$ ]] || die "WT_MAX_WORKTREES must be a positive integer"
if [[ -n "$WT_PORT_START" ]]; then
  [[ "$WT_PORT_START" =~ ^[1-9][0-9]*$ ]] || die "WT_PORT_START must be a positive integer"
fi

validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{1,40}$ ]] ||
    die "invalid slug '$slug'; use 2-41 lowercase letters, numbers, or hyphens"
}

wt_path() {
  echo "$WT_ROOT/$1"
}

meta_file() {
  echo "$WT_ROOT/.metadata/$1"
}

read_meta() {
  local slug="$1" key="$2" file
  file="$(meta_file "$slug")"
  [[ -f "$file" ]] || return 1
  sed -n "s/^${key}=//p" "$file" | head -n 1
}

existing_slugs() {
  local path
  [[ -d "$WT_ROOT" ]] || return 0
  for path in "$WT_ROOT"/*; do
    [[ -d "$path" ]] || continue
    basename "$path"
  done | sort
}

port_in_use() {
  local port="$1"
  [[ -n "$port" ]] || return 1
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

pick_free_port() {
  [[ -n "$WT_PORT_START" ]] || return 0
  local offset candidate slug assigned reserved
  for ((offset = 0; offset < WT_MAX_WORKTREES; offset += 1)); do
    candidate=$((WT_PORT_START + offset))
    reserved=0
    while IFS= read -r slug; do
      [[ -n "$slug" ]] || continue
      assigned="$(read_meta "$slug" PORT || true)"
      [[ "$assigned" == "$candidate" ]] && reserved=1
    done < <(existing_slugs)
    if [[ "$reserved" -eq 0 ]] && ! port_in_use "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

discover_dev_command() {
  if [[ -n "$WT_DEV_COMMAND" ]]; then
    echo "$WT_DEV_COMMAND"
    return 0
  fi
  [[ -f "$REPO_ROOT/package.json" ]] ||
    die "set WT_DEV_COMMAND; no package.json was found"
  node -e '
    const p = require(process.argv[1]);
    process.exit(p.scripts && p.scripts.dev ? 0 : 1);
  ' "$REPO_ROOT/package.json" || die "set WT_DEV_COMMAND; package.json has no dev script"

  if [[ -f "$REPO_ROOT/pnpm-lock.yaml" ]]; then echo "pnpm run dev"
  elif [[ -f "$REPO_ROOT/yarn.lock" ]]; then echo "yarn dev"
  elif [[ -f "$REPO_ROOT/bun.lock" || -f "$REPO_ROOT/bun.lockb" ]]; then echo "bun run dev"
  elif [[ -f "$REPO_ROOT/package-lock.json" ]]; then echo "npm run dev"
  else die "set WT_DEV_COMMAND; no recognized package manager lockfile was found"
  fi
}

cmd_new() {
  local slug="${1:-}" path branch count port template target
  validate_slug "$slug"
  path="$(wt_path "$slug")"
  branch="${WT_BRANCH_PREFIX}${slug}"
  [[ ! -e "$path" ]] || die "worktree already exists: $path"
  git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$branch" &&
    die "branch already exists: $branch"

  count="$(existing_slugs | sed '/^$/d' | wc -l | tr -d ' ')"
  ((count < WT_MAX_WORKTREES)) || die "maximum of $WT_MAX_WORKTREES live worktrees reached"
  port="$(pick_free_port)" || die "no configured worktree port is free"

  mkdir -p "$WT_ROOT"
  git -C "$REPO_ROOT" worktree add -b "$branch" "$path" "$WT_BASE_BRANCH"
  mkdir -p "$WT_ROOT/.metadata"
  {
    echo "SLUG=$slug"
    echo "BRANCH=$branch"
    echo "PORT=$port"
  } > "$(meta_file "$slug")"

  if [[ -n "$WT_ENV_TEMPLATE" ]]; then
    template="$WT_ENV_TEMPLATE"
    [[ "$template" = /* ]] || template="$REPO_ROOT/$template"
    [[ -f "$template" ]] || die "WT_ENV_TEMPLATE does not exist: $template"
    target="$path/$WT_ENV_TARGET"
    mkdir -p "$(dirname "$target")"
    cp "$template" "$target"
    chmod 600 "$target"
    info "copied reviewed environment template to $WT_ENV_TARGET"
  fi

  if [[ -n "$WT_INSTALL_COMMAND" ]]; then
    (cd "$path" && bash -lc "$WT_INSTALL_COMMAND")
    info "dependency setup complete"
  fi

  info "worktree: $path"
  info "branch: $branch"
  [[ -n "$port" ]] && info "port: $port"
  return 0
}

cmd_up() {
  local slug="${1:-}" path port command
  validate_slug "$slug"
  path="$(wt_path "$slug")"
  [[ -d "$path" ]] || die "unknown worktree: $slug"
  port="$(read_meta "$slug" PORT || true)"
  [[ -z "$port" ]] || ! port_in_use "$port" || die "port $port is already in use"
  command="$(discover_dev_command)"
  if [[ "$command" == *"{port}"* && -z "$port" ]]; then
    die "WT_DEV_COMMAND uses {port}, but WT_PORT_START is not configured"
  fi
  command="${command//\{port\}/$port}"
  info "starting $slug${port:+ on port $port}"
  cd "$path"
  if [[ -n "$port" ]]; then
    PORT="$port" exec bash -lc "$command"
  else
    exec bash -lc "$command"
  fi
}

cmd_list() {
  local slugs slug path branch port dev dirty ahead
  slugs="$(existing_slugs)"
  [[ -n "$slugs" ]] || {
    echo "No live worktrees."
    return 0
  }
  printf '%-24s %-32s %-8s %-10s %s\n' WORKTREE BRANCH PORT DEV CHANGES
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    path="$(wt_path "$slug")"
    branch="$(read_meta "$slug" BRANCH || git -C "$path" branch --show-current)"
    port="$(read_meta "$slug" PORT || true)"
    if [[ -n "$port" ]] && port_in_use "$port"; then dev="running"; else dev="stopped"; fi
    dirty="$(git -C "$path" status --porcelain | sed '/^$/d' | wc -l | tr -d ' ')"
    ahead="$(git -C "$path" rev-list --count "$WT_BASE_BRANCH..HEAD")"
    printf '%-24s %-32s %-8s %-10s dirty=%s ahead=%s\n' \
      "$slug" "$branch" "${port:--}" "$dev" "$dirty" "$ahead"
  done <<< "$slugs"
}

cmd_doctor() {
  local slugs tmp slug path shared file
  slugs="$(existing_slugs)"
  [[ -n "$slugs" ]] || {
    echo "No live worktrees."
    return 0
  }
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  while IFS= read -r slug; do
    [[ -n "$slug" ]] || continue
    path="$(wt_path "$slug")"
    {
      git -C "$path" diff --name-only "$WT_BASE_BRANCH...HEAD"
      git -C "$path" diff --name-only
      git -C "$path" ls-files --others --exclude-standard
    } | sort -u | while IFS= read -r file; do
      [[ -n "$file" ]] && printf '%s\t%s\n' "$slug" "$file"
    done
  done <<< "$slugs" > "$tmp"
  shared="$(cut -f2- "$tmp" | sort | uniq -d)"
  if [[ -z "$shared" ]]; then
    echo "No file is modified by more than one worktree."
    return 0
  fi
  echo "Files modified by multiple worktrees:"
  while IFS= read -r file; do
    [[ -n "$file" ]] || continue
    echo "  $file"
    awk -F '\t' -v target="$file" '$2 == target { print "    - " $1 }' "$tmp"
  done <<< "$shared"
}

cmd_kill() {
  local slug="${1:-}" force="${2:-}" path port dirty ahead branch
  validate_slug "$slug"
  [[ -z "$force" || "$force" == "--force" ]] || die "unknown kill option: $force"
  path="$(wt_path "$slug")"
  [[ -d "$path" ]] || die "unknown worktree: $slug"
  port="$(read_meta "$slug" PORT || true)"
  [[ -z "$port" ]] || ! port_in_use "$port" || die "development server is still using port $port"
  dirty="$(git -C "$path" status --porcelain | sed '/^$/d' | wc -l | tr -d ' ')"
  ahead="$(git -C "$path" rev-list --count "$WT_BASE_BRANCH..HEAD")"
  if [[ "$force" != "--force" && ( "$dirty" -gt 0 || "$ahead" -gt 0 ) ]]; then
    die "$slug has uncommitted or unmerged work; merge it or repeat kill with --force"
  fi
  branch="$(git -C "$path" branch --show-current)"
  if [[ "$force" == "--force" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$path"
  else
    git -C "$REPO_ROOT" worktree remove "$path"
  fi
  if [[ -n "$branch" && "$branch" != "$WT_BASE_BRANCH" ]]; then
    git -C "$REPO_ROOT" branch -d "$branch" >/dev/null 2>&1 ||
      info "branch preserved because it is not merged: $branch"
  fi
  rm -f "$(meta_file "$slug")"
  info "closed $slug"
}

cmd_merge() {
  local slug="${1:-}" path port dirty ahead branch current lock
  validate_slug "$slug"
  path="$(wt_path "$slug")"
  [[ -d "$path" ]] || die "unknown worktree: $slug"
  mkdir -p "$WT_ROOT"
  lock="$WT_ROOT/.merge.lock"
  mkdir "$lock" 2>/dev/null || die "another merge is in progress"
  MERGE_LOCK_DIR="$lock"
  trap 'rmdir "$MERGE_LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

  port="$(read_meta "$slug" PORT || true)"
  [[ -z "$port" ]] || ! port_in_use "$port" || die "development server is still using port $port"
  dirty="$(git -C "$path" status --porcelain | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$dirty" -eq 0 ]] || die "worker tree has $dirty uncommitted change(s)"
  ahead="$(git -C "$path" rev-list --count "$WT_BASE_BRANCH..HEAD")"
  ((ahead > 0)) || die "worker branch has no commits ahead of $WT_BASE_BRANCH"
  dirty="$(git -C "$REPO_ROOT" status --porcelain | sed '/^$/d' | wc -l | tr -d ' ')"
  [[ "$dirty" -eq 0 ]] || die "base tree has $dirty uncommitted change(s)"
  current="$(git -C "$REPO_ROOT" branch --show-current)"
  [[ "$current" == "$WT_BASE_BRANCH" ]] || die "base tree must have $WT_BASE_BRANCH checked out"
  branch="$(git -C "$path" branch --show-current)"

  if ! git -C "$path" merge "$WT_BASE_BRANCH" -m "merge: refresh $slug before integration"; then
    git -C "$path" merge --abort >/dev/null 2>&1 || true
    die "conflict while bringing $WT_BASE_BRANCH into $slug; resolve it in the worktree"
  fi
  git -C "$REPO_ROOT" merge --no-ff "$branch" -m "merge($slug): integrate worktree"
  cmd_kill "$slug"
  rmdir "$MERGE_LOCK_DIR" 2>/dev/null || true
  trap - EXIT INT TERM
  info "merged locally into $WT_BASE_BRANCH; nothing was pushed"
}

usage() {
  cat <<'EOF'
wt.sh — conservative Git worktree helper

  wt.sh new <slug>             create a branch and worktree
  wt.sh up <slug>              start the configured/discovered dev command
  wt.sh list                   show live worktrees and Git state
  wt.sh doctor                 report overlapping changed files
  wt.sh merge <slug>           merge --no-ff locally and close the worktree
  wt.sh kill <slug> [--force]  close without merging

Configuration: .agent-worktrees.conf in the main repository root.
EOF
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  up) shift; cmd_up "$@" ;;
  list) shift; cmd_list "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  merge) shift; cmd_merge "$@" ;;
  kill) shift; cmd_kill "$@" ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
