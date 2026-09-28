#!/bin/sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repository_root=$(dirname "$script_directory")
workspace=${1:-$(pwd)}

exec node "$repository_root/plugin/hooks/archive.mjs" \
  --backfill \
  --foreground \
  --cwd "$workspace"
