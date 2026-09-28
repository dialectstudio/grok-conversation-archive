#!/bin/sh

set -eu

find_log() {
  if [ -n "${CONVERSATION_ARCHIVE_LOG_DIR:-}" ] &&
    [ -f "$CONVERSATION_ARCHIVE_LOG_DIR/archive.log" ]
  then
    printf '%s\n' "$CONVERSATION_ARCHIVE_LOG_DIR/archive.log"
    return
  fi

  if [ -n "${GROK_PLUGIN_DATA:-}" ] &&
    [ -f "$GROK_PLUGIN_DATA/archive.log" ]
  then
    printf '%s\n' "$GROK_PLUGIN_DATA/archive.log"
    return
  fi

  if [ -f "$HOME/.grok/conversation-archive/archive.log" ]; then
    printf '%s\n' "$HOME/.grok/conversation-archive/archive.log"
    return
  fi

  find "$HOME/.grok" -name archive.log -type f 2>/dev/null | head -n 1
}

log_file=$(find_log || true)

if [ "${1:-}" = "--path" ]; then
  [ -n "$log_file" ] || {
    printf 'debug-log: no archive log yet\n' >&2
    exit 1
  }
  printf '%s\n' "$log_file"
  exit 0
fi

[ -n "$log_file" ] || {
  printf 'debug-log: no archive log yet\n' >&2
  exit 1
}

exec tail -n 80 -f "$log_file"
