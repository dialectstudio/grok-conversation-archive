#!/bin/sh

set -eu

plugin_directory=${GROK_PLUGIN_DIR:-$HOME/.grok/plugins/grok-conversation-archive}
manifest=$plugin_directory/plugin.json

fail() {
  printf 'uninstall-local: %s\n' "$*" >&2
  exit 1
}

[ -d "$plugin_directory" ] || fail "plugin directory not found: $plugin_directory"
[ ! -L "$plugin_directory" ] || fail "refusing to remove symlink: $plugin_directory"
[ -f "$manifest" ] || fail "plugin.json not found: $manifest"

name=$(
  node -e '
    const fs = require("node:fs")
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (!manifest || typeof manifest.name !== "string") process.exit(2)
    process.stdout.write(manifest.name)
  ' "$manifest"
) || fail "could not read plugin name"

[ "$name" = "grok-conversation-archive" ] ||
  fail "refusing to remove unrelated plugin: $name"

rm -rf "$plugin_directory"
printf 'Removed: %s\n' "$plugin_directory"
