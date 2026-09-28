#!/bin/sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repository_root=$(dirname "$script_directory")
source_root=$repository_root/plugin
plugin_directory=${GROK_PLUGIN_DIR:-$HOME/.grok/plugins/grok-conversation-archive}
status=0

compare() {
  source_file=$1
  target_file=$2

  if [ ! -f "$target_file" ]; then
    printf 'Missing: %s\n' "$target_file"
    status=1
    return
  fi

  if cmp -s "$source_file" "$target_file"; then
    printf 'Matches: %s\n' "$target_file"
  else
    printf 'Differs: %s\n' "$target_file"
    status=1
  fi
}

compare "$source_root/plugin.json" "$plugin_directory/plugin.json"
compare "$source_root/hooks/hooks.json" "$plugin_directory/hooks/hooks.json"
compare "$source_root/hooks/archive.mjs" "$plugin_directory/hooks/archive.mjs"

exit "$status"
