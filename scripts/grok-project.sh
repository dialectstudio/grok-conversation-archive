#!/bin/sh

set -eu

fail() {
  printf 'grok-project: %s\n' "$*" >&2
  exit 1
}

canonical_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
    return
  fi

  path_directory=$(dirname "$1")
  path_name=$(basename "$1")
  (
    CDPATH= cd "$path_directory"
    printf '%s/%s\n' "$(pwd -P)" "$path_name"
  )
}

find_project_root() {
  candidate=$(canonical_path "$1")

  while :; do
    for marker in "$candidate"/*.sublime-project; do
      if [ -f "$marker" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done

    parent=$(dirname "$candidate")
    if [ "$parent" = "$candidate" ]; then
      return 1
    fi

    candidate=$parent
  done
}

if [ -n "${GROK_BIN:-}" ]; then
  real_grok=$(command -v "$GROK_BIN" 2>/dev/null || true)
else
  real_grok=$(command -v grok 2>/dev/null || true)
fi

[ -n "$real_grok" ] || fail "cannot locate the real grok executable"

script_path=$(canonical_path "$0")
real_grok=$(canonical_path "$real_grok")

if [ "$script_path" = "$real_grok" ]; then
  fail "refusing recursive invocation; set GROK_BIN to the real executable"
fi

if [ "$#" -gt 0 ]; then
  exec "$real_grok" "$@"
fi

starting_directory=$(pwd -P)
project_root=$(find_project_root "$starting_directory" || true)

if [ -z "$project_root" ]; then
  exec "$real_grok"
fi

cd "$project_root"

session_file=$project_root/.session_ids
session_id=

if [ -s "$session_file" ] && command -v node >/dev/null 2>&1; then
  session_id=$(
    node --input-type=module -e '
      import { existsSync, readdirSync, readFileSync } from "node:fs"
      import { homedir } from "node:os"
      import { join } from "node:path"

      const sessionFile = process.argv[1]
      const grokHome = process.env.GROK_HOME || join(homedir(), ".grok")
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const stored = readFileSync(sessionFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((id) => uuid.test(id))
      let groups = []

      try {
        groups = readdirSync(join(grokHome, "sessions"))
      } catch {
        groups = []
      }

      for (const sessionID of stored) {
        for (const group of groups) {
          const directory = join(grokHome, "sessions", group, sessionID)
          if (
            existsSync(join(directory, "summary.json")) ||
            existsSync(join(directory, "updates.jsonl"))
          ) {
            process.stdout.write(sessionID)
            process.exit(0)
          }
        }
      }
    ' "$session_file"
  )
fi

if [ -n "$session_id" ]; then
  exec "$real_grok" --resume "$session_id"
fi

exec "$real_grok"
