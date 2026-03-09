---
title: Openclaw Agent Skills 清单
date: 2026-03-09
description: openclaw 分析文档 by claude opus
category: 架构分析
---
# OpenClaw Agent Skills 全量清单

> 基于 `openclaw/skills/` 目录及 `src/agents/skills/` 源码整理。

---

## 1. Skills 系统概述

### 1.1 什么是 Skill

Skill 是 OpenClaw 中一种**可插拔的 prompt 扩展机制**。每个 skill 本质是一个 `SKILL.md` 文件，包含 YAML frontmatter（元数据）和 Markdown 正文（指令/知识），在 agent 运行时注入到系统提示中，指导 agent 使用特定的 CLI 工具或 API。

Skill **不是 tool**——它不直接暴露为 LLM 函数调用，而是作为上下文知识注入 prompt，告诉 agent 何时、如何使用已有的 `exec`/`message`/`browser` 等 tool 来完成特定任务。

### 1.2 核心架构

| 组件 | 文件 | 说明 |
|------|------|------|
| Skill 类型定义 | `src/agents/skills/types.ts` | `SkillEntry`, `OpenClawSkillMetadata`, `SkillInvocationPolicy` 等 |
| Frontmatter 解析 | `src/agents/skills/frontmatter.ts` | 从 SKILL.md 解析 name、description、metadata、requires 等 |
| 过滤与加载 | `src/agents/skills/workspace.ts` | `loadWorkspaceSkillEntries()`, `buildWorkspaceSkillsPrompt()`, `resolveSkillsPromptForRun()` |
| 配置与条件 | `src/agents/skills/config.ts` | `shouldIncludeSkill()`, `hasBinary()`, 平台/依赖检查 |
| 内置 Skills 目录 | `src/agents/skills/bundled-dir.ts` | 解析 `skills/` 目录路径 |
| 插件 Skills | `src/agents/skills/plugin-skills.ts` | 扩展插件注册的 skill 目录 |
| Skill Commands (斜杠命令) | `src/auto-reply/skill-commands.ts` | 将 skill 注册为 `/skill-name` 聊天命令 |
| 安装系统 | `src/agents/skills-install.ts` | 自动安装 skill 依赖的 CLI 工具 (brew/npm/go/uv/download) |

### 1.3 Skill 元数据结构

每个 `SKILL.md` 的 frontmatter 包含：

```yaml
---
name: skill-name            # 技能名称，作为 /skill-name 斜杠命令
description: "..."          # 描述，用于 LLM 判断何时激活
homepage: https://...       # 可选，相关主页
metadata:
  openclaw:
    emoji: "🔧"            # 可选，展示用图标
    always: true            # 可选，是否始终加载（不管 LLM 判断）
    skillKey: "..."         # 可选，配置键
    primaryEnv: "..."       # 可选，主要环境变量
    os: ["macos"]           # 可选，平台限制
    requires:               # 可选，前置条件
      bins: ["curl"]        #   必须存在的 CLI 工具
      anyBins: ["a", "b"]   #   存在其中任一即可
      env: ["API_KEY"]      #   必须存在的环境变量
      config: ["path.key"]  #   必须存在的配置项
    install:                # 可选，自动安装规则
      - kind: brew          #   brew/node/go/uv/download
        formula: tool-name
user-invocable: true        # 可选，是否可通过 /命令 手动调用（默认 true）
disable-model-invocation: false  # 可选，是否禁止 LLM 自动调用（默认 false）
---
```

### 1.4 Skill 加载流程

1. 从 `skills/` (内置) + workspace + plugin 目录加载所有 `SKILL.md`
2. 通过 `shouldIncludeSkill()` 检查 os、requires (bins/env/config) 等前置条件
3. 按 agent 配置的 `skillFilter` 过滤
4. 限制最多 150 个 skill、30,000 字符 prompt
5. 通过 `formatSkillsForPrompt()` 序列化注入系统提示

---

## 2. Skills 全量清单 (52 个)

### 2.1 通信与消息类

#### `bluebubbles` — BlueBubbles iMessage 集成

- **描述**: 通过 BlueBubbles 发送和管理 iMessage。通过 message tool (channel="bluebubbles") 发送消息。
- **文件**: `skills/bluebubbles/SKILL.md`
- **依赖**: 无特定 CLI

#### `discord` — Discord 操作

- **描述**: 通过 message tool (channel=discord) 执行 Discord 操作。
- **文件**: `skills/discord/SKILL.md`
- **依赖**: 无特定 CLI

#### `himalaya` — 终端邮件管理

- **描述**: 通过 IMAP/SMTP 管理邮件，支持列出、阅读、编写、回复、转发、搜索邮件。使用 MML (MIME Meta Language) 编写邮件。
- **文件**: `skills/himalaya/SKILL.md`
- **依赖**: `himalaya` CLI

#### `imsg` — iMessage/SMS 操作

- **描述**: iMessage/SMS CLI，列出聊天、历史记录、通过 Messages.app 发送消息。
- **文件**: `skills/imsg/SKILL.md`
- **依赖**: `imsg` CLI
- **平台**: macOS

#### `slack` — Slack 操作

- **描述**: 通过 slack tool 控制 Slack，包括消息反应、固定/取消固定消息等。
- **文件**: `skills/slack/SKILL.md`
- **依赖**: 无特定 CLI

#### `voice-call` — 语音通话

- **描述**: 通过 OpenClaw voice-call 插件启动语音通话。
- **文件**: `skills/voice-call/SKILL.md`
- **依赖**: voice-call 扩展插件

#### `wacli` — WhatsApp CLI

- **描述**: 通过 wacli CLI 发送 WhatsApp 消息、搜索/同步 WhatsApp 历史记录。
- **文件**: `skills/wacli/SKILL.md`
- **依赖**: `wacli` CLI

#### `xurl` — X (Twitter) API CLI

- **描述**: 通过 xurl CLI 发推文、回复、引用、搜索、阅读帖子、管理关注者、发送 DM、上传媒体等。
- **文件**: `skills/xurl/SKILL.md`
- **依赖**: `xurl` CLI

---

### 2.2 开发与代码类

#### `coding-agent` — 编码 Agent 委派

- **描述**: 将编码任务委派给 Codex、Claude Code 或 Pi agent 通过后台进程执行。适用于构建新功能、PR 审查、大型代码库重构、需要文件探索的迭代编码。
- **文件**: `skills/coding-agent/SKILL.md`
- **依赖**: `claude` / `codex` / `opencode` / `pi` (任一)

#### `gh-issues` — GitHub Issue 自动修复

- **描述**: 获取 GitHub issues，生成子 agent 并行实现修复并开 PR，然后监控和处理 PR review 评论。是一个自动修复 GitHub issue 的编排 skill。
- **文件**: `skills/gh-issues/SKILL.md`
- **依赖**: `gh` CLI

#### `github` — GitHub 操作

- **描述**: 通过 `gh` CLI 进行 GitHub 操作：issues、PRs、CI runs、code review、API 查询。
- **文件**: `skills/github/SKILL.md`
- **依赖**: `gh` CLI

#### `gemini` — Gemini CLI

- **描述**: 使用 Gemini CLI 进行一次性 Q&A、摘要和文本生成。
- **文件**: `skills/gemini/SKILL.md`
- **依赖**: `gemini` CLI

#### `oracle` — Oracle CLI

- **描述**: 使用 oracle CLI 的最佳实践（prompt + 文件打包、引擎、会话、文件附件模式）。
- **文件**: `skills/oracle/SKILL.md`
- **依赖**: `oracle` CLI

#### `mcporter` — MCP Server 管理

- **描述**: 使用 mcporter CLI 列出、配置、认证和调用 MCP servers/tools（HTTP 或 stdio），包括临时 server、配置编辑和 CLI/类型生成。
- **文件**: `skills/mcporter/SKILL.md`
- **依赖**: `mcporter` CLI

#### `skill-creator` — Skill 创建/更新

- **描述**: 创建或更新 AgentSkills。用于设计、构造和打包 skills（含脚本、引用和资源）。
- **文件**: `skills/skill-creator/SKILL.md`

#### `clawhub` — ClawHub Skill 市场

- **描述**: 使用 ClawHub CLI 搜索、安装、更新和发布 agent skills。
- **文件**: `skills/clawhub/SKILL.md`
- **依赖**: `clawhub` CLI

#### `tmux` — Tmux 会话控制

- **描述**: 远程控制 tmux 会话，通过发送按键和抓取 pane 输出来操作交互式 CLI。
- **文件**: `skills/tmux/SKILL.md`
- **依赖**: `tmux`

---

### 2.3 生产力与笔记类

#### `apple-notes` — Apple Notes 管理

- **描述**: 通过 `memo` CLI 在 macOS 上管理 Apple Notes（创建、查看、编辑、删除、搜索、移动、导出笔记）。
- **文件**: `skills/apple-notes/SKILL.md`
- **依赖**: `memo` CLI
- **平台**: macOS

#### `apple-reminders` — Apple Reminders 管理

- **描述**: 通过 `remindctl` CLI 管理 Apple Reminders（列出、添加、编辑、完成、删除），支持列表、日期过滤和 JSON/纯文本输出。
- **文件**: `skills/apple-reminders/SKILL.md`
- **依赖**: `remindctl` CLI
- **平台**: macOS

#### `bear-notes` — Bear 笔记管理

- **描述**: 通过 `grizzly` CLI 创建、搜索和管理 Bear 笔记。
- **文件**: `skills/bear-notes/SKILL.md`
- **依赖**: `grizzly` CLI
- **平台**: macOS

#### `notion` — Notion 管理

- **描述**: 通过 Notion API 创建和管理页面、数据库和块。
- **文件**: `skills/notion/SKILL.md`
- **依赖**: Notion API token

#### `obsidian` — Obsidian Vault 管理

- **描述**: 操作 Obsidian vault（纯 Markdown 笔记）并通过 obsidian-cli 自动化。
- **文件**: `skills/obsidian/SKILL.md`
- **依赖**: `obsidian-cli`

#### `things-mac` — Things 3 任务管理

- **描述**: 通过 `things` CLI 在 macOS 上管理 Things 3（通过 URL scheme 添加/更新项目和待办，从本地 Things 数据库读取/搜索/列出）。
- **文件**: `skills/things-mac/SKILL.md`
- **依赖**: `things` CLI
- **平台**: macOS

#### `trello` — Trello 管理

- **描述**: 通过 Trello REST API 管理 boards、lists 和 cards。
- **文件**: `skills/trello/SKILL.md`
- **依赖**: Trello API key/token

---

### 2.4 媒体与音视频类

#### `camsnap` — 摄像头抓拍

- **描述**: 从 RTSP/ONVIF 摄像头捕获帧或片段。
- **文件**: `skills/camsnap/SKILL.md`
- **依赖**: `camsnap` CLI

#### `gifgrep` — GIF 搜索

- **描述**: 搜索 GIF 提供商（CLI/TUI），下载结果，提取静帧/缩略图。
- **文件**: `skills/gifgrep/SKILL.md`
- **依赖**: `gifgrep` CLI

#### `nano-banana-pro` — Gemini 图像生成/编辑

- **描述**: 通过 Gemini 3 Pro Image (Nano Banana Pro) 生成或编辑图像。
- **文件**: `skills/nano-banana-pro/SKILL.md`

#### `nano-pdf` — PDF 编辑

- **描述**: 使用自然语言指令通过 nano-pdf CLI 编辑 PDF。
- **文件**: `skills/nano-pdf/SKILL.md`
- **依赖**: `nano-pdf` CLI

#### `openai-image-gen` — OpenAI 图像生成

- **描述**: 通过 OpenAI Images API 批量生成图像，支持随机 prompt 采样 + `index.html` 画廊。
- **文件**: `skills/openai-image-gen/SKILL.md`
- **依赖**: OpenAI API key

#### `openai-whisper` — 本地语音转文字

- **描述**: 使用 Whisper CLI 进行本地语音转文字（无需 API key）。
- **文件**: `skills/openai-whisper/SKILL.md`
- **依赖**: `whisper` CLI

#### `openai-whisper-api` — OpenAI 语音转文字 API

- **描述**: 通过 OpenAI Audio Transcriptions API (Whisper) 进行语音转录。
- **文件**: `skills/openai-whisper-api/SKILL.md`
- **依赖**: OpenAI API key

#### `peekaboo` — macOS UI 自动化

- **描述**: 使用 Peekaboo CLI 捕获和自动化 macOS UI。
- **文件**: `skills/peekaboo/SKILL.md`
- **依赖**: `peekaboo` CLI
- **平台**: macOS

#### `sag` — ElevenLabs TTS

- **描述**: 使用 ElevenLabs 进行文本转语音，类似 macOS `say` 的用户体验。
- **文件**: `skills/sag/SKILL.md`
- **依赖**: `sag` CLI

#### `sherpa-onnx-tts` — 本地离线 TTS

- **描述**: 通过 sherpa-onnx 进行本地文本转语音（离线，无需云服务）。
- **文件**: `skills/sherpa-onnx-tts/SKILL.md`
- **依赖**: `sherpa-onnx-tts` CLI

#### `songsee` — 音频频谱可视化

- **描述**: 使用 songsee CLI 从音频生成频谱图和特征面板可视化。
- **文件**: `skills/songsee/SKILL.md`
- **依赖**: `songsee` CLI

#### `video-frames` — 视频帧提取

- **描述**: 使用 ffmpeg 从视频中提取帧或短片段。
- **文件**: `skills/video-frames/SKILL.md`
- **依赖**: `ffmpeg`

---

### 2.5 智能家居与 IoT 类

#### `blucli` — BluOS 音响控制

- **描述**: BluOS CLI (`blu`)，用于设备发现、播放控制、分组和音量调节。
- **文件**: `skills/blucli/SKILL.md`
- **依赖**: `blu` CLI

#### `eightctl` — Eight Sleep 床垫控制

- **描述**: 控制 Eight Sleep pod（状态、温度、闹钟、日程）。
- **文件**: `skills/eightctl/SKILL.md`
- **依赖**: `eightctl` CLI

#### `openhue` — Philips Hue 灯光控制

- **描述**: 通过 OpenHue CLI 控制 Philips Hue 灯光和场景。
- **文件**: `skills/openhue/SKILL.md`
- **依赖**: `openhue` CLI

#### `sonoscli` — Sonos 音响控制

- **描述**: 控制 Sonos 音响（发现/状态/播放/音量/分组）。
- **文件**: `skills/sonoscli/SKILL.md`
- **依赖**: `sonoscli` CLI

---

### 2.6 Web 服务与 API 类

#### `gog` — Google Workspace CLI

- **描述**: Google Workspace CLI，用于 Gmail、Calendar、Drive、Contacts、Sheets 和 Docs。
- **文件**: `skills/gog/SKILL.md`
- **依赖**: `gog` CLI

#### `goplaces` — Google Places 查询

- **描述**: 通过 goplaces CLI 查询 Google Places API (New)，支持文本搜索、地点详情、解析和评论。
- **文件**: `skills/goplaces/SKILL.md`
- **依赖**: `goplaces` CLI

#### `spotify-player` — Spotify 播放控制

- **描述**: 终端 Spotify 播放/搜索，优先使用 spogo，备选 spotify_player。
- **文件**: `skills/spotify-player/SKILL.md`
- **依赖**: `spogo` / `spotify_player` (任一)

#### `weather` — 天气查询

- **描述**: 通过 wttr.in 或 Open-Meteo 获取当前天气和预报。无需 API key。
- **文件**: `skills/weather/SKILL.md`
- **依赖**: `curl`

#### `ordercli` — 外卖订单查询

- **描述**: Foodora 订单 CLI，查看历史订单和活动订单状态（Deliveroo 开发中）。
- **文件**: `skills/ordercli/SKILL.md`
- **依赖**: `ordercli` CLI

#### `blogwatcher` — 博客/RSS 监控

- **描述**: 使用 blogwatcher CLI 监控博客和 RSS/Atom feeds 的更新。
- **文件**: `skills/blogwatcher/SKILL.md`
- **依赖**: `blogwatcher` CLI

---

### 2.7 UI 与展示类

#### `canvas` — Canvas UI 展示

- **描述**: 在连接的 OpenClaw 节点（Mac 应用、iOS、Android）上展示 HTML 内容。
- **文件**: `skills/canvas/SKILL.md`
- **依赖**: canvas tool

#### `summarize` — URL/播客/文件摘要

- **描述**: 从 URL、播客和本地文件中摘要或提取文本/转录内容（也可作为"转录 YouTube/视频"的后备方案）。
- **文件**: `skills/summarize/SKILL.md`

---

### 2.8 安全与运维类

#### `1password` — 1Password CLI

- **描述**: 设置和使用 1Password CLI (`op`)，用于安装 CLI、启用桌面应用集成、登录、读取/注入/运行 secrets。
- **文件**: `skills/1password/SKILL.md`
- **依赖**: `op` CLI

#### `healthcheck` — 安全加固

- **描述**: 宿主安全加固和 OpenClaw 部署的风险容忍度配置。用于安全审计、防火墙/SSH/更新加固、风险态势、暴露审查或版本状态检查。
- **文件**: `skills/healthcheck/SKILL.md`

---

### 2.9 日志与调试类

#### `model-usage` — 模型使用统计

- **描述**: 使用 CodexBar CLI 汇总每个模型的本地成本使用情况。
- **文件**: `skills/model-usage/SKILL.md`
- **依赖**: `codexbar` CLI

#### `session-logs` — 会话日志搜索

- **描述**: 使用 jq 搜索和分析自身的会话日志（历史/父级对话）。
- **文件**: `skills/session-logs/SKILL.md`
- **依赖**: `jq`

---

## 3. Skills 分类统计

| 类别 | 数量 | Skills |
|------|------|--------|
| 通信与消息 | 8 | bluebubbles, discord, himalaya, imsg, slack, voice-call, wacli, xurl |
| 开发与代码 | 8 | coding-agent, gh-issues, github, gemini, oracle, mcporter, skill-creator, clawhub |
| 生产力与笔记 | 7 | apple-notes, apple-reminders, bear-notes, notion, obsidian, things-mac, trello |
| 媒体与音视频 | 12 | camsnap, gifgrep, nano-banana-pro, nano-pdf, openai-image-gen, openai-whisper, openai-whisper-api, peekaboo, sag, sherpa-onnx-tts, songsee, video-frames |
| 智能家居与 IoT | 4 | blucli, eightctl, openhue, sonoscli |
| Web 服务与 API | 6 | gog, goplaces, spotify-player, weather, ordercli, blogwatcher |
| UI 与展示 | 2 | canvas, summarize |
| 安全与运维 | 2 | 1password, healthcheck |
| 日志与调试 | 2 | model-usage, session-logs |
| **Tmux** | 1 | tmux |
| **合计** | **52** | |

---

## 4. Skill 与 Tool 的关系

Skills 和 Tools 是 OpenClaw 向 agent 赋能的两种互补机制：

| 维度 | Tool | Skill |
|------|------|-------|
| **本质** | LLM function call（函数调用） | Prompt 注入（上下文知识） |
| **调用方式** | LLM 直接通过 tool_use 调用 | LLM 读取 prompt 后决定使用哪些 tool |
| **注册位置** | `src/agents/tools/`, `src/agents/bash-tools.*.ts` | `skills/*/SKILL.md` |
| **运行时** | 由 tool executor 执行 | 由 agent 使用已有 tool 组合实现 |
| **典型用法** | `exec`, `message`, `browser` 等底层能力 | `github`, `weather`, `slack` 等领域知识 |

大多数 skills 通过 `exec` tool 调用外部 CLI 工具来实现功能。部分 skills（如 `discord`、`slack`、`canvas`）直接指导 agent 使用对应的内置 tool。

---

## 5. Skill 安装机制

Skills 可声明依赖的外部工具，OpenClaw 支持自动安装：

| 安装方式 | frontmatter `install.kind` | 示例 |
|---------|---------------------------|------|
| Homebrew | `brew` | `formula: gh` |
| npm (全局) | `node` | `package: clawhub` |
| Go install | `go` | `module: github.com/...` |
| UV (Python) | `uv` | `package: whisper` |
| 直接下载 | `download` | `url: https://...`, `archive: tar.gz` |

安装偏好通过 `config.skills.install` 配置（`preferBrew`, `nodeManager`）。

代码位置: `src/agents/skills-install.ts`, `src/agents/skills-install-download.ts`, `src/agents/skills-install-extract.ts`