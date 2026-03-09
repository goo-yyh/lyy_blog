---
title: Codex Agent Skills 清单
date: 2026-03-09
description: codex 分析文档 by claude opus
category: 架构分析
---
# Codex Agent Skills 清单

本文档整理了 OpenAI Codex 项目中的 Skills 系统架构及所有提供给 agent 的 skills。

---

## 一、Skills 系统概述

Skills 是 Codex 中一套模块化、可扩展的能力系统。每个 skill 是一个自包含的文件夹，通过 `SKILL.md` 文件声明元数据和指令，将 Codex 从通用 agent 转变为特定领域的专业 agent。

### 核心设计理念

Skills 采用 **渐进式披露（Progressive Disclosure）** 的三层加载机制：

1. **元数据层**（name + description）— 始终加载到上下文中（~100 words）
2. **指令层**（SKILL.md body）— 当 skill 被触发时加载（<5k words）
3. **资源层**（scripts / references / assets）— 按需加载（无限制，脚本可直接执行无需加载到上下文）

### Skill 目录结构

```
skill-name/
├── SKILL.md              # 必需：YAML frontmatter + Markdown 指令
├── agents/
│   └── openai.yaml       # 推荐：UI 元数据（display_name, icon 等）
├── scripts/              # 可选：可执行脚本（Python/Bash 等）
├── references/           # 可选：参考文档，按需加载到上下文
└── assets/               # 可选：输出资源（模板、图标等），不加载到上下文
```

---

## 二、Skills 基础设施代码

### 2.1 数据模型

| 文件 | 说明 |
|------|------|
| `codex-rs/core/src/skills/model.rs` | 定义 `SkillMetadata`（name, description, interface, dependencies, policy, scope 等）、`SkillPolicy`、`SkillInterface`、`SkillDependencies`、`SkillLoadOutcome` |
| `codex-rs/core/src/skills/mod.rs` | Skills 模块入口，导出所有公共类型 |

### 2.2 加载与发现

| 文件 | 说明 |
|------|------|
| `codex-rs/core/src/skills/loader.rs` | Skill 文件解析器：解析 SKILL.md 的 YAML frontmatter 和 `agents/openai.yaml` 元数据；从多个 root 目录递归扫描 skills |
| `codex-rs/core/src/skills/manager.rs` | `SkillsManager`：管理 skill 的加载、缓存和按 cwd 分组查询 |
| `codex-rs/core/src/skills/system.rs:1` | 导入系统 skill 安装函数 |
| `codex-rs/skills/src/lib.rs` | 嵌入式系统 skills：将 `src/assets/samples/` 编译进二进制，启动时安装到 `$CODEX_HOME/skills/.system/` |

### 2.3 Skill 来源（SkillScope）

Skills 按优先级从高到低从以下位置加载（定义在 `codex-rs/core/src/skills/loader.rs:192-280`）：

| Scope | 路径 | 说明 |
|-------|------|------|
| **Repo** | `.codex/skills/` 或 `.agents/skills/`（项目根到 cwd 之间） | 项目级别 skills，优先级最高 |
| **User** | `$CODEX_HOME/skills/` 或 `$HOME/.agents/skills/` | 用户级别 skills |
| **System** | `$CODEX_HOME/skills/.system/`（从二进制嵌入解压） | 内置系统 skills |
| **Admin** | `/etc/codex/skills/`（Unix） | 管理员级别 skills |

### 2.4 触发与注入

| 文件 | 说明 |
|------|------|
| `codex-rs/core/src/skills/injection.rs` | **显式触发**：处理用户通过 `$skill-name` 语法或 UI 选择触发 skill，将 SKILL.md 内容注入到对话上下文 |
| `codex-rs/core/src/skills/invocation_utils.rs` | **隐式触发**：检测 agent 执行的命令是否在运行 skill 的脚本或读取 skill 文档，自动关联 skill 调用（用于分析追踪） |
| `codex-rs/core/src/skills/render.rs` | 渲染 skills 列表到系统 prompt 的 `## Skills` 段落，供 agent 了解可用 skills |

### 2.5 触发机制详解

**显式触发**（`injection.rs:100-153`）：
- 用户在文本中使用 `$skill-name` 提及 skill
- 用户在文本中使用 `[$skill-name](skill://path)` 链接形式
- 用户通过 UI 选择 `UserInput::Skill { name, path }` 结构化输入
- 多个提及 = 使用所有被提及的 skills
- 同名 skill 如有多个实例，需通过路径精确匹配，否则跳过歧义名称

**隐式触发**（`invocation_utils.rs:34-54`）：
- agent 执行脚本时（如 `python3 scripts/foo.py`），如果脚本位于某 skill 的 `scripts/` 目录下，自动关联该 skill
- agent 读取文件时（如 `cat SKILL.md`），如果路径匹配某 skill 的文档路径，自动关联
- 仅用于分析追踪，不影响上下文注入

### 2.6 Render 到系统 Prompt

`render.rs:3-43` 将可用 skills 渲染为系统 prompt 中的说明段，核心规则：

- 如果用户提到 skill 名称（`$SkillName` 或纯文本）或任务明确匹配 skill 描述，agent **必须**使用该 skill
- 使用 skill 时先打开 `SKILL.md`，按渐进式披露原则按需加载资源
- 优先运行 `scripts/` 而非重写代码
- 优先复用 `assets/` 而非从头创建

---

## 三、具体 Skills 清单

### 3.1 系统内置 Skills（System Scope）

这两个 skill 编译嵌入在 Codex 二进制中，启动时自动安装到 `$CODEX_HOME/skills/.system/`。

#### skill-creator

| 项目 | 内容 |
|------|------|
| **名称** | `skill-creator` |
| **显示名** | Skill Creator |
| **作用** | 指导用户创建或更新 skill。提供完整的 skill 开发流程：理解需求 → 规划资源 → 初始化 → 编辑 → 验证 → 迭代 |
| **触发条件** | 用户想要创建新 skill 或更新现有 skill 时 |
| **附带脚本** | `scripts/init_skill.py`（初始化 skill 目录）、`scripts/quick_validate.py`（验证 skill）、`scripts/generate_openai_yaml.py`（生成 UI 元数据） |
| **附带参考** | `references/openai_yaml.md`（openai.yaml 字段定义） |
| **SKILL.md** | `codex-rs/skills/src/assets/samples/skill-creator/SKILL.md` |
| **openai.yaml** | `codex-rs/skills/src/assets/samples/skill-creator/agents/openai.yaml` |

#### skill-installer

| 项目 | 内容 |
|------|------|
| **名称** | `skill-installer` |
| **显示名** | Skill Installer |
| **作用** | 从 GitHub 安装 skills 到 `$CODEX_HOME/skills`。支持从 [openai/skills](https://github.com/openai/skills) 官方列表安装精选/实验性 skills，也支持从任意 GitHub 仓库（含私有仓库）安装 |
| **触发条件** | 用户要求列出可安装的 skills、安装精选 skill、或从其他仓库安装 skill 时 |
| **附带脚本** | `scripts/list-skills.py`（列出可用 skills）、`scripts/install-skill-from-github.py`（从 GitHub 安装 skill）、`scripts/github_utils.py`（GitHub API 工具函数） |
| **SKILL.md** | `codex-rs/skills/src/assets/samples/skill-installer/SKILL.md` |
| **openai.yaml** | `codex-rs/skills/src/assets/samples/skill-installer/agents/openai.yaml` |

### 3.2 项目级 Skills（Repo Scope）

以下 skills 定义在 codex 项目自身的 `.codex/skills/` 目录中，仅在该项目目录下工作时可用。

#### babysit-pr

| 项目 | 内容 |
|------|------|
| **名称** | `babysit-pr` |
| **显示名** | PR Babysitter |
| **作用** | 自动化监控 GitHub Pull Request。持续轮询 CI 检查、review 评论、可合并状态；诊断 CI 失败（区分代码问题 vs flaky 测试）；自动修复并推送分支问题；对 flaky 失败重试最多 3 次；仅在需要用户介入时停止 |
| **触发条件** | 用户要求 Codex 监控 PR、观察 CI、处理 review 评论、关注 PR 的失败和反馈 |
| **附带脚本** | `scripts/gh_pr_watch.py`（PR 监控脚本，支持 `--once` 单次快照、`--watch` 持续监控、`--retry-failed-now` 重试失败） |
| **附带参考** | `references/heuristics.md`（CI 失败分类启发式规则）、`references/github-api-notes.md`（GitHub CLI/API 用法） |
| **SKILL.md** | `.codex/skills/babysit-pr/SKILL.md` |
| **openai.yaml** | `.codex/skills/babysit-pr/agents/openai.yaml` |

#### test-tui

| 项目 | 内容 |
|------|------|
| **名称** | `test-tui` |
| **显示名** | — |
| **作用** | 指导交互式测试 Codex TUI。提供启动 TUI 的注意事项：设置 `RUST_LOG="trace"`、使用 `-c log_dir=<dir>` 指定日志目录、使用 `just codex` 启动等 |
| **触发条件** | 用户要求测试 Codex TUI 时 |
| **SKILL.md** | `.codex/skills/test-tui/SKILL.md` |

---

## 四、Skills 配置与管理

### 4.1 启用/禁用 Skills

Skills 可在用户配置或 session 级别启用/禁用（`codex-rs/core/src/skills/manager.rs:182-221`）：

```toml
# 在 config.toml 中
[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

Session 级别的设置（`SessionFlags`）优先级高于用户级别设置。

### 4.2 隐式触发控制

每个 skill 可在 `agents/openai.yaml` 中配置 policy：

```yaml
policy:
  allow_implicit_invocation: false  # 禁止隐式触发
```

默认情况下所有 skill 允许隐式触发（`model.rs:24-30`）。

### 4.3 权限配置

Skills 可声明所需权限（`model.rs:17`）：

```yaml
# agents/openai.yaml
permissions:
  # PermissionProfile 相关配置
```

### 4.4 工具依赖

Skills 可声明对外部工具的依赖（`model.rs:47-60`），如 MCP 服务器：

```yaml
# agents/openai.yaml
dependencies:
  tools:
    - type: mcp
      value: server-name
      description: "..."
      transport: stdio
      command: "..."
```

### 4.5 TUI 交互

| 文件 | 说明 |
|------|------|
| `codex-rs/tui/src/bottom_pane/skill_popup.rs` | Skill 详情弹窗 |
| `codex-rs/tui/src/bottom_pane/skills_toggle_view.rs` | Skill 启用/禁用切换界面 |
| `codex-rs/tui/src/chatwidget/skills.rs` | 聊天中的 skill 交互组件 |
| `codex-rs/tui/src/skills_helpers.rs` | Skill 辅助函数 |
| `codex-rs/tui/src/slash_command.rs:8` | `/skills` 斜杠命令入口 |

---

## 五、汇总

| 分类 | Skill 数量 | Skills |
|------|-----------|--------|
| 系统内置（System） | 2 | `skill-creator`, `skill-installer` |
| 项目级（Repo）— codex 自身 | 2 | `babysit-pr`, `test-tui` |
| 用户安装（User） | 可变 | 通过 `skill-installer` 从 GitHub 安装 |
| 管理员（Admin） | 可变 | 系统管理员通过 `/etc/codex/skills/` 部署 |

> **注意**：Skills 是一个开放的扩展体系。上表中的 4 个 skills 是 codex 仓库中实际存在的 skills。用户可以通过 `skill-installer` 安装更多社区 skills，也可以使用 `skill-creator` 自行创建 skills，放置在 `$CODEX_HOME/skills/`、`$HOME/.agents/skills/`、`.codex/skills/` 或 `.agents/skills/` 目录中。
