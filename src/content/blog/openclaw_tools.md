---
title: openclaw Agent Tools 清单
date: 2026-03-09
description: openclaw 分析文档 by claude opus
category: 架构分析
---
# OpenClaw Agent Tools 全量清单

> 基于 `openclaw/` 源码整理，涵盖核心工具、编码工具、渠道工具和扩展插件工具。

---

## 1. 工具总览

OpenClaw 的工具注册分为以下几层：

| 层级 | 入口文件 | 说明 |
|------|---------|------|
| 编码工具 (Coding Tools) | `src/agents/pi-tools.ts` → `createOpenClawCodingTools()` | read/write/edit/exec/process/apply_patch，来自 `@mariozechner/pi-coding-agent` 并由 OpenClaw 增强 |
| OpenClaw 核心工具 | `src/agents/openclaw-tools.ts` → `createOpenClawTools()` | browser/canvas/nodes/cron/message/tts 等 OpenClaw 自有工具 |
| 渠道工具 (Channel Tools) | `src/agents/channel-tools.ts` → `listChannelAgentTools()` | 各消息渠道（Discord/Slack/Telegram/WhatsApp）的 action 工具 |
| 插件工具 (Plugin Tools) | `src/plugins/tools.ts` → `resolvePluginTools()` | 通过 `api.registerTool()` 动态注册的扩展插件工具 |
| 工具目录 (Tool Catalog) | `src/agents/tool-catalog.ts` | 定义工具 profile（minimal/coding/messaging/full）和分组 |

---

## 2. 编码工具 (Coding Tools)

来自 `@mariozechner/pi-coding-agent`，经 OpenClaw 包装增强（沙箱支持、workspace 守卫等）。

### 2.1 `read` — 读取文件内容

- **描述**: Read file contents
- **来源**: `@mariozechner/pi-coding-agent` 中的 `readTool`，经 `createOpenClawReadTool()` 包装
- **代码位置**: `src/agents/pi-tools.ts:336-357`、`src/agents/pi-tools.read.ts`
- **Profile**: coding

### 2.2 `write` — 创建/覆盖写入文件

- **描述**: Create or overwrite files
- **来源**: `@mariozechner/pi-coding-agent` 中的 `writeTool`，经 `createHostWorkspaceWriteTool()` 包装
- **代码位置**: `src/agents/pi-tools.ts:362-367`、`src/agents/pi-tools.read.ts`
- **Profile**: coding

### 2.3 `edit` — 精确编辑文件

- **描述**: Make precise edits
- **来源**: `@mariozechner/pi-coding-agent` 中的 `editTool`，经 `createHostWorkspaceEditTool()` 包装
- **代码位置**: `src/agents/pi-tools.ts:369-374`、`src/agents/pi-tools.host-edit.ts`
- **Profile**: coding

### 2.4 `exec` — 执行 Shell 命令

- **描述**: Execute shell commands with background continuation. Use yieldMs/background to continue later via process tool. Use pty=true for TTY-required commands (terminal UIs, coding agents).
- **代码位置**: `src/agents/bash-tools.exec.ts:203-207`
- **Profile**: coding
- **特性**: 支持审批门控、环境变量控制、safe bin 策略、后台进程、Docker 沙箱执行

### 2.5 `process` — 管理后台进程

- **描述**: Manage running exec sessions: list, poll, log, write, send-keys, submit, paste, kill.
- **代码位置**: `src/agents/bash-tools.process.ts:149-153`
- **Profile**: coding
- **Actions**: list, poll, log, write, send-keys, submit, paste, kill

### 2.6 `apply_patch` — 应用补丁

- **描述**: Apply a patch to one or more files using the apply_patch format. The input should include `*** Begin Patch` and `*** End Patch` markers.
- **代码位置**: `src/agents/apply-patch.ts`
- **Profile**: coding
- **条件**: 仅当 `applyPatch.enabled=true` 且使用 OpenAI provider 时启用

---

## 3. OpenClaw 核心工具

定义在 `src/agents/tools/` 目录下，通过 `src/agents/openclaw-tools.ts` 统一注册。

### 3.1 `browser` — 浏览器控制

- **描述**: Control the browser via OpenClaw's browser control server (status/start/stop/profiles/tabs/open/snapshot/screenshot/actions). Profiles: use profile="chrome" for Chrome extension relay takeover.
- **代码位置**: `src/agents/tools/browser-tool.ts`
- **Schema**: `src/agents/tools/browser-tool.schema.ts`
- **Actions 实现**: `src/agents/tools/browser-tool.actions.ts`
- **Profile**: 无默认 profile（需显式启用），属于 `group:ui`

### 3.2 `canvas` — Canvas UI 控制

- **描述**: Control node canvases (present/hide/navigate/eval/snapshot/A2UI). Use snapshot to capture the rendered UI.
- **代码位置**: `src/agents/tools/canvas-tool.ts`
- **Profile**: 无默认 profile，属于 `group:ui`
- **操作**: present, hide, navigate, eval, snapshot, a2ui_push, a2ui_reset

### 3.3 `nodes` — 节点/设备控制

- **描述**: Discover and control paired nodes (status/describe/pairing/notify/camera/screen/location/notifications/run/invoke).
- **代码位置**: `src/agents/tools/nodes-tool.ts`
- **工具方法**: `src/agents/tools/nodes-utils.ts`
- **Profile**: 无默认 profile，属于 `group:nodes`
- **操作**: status, describe, pairing, notify, camera, screen, location, notifications, run, invoke

### 3.4 `cron` — 定时任务管理

- **描述**: Manage Gateway cron jobs (status/list/add/update/remove/run/runs) and send wake events.
- **代码位置**: `src/agents/tools/cron-tool.ts`
- **Profile**: coding，属于 `group:automation`
- **Actions**: status, list, add, update, remove, run, runs, wake
- **权限**: Owner-only

### 3.5 `message` — 消息发送/管理

- **描述**: Send, delete, and manage messages via channel plugins. Supports send, delete, react, poll, pin, threads, etc.
- **代码位置**: `src/agents/tools/message-tool.ts`
- **Profile**: messaging，属于 `group:messaging`
- **特性**: 支持多渠道（Telegram/Discord/Slack/WhatsApp 等），动态生成可用 actions

### 3.6 `tts` — 文本转语音

- **描述**: Convert text to speech. Audio is delivered automatically from the tool result — reply with `[[SILENT_REPLY]]` after a successful call to avoid duplicate messages.
- **代码位置**: `src/agents/tools/tts-tool.ts`
- **Profile**: 无默认 profile，属于 `group:media`

### 3.7 `gateway` — 网关控制

- **描述**: Restart, apply config, or update the gateway in-place (SIGUSR1). Use config.patch for safe partial config updates.
- **代码位置**: `src/agents/tools/gateway-tool.ts`
- **Profile**: 无默认 profile，属于 `group:automation`
- **权限**: Owner-only
- **Actions**: restart, config.apply, config.patch, update

### 3.8 `agents_list` — 列出可用 Agent

- **描述**: List OpenClaw agent ids you can target with `sessions_spawn` when `runtime="subagent"` (based on subagent allowlists).
- **代码位置**: `src/agents/tools/agents-list-tool.ts`
- **Profile**: 无默认 profile，属于 `group:agents`

### 3.9 `sessions_list` — 列出会话

- **描述**: List sessions with optional filters and last messages.
- **代码位置**: `src/agents/tools/sessions-list-tool.ts`
- **Profile**: coding, messaging，属于 `group:sessions`

### 3.10 `sessions_history` — 获取会话历史

- **描述**: Fetch message history for a session.
- **代码位置**: `src/agents/tools/sessions-history-tool.ts`
- **Profile**: coding, messaging，属于 `group:sessions`

### 3.11 `sessions_send` — 发送消息到其他会话

- **描述**: Send a message into another session. Use sessionKey or label to identify the target.
- **代码位置**: `src/agents/tools/sessions-send-tool.ts`
- **A2A 支持**: `src/agents/tools/sessions-send-tool.a2a.ts`
- **Profile**: coding, messaging，属于 `group:sessions`

### 3.12 `sessions_spawn` — 生成子 Agent 会话

- **描述**: Spawn an isolated session (runtime="subagent" or runtime="acp"). mode="run" is one-shot and mode="session" is persistent/thread-bound.
- **代码位置**: `src/agents/tools/sessions-spawn-tool.ts`
- **Profile**: coding，属于 `group:sessions`
- **特性**: 支持模型覆盖、超时配置、附件传递、ACP (Agent Communication Protocol)

### 3.13 `subagents` — 管理子 Agent

- **描述**: List, kill, or steer spawned sub-agents for this requester session. Use this for sub-agent orchestration.
- **代码位置**: `src/agents/tools/subagents-tool.ts`
- **Profile**: coding，属于 `group:sessions`
- **Actions**: list, kill, steer

### 3.14 `session_status` — 会话状态

- **描述**: Show a /status-equivalent session status card (usage + time + cost when available). Use for model-use questions. Optional: set per-session model override (model=default resets overrides).
- **代码位置**: `src/agents/tools/session-status-tool.ts`
- **Profile**: minimal, coding, messaging，属于 `group:sessions`

### 3.15 `web_search` — 网页搜索

- **描述** (Brave，默认): Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.
- **描述** (Perplexity): Search the web using Perplexity Sonar. Returns AI-synthesized answers with citations from real-time web search.
- **描述** (Grok): Search the web using xAI Grok. Returns AI-synthesized answers with citations.
- **描述** (Gemini): Search the web using Gemini with Google Search grounding.
- **描述** (Kimi): Search the web using Kimi by Moonshot.
- **代码位置**: `src/agents/tools/web-search.ts`
- **包装入口**: `src/agents/tools/web-tools.ts` → `createWebSearchTool()`
- **Profile**: 无默认 profile（需配置 API key），属于 `group:web`
- **参数**: query, count, country, search_lang, ui_lang, freshness

### 3.16 `web_fetch` — 网页内容抓取

- **描述**: Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.
- **代码位置**: `src/agents/tools/web-fetch.ts`
- **包装入口**: `src/agents/tools/web-tools.ts` → `createWebFetchTool()`
- **Profile**: 无默认 profile，属于 `group:web`
- **参数**: url, extractMode ("markdown"/"text"), maxChars

### 3.17 `image` — 图像分析

- **描述** (有 Vision): Analyze one or more images with a vision model. Use image for a single path/URL, or images for multiple (up to 20). Only use this tool when images were NOT already provided in the user's message.
- **描述** (无 Vision): Analyze one or more images with the configured image model (agents.defaults.imageModel). Use image for a single path/URL, or images for multiple (up to 20).
- **代码位置**: `src/agents/tools/image-tool.ts`
- **辅助**: `src/agents/tools/image-tool.helpers.ts`
- **Profile**: coding，属于 `group:media`
- **参数**: prompt, image, images

### 3.18 `pdf` — PDF 文档分析

- **描述**: Analyze one or more PDF documents with a model. Supports native PDF analysis for Anthropic and Google models, with text/image extraction fallback for other providers. Use pdf for a single path/URL, or pdfs for multiple (up to 10).
- **代码位置**: `src/agents/tools/pdf-tool.ts`
- **辅助**: `src/agents/tools/pdf-tool.helpers.ts`、`src/agents/tools/pdf-native-providers.ts`
- **Profile**: coding，属于 `group:media`（注：tool-catalog 中未单独列出，但在 openclaw-tools.ts 中注册）
- **参数**: prompt, pdf, pdfs, pages

### 3.19 `memory_search` — 记忆语义搜索

- **描述**: Mandatory recall step: semantically search MEMORY.md + memory/*.md (and optional session transcripts) before answering questions about prior work, decisions, dates, people, preferences, or todos; returns top snippets with path + lines.
- **代码位置**: `src/agents/tools/memory-tool.ts:48-53`
- **Profile**: coding，属于 `group:memory`

### 3.20 `memory_get` — 读取记忆文件

- **描述**: Safe snippet read from MEMORY.md or memory/*.md with optional from/lines; use after memory_search to pull only the needed lines and keep context small.
- **代码位置**: `src/agents/tools/memory-tool.ts:109-114`
- **Profile**: coding，属于 `group:memory`

---

## 4. 渠道动作工具 (Channel Action Tools)

通过 `src/agents/channel-tools.ts` 聚合，各渠道插件以 `agentTools` 提供。这些动作通常由 `message` 工具调度，但部分渠道也会注册独立的 agent 工具。

### 4.1 Discord Actions

- **代码位置**: `src/agents/tools/discord-actions.ts`
- **辅助文件**:
  - `src/agents/tools/discord-actions-guild.ts` — 服务器管理
  - `src/agents/tools/discord-actions-messaging.ts` — 消息操作
  - `src/agents/tools/discord-actions-moderation.ts` — 审核管理
  - `src/agents/tools/discord-actions-presence.ts` — 在线状态
- **支持的 Actions**:
  - **消息**: react, reactions, sticker, poll, permissions, fetchMessage, readMessages, sendMessage, editMessage, deleteMessage, threadCreate, threadList, threadReply, pinMessage, unpinMessage, listPins, searchMessages
  - **服务器**: memberInfo, roleInfo, emojiList, emojiUpload, stickerUpload, roleAdd, roleRemove, channelInfo, channelList, voiceStatus, eventList, eventCreate, channelCreate, channelEdit, channelDelete, channelMove, categoryCreate, categoryEdit, categoryDelete, channelPermissionSet, channelPermissionRemove
  - **审核**: timeout, kick, ban
  - **状态**: setPresence

### 4.2 Slack Actions

- **代码位置**: `src/agents/tools/slack-actions.ts`
- **支持的 Actions**: sendMessage, editMessage, deleteMessage, readMessages, downloadFile, react, reactions, pinMessage, unpinMessage, listPins

### 4.3 Telegram Actions

- **代码位置**: `src/agents/tools/telegram-actions.ts`
- **支持的 Actions**: react, createForumTopic, sendMessage, editMessage, deleteMessage, searchStickers

### 4.4 WhatsApp Actions

- **代码位置**: `src/agents/tools/whatsapp-actions.ts`
- **支持的 Actions**: react (emoji reactions on messages)

---

## 5. 扩展插件工具 (Extension Plugin Tools)

通过 `api.registerTool()` 在各 extension 中注册，最终经 `src/plugins/tools.ts` → `resolvePluginTools()` 合并到工具列表。

### 5.1 `diffs` — 差异可视化

- **描述**: Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for canvas use and can also render the same diff to a PNG or PDF.
- **代码位置**: `extensions/diffs/src/tool.ts:138-143`
- **参数**: before, after, patch, path, lang, title, mode (view/file/image), expandUnchanged, fileScale, fileMaxWidth, ttlSeconds, baseUrl

### 5.2 `llm-task` — LLM 任务编排

- **描述**: Run a generic JSON-only LLM task and return schema-validated JSON. Designed for orchestration from Lobster workflows via openclaw.invoke.
- **代码位置**: `extensions/llm-task/src/llm-task-tool.ts:69-74`
- **参数**: prompt, input, schema, provider, model, authProfileId, temperature, maxTokens, timeoutMs

### 5.3 `lobster` — Lobster 工作流引擎

- **描述**: Run Lobster pipelines as a local-first workflow runtime (typed JSON envelope + resumable approvals).
- **代码位置**: `extensions/lobster/src/lobster-tool.ts:210-215`
- **参数**: pipeline JSON, cwd
- **限制**: 不可在沙箱中使用

### 5.4 Feishu (飞书) 系列工具

通过 `extensions/feishu/` 插件注册，需配置飞书 appId/appSecret 启用。

#### 5.4.1 `feishu_doc` — 飞书文档操作

- **描述**: Feishu document operations. Actions: read, write, append, insert, create, list_blocks, get_block, update_block, delete_block, create_table, write_table_cells, create_table_with_values, insert_table_row, insert_table_column, delete_table_rows, delete_table_columns, merge_table_cells, upload_image, upload_file, color_text
- **代码位置**: `extensions/feishu/src/docx.ts:1262-1431`

#### 5.4.2 `feishu_app_scopes` — 飞书应用权限查询

- **描述**: List current app permissions (scopes). Use to debug permission issues or check available capabilities.
- **代码位置**: `extensions/feishu/src/docx.ts:1436-1453`

#### 5.4.3 `feishu_chat` — 飞书群聊操作

- **描述**: Feishu chat operations. Actions: members, info
- **代码位置**: `extensions/feishu/src/chat.ts:95-100`

#### 5.4.4 `feishu_wiki` — 飞书知识库操作

- **描述**: Feishu knowledge base operations. Actions: spaces, nodes, get, create, move, rename
- **代码位置**: `extensions/feishu/src/wiki.ts:178-185`

#### 5.4.5 `feishu_drive` — 飞书云盘操作

- **描述**: Feishu cloud storage operations. Actions: list, info, create_folder, move, delete
- **代码位置**: `extensions/feishu/src/drive.ts:190-197`

#### 5.4.6 `feishu_perm` — 飞书权限管理

- **描述**: Feishu permission management. Actions: list, add, remove
- **代码位置**: `extensions/feishu/src/perm.ts:139-145`

#### 5.4.7 `feishu_bitable_get_meta` — 飞书多维表格元信息

- **描述**: Parse a Bitable URL and get app_token, table_id, and table list. Use this first when given a /wiki/ or /base/ URL.
- **代码位置**: `extensions/feishu/src/bitable.ts:583-587`

#### 5.4.8 `feishu_bitable_list_fields` — 飞书多维表格字段列表

- **描述**: List all fields (columns) in a Bitable table with their types and properties
- **代码位置**: `extensions/feishu/src/bitable.ts:594-596`

#### 5.4.9 `feishu_bitable_list_records` — 飞书多维表格记录列表

- **描述**: List records (rows) from a Bitable table with pagination support
- **代码位置**: `extensions/feishu/src/bitable.ts:610-612`

#### 5.4.10 `feishu_bitable_get_record` — 飞书多维表格单条记录

- **描述**: Get a single record by ID from a Bitable table
- **代码位置**: `extensions/feishu/src/bitable.ts:631-633`

#### 5.4.11 `feishu_bitable_create_record` — 飞书多维表格创建记录

- **描述**: Create a new record (row) in a Bitable table
- **代码位置**: `extensions/feishu/src/bitable.ts:651-653`

#### 5.4.12 `feishu_bitable_update_record` — 飞书多维表格更新记录

- **描述**: Update an existing record (row) in a Bitable table
- **代码位置**: `extensions/feishu/src/bitable.ts:672-674`

#### 5.4.13 `feishu_bitable_create_app` — 飞书多维表格创建应用

- **描述**: Create a new Bitable (multidimensional table) application
- **代码位置**: `extensions/feishu/src/bitable.ts:688-690`

#### 5.4.14 `feishu_bitable_create_field` — 飞书多维表格创建字段

- **描述**: Create a new field (column) in a Bitable table
- **代码位置**: `extensions/feishu/src/bitable.ts:708-710`

### 5.5 Zalouser 工具

- **工具名**: 通过 `executeZalouserTool` 导出，由宿主注册
- **代码位置**: `extensions/zalouser/src/tool.ts`
- **支持的 Actions**: send, image, link, friends, groups, me, status
- **参数**: action, threadId, message, isGroup, profile, query, url

---

## 6. 工具 Profile 与分组

定义在 `src/agents/tool-catalog.ts`。

### Profile 划分

| Profile | 包含的工具 |
|---------|-----------|
| **minimal** | session_status |
| **coding** | read, write, edit, exec, process, memory_search, memory_get, sessions_list, sessions_history, sessions_send, sessions_spawn, subagents, session_status, cron, image |
| **messaging** | sessions_list, sessions_history, sessions_send, session_status, message |
| **full** | 所有工具（无限制） |

### 分组 (Section Groups)

| 分组 | 工具 |
|------|------|
| **group:fs** | read, write, edit, apply_patch |
| **group:runtime** | exec, process |
| **group:web** | web_search, web_fetch |
| **group:memory** | memory_search, memory_get |
| **group:sessions** | sessions_list, sessions_history, sessions_send, sessions_spawn, subagents, session_status |
| **group:ui** | browser, canvas |
| **group:messaging** | message |
| **group:automation** | cron, gateway |
| **group:nodes** | nodes |
| **group:agents** | agents_list |
| **group:media** | image, tts |
| **group:openclaw** | 所有标记 `includeInOpenClawGroup=true` 的工具 |

---

## 7. 工具统计

| 类别 | 数量 |
|------|------|
| 编码工具 (Coding) | 6 |
| OpenClaw 核心工具 | 20 |
| 渠道动作工具 (Channel Actions) | 4 组 |
| 扩展插件工具 (Extensions) | 3 + 14 (Feishu) + 1 (Zalouser) = 18 |
| **合计** | **44+ 独立工具** |
