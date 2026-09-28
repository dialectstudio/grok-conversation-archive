# Grok Conversation Archive

A Grok TUI plugin that writes durable Markdown snapshots of Grok conversations on the local machine. Repository source is authoritative. The installed plugin, Grok's session store, and the generated conversation records stay outside this repository.

The plugin reads `summary.json` and `updates.jsonl` under `~/.grok/sessions/`. It does not call the model. `GROK_HOME` overrides the Grok home directory.

Repository: [github.com/dialectstudio/grok-conversation-archive](https://github.com/dialectstudio/grok-conversation-archive)

## Requirements

- macOS. The plugin is a Grok TUI hook and is developed on macOS.
- Grok TUI.
- Node.js 20 or newer. The hook and the tests use Node. There are no runtime dependencies.

## Install

The installable plugin is the `plugin/` directory, not the repository root.

After this repository is public, install that directory and trust its hooks:

```sh
grok plugin install dialectstudio/grok-conversation-archive#plugin --trust
```

The `#plugin` suffix selects `plugin/`. Omit `--trust` if you want Grok to show the source and ask before the hooks are activated. Start a new Grok session so the hooks load.

For development, copy the same directory into `~/.grok/plugins/grok-conversation-archive`:

```sh
make install-local
```

That path is `$HOME/.grok`, not `~/.config/grok`. Grok has no `~/.config/grok` directory. `grok plugin list` and `grok plugin enable` only know plugins registered with `grok plugin install`, so they report this plugin as missing even after a successful local install. A plugin placed in `~/.grok/plugins/` is discovered and trusted directly. Confirm it with `grok inspect`: it appears under Plugins as `grok-conversation-archive (user, enabled)`.

`GROK_PLUGIN_DIR` overrides the destination. A differing deployed file is copied aside with a `.backup-*` suffix before it is replaced. Check the deployed copy with `make check-deployed`. Remove that installed directory with `make uninstall-local`. Start a new Grok session after installing so the hooks load.

## Archive output

Project conversations are written beneath:

```text
~/Documents/AI/20-conversations/grok/<project-name>/<session-id>/conversation.md
```

`CONVERSATION_ARCHIVE_ROOT` replaces `~/Documents/AI/20-conversations` when it is set. The record filename is `conversation.md`, matching the OpenCode archives already in that tree. The YAML header uses the same fields:

```text
kind, project, source, provider, source_project_id,
source_project_name, source_conversation_id, title,
created_at, updated_at, snapshot_sha256
```

`source` is `grok`. `provider` is `xai`. `source_project_id` is the SHA-1 of the project root path. `snapshot_sha256` covers the Markdown body only, not the header.

The body keeps user text, assistant metadata, reasoning, the assistant response, and tool calls with their inputs and outputs. Hook-execution events are omitted. Child sessions are not archived when a hook payload includes `subagentType`, or when `summary.json` marks the session as a subagent. Forks are archived.

A session opened in `~/Documents/AI/20-conversations/standalone` is written directly under that `standalone/` directory, with project name `_standalone`. With `CONVERSATION_ARCHIVE_ROOT` set, the same rule applies to a `standalone` directory inside that root.

Archive files are replaced with a same-directory temporary file and rename. An older snapshot does not replace a newer one. A same-timestamp snapshot is replaced when its body hash differs.

These records can contain the full conversation, including tool inputs and outputs. They are local files. Do not commit them, and do not put `~/.grok` or `~/Documents/AI` into this repository.

## Project sessions

When Grok is running under a directory with a `*.sublime-project` ancestor, the nearest such ancestor is the project root. The plugin maintains:

```text
$PROJECT_ROOT/.session_ids
```

The file contains one root Grok session id per line, newest or most recently active first. Ids are UUIDs. Lines that are not Grok ids, including OpenCode `ses_` ids, are preserved. OpenCode's own reconciler still rewrites this file with only `ses_` ids, so a later OpenCode session in the same project can drop Grok ids until the next Grok reconciliation.

No `.session_ids` file is created when no `*.sublime-project` ancestor exists. Conversation archival still runs.

`.session_ids` is runtime state. This repository ignores it. The plugin does not edit other projects' ignore files.

## Plugin

The installable plugin is `plugin/`:

```text
plugin/plugin.json
plugin/hooks/hooks.json
plugin/hooks/archive.mjs
```

`plugin/hooks/archive.mjs` is the hook and the archive implementation.

Hooks run on `SessionStart`, `Stop`, `StopFailure`, `StopCancelled`, `SessionEnd`, and `PostCompact`. The hook process detaches the writer and exits so the turn is not held open for the snapshot. `SessionStart` also reconciles `.session_ids`.

## Development

Run the local checks:

```sh
make check
```

Run tests only:

```sh
make test
```

Tests use temporary directories and synthetic fixtures. They do not read or write the real conversation archive.

Backfill the current Sublime project from sessions already on disk:

```sh
make backfill
```

That command writes into the real archive and updates the current project's `.session_ids`. Do not run it as part of an unrelated change.

Start Grok for this project, resuming the newest stored Grok session when one exists:

```sh
make start
```

Arguments passed to `scripts/grok-project.sh` are forwarded to `grok` and skip automatic resume. Set `GROK_BIN` when `grok` is not on `PATH`.

Follow the plugin log:

```sh
make debug
```

The log is `archive.log` in `GROK_PLUGIN_DATA` when the hook sets it, otherwise `~/.grok/conversation-archive/archive.log`.

## Contributing

Contributions are welcome. Useful work includes keeping the hooks compatible with Grok, making the Markdown snapshot more faithful, and adding tests that never touch a real archive.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or a pull request. Bug reports belong on GitHub. Include the Grok and Node.js versions and a sanitized log excerpt, not conversation text or tool output.

## License

Original code and documentation in this repository are available under the MIT License. Copyright (c) 2026 dialectStudio, LLC. See [LICENSE](LICENSE).
