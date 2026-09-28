#!/bin/sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
repository_root=$(dirname "$script_directory")
source_root=$repository_root/plugin
plugin_directory=${GROK_PLUGIN_DIR:-$HOME/.grok/plugins/grok-conversation-archive}

fail() {
  printf 'install-local: %s\n' "$*" >&2
  exit 1
}

[ -f "$source_root/plugin.json" ] || fail "plugin.json not found"
[ -f "$source_root/hooks/hooks.json" ] || fail "hooks.json not found"
[ -f "$source_root/hooks/archive.mjs" ] || fail "archive.mjs not found"
[ ! -L "$plugin_directory" ] || fail "refusing to overwrite symlink: $plugin_directory"

mkdir -p "$plugin_directory/hooks"

install_file() {
  source_file=$1
  target_file=$2
  mode=$3

  if [ -e "$target_file" ] && [ ! -f "$target_file" ]; then
    fail "target exists but is not a regular file: $target_file"
  fi

  if [ -f "$target_file" ] && cmp -s "$source_file" "$target_file"; then
    chmod "$mode" "$target_file"
    return
  fi

  if [ -f "$target_file" ]; then
    timestamp=$(date -u '+%Y%m%dT%H%M%SZ')
    backup_file=$target_file.backup-$timestamp-$$
    cp -p "$target_file" "$backup_file"
    printf 'Preserved differing deployed file: %s\n' "$backup_file"
  fi

  temporary_file=$target_file.install.$$
  trap 'rm -f "$temporary_file"' EXIT HUP INT TERM
  cp "$source_file" "$temporary_file"
  chmod "$mode" "$temporary_file"
  mv -f "$temporary_file" "$target_file"
  trap - EXIT HUP INT TERM
}

install_file "$source_root/plugin.json" "$plugin_directory/plugin.json" 0644
install_file "$source_root/hooks/hooks.json" "$plugin_directory/hooks/hooks.json" 0644
install_file "$source_root/hooks/archive.mjs" "$plugin_directory/hooks/archive.mjs" 0755

printf 'Installed: %s\n' "$plugin_directory"
printf 'Grok discovers this directory directly. grok plugin enable does not apply to it.\n'
printf 'Confirm with: grok inspect\n'
printf 'Start a new Grok session so the hooks load.\n'
