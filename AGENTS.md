---
author: dialectStudio, LLC
title: coding project - Grok Conversation Archive
subject: Grok TUI plugin development; local AI conversation archiving
description: Development instructions for the Grok TUI plugin that archives conversations as local Markdown records.
keywords: coding project; development; grok; plugin; conversation archive; markdown; javascript;
organization: dialectStudio, LLC
copyright: Coding project © 2026 dialectStudio, LLC; underlying source text and third-party materials remain the property of their respective rights holders.
---

# Project Instructions

This file defines the working conventions for the Grok Conversation Archive development project.

## Project

* Project name: `grok-conversation-archive`
* Primary language: JavaScript (ES modules, Node.js 20+)
* Platform: Grok TUI plugin hooks on macOS
* Primary directory:

```text
$HOME/Dev/dialectstudio/_internal/grok-conversation-archive
```

* Authoritative implementation:

```text
plugin/hooks/archive.mjs
```

* Installed plugin directory:

```text
$HOME/.grok/plugins/grok-conversation-archive
```

* Conversation archive root:

```text
$HOME/Documents/AI/20-conversations
```

Project conversations are stored at:

```text
$HOME/Documents/AI/20-conversations/grok/<project-name>/<session-id>/conversation.md
```

The filename is `conversation.md`, singular, matching the existing OpenCode records. Do not rename it to `conversations.md`.

## Purpose

Maintain a Grok TUI plugin that preserves Grok conversations as local, application-independent Markdown records for a later local research agent.

This repository contains the plugin source and development tooling. It does not contain archived conversations or the live Grok home directory.

## Boundaries

Do not copy these trees into the repository:

```text
$HOME/.grok
$HOME/Documents/AI
```

Do not edit the installed plugin as the normal workflow. Edit `plugin/hooks/archive.mjs`, run `make check`, then `make install-local`.

Do not use the real conversation archive as a test fixture or test output directory.

`.session_ids` in a coding project is runtime state. Preserve non-Grok lines in that file, especially OpenCode `ses_` ids. Do not modify other projects' ignore files.

## Archive behavior

* Read `summary.json` and `updates.jsonl` from `~/.grok/sessions/`. `GROK_HOME` overrides the Grok home.
* Rebuild each snapshot from those files. Do not append incremental fragments onto an existing archive.
* Replace a file only atomically, and never with an older `updated_at`.
* Skip subagent sessions. Archive forks.
* On `SessionStart`, reconcile `.session_ids` for the nearest `*.sublime-project` ancestor.
* On `Stop`, `StopFailure`, `StopCancelled`, `SessionEnd`, and `PostCompact`, archive the current root session.
* The hook must exit without blocking the turn. The writer is detached. Failures are logged and do not deny the hook.
* `snapshot_sha256` is the SHA-256 of the Markdown body, excluding the YAML header.
* Keep the YAML field set aligned with the OpenCode archives: `kind`, `project`, `source`, `provider`, `source_project_id`, `source_project_name`, `source_conversation_id`, `title`, `created_at`, `updated_at`, `snapshot_sha256`.

## Checks

```text
make check
make test
```

`make check` syntax-checks the hook and shell scripts, then runs the Node test suite.

For a change that affects hook loading, install the plugin, enable it, start a disposable Grok session, and confirm `conversation.md` was created or updated. Do not use an important production conversation for the first check.

## Deployment

```text
make install-local
make check-deployed
make uninstall-local
```

`make install-local` copies `plugin/` to `~/.grok/plugins/grok-conversation-archive` and backs up a differing deployed file before replacing it. It does not delete other plugins. Do not run `grok plugin enable` for this copy: that command only sees marketplace installs. Confirm discovery with `grok inspect`, then start a new session.

`make backfill` writes real archive files for the current project. Do not run it as part of an unrelated edit.
