# Contributing

Contributions are welcome. This plugin keeps Grok conversations as local Markdown, and help that makes those records more faithful, the hooks safer to run, or the project easier to install is useful.

Good places to start:

- Grok hook compatibility as the TUI changes
- Snapshot fidelity: what is kept, what is omitted, and how forks differ from subagent sessions
- Tests that stay on temporary directories and synthetic fixtures
- Install, logging, and documentation for people who are not developing on this machine
- Clearer failure reports when a snapshot cannot be written

## Before a pull request

1. Change `plugin/hooks/archive.mjs` and the repository scripts. Do not treat the copy under `~/.grok/plugins/` as the source.
2. Run `make check`.
3. Keep tests on temporary directories and synthetic fixtures. Do not read or write a real conversation archive, `~/.grok`, or another project's `.session_ids`.
4. Do not commit archived conversations, session logs, `.session_ids`, credentials, or editor workspace files.
5. Preserve lines in `.session_ids` that are not Grok session ids, including OpenCode `ses_` ids. Do not modify other projects' ignore files.
6. Replace an archive file only atomically, and never with an older `updated_at`.

## Bug reports

Open a GitHub issue. Include the Grok version, the Node.js version, the hook event if you know it, and a sanitized excerpt of `archive.log`.

The log is `archive.log` in `GROK_PLUGIN_DATA` when the hook sets it, otherwise `~/.grok/conversation-archive/archive.log`. Remove conversation text, tool inputs, tool outputs, paths that identify a private project, and anything that looks like a credential before posting it.

## License

By submitting a contribution, you agree that dialectStudio, LLC may include it in this repository under the MIT License in `LICENSE`.
