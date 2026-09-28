import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { afterEach, test } from "node:test"

import {
  appendChunk,
  archiveSession,
  buildMessages,
  encodeSessionGroup,
  findSublimeProjectRoot,
  handleHookEvent,
  mergeSessionIDs,
  parseSessionIDs,
  parseUpdates,
  projectArchive,
  reconcileProjectSessions,
  renderArchiveSnapshot,
  shouldReplaceArchive,
  snapshotSHA256
} from "../plugin/hooks/archive.mjs"

const SESSION_ID = "018f3a2e-7c31-7c3a-8c3a-111111111111"
const OLDER_SESSION_ID = "018f3a2e-7c31-7c3a-8c3a-222222222222"
const temporaryDirectories = []


async function temporaryDirectory() {
  const directory = await mkdtemp(
    join(tmpdir(), "grok-conversation-archive-")
  )

  temporaryDirectories.push(directory)
  return directory
}


function updateLine(update, timestamp) {
  return JSON.stringify({
    timestamp: timestamp,
    method: "session/update",
    params: {
      sessionId: SESSION_ID,
      update: update
    }
  })
}


function syntheticUpdates() {
  return [
    updateLine({
      sessionUpdate: "user_message_chunk",
      content: {
        type: "text",
        text: "Inspect the synthetic fixture."
      },
      _meta: {
        modelId: "grok-test"
      }
    }, 1760000000),
    updateLine({
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "Look at the fixture first."
      }
    }, 1760000001),
    updateLine({
      sessionUpdate: "tool_call",
      toolCallId: "call_read_fixture",
      title: "Read fixture",
      rawInput: {
        target_file: "fixture.txt"
      },
      _meta: {
        "x.ai/tool": {
          name: "read_file",
          kind: "read"
        }
      }
    }, 1760000002),
    updateLine({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_read_fixture",
      status: "completed",
      rawOutput: {
        type: "file",
        text: "synthetic contents"
      }
    }, 1760000003),
    updateLine({
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: "The fixture is readable."
      }
    }, 1760000004),
    updateLine({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: "Archive integration complete."
      }
    }, 1760000005),
    "{\"not json",
    updateLine({
      sessionUpdate: "hook_execution",
      event_name: "stop"
    }, 1760000006)
  ].join("\n") + "\n"
}


function summaryDocument(cwd, overrides) {
  return Object.assign({
    info: {
      id: SESSION_ID,
      cwd: cwd
    },
    generated_title: "Synthetic title",
    created_at: "2026-01-02T03:04:05.000Z",
    updated_at: "2026-01-02T03:09:00.000Z",
    current_model_id: "grok-test",
    agent_name: "build",
    reasoning_effort: "high"
  }, overrides || {})
}


async function writeSession(options) {
  const group = encodeSessionGroup(options.cwd)
  const directory = join(
    options.grokHome,
    "sessions",
    group,
    options.sessionID || SESSION_ID
  )

  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, "summary.json"),
    JSON.stringify(options.summary) + "\n",
    "utf8"
  )
  await writeFile(
    join(directory, "updates.jsonl"),
    options.updates === undefined
      ? syntheticUpdates()
      : options.updates,
    "utf8"
  )

  return directory
}


function environment(root, project) {
  return {
    HOME: root,
    GROK_HOME: join(root, "grok-home"),
    CONVERSATION_ARCHIVE_ROOT: join(root, "conversations"),
    CONVERSATION_ARCHIVE_LOG_DIR: join(root, "logs"),
    GROK_WORKSPACE_ROOT: project,
    GROK_SESSION_ID: SESSION_ID
  }
}


afterEach(async function () {
  await Promise.all(
    temporaryDirectories.splice(0).map(function (directory) {
      return rm(directory, {
        recursive: true,
        force: true
      })
    })
  )
})


test("appends streaming snapshots without duplicating text", function () {
  assert.equal(appendChunk("", "Hello"), "Hello")
  assert.equal(appendChunk("Hello", "Hello world"), "Hello world")
  assert.equal(appendChunk("Hello", " world"), "Hello world")
  assert.equal(appendChunk("Hello", "Hello"), "Hello")
})


test("encodes a session group the way Grok names it", function () {
  assert.equal(
    encodeSessionGroup(
      "/Users/gregk/Dev/dialectstudio/_internal/grok-conversation-archive"
    ),
    "%2FUsers%2Fgregk%2FDev%2Fdialectstudio%2F_internal%2Fgrok-conversation-archive"
  )
})


test("keeps Grok ids and preserves foreign session lines", function () {
  const stored = [
    "ses_ROOTOLD",
    SESSION_ID,
    "not an id",
    SESSION_ID,
    ""
  ].join("\n")

  assert.deepEqual(parseSessionIDs(stored), [SESSION_ID])
  assert.equal(
    mergeSessionIDs(stored, [OLDER_SESSION_ID, SESSION_ID]),
    OLDER_SESSION_ID + "\n" +
      SESSION_ID + "\n" +
      "ses_ROOTOLD\n" +
      "not an id\n"
  )
})


test("finds the nearest Sublime project root", async function () {
  const outer = await temporaryDirectory()
  const inner = join(outer, "workspace")
  const nested = join(inner, "src", "feature")

  await mkdir(nested, { recursive: true })
  await writeFile(join(outer, "outer.sublime-project"), "{}\n")
  await writeFile(join(inner, "inner.sublime-project"), "{}\n")

  assert.equal(await findSublimeProjectRoot(nested), inner)
  assert.equal(
    await findSublimeProjectRoot(
      await temporaryDirectory()
    ),
    null
  )
})


test("selects the grok or standalone archive directory", async function () {
  const root = await temporaryDirectory()
  const conversations = join(root, "conversations")
  const project = join(root, "widget")

  assert.deepEqual(
    projectArchive(project, conversations, project),
    {
      name: "widget",
      path: join(conversations, "grok", "widget"),
      projectID: createHash("sha1")
        .update(project, "utf8")
        .digest("hex")
    }
  )

  const standalone = projectArchive(
    join(conversations, "standalone"),
    conversations,
    null
  )

  assert.equal(standalone.name, "_standalone")
  assert.equal(
    standalone.path,
    join(conversations, "standalone")
  )
})


test("renders the OpenCode archive header and conversation body", function () {
  const messages = buildMessages(parseUpdates(syntheticUpdates()))
  const snapshot = renderArchiveSnapshot(
    {
      id: SESSION_ID,
      cwd: "/synthetic/widget",
      title: "Synthetic title",
      createdAt: "2026-01-02T03:04:05.000Z",
      updatedAt: "2026-01-02T03:09:00.000Z",
      modelID: "grok-test",
      agentName: "build",
      reasoningEffort: "high"
    },
    messages,
    {
      name: "widget",
      projectID: "abc123"
    }
  )

  assert.equal(snapshot.hash, snapshotSHA256(snapshot.body))
  assert.ok(snapshot.content.startsWith([
    "---",
    'kind: "ai-conversation"',
    'project: "widget"',
    'source: "grok"',
    'provider: "xai"',
    'source_project_id: "abc123"',
    'source_project_name: "widget"',
    'source_conversation_id: "' + SESSION_ID + '"',
    'title: "Synthetic title"',
    'created_at: "2026-01-02T03:04:05.000Z"',
    'updated_at: "2026-01-02T03:09:00.000Z"',
    'snapshot_sha256: "' + snapshot.hash + '"',
    "---",
    ""
  ].join("\n")))

  const userAt = snapshot.body.indexOf("#User")
  const assistantAt = snapshot.body.indexOf("#Assistant")
  const toolAt = snapshot.body.indexOf("## Tool Call: read_file")
  const responseAt = snapshot.body.indexOf("## Response")
  const secondAssistant = snapshot.body.indexOf(
    "#Assistant",
    assistantAt + 1
  )

  assert.ok(userAt !== -1)
  assert.ok(userAt < assistantAt)
  assert.ok(assistantAt < toolAt)
  assert.ok(toolAt < secondAssistant)
  assert.ok(secondAssistant < responseAt)
  assert.match(snapshot.body, /Inspect the synthetic fixture\./)
  assert.match(snapshot.body, /Archive integration complete\./)
  assert.match(snapshot.body, /synthetic contents/)
  assert.equal(snapshot.body.includes("hook_execution"), false)
  assert.equal(snapshot.body.includes("not json"), false)

  const older = snapshot.content.replace(
    "2026-01-02T03:09:00.000Z",
    "2026-01-02T03:00:00.000Z"
  )

  assert.equal(shouldReplaceArchive("", snapshot.content), true)
  assert.equal(
    shouldReplaceArchive(snapshot.content, older),
    false
  )
  assert.equal(
    shouldReplaceArchive(older, snapshot.content),
    true
  )
  assert.equal(
    shouldReplaceArchive(snapshot.content, snapshot.content),
    false
  )
})


test("archives a session and records its id on the project", async function () {
  const root = await temporaryDirectory()
  const project = join(root, "widget")
  const env = environment(root, project)
  const cwd = join(project, "src")

  await mkdir(cwd, { recursive: true })
  await writeFile(join(project, "widget.sublime-project"), "{}\n")
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: cwd,
    summary: summaryDocument(cwd),
    updates: syntheticUpdates()
  })

  const result = await handleHookEvent({
    hook_event_name: "Stop",
    sessionId: SESSION_ID,
    cwd: cwd,
    workspaceRoot: project
  }, env)

  const target = join(
    env.CONVERSATION_ARCHIVE_ROOT,
    "grok",
    "widget",
    SESSION_ID,
    "conversation.md"
  )

  assert.equal(result.archived, true)
  assert.equal(result.target, target)
  assert.match(
    await readFile(target, "utf8"),
    /source: "grok"\nprovider: "xai"/
  )
  assert.equal(
    await readFile(join(project, ".session_ids"), "utf8"),
    SESSION_ID + "\n"
  )
})


test("a turn-ending hook also archives the project's other sessions", async function () {
  const root = await temporaryDirectory()
  const project = join(root, "widget")
  const env = environment(root, project)

  await mkdir(project, { recursive: true })
  await writeFile(join(project, "widget.sublime-project"), "{}\n")
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: project,
    summary: summaryDocument(project, {
      updated_at: "2026-02-02T00:00:00.000Z"
    })
  })
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: project,
    sessionID: OLDER_SESSION_ID,
    summary: summaryDocument(project, {
      info: {
        id: OLDER_SESSION_ID,
        cwd: project
      },
      generated_title: "Older session",
      updated_at: "2026-01-01T00:00:00.000Z"
    })
  })

  const result = await handleHookEvent({
    hook_event_name: "Stop",
    sessionId: SESSION_ID,
    cwd: project,
    workspaceRoot: project
  }, env)

  assert.equal(result.archived, true)
  assert.equal(result.sessionID, SESSION_ID)
  assert.match(
    await readFile(
      join(
        env.CONVERSATION_ARCHIVE_ROOT,
        "grok",
        "widget",
        OLDER_SESSION_ID,
        "conversation.md"
      ),
      "utf8"
    ),
    /Older session/
  )
  assert.equal(
    await readFile(join(project, ".session_ids"), "utf8"),
    SESSION_ID + "\n" + OLDER_SESSION_ID + "\n"
  )
})


test("does not replace a newer snapshot or archive a subagent", async function () {
  const root = await temporaryDirectory()
  const project = join(root, "widget")
  const env = environment(root, project)

  await mkdir(project, { recursive: true })
  await writeFile(join(project, "widget.sublime-project"), "{}\n")
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: project,
    summary: summaryDocument(project)
  })

  const target = join(
    env.CONVERSATION_ARCHIVE_ROOT,
    "grok",
    basename(project),
    SESSION_ID,
    "conversation.md"
  )
  const newer = [
    "---",
    'kind: "ai-conversation"',
    'project: "widget"',
    'source: "grok"',
    'provider: "xai"',
    'source_project_id: "kept"',
    'source_project_name: "widget"',
    'source_conversation_id: "' + SESSION_ID + '"',
    'title: "Kept"',
    'created_at: "2099-01-01T00:00:00.000Z"',
    'updated_at: "2099-01-01T00:00:00.000Z"',
    'snapshot_sha256: "kept"',
    "---",
    "#User",
    "",
    "keep this newer archive",
    ""
  ].join("\n")

  await mkdir(join(target, ".."), { recursive: true })
  await writeFile(target, newer, "utf8")

  const skipped = await archiveSession({
    sessionID: SESSION_ID,
    cwd: project,
    workspace: project,
    env: env
  })

  assert.equal(skipped.reason, "not-newer")
  assert.equal(await readFile(target, "utf8"), newer)

  const subagent = await handleHookEvent({
    hook_event_name: "SessionEnd",
    sessionId: SESSION_ID,
    cwd: project,
    workspaceRoot: project,
    subagentType: "explore"
  }, env)

  assert.equal(subagent.reason, "subagent")
})


test("reconciles project sessions without dropping OpenCode ids", async function () {
  const root = await temporaryDirectory()
  const project = join(root, "widget")
  const elsewhere = join(root, "other")
  const env = environment(root, project)

  await mkdir(project, { recursive: true })
  await mkdir(elsewhere, { recursive: true })
  await writeFile(join(project, "widget.sublime-project"), "{}\n")
  await writeFile(join(elsewhere, "other.sublime-project"), "{}\n")
  await writeFile(
    join(project, ".session_ids"),
    [
      "ses_KEEP",
      OLDER_SESSION_ID,
      ""
    ].join("\n"),
    "utf8"
  )

  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: project,
    sessionID: SESSION_ID,
    summary: summaryDocument(project, {
      updated_at: "2026-02-02T00:00:00.000Z"
    })
  })
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: project,
    sessionID: OLDER_SESSION_ID,
    summary: summaryDocument(project, {
      info: {
        id: OLDER_SESSION_ID,
        cwd: project
      },
      updated_at: "2026-01-01T00:00:00.000Z"
    }),
    updates: ""
  })
  await writeSession({
    grokHome: env.GROK_HOME,
    cwd: elsewhere,
    sessionID: "018f3a2e-7c31-7c3a-8c3a-333333333333",
    summary: summaryDocument(elsewhere, {
      info: {
        id: "018f3a2e-7c31-7c3a-8c3a-333333333333",
        cwd: elsewhere
      }
    }),
    updates: ""
  })

  const result = await reconcileProjectSessions({
    workspace: project,
    cwd: project,
    env: env
  })

  assert.equal(result.sessions, 2)
  assert.equal(
    await readFile(join(project, ".session_ids"), "utf8"),
    [
      SESSION_ID,
      OLDER_SESSION_ID,
      "ses_KEEP",
      ""
    ].join("\n")
  )
})


test("finds a session stored under the long-path group marker", async function () {
  const root = await temporaryDirectory()
  const project = join(root, "widget")
  const env = environment(root, project)
  const sessionDirectory = join(
    env.GROK_HOME,
    "sessions",
    "slug-hash",
    SESSION_ID
  )

  await mkdir(project, { recursive: true })
  await mkdir(sessionDirectory, { recursive: true })
  await writeFile(
    join(env.GROK_HOME, "sessions", "slug-hash", ".cwd"),
    project + "\n",
    "utf8"
  )
  await writeFile(join(project, "widget.sublime-project"), "{}\n")
  await writeFile(
    join(sessionDirectory, "summary.json"),
    JSON.stringify(summaryDocument(project)) + "\n",
    "utf8"
  )
  await writeFile(
    join(sessionDirectory, "updates.jsonl"),
    syntheticUpdates(),
    "utf8"
  )

  const result = await archiveSession({
    sessionID: SESSION_ID,
    cwd: project,
    workspace: project,
    env: env
  })

  assert.equal(result.archived, true)
  assert.match(result.target, /slug-hash|conversation\.md/)
  assert.match(result.target, new RegExp(SESSION_ID + "/conversation\\.md$"))
})
