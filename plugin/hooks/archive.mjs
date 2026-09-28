#!/usr/bin/env node

// Grok TUI hook: archive the current session as Markdown.
//
// Repository copy is authoritative. Install it with scripts/install-local.sh.
// The hook process exits after spawning a detached writer so a Stop hook
// does not hold the turn open while the snapshot is rendered.

import { createHash, randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile
} from "node:fs/promises"
import { homedir } from "node:os"
import {
  basename,
  dirname,
  join,
  resolve
} from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const LOG_SERVICE = "grok-conversation-archive"
const SOURCE = "grok"
const PROVIDER = "xai"
const CONVERSATION_FILENAME = "conversation.md"
const SESSION_IDS_FILENAME = ".session_ids"
const SESSION_IDS_LOCK_FILENAME = ".session_ids.lock"
const LOCK_OWNER_FILENAME = "owner"
const SESSION_IDS_LOCK_STALE_MS = 120000
const SESSION_IDS_LOCK_WAIT_MS = 5000
const ARCHIVE_LOCK_WAIT_MS = 30000
const PROJECT_SESSION_LIMIT = 1000
const SESSION_GROUP_NAME_MAX_BYTES = 255

const HANDLED_EVENTS = new Set([
  "stop",
  "stop_failure",
  "stop_cancelled",
  "session_end",
  "session_start",
  "post_compact"
])


function yaml(value) {
  if (value === undefined || value === null) {
    return '""'
  }

  return JSON.stringify(String(value))
}


function iso(value) {
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value
    return new Date(milliseconds).toISOString()
  }

  return new Date().toISOString()
}


function timestampMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value)

    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return 0
}


function isMissingFile(error) {
  return Boolean(
    error &&
    typeof error === "object" &&
    error.code === "ENOENT"
  )
}


function delay(ms) {
  return new Promise(function (resolvePromise) {
    setTimeout(resolvePromise, ms)
  })
}


function sha1(value) {
  return createHash("sha1")
    .update(String(value), "utf8")
    .digest("hex")
}


function snapshotSHA256(body) {
  return createHash("sha256")
    .update(body, "utf8")
    .digest("hex")
}


function encodeSessionGroup(directory) {
  return encodeURIComponent(resolve(directory))
}


function isGrokSessionID(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value)
  )
}


function parseSessionIDs(value) {
  return splitSessionLines(value).grok
}


function splitSessionLines(value) {
  const grok = []
  const foreign = []
  const seen = new Set()

  if (typeof value !== "string") {
    return { grok, foreign }
  }

  for (const line of value.split(/\r?\n/)) {
    const sessionID = line.trim()

    if (!sessionID || seen.has(sessionID)) {
      continue
    }

    seen.add(sessionID)

    if (isGrokSessionID(sessionID)) {
      grok.push(sessionID)
    } else {
      // OpenCode stores ses_ ids in the same file. Keep those lines.
      foreign.push(sessionID)
    }
  }

  return { grok, foreign }
}


function formatSessionIDs(sessionIDs) {
  if (!sessionIDs.length) {
    return ""
  }

  return sessionIDs.join("\n") + "\n"
}


function mergeSessionIDs(existingText, grokIDs) {
  const foreign = splitSessionLines(existingText).foreign
  const grok = []
  const seen = new Set()

  for (const sessionID of grokIDs) {
    if (!isGrokSessionID(sessionID) || seen.has(sessionID)) {
      continue
    }

    seen.add(sessionID)
    grok.push(sessionID)

    if (grok.length >= PROJECT_SESSION_LIMIT) {
      break
    }
  }

  return formatSessionIDs(grok.concat(foreign))
}


function moveSessionFirst(existingText, sessionID) {
  const split = splitSessionLines(existingText)
  const grok = [sessionID]

  for (const existingID of split.grok) {
    if (existingID !== sessionID) {
      grok.push(existingID)
    }
  }

  return mergeSessionIDs(
    formatSessionIDs(split.foreign),
    grok
  )
}


function safeProjectName(name) {
  const trimmed = String(name || "").trim()

  if (!trimmed || trimmed === "." || trimmed === "..") {
    return "_unknown"
  }

  return trimmed.replaceAll("/", "_").replaceAll("\0", "")
}


function projectArchive(
  workspace,
  conversationsRoot,
  projectRoot
) {
  const standalone = join(conversationsRoot, "standalone")
  const resolvedWorkspace = resolve(workspace)
  const resolvedStandalone = resolve(standalone)
  const resolvedProject = projectRoot
    ? resolve(projectRoot)
    : resolvedWorkspace

  if (
    resolvedWorkspace === resolvedStandalone ||
    resolvedProject === resolvedStandalone
  ) {
    return {
      name: "_standalone",
      path: standalone,
      projectID: sha1(resolvedStandalone)
    }
  }

  const name = safeProjectName(basename(resolvedProject))

  return {
    name: name,
    path: join(conversationsRoot, "grok", name),
    projectID: sha1(resolvedProject)
  }
}


function stableValue(value, seen) {
  if (value === null) {
    return null
  }

  if (value === undefined) {
    return "[undefined]"
  }

  if (typeof value === "bigint") {
    return String(value)
  }

  if (
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value
  }

  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      return value
    }

    return String(value)
  }

  if (typeof value !== "object") {
    return String(value)
  }

  if (seen.has(value)) {
    return "[Circular]"
  }

  seen.add(value)

  let result

  if (Array.isArray(value)) {
    result = value.map(function (item) {
      return stableValue(item, seen)
    })
  } else {
    result = Object.create(null)

    for (const key of Object.keys(value).sort()) {
      result[key] = stableValue(value[key], seen)
    }
  }

  seen.delete(value)
  return result
}


function stableJSON(value) {
  return JSON.stringify(
    stableValue(value, new WeakSet()),
    null,
    2
  )
}


function jsonBlock(value) {
  return "```json\n" + stableJSON(value) + "\n```"
}


function appendChunk(current, next) {
  if (!next) {
    return current || ""
  }

  if (!current) {
    return next
  }

  // A longer chunk that already contains the text so far is a snapshot,
  // not a new tail. Otherwise append, which is what token deltas need.
  if (next.startsWith(current)) {
    return next
  }

  if (current.endsWith(next)) {
    return current
  }

  return current + next
}


function textOf(content) {
  if (typeof content === "string") {
    return content
  }

  if (!content || typeof content !== "object") {
    return ""
  }

  if (Array.isArray(content)) {
    let text = ""

    for (const item of content) {
      const piece = textOf(item)

      if (piece === null) {
        return null
      }

      text += piece
    }

    return text
  }

  if (
    typeof content.text === "string" &&
    (
      !content.type ||
      content.type === "text"
    )
  ) {
    return content.text
  }

  return null
}


function contentType(content) {
  if (content && typeof content === "object" && content.type) {
    return String(content.type)
  }

  return "unknown"
}


function toolMeta(update) {
  if (!update || !update._meta) {
    return null
  }

  const meta = update._meta["x.ai/tool"]

  if (!meta || typeof meta !== "object") {
    return null
  }

  return meta
}


function toolName(update) {
  const meta = toolMeta(update)

  if (meta && meta.name) {
    return String(meta.name)
  }

  if (update && update.title) {
    return String(update.title)
  }

  return "unknown"
}


function createTool(update) {
  const meta = toolMeta(update)

  return {
    toolCallId: update.toolCallId
      ? String(update.toolCallId)
      : "",
    name: toolName(update),
    kind: (meta && meta.kind) || update.kind || "",
    status: update.status ? String(update.status) : "",
    title: update.title ? String(update.title) : "",
    input: update.rawInput !== undefined
      ? update.rawInput
      : (meta && meta.input !== undefined ? meta.input : null),
    output: update.rawOutput !== undefined
      ? update.rawOutput
      : (
        update.content !== undefined
          ? update.content
          : null
      ),
    locations: update.locations || null
  }
}


function mergeTool(tool, update) {
  const meta = toolMeta(update)

  if (meta && meta.name) {
    tool.name = String(meta.name)
  }

  if (meta && meta.kind) {
    tool.kind = String(meta.kind)
  }

  if (update.kind) {
    tool.kind = String(update.kind)
  }

  if (update.status) {
    tool.status = String(update.status)
  }

  if (update.title) {
    tool.title = String(update.title)
  }

  if (update.rawInput !== undefined) {
    tool.input = update.rawInput
  }

  if (update.rawOutput !== undefined) {
    tool.output = update.rawOutput
  } else if (
    update.content !== undefined &&
    tool.output == null
  ) {
    tool.output = update.content
  }

  if (update.locations) {
    tool.locations = update.locations
  }
}


function toolPayload(tool) {
  const payload = {
    type: "tool",
    toolCallId: tool.toolCallId,
    name: tool.name,
    status: tool.status,
    input: tool.input
  }

  if (tool.kind) {
    payload.kind = tool.kind
  }

  if (tool.title) {
    payload.title = tool.title
  }

  if (tool.output !== null && tool.output !== undefined) {
    payload.output = tool.output
  }

  if (tool.locations) {
    payload.locations = tool.locations
  }

  return payload
}


function parseUpdates(text) {
  const updates = []

  if (typeof text !== "string" || !text) {
    return updates
  }

  for (const line of text.split(/\n/)) {
    if (!line.trim()) {
      continue
    }

    let value

    try {
      value = JSON.parse(line)
    } catch (error) {
      continue
    }

    const update = value &&
      value.params &&
      value.params.update
      ? value.params.update
      : value && value.update
        ? value.update
        : value

    if (
      !update ||
      typeof update !== "object" ||
      typeof update.sessionUpdate !== "string"
    ) {
      continue
    }

    if (
      value &&
      value.timestamp != null &&
      update.timestamp == null
    ) {
      updates.push(Object.assign({}, update, {
        timestamp: value.timestamp
      }))
    } else {
      updates.push(update)
    }
  }

  return updates
}


function buildMessages(updates) {
  const messages = []
  let currentModel = ""
  let user = null
  let assistant = null
  let open = null
  let stepHasTool = false
  const tools = new Map()

  function flushOpen() {
    if (!assistant || !open) {
      open = null
      return
    }

    if (open.text && open.text.trim()) {
      assistant.parts.push({
        type: open.type,
        text: open.text
      })
    }

    open = null
  }

  function closeAssistant() {
    flushOpen()

    if (assistant && assistant.parts.length) {
      messages.push(assistant)
    }

    assistant = null
    stepHasTool = false
  }

  function flushUser() {
    if (!user) {
      return
    }

    const hasText = Boolean(user.text && user.text.trim())

    if (hasText || user.parts.length) {
      messages.push(user)
    }

    user = null
  }

  function ensureUser(modelID) {
    closeAssistant()

    if (modelID) {
      currentModel = modelID
    }

    if (!user) {
      user = {
        role: "user",
        text: "",
        parts: [],
        modelID: currentModel
      }
    }
  }

  function createAssistant(time) {
    return {
      role: "assistant",
      modelID: currentModel,
      startedAt: time ?? null,
      completedAt: time ?? null,
      parts: []
    }
  }

  function beginAssistantText(time) {
    flushUser()

    if (assistant && stepHasTool && !open) {
      closeAssistant()
    }

    if (!assistant) {
      assistant = createAssistant(time)
      stepHasTool = false
    } else if (time != null) {
      assistant.completedAt = time
    }
  }

  function ensureAssistantForTool(time) {
    flushUser()

    if (!assistant) {
      assistant = createAssistant(time)
      stepHasTool = false
    } else if (time != null) {
      assistant.completedAt = time
    }
  }

  function appendText(type, text, time) {
    if (!text) {
      return
    }

    beginAssistantText(time)

    if (open && open.type !== type) {
      flushOpen()
    }

    if (!open) {
      open = {
        type: type,
        text: ""
      }
    }

    open.text = appendChunk(open.text, text)
  }

  for (const update of updates) {
    const kind = update.sessionUpdate
    const time = update.timestamp

    if (kind === "hook_execution") {
      continue
    }

    if (kind === "user_message_chunk") {
      const modelID = update._meta && update._meta.modelId
        ? String(update._meta.modelId)
        : ""

      ensureUser(modelID)

      const text = textOf(update.content)

      if (text === null) {
        user.parts.push({
          type: "part",
          partType: contentType(update.content),
          value: update.content
        })
      } else {
        user.text = appendChunk(user.text, text)
      }

      continue
    }

    if (kind === "agent_thought_chunk") {
      const text = textOf(update.content)

      if (text) {
        appendText("reasoning", text, time)
      }

      continue
    }

    if (kind === "agent_message_chunk") {
      const text = textOf(update.content)

      if (text) {
        appendText("response", text, time)
      }

      continue
    }

    if (kind === "tool_call" || kind === "tool_call_update") {
      ensureAssistantForTool(time)
      flushOpen()

      const toolID = update.toolCallId
        ? String(update.toolCallId)
        : ""
      let tool = toolID ? tools.get(toolID) : null

      if (!tool) {
        tool = createTool(update)

        if (toolID) {
          tools.set(toolID, tool)
        }

        assistant.parts.push({
          type: "tool",
          tool: tool
        })
        stepHasTool = true
      } else {
        mergeTool(tool, update)
      }

      continue
    }

    if (kind) {
      beginAssistantText(time)
      flushOpen()
      assistant.parts.push({
        type: "part",
        partType: kind,
        value: update
      })
    }
  }

  flushUser()
  closeAssistant()
  return messages
}


function renderPart(part) {
  if (!part || part.type === "reasoning") {
    const text = part && part.text
      ? String(part.text).trim()
      : ""

    if (!text) {
      return ""
    }

    return "## Reasoning\n\n" + jsonBlock({
      type: "reasoning",
      text: text
    })
  }

  if (part.type === "response") {
    const text = String(part.text || "").trim()

    if (!text) {
      return ""
    }

    return "## Response\n\n" + text
  }

  if (part.type === "tool") {
    const name = part.tool && part.tool.name
      ? part.tool.name
      : "unknown"

    return "## Tool Call: " + name + "\n\n" +
      jsonBlock(toolPayload(part.tool))
  }

  const partType = part.partType
    ? String(part.partType)
    : "unknown"

  return "## Part: " + partType + "\n\n" +
    jsonBlock(part.value)
}


function assistantMetadata(message, summary) {
  const metadata = {
    providerID: PROVIDER,
    modelID: message.modelID || summary.modelID || "unknown",
    sessionID: summary.id,
    role: "assistant"
  }

  if (summary.agentName) {
    metadata.agent = summary.agentName
  }

  if (summary.reasoningEffort) {
    metadata.reasoning_effort = summary.reasoningEffort
  }

  if (summary.cwd) {
    metadata.path = {
      cwd: summary.cwd
    }
  }

  if (message.startedAt != null || message.completedAt != null) {
    metadata.time = {}

    if (message.startedAt != null) {
      metadata.time.created = iso(message.startedAt)
    }

    if (message.completedAt != null) {
      metadata.time.completed = iso(message.completedAt)
    }
  }

  return metadata
}


function renderMessage(message, summary) {
  if (!message) {
    return ""
  }

  if (message.role === "user") {
    const sections = []
    const text = String(message.text || "").trim()

    if (text) {
      sections.push(text)
    }

    for (const part of message.parts || []) {
      const rendered = renderPart(part)

      if (rendered) {
        sections.push(rendered)
      }
    }

    if (!sections.length) {
      return ""
    }

    return "#User\n\n" + sections.join("\n\n")
  }

  if (message.role !== "assistant") {
    return ""
  }

  const sections = [
    "## Metadata\n\n" + jsonBlock(
      assistantMetadata(message, summary)
    )
  ]

  for (const part of message.parts || []) {
    const rendered = renderPart(part)

    if (rendered) {
      sections.push(rendered)
    }
  }

  if (sections.length === 1) {
    return ""
  }

  return "#Assistant\n\n" + sections.join("\n\n")
}


function renderConversationBody(messages, summary) {
  const bodyParts = []

  for (const message of messages) {
    const rendered = renderMessage(message, summary)

    if (rendered) {
      bodyParts.push(rendered)
    }
  }

  let body = bodyParts.join("\n\n")

  if (body.length) {
    body += "\n"
  }

  return body
}


function renderArchiveSnapshot(
  summary,
  messages,
  archiveProject
) {
  const body = renderConversationBody(messages, summary)
  const hash = snapshotSHA256(body)
  const title = summary.title || "Untitled"
  const header = [
    "---",
    'kind: "ai-conversation"',
    "project: " + yaml(archiveProject.name),
    'source: "' + SOURCE + '"',
    "provider: " + yaml(PROVIDER),
    "source_project_id: " + yaml(archiveProject.projectID),
    "source_project_name: " + yaml(archiveProject.name),
    "source_conversation_id: " + yaml(summary.id),
    "title: " + yaml(title),
    "created_at: " + yaml(iso(summary.createdAt)),
    "updated_at: " + yaml(iso(summary.updatedAt)),
    "snapshot_sha256: " + yaml(hash),
    "---",
    ""
  ].join("\n")

  return {
    body: body,
    hash: hash,
    content: header + body
  }
}


function headerValue(content, field) {
  const match = new RegExp(
    "^" + field + ": (.+)$",
    "m"
  ).exec(content || "")

  if (!match) {
    return ""
  }

  try {
    return JSON.parse(match[1])
  } catch (error) {
    return ""
  }
}


function archiveUpdatedMilliseconds(content) {
  return timestampMilliseconds(
    headerValue(content, "updated_at")
  )
}


function shouldReplaceArchive(current, candidate) {
  if (!current) {
    return true
  }

  const currentUpdated = archiveUpdatedMilliseconds(current)
  const candidateUpdated = archiveUpdatedMilliseconds(candidate)

  if (
    Number.isFinite(currentUpdated) &&
    Number.isFinite(candidateUpdated) &&
    currentUpdated !== 0 &&
    candidateUpdated !== 0
  ) {
    if (candidateUpdated > currentUpdated) {
      return true
    }

    if (candidateUpdated < currentUpdated) {
      return false
    }
  }

  const currentHash = headerValue(current, "snapshot_sha256")
  const candidateHash = headerValue(candidate, "snapshot_sha256")

  if (currentHash && candidateHash) {
    return currentHash !== candidateHash
  }

  return current !== candidate
}


function normalizeSummary(raw, sessionID) {
  const source = raw && typeof raw === "object" ? raw : {}
  const info = source.info && typeof source.info === "object"
    ? source.info
    : {}
  const subagentType = source.subagent_type || source.subagentType || ""

  return {
    id: info.id || sessionID,
    cwd: info.cwd || "",
    title: source.generated_title ||
      source.session_summary ||
      "Untitled",
    createdAt: source.created_at || "",
    updatedAt: source.updated_at || "",
    modelID: source.current_model_id || "",
    agentName: source.agent_name || "",
    reasoningEffort: source.reasoning_effort || "",
    parentSessionID: source.parent_session_id || "",
    subagentType: subagentType ? String(subagentType) : "",
    isSubagent: Boolean(
      source.is_subagent ||
      subagentType
    )
  }
}


function normalizeEventName(event) {
  const raw = event && (
    event.hook_event_name ||
    event.hookEventName
  )

  if (!raw) {
    return ""
  }

  return String(raw)
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]/g, "_")
    .toLowerCase()
}


function eventSessionID(event, env) {
  if (event && typeof event.sessionId === "string") {
    return event.sessionId
  }

  if (event && typeof event.session_id === "string") {
    return event.session_id
  }

  if (env && typeof env.GROK_SESSION_ID === "string") {
    return env.GROK_SESSION_ID
  }

  return ""
}


function eventWorkspace(event, env) {
  if (event && typeof event.workspaceRoot === "string") {
    return event.workspaceRoot
  }

  if (event && typeof event.workspace_root === "string") {
    return event.workspace_root
  }

  if (env && typeof env.GROK_WORKSPACE_ROOT === "string") {
    return env.GROK_WORKSPACE_ROOT
  }

  if (event && typeof event.cwd === "string") {
    return event.cwd
  }

  return ""
}


function eventCwd(event, env) {
  if (event && typeof event.cwd === "string" && event.cwd) {
    return event.cwd
  }

  return eventWorkspace(event, env)
}


function isSubagentEvent(event) {
  return Boolean(
    event &&
    (
      event.subagentType ||
      event.subagent_type
    )
  )
}


function homeDirectory(env) {
  if (env && env.HOME) {
    return env.HOME
  }

  return homedir()
}


function conversationsRootFrom(env) {
  if (env && env.CONVERSATION_ARCHIVE_ROOT) {
    return env.CONVERSATION_ARCHIVE_ROOT
  }

  return join(
    homeDirectory(env),
    "Documents",
    "AI",
    "20-conversations"
  )
}


function grokHomeFrom(env) {
  if (env && env.GROK_HOME) {
    return env.GROK_HOME
  }

  return join(homeDirectory(env), ".grok")
}


function logDirectory(env) {
  if (env && env.CONVERSATION_ARCHIVE_LOG_DIR) {
    return env.CONVERSATION_ARCHIVE_LOG_DIR
  }

  if (env && env.GROK_PLUGIN_DATA) {
    return env.GROK_PLUGIN_DATA
  }

  return join(
    homeDirectory(env),
    ".grok",
    "conversation-archive"
  )
}


async function log(level, message, extra, env) {
  const entry = Object.assign(
    {
      time: new Date().toISOString(),
      level: level,
      service: LOG_SERVICE,
      message: message
    },
    extra || {}
  )
  const line = JSON.stringify(entry) + "\n"

  try {
    const directory = logDirectory(env)
    await mkdir(directory, { recursive: true })
    await appendFile(
      join(directory, "archive.log"),
      line,
      "utf8"
    )
  } catch (error) {
    // Logging must never block archival.
  }
}


function errorDetails(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message
    }
  }

  return {
    message: String(error)
  }
}


async function pathExists(target) {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (isMissingFile(error)) {
      return false
    }

    throw error
  }
}


async function readTextStable(target) {
  let previous = null
  let text = ""

  for (let attempt = 0; attempt < 5; attempt++) {
    text = await readFile(target, "utf8")

    if (text === previous) {
      return text
    }

    previous = text

    if (attempt < 4) {
      await delay(50)
    }
  }

  return text
}


async function atomicWriteFile(target, content) {
  await mkdir(dirname(target), { recursive: true })

  const temporary = target + "." +
    String(process.pid) + "." +
    randomBytes(8).toString("hex") +
    ".tmp"

  try {
    await writeFile(temporary, content, "utf8")
    await rename(temporary, target)
  } catch (error) {
    try {
      await unlink(temporary)
    } catch (cleanupError) {
      if (!isMissingFile(cleanupError)) {
        // Preserve the original write failure.
      }
    }

    throw error
  }
}


async function findSublimeProjectRoot(startDirectory) {
  let current = resolve(startDirectory)

  while (true) {
    let entries

    try {
      entries = await readdir(current, {
        withFileTypes: true
      })
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }

      return null
    }

    const found = entries.some(function (entry) {
      if (!entry || typeof entry.name !== "string") {
        return false
      }

      if (!entry.name.endsWith(".sublime-project")) {
        return false
      }

      if (typeof entry.isFile !== "function") {
        return true
      }

      return entry.isFile()
    })

    if (found) {
      return current
    }

    const parent = dirname(current)

    if (parent === current) {
      return null
    }

    current = parent
  }
}


async function readOptionalText(target) {
  try {
    return await readFile(target, "utf8")
  } catch (error) {
    if (isMissingFile(error)) {
      return ""
    }

    throw error
  }
}


async function findSessionGroup(sessionsRoot, directory) {
  if (!directory) {
    return null
  }

  const resolvedDirectory = resolve(directory)
  const encoded = encodeSessionGroup(resolvedDirectory)

  if (Buffer.byteLength(encoded) <= SESSION_GROUP_NAME_MAX_BYTES) {
    const direct = join(sessionsRoot, encoded)

    if (await pathExists(direct)) {
      return direct
    }
  }

  let entries

  try {
    entries = await readdir(sessionsRoot, {
      withFileTypes: true
    })
  } catch (error) {
    if (isMissingFile(error)) {
      return null
    }

    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const group = join(sessionsRoot, entry.name)
    const recorded = (await readOptionalText(
      join(group, ".cwd")
    )).trim()

    if (
      recorded &&
      resolve(recorded) === resolvedDirectory
    ) {
      return group
    }

    try {
      if (
        resolve(decodeURIComponent(entry.name)) ===
          resolvedDirectory
      ) {
        return group
      }
    } catch (error) {
      // Ignore groups whose names are not URL-encoded paths.
    }
  }

  return null
}


async function hasSessionFiles(directory) {
  return (
    await pathExists(join(directory, "summary.json")) ||
    await pathExists(join(directory, "updates.jsonl"))
  )
}


async function findSessionDirectory(
  grokHome,
  sessionID,
  directories
) {
  const sessionsRoot = join(grokHome, "sessions")

  for (const directory of directories) {
    if (!directory) {
      continue
    }

    const group = await findSessionGroup(
      sessionsRoot,
      directory
    )

    if (!group) {
      continue
    }

    const candidate = join(group, sessionID)

    if (await hasSessionFiles(candidate)) {
      return candidate
    }
  }

  let entries

  try {
    entries = await readdir(sessionsRoot, {
      withFileTypes: true
    })
  } catch (error) {
    if (isMissingFile(error)) {
      return null
    }

    throw error
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const candidate = join(
      sessionsRoot,
      entry.name,
      sessionID
    )

    if (await hasSessionFiles(candidate)) {
      return candidate
    }
  }

  return null
}


async function loadSummary(directory, sessionID) {
  const target = join(directory, "summary.json")

  if (!await pathExists(target)) {
    return normalizeSummary({}, sessionID)
  }

  const text = await readTextStable(target)
  return normalizeSummary(JSON.parse(text), sessionID)
}


async function loadMessages(directory) {
  const target = join(directory, "updates.jsonl")

  if (!await pathExists(target)) {
    return []
  }

  const text = await readTextStable(target)
  return buildMessages(parseUpdates(text))
}


async function belongsToProject(
  sessionCwd,
  projectRoot,
  workspace
) {
  if (!sessionCwd) {
    return false
  }

  if (projectRoot) {
    const root = await findSublimeProjectRoot(sessionCwd)
    return (
      root !== null &&
      resolve(root) === resolve(projectRoot)
    )
  }

  return resolve(sessionCwd) === resolve(workspace)
}


async function listCandidateSessions(grokHome) {
  const sessionsRoot = join(grokHome, "sessions")
  const sessions = []
  let groups

  try {
    groups = await readdir(sessionsRoot, {
      withFileTypes: true
    })
  } catch (error) {
    if (isMissingFile(error)) {
      return sessions
    }

    throw error
  }

  for (const group of groups) {
    if (!group.isDirectory() || group.name.startsWith(".")) {
      continue
    }

    const groupPath = join(sessionsRoot, group.name)
    let entries

    try {
      entries = await readdir(groupPath, {
        withFileTypes: true
      })
    } catch (error) {
      if (isMissingFile(error)) {
        continue
      }

      throw error
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !isGrokSessionID(entry.name)
      ) {
        continue
      }

      const directory = join(groupPath, entry.name)

      if (!await hasSessionFiles(directory)) {
        continue
      }

      try {
        const summary = await loadSummary(
          directory,
          entry.name
        )

        sessions.push({
          id: entry.name,
          directory: directory,
          summary: summary,
          updated: timestampMilliseconds(summary.updatedAt)
        })
      } catch (error) {
        sessions.push({
          id: entry.name,
          directory: directory,
          summary: null,
          updated: 0,
          unreadable: true
        })
      }
    }
  }

  return sessions
}


async function withDirectoryLock(
  lockPath,
  operation,
  waitMilliseconds
) {
  const owner = [
    process.pid,
    Date.now(),
    randomBytes(8).toString("hex")
  ].join("-")
  const ownerPath = join(lockPath, LOCK_OWNER_FILENAME)
  const deadline = Date.now() + (
    waitMilliseconds === undefined
      ? SESSION_IDS_LOCK_WAIT_MS
      : waitMilliseconds
  )

  await mkdir(dirname(lockPath), { recursive: true })

  while (true) {
    try {
      await mkdir(lockPath)
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error
      }

      try {
        const lockInfo = await stat(lockPath)

        if (
          Date.now() - lockInfo.mtimeMs >
            SESSION_IDS_LOCK_STALE_MS
        ) {
          await rm(lockPath, {
            recursive: true,
            force: true
          })
          continue
        }
      } catch (lockError) {
        if (isMissingFile(lockError)) {
          continue
        }

        throw lockError
      }

      if (Date.now() >= deadline) {
        throw new Error(
          "timed out waiting for filesystem lock"
        )
      }

      await delay(25)
      continue
    }

    try {
      await writeFile(ownerPath, owner, "utf8")
    } catch (error) {
      await rm(lockPath, {
        recursive: true,
        force: true
      })
      throw error
    }

    break
  }

  const heartbeat = setInterval(function () {
    const now = new Date()
    void utimes(lockPath, now, now).catch(function () {})
  }, Math.floor(SESSION_IDS_LOCK_STALE_MS / 3))

  if (typeof heartbeat.unref === "function") {
    heartbeat.unref()
  }

  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)

    try {
      const currentOwner = await readFile(ownerPath, "utf8")

      if (currentOwner === owner) {
        await rm(lockPath, {
          recursive: true,
          force: true
        })
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error
      }
    }
  }
}


async function readSessionIDFile(projectRoot) {
  return readOptionalText(
    join(projectRoot, SESSION_IDS_FILENAME)
  )
}


async function writeSessionIDFile(projectRoot, content) {
  const target = join(projectRoot, SESSION_IDS_FILENAME)
  const previous = await readOptionalText(target)

  if (previous === content) {
    return false
  }

  await atomicWriteFile(target, content)
  return true
}


async function trackSession(projectRoot, sessionID, env) {
  if (!projectRoot || !isGrokSessionID(sessionID)) {
    return false
  }

  return withDirectoryLock(
    join(projectRoot, SESSION_IDS_LOCK_FILENAME),
    async function () {
      const current = await readSessionIDFile(projectRoot)
      const content = moveSessionFirst(current, sessionID)
      return writeSessionIDFile(projectRoot, content)
    }
  ).catch(async function (error) {
    await log(
      "error",
      "session ID update failed",
      {
        sessionID: sessionID,
        projectRoot: projectRoot,
        error: errorDetails(error)
      },
      env
    )
    return false
  })
}


async function reconcileProjectSessions(options) {
  const env = options.env || {}
  const workspace = options.workspace || options.cwd

  if (!workspace) {
    return { updated: false, sessions: 0 }
  }

  const projectRoot = options.projectRoot !== undefined
    ? options.projectRoot
    : await findSublimeProjectRoot(workspace)

  if (!projectRoot) {
    return { updated: false, sessions: 0, reason: "no-project" }
  }

  const grokHome = options.grokHome || grokHomeFrom(env)
  const candidates = await listCandidateSessions(grokHome)
  const relevant = []
  const unreadable = []

  for (const session of candidates) {
    if (session.unreadable || !session.summary) {
      unreadable.push(session.id)
      continue
    }

    if (session.summary.isSubagent) {
      continue
    }

    const sessionCwd = session.summary.cwd || ""

    if (
      await belongsToProject(
        sessionCwd,
        projectRoot,
        workspace
      )
    ) {
      relevant.push(session)
    }
  }

  if (unreadable.length) {
    await log(
      "warn",
      "preserved unreadable session IDs",
      {
        projectRoot: projectRoot,
        unverifiedSessions: unreadable.length
      },
      env
    )
  }

  relevant.sort(function (left, right) {
    const difference = right.updated - left.updated

    if (difference) {
      return difference
    }

    return String(right.id).localeCompare(String(left.id))
  })

  const sessionIDs = relevant.map(function (session) {
    return session.id
  })

  const changed = await withDirectoryLock(
    join(projectRoot, SESSION_IDS_LOCK_FILENAME),
    async function () {
      const current = await readSessionIDFile(projectRoot)
      const preserved = parseSessionIDs(current).filter(
        function (sessionID) {
          return unreadable.includes(sessionID)
        }
      )

      return writeSessionIDFile(
        projectRoot,
        mergeSessionIDs(
          current,
          sessionIDs.concat(preserved)
        )
      )
    }
  )

  await log(
    "info",
    "session reconciliation complete",
    {
      projectRoot: projectRoot,
      sessions: sessionIDs.length,
      changed: changed
    },
    env
  )

  return {
    updated: changed,
    sessions: sessionIDs.length
  }
}


async function archiveSession(options) {
  const env = options.env || {}
  const sessionID = options.sessionID

  if (!isGrokSessionID(sessionID)) {
    return {
      archived: false,
      reason: "invalid-session-id"
    }
  }

  const workspace = options.workspace || options.cwd || ""
  const cwd = options.cwd || workspace
  const grokHome = options.grokHome || grokHomeFrom(env)
  const conversationsRoot = options.conversationsRoot ||
    conversationsRootFrom(env)
  const directory = await findSessionDirectory(
    grokHome,
    sessionID,
    [cwd, workspace]
  )

  if (!directory) {
    await log(
      "error",
      "session directory not found",
      {
        sessionID: sessionID,
        cwd: cwd
      },
      env
    )
    return {
      archived: false,
      reason: "missing-session"
    }
  }

  const summary = await loadSummary(directory, sessionID)

  if (summary.isSubagent) {
    return {
      archived: false,
      reason: "subagent"
    }
  }

  const projectRoot = workspace
    ? await findSublimeProjectRoot(workspace)
    : null
  const archiveProject = projectArchive(
    summary.cwd || workspace || cwd,
    conversationsRoot,
    projectRoot
  )
  const messages = await loadMessages(directory)
  const snapshot = renderArchiveSnapshot(
    summary,
    messages,
    archiveProject
  )

  if (!snapshot.body) {
    return {
      archived: false,
      reason: "empty"
    }
  }

  if (projectRoot) {
    await trackSession(projectRoot, sessionID, env)
  }

  const target = join(
    archiveProject.path,
    sessionID,
    CONVERSATION_FILENAME
  )

  const replaced = await withDirectoryLock(
    target + ".lock",
    async function () {
      const current = await readOptionalText(target)

      if (!shouldReplaceArchive(current, snapshot.content)) {
        return false
      }

      await atomicWriteFile(target, snapshot.content)
      return true
    },
    ARCHIVE_LOCK_WAIT_MS
  )

  await log(
    replaced ? "info" : "debug",
    replaced ? "archive complete" : "archive snapshot not newer",
    {
      sessionID: sessionID,
      target: target,
      snapshotSHA256: snapshot.hash
    },
    env
  )

  return {
    archived: replaced,
    reason: replaced ? "written" : "not-newer",
    target: target,
    hash: snapshot.hash
  }
}


async function backfillProject(options) {
  const env = options.env || {}
  const workspace = options.workspace || options.cwd || process.cwd()
  const grokHome = options.grokHome || grokHomeFrom(env)
  const conversationsRoot = options.conversationsRoot ||
    conversationsRootFrom(env)
  const projectRoot = await findSublimeProjectRoot(workspace)
  const candidates = await listCandidateSessions(grokHome)
  const results = []

  for (const session of candidates) {
    if (!session.summary || session.summary.isSubagent) {
      continue
    }

    const sessionCwd = session.summary.cwd || workspace

    if (
      !await belongsToProject(
        sessionCwd,
        projectRoot,
        workspace
      )
    ) {
      continue
    }

    try {
      results.push(Object.assign(
        { sessionID: session.id },
        await archiveSession({
          sessionID: session.id,
          cwd: sessionCwd,
          workspace: workspace,
          grokHome: grokHome,
          conversationsRoot: conversationsRoot,
          env: env
        })
      ))
    } catch (error) {
      await log(
        "error",
        "archive failed",
        {
          sessionID: session.id,
          error: errorDetails(error)
        },
        env
      )
      results.push({
        sessionID: session.id,
        archived: false,
        reason: "error"
      })
    }
  }

  await reconcileProjectSessions({
    workspace: workspace,
    cwd: workspace,
    projectRoot: projectRoot,
    grokHome: grokHome,
    env: env
  })

  return results
}


async function handleHookEvent(event, env) {
  const sourceEvent = event || {}
  const sourceEnv = env || {}

  if (isSubagentEvent(sourceEvent)) {
    return {
      archived: false,
      reason: "subagent"
    }
  }

  const name = normalizeEventName(sourceEvent)

  if (name && !HANDLED_EVENTS.has(name)) {
    return {
      archived: false,
      reason: "ignored"
    }
  }

  const sessionID = eventSessionID(sourceEvent, sourceEnv)
  const cwd = eventCwd(sourceEvent, sourceEnv)
  const workspace = eventWorkspace(sourceEvent, sourceEnv) || cwd

  try {
    const results = await backfillProject({
      cwd: cwd,
      workspace: workspace,
      env: sourceEnv
    })
    const current = results.find(function (result) {
      return result.sessionID === sessionID
    })

    if (current) {
      return current
    }

    return {
      archived: false,
      reason: sessionID ? "missing-session" : "maintained",
      sessions: results.length
    }
  } catch (error) {
    await log(
      "error",
      "archive failed",
      {
        sessionID: sessionID,
        error: errorDetails(error)
      },
      sourceEnv
    )
    return {
      archived: false,
      reason: "error"
    }
  }
}


function argumentValue(args, name) {
  const index = args.indexOf(name)

  if (index === -1) {
    return ""
  }

  return args[index + 1] || ""
}


function isDirectRun() {
  const entry = process.argv[1]

  if (!entry) {
    return false
  }

  try {
    return realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(entry)
  } catch (error) {
    return import.meta.url === pathToFileURL(resolve(entry)).href
  }
}


async function readStdin() {
  const chunks = []

  for await (const chunk of process.stdin) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks).toString("utf8")
}


function spawnDetached(raw) {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(import.meta.url),
      "--archive-run"
    ],
    {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: process.env
    }
  )

  return new Promise(function (resolvePromise, rejectPromise) {
    child.on("error", rejectPromise)
    child.stdin.write(raw, "utf8", function (error) {
      if (error) {
        rejectPromise(error)
        return
      }

      child.stdin.end(function () {
        child.unref()
        resolvePromise()
      })
    })
  })
}


async function main() {
  const args = process.argv.slice(2)
  const env = process.env
  const cwd = argumentValue(args, "--cwd") || process.cwd()

  if (args.includes("--backfill")) {
    await backfillProject({
      cwd: cwd,
      workspace: cwd,
      env: env
    })
    return
  }

  const sessionID = argumentValue(args, "--session")

  if (sessionID) {
    await archiveSession({
      sessionID: sessionID,
      cwd: cwd,
      workspace: cwd,
      env: env
    })
    return
  }

  const raw = await readStdin()
  let event = {}

  if (raw.trim()) {
    try {
      event = JSON.parse(raw)
    } catch (error) {
      await log(
        "error",
        "hook payload was not valid JSON",
        { error: errorDetails(error) },
        env
      )
      return
    }
  }

  const runInline = args.includes("--foreground") ||
    args.includes("--archive-run")

  if (!args.includes("--archive-run")) {
    await log(
      "info",
      "hook accepted",
      {
        event: normalizeEventName(event) || "unspecified",
        sessionID: eventSessionID(event, env)
      },
      env
    )
  }

  if (!runInline) {
    try {
      await spawnDetached(raw)
      return
    } catch (error) {
      await log(
        "warn",
        "detached archive failed; running inline",
        { error: errorDetails(error) },
        env
      )
    }
  }

  await handleHookEvent(event, env)
}


if (isDirectRun()) {
  main().catch(async function (error) {
    try {
      await log(
        "error",
        "archive hook failed",
        { error: errorDetails(error) },
        process.env
      )
    } catch (logError) {
      // The hook must fail open.
    }
  })
}


export {
  appendChunk,
  archiveSession,
  archiveUpdatedMilliseconds,
  backfillProject,
  buildMessages,
  encodeSessionGroup,
  findSublimeProjectRoot,
  formatSessionIDs,
  handleHookEvent,
  isGrokSessionID,
  mergeSessionIDs,
  moveSessionFirst,
  parseSessionIDs,
  parseUpdates,
  projectArchive,
  reconcileProjectSessions,
  renderArchiveSnapshot,
  safeProjectName,
  shouldReplaceArchive,
  snapshotSHA256
}
