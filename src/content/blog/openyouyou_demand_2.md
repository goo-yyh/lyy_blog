---
title: openyouyou 的 agent 需求文档第二版
date: 2026-03-12
description: agent 设计
category: 胡说八道
---
# YouYou Agent Module - Requirements Document v2

| Field         | Value                            |
|---------------|----------------------------------|
| Document ID   | 0002                             |
| Type          | demand                           |
| Status        | Draft                            |
| Created       | 2026-03-12                       |
| Supersedes    | 0001                             |
| Module Path   | src-tauri/src/agent/             |

---

## 1. Overview

YouYou Agent 是一个运行在 Tauri 后端的无状态多轮对话 Agent 框架。它本身不内置任何 Model Provider、Tool、Skill、Plugin 或 Storage 实现，所有能力均通过**双通道注册**接入：

- **编程注册**：通过 Rust trait 接口在代码中注册实现
- **文件注册**：通过 ~/.youyou/ 目录下的声明式文件自动发现并注册

设计参考 codex-rs 的核心架构，Plugin 系统参考 webpack 的 tapable hook 设计。

### 1.1 设计目标

- **无状态核心**：Agent 本身不持有任何持久状态，所有持久化由外部注册的 Storage 负责
- **双通道注册**：trait 编程注册与文件声明注册共存，启动时按优先级合并
- **单会话模型**：同一时间只允许一个 Session 运行
- **多轮对话**：完整的多轮对话循环，包括上下文管理、Tool 调用、流式输出、多模态输入
- **可组合**：各子系统独立，可按需注册，缺失非核心注册项时 Agent 降级运行
- **Tapable Hook + Plugin**：Plugin 是 Hook 的消费者，通过 tap 机制挂载到生命周期各阶段

### 1.2 Non-Goals

- MCP (Model Context Protocol) 服务器集成
- 多 Agent 协调/编排
- 安全确认与人工审批流程
- 沙箱隔离执行环境
- 内置任何具体的 Model Provider / Tool / Skill / Plugin 实现

### 1.3 Trust Model

YouYou Agent 信任 ~/.youyou/ 和 {project}/.youyou/ 目录下的所有内容。文件注册的 Tool 和 Plugin 可执行任意 shell 命令，等同于用户本地代码。

- ~/.youyou/ 目录仅由用户本人或经过用户确认的前端操作写入
- 前端管理界面在创建 mutating Tool 或 Plugin 时应向用户展示明确提示
- 不支持从网络直接导入未经审查的 Tool / Plugin 包

---

## 2. Architecture Overview

系统分为三层：

**注册层**：AgentBuilder 接受编程注册和文件注册两种来源，按优先级合并后构建 Agent 实例。

**核心层**：Agent 内部由以下组件构成：
- Turn Loop：驱动多轮对话的主循环
- Context Manager：管理对话上下文窗口与压缩
- System Prompt Builder：分层拼接系统指令
- Tool Dispatcher：路由和执行 Tool 调用
- Skill Manager：管理 Skill 定义与触发
- Hook Registry：维护可 tap 的生命周期钩子
- Plugin Manager：管理 Plugin 的注册与生命周期
- Memory Manager：协调跨会话记忆的加载与提取

**会话层**：Agent 同一时间只允许运行一个 Session（单会话模型）。运行中的 Session 必须关闭后才能创建或恢复另一个 Session。新加载的 Tool / Skill / Plugin 仅在下一个 Session 创建时生效。

---

## 3. 注册接口

### 3.1 注册来源优先级

所有可注册组件遵循统一的优先级规则（高优先级覆盖低优先级同名组件）：

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 最高 | 项目级文件注册 | {cwd}/.youyou/ 下的定义 |
| 中 | 全局文件注册 | ~/.youyou/ 下的定义 |
| 最低 | 编程注册 | 通过 AgentBuilder trait 接口注册 |

**覆盖规则：**
- Tool、Skill、Plugin：高优先级来源的同名组件覆盖低优先级来源，不报错。最终生效的组件保留来源标识供前端展示。
- SessionStorage、MemoryStorage：仅支持编程注册，重复注册直接报错。
- ModelProvider：仅支持编程注册，多个 Provider 共存，Provider ID 重复则报错。所有 Provider 声明的模型 ID 必须全局唯一（跨 Provider 不允许重复），构建阶段校验。
- AGENT.md：所有层级的内容按序拼接（非覆盖），Project 级排在 Global 级之后。
- SOUL.md：仅支持全局级（~/.youyou/SOUL.md），不支持项目级覆盖。人设是用户级别属性，不随项目变化。

### 3.2 ModelProvider（必须，至少一个）

Model Provider 负责与 LLM API 通信。Agent 不关心底层是 OpenAI、Anthropic 还是本地模型。

**职责：**
- 声明自身的唯一标识
- 声明所支持的模型列表（模型 ID、显示名称、上下文窗口大小、支持的能力如 tool_use / vision / streaming）
- 接受 ChatRequest，以流式方式返回 ChatEvent 序列
- 支持通过 CancellationToken 取消正在进行的请求

**ChatRequest 包含：** 模型 ID、消息列表（支持文本和多模态内容）、可用工具定义列表、temperature、max_tokens、reasoning_effort 等参数。

**ChatEvent 类型：**
- TextDelta - 文本增量
- ReasoningDelta - 推理过程增量
- ToolCall - 工具调用请求（含 call_id、tool_name、arguments）
- Done - 完成（含 usage 信息）
- Error - 错误

**仅支持编程注册。**

### 3.3 ToolHandler（可选，零个或多个）

Tool 是 Agent 可调用的外部能力（文件读写、Shell 执行、搜索等）。

**每个 Tool 需声明：**
- 唯一名称
- 描述文本（用于 System Prompt 中向模型说明用途）
- 参数格式（JSON Schema）
- 是否具有副作用（mutating 标记）

**执行模型：** 接收结构化的 ToolInput（call_id、tool_name、arguments），返回 ToolOutput（内容文本、是否出错、可选的结构化元数据）。所有已注册 Tool 均可被模型自由调用，无额外鉴权机制。

**注册方式差异：** 编程注册的 Tool 可返回完整的 ToolOutput（含 metadata）。文件注册的 Tool 仅支持文本输出子集：stdout 作为 content，退出码映射为 is_error，不支持 metadata 字段。

**支持双通道注册。** 文件注册的 Tool 通过结构化脚本协议执行，详见第 5 节。

### 3.4 SkillDefinition（可选，零个或多个）

Skill 是可复用的 prompt 模板。触发方式仅有一种：**用户显式调用** — 用户在输入中使用 /skill_name 语法触发，Agent 将 Skill 的 prompt 注入当前 Turn 上下文。

标记为 allow_implicit_invocation 的 Skill 会将名称和描述列入 System Prompt，供模型在回复中建议用户使用（如"你可以使用 /commit 来完成这个操作"）。但 Agent 不会因模型建议而自动注入 Skill prompt，始终需要用户主动触发。

**每个 Skill 包含：**
- 唯一名称（用于 /name 触发）
- 显示名称
- 简短描述
- 完整的 prompt 内容
- 依赖的 Tool 名称列表
- 是否在 System Prompt 中列出供模型参考（allow_implicit_invocation）
- 来源标识（programmatic / global / project）

**支持双通道注册。** 文件注册的 Skill 以 Markdown 格式定义，详见第 5 节。

### 3.5 Plugin（可选，零个或多个）

Plugin 的设计参考 webpack 的 tapable 架构。Plugin 不是 Tool + Skill 的打包单元，而是 Hook 生命周期的消费者。每个 Plugin 可以 tap 到任意 Hook 阶段执行自定义逻辑。

**每个 Plugin 需声明：**
- 唯一 ID
- 显示名称
- 描述
- 需要 tap 的 Hook 事件列表，以及每个事件对应的处理逻辑

**Plugin 配置合并规则：** Plugin 的最终配置按以下优先级整体覆盖（非递归合并，高优先级存在则完全替换低优先级）：
1. config.yaml 中的 plugin_configs[plugin_id]（最高）
2. 生效的 index.md 中的 config 字段（按 3.1 的覆盖规则，项目级 > 全局级）
3. 编程注册时传入的默认配置（最低）

**Plugin 生命周期（编程注册）：**
1. 注册：通过 AgentBuilder 注册
2. 初始化：Agent 构建时按注册顺序调用 initialize，传入合并后的最终 Plugin 配置
3. apply：Plugin 将自身的 hook handler 注册到 Hook Registry
4. 运行：Agent 运行期间，Hook 触发时按注册顺序执行各 Plugin 的 handler
5. 关闭：Agent 关闭时按逆序调用 shutdown

**Plugin 生命周期（文件注册）：**
文件注册的 Plugin 不支持 initialize 和 shutdown 阶段（无持久进程）。其 hook handler 在每次 Hook 触发时启动脚本进程，执行完毕后退出。如需初始化/清理逻辑，应由脚本自行管理。

**支持双通道注册。** 文件注册的 Plugin 通过脚本协议执行，详见第 5 节。

**Plugin 启用/禁用规则：**
- 编程注册的 Plugin 始终启用，不可通过前端或配置文件禁用。如需禁用，须修改代码移除注册。
- 文件注册的 Plugin 启用/禁用优先级（从高到低）：前端运行时切换 > 项目级 index.md enabled 字段 > 全局 index.md enabled 字段。运行时切换仅影响下次 Session。

### 3.6 Hook Registry

Hook Registry 是 Agent 的生命周期事件系统。Plugin 通过 tap 方法将自己的处理逻辑挂载到指定的 Hook 上。

**Hook 事件类型：**

| Hook | 触发时机 | Payload 数据 |
|------|----------|-------------|
| SessionStart | 新会话创建时 | session_id |
| SessionEnd | 会话关闭时 | session_id, message_count |
| TurnStart | 每轮对话开始时 | session_id, turn_id, user_input |
| TurnEnd | 每轮对话结束时 | session_id, turn_id, assistant_output |
| BeforeToolUse | Tool 调用前 | session_id, turn_id, tool_name, arguments |
| AfterToolUse | Tool 调用后 | session_id, turn_id, tool_name, output, duration_ms, success |
| BeforeCompact | 上下文压缩前 | session_id, message_count, estimated_tokens |

**公共 Payload 字段：** 所有 Hook 事件的 Payload 除上表所列的事件特定数据外，还包含 plugin_config 字段（该 Plugin 合并后的最终配置），确保文件注册 Plugin 的脚本也能获取到配置。

**Hook Handler 返回值：**
- Continue：继续执行
- ContinueWith(modified_data)：继续执行，但使用修改后的数据（如修改 Tool 参数）
- Abort(reason)：中止当前操作

**执行顺序：** 同一 Hook 上的多个 handler 按 Plugin 注册顺序依次执行。遇到 Abort 立即停止后续 handler。

**Hook Registry 不直接对外注册。** 所有 hook handler 通过 Plugin 的 apply 方法间接注册。

### 3.7 SessionStorage（可选，至多一个）

会话持久化与发现。不注册时 Agent 仅支持内存中的单次会话。

**职责：**
- 按 session_id 保存会话事件（UserMessage / AssistantMessage / ToolCall / ToolResult / SystemMessage / Metadata）
- 加载完整会话历史
- 分页列出会话（返回 SessionSummary 列表，含 session_id、title、created_at、updated_at、message_count）
- 按 ID 前缀或名称查找会话
- 删除会话

**消息状态：** 每条 AssistantMessage 事件携带 status 字段，取值为 complete / incomplete。取消导致的中断消息标记为 incomplete。恢复会话时，Context Manager 将 incomplete 消息以原样加载到上下文中，并在其后追加系统提示"[此消息因用户取消而中断]"，让模型知晓上一轮未完成。

**仅支持编程注册。重复注册直接报错。**

### 3.8 MemoryStorage（可选，至多一个）

跨会话的持久化记忆。不注册时 Agent 无记忆能力。

**职责：**
- 加载记忆（Memory 包含 id、namespace、content、source、tags、created_at、updated_at）
- 保存/更新记忆（按 id 做 upsert，内容相同则更新时间戳，内容不同则更新内容）
- 删除记忆
- 按 namespace + 查询搜索相关记忆（用于注入上下文）

**仅支持编程注册。重复注册直接报错。**

---

## 4. Core Components

### 4.1 Turn Loop（对话循环）

Turn Loop 是 Agent 的核心驱动逻辑，处理一轮完整的用户交互。

**Turn 状态机：** Running -> Cancelling -> Cancelled / Completed / Failed

**流程：**
1. 接收用户输入（文本 / 图片 / 文件 / Skill 调用）
2. 通过 Context Manager 组装完整消息历史
3. 注入 System Prompt（含 Tool 定义、Skill 列表、Memories、用户指令等）
4. 调用 Model Provider 进行流式推理
5. 若模型返回 Tool Call，分发到 Tool Dispatcher 执行
6. 将 Tool 结果注入上下文，循环调用模型直到不再产生 Tool Call
7. 在各节点触发对应 Hook
8. 通过 Session Storage 持久化事件
9. Turn 结束，等待下一轮输入

**Tool 调用并发策略：** 模型在单次响应中返回的多个 Tool Call 的顺序具有语义（模型可能假设前一个 Tool 的副作用已经生效）。执行策略如下：
- 若批次中**全部为只读 Tool**（mutating=false）：并发执行
- 若批次中**包含任意 mutating Tool**：整批按模型返回顺序串行执行，不重排

**单轮 Tool 调用上限：** 可配置的最大调用次数，超过后强制终止当前 Turn 并向模型返回超限提示。

### 4.2 Context Manager

**职责：**
- 维护有序的消息列表（user / assistant / tool_result / system），支持多模态内容（文本、图片、文件）
- 上下文压缩（Compact）：当上下文接近模型窗口限制时，自动压缩早期对话
- 消息格式标准化：统一不同来源的消息格式

**上下文压缩触发策略（双触发机制）：**

1. **预估触发（主要）**：使用近似估算（字符数 / 4 作为粗略 token 近似）计算当前上下文大小，当预估值超过模型上下文窗口的 compact_threshold 比例时，主动触发压缩。模型的上下文窗口大小从 ModelProvider 声明的 ModelInfo 中获取。
2. **兜底触发**：当 Model Provider 返回 context_length_exceeded 错误时，立即触发压缩，压缩后自动重试本次请求。

**压缩执行：**
- 压缩前触发 BeforeCompact Hook
- 使用 Model Provider 生成摘要（可配置专用 compact_model，不配置则使用当前对话模型）
- 若 compact_model 不可用或压缩请求失败，回退到截断式压缩（保留最近 N 条消息，丢弃最早的消息）
- 可配置压缩用的 prompt 模板

### 4.3 System Prompt Builder

System Prompt 由以下部分按序拼接：

1. **Base Instructions**：通过 AgentConfig 配置的基础指令
2. **Global User Instructions**：从 ~/.youyou/AGENT.md 加载
3. **Project User Instructions**：从 {cwd}/.youyou/AGENT.md 加载
4. **Personality**：从 ~/.youyou/SOUL.md 加载的人设定义
5. **Tool Definitions**：已注册 Tool 的名称、描述、参数 Schema
6. **Skill List**：已注册且标记为 allow_implicit_invocation 的 Skill 名称和描述
7. **Active Plugin Info**：已启用 Plugin 的描述
8. **Memories**：从 Memory Storage 加载的相关记忆（按 namespace 过滤，限制注入条数，详见 4.7）
9. **Environment Context**：运行环境信息（OS、工作目录、时间等）
10. **Dynamic Sections**：通过 TurnStart Hook 动态注入的自定义段

任何层级的文件不存在则跳过，不报错。

### 4.4 Tool Dispatcher

**职责：**
- 维护 name -> ToolHandler 的映射（合并编程注册与文件注册的 Tool，按优先级规则处理同名冲突）
- 根据 mutating 标记决定并发或串行执行（见 4.1）
- 可配置的执行超时（超时后 kill 进程并返回超时错误）
- 执行前触发 BeforeToolUse Hook，执行后触发 AfterToolUse Hook
- Hook 返回 Abort 时中止 Tool 执行并向模型返回错误信息
- 单次 Tool 输出大小上限为 1MB，超过则截断并附加截断提示

### 4.5 Skill Manager

**职责：**
- 维护 name -> SkillDefinition 的映射
- 解析用户输入中的 /skill_name 显式调用
- 将 Skill 的 prompt 注入当前 Turn 的上下文
- 向 System Prompt Builder 提供标记为 allow_implicit_invocation 的 Skill 列表
- 校验 Skill 依赖的 Tool 是否已注册

### 4.6 Plugin Manager

**职责：**
- 管理编程注册 Plugin 的完整生命周期（注册 -> 初始化 -> apply -> 运行 -> 关闭）
- 管理文件注册 Plugin 的简化生命周期（注册 -> apply -> 运行）
- 在 Agent 构建阶段依次初始化编程注册的 Plugin，然后对所有 Plugin 调用 apply
- Agent 关闭时按逆序调用编程注册 Plugin 的 shutdown
- 维护 Plugin 启用/禁用状态

**文件注册 Plugin 的 hook 脚本失败处理：**
- 脚本超时：kill 进程，视为 Continue（记录警告日志）
- 脚本退出码非 0：视为 Continue（记录警告日志，将 stderr 输出记入日志）
- 脚本输出非法 JSON：视为 Continue（记录警告日志）

### 4.7 Memory Manager

**职责：**
- 会话开始时从 MemoryStorage 加载相关记忆，注入 System Prompt
- 会话结束时批量提取新记忆并保存（主要策略）
- 每 N 轮做一次增量 checkpoint 提取（兜底策略，防止会话异常中断丢失记忆）
- 记忆提取使用的模型可配置，不配置则使用当前对话模型
- Checkpoint 间隔可配置

**Memory Namespace：** 记忆按 namespace 隔离，namespace 由 workspace_root（项目工作目录的绝对路径）确定。不同项目的记忆互不可见。无项目上下文时使用 "global" 作为默认 namespace。注意：项目目录移动后 namespace 会变化，记忆不会自动迁移。如需迁移，由 MemoryStorage 实现层处理。

**去重与更新：** MemoryStorage 按 id 做 upsert。Agent 在提取记忆时，由模型判断是否为已有记忆的更新或重复。若模型输出的记忆 id 与已有记忆匹配，则更新内容；否则作为新记忆插入。

**注入预算：** 每次注入 System Prompt 的记忆数量上限可配置（memory_max_items，默认 20）。MemoryStorage 的 search 方法负责按相关度排序，Agent 取 top_k 结果。

**失败隔离：** 记忆提取失败不阻塞会话关闭流程。提取失败时记录错误日志，会话正常关闭。

---

## 5. ~/.youyou 目录结构与文件格式

### 5.1 目录结构

每个 Tool、Skill、Plugin 均为一个独立的文件夹，文件夹名即为该组件的唯一名称。每个文件夹下必须有一个 index.md 作为入口定义文件，同目录下可放置辅助参考文件（脚本、配置、示例等）。

```
~/.youyou/
├── AGENT.md                    # 全局 Agent 指令
├── SOUL.md                     # 人设定义
├── config.yaml                 # 全局配置
├── tools/                      # Tool 定义目录
│   └── {tool-name}/
│       ├── index.md            # Tool 定义入口（YAML front matter + 描述正文）
│       └── ...                 # 可选的辅助文件（脚本等）
├── skills/                     # Skill 定义目录
│   └── {skill-name}/
│       ├── index.md            # Skill 定义入口（YAML front matter + prompt 正文）
│       └── ...                 # 可选的参考文件
├── plugins/                    # Plugin 定义目录
│   └── {plugin-name}/
│       ├── index.md            # Plugin 定义入口（YAML front matter + 描述正文）
│       └── ...                 # 可选的 hook 脚本等
├── memories/                   # 推荐的 MemoryStorage 实现存储目录（非 Agent 强制要求）
└── sessions/                   # 推荐的 SessionStorage 实现存储目录（非 Agent 强制要求）
```

**memories/ 和 sessions/ 说明：** 这两个目录是为 MemoryStorage 和 SessionStorage 的外部实现提供的推荐存储位置。Agent 本身不读写这两个目录，具体存储格式和读写逻辑由注册的 Storage 实现自行决定。

项目级目录（可选，优先级高于全局）：

```
{project}/.youyou/
├── AGENT.md                    # 项目级 Agent 指令
├── tools/
│   └── {tool-name}/
│       ├── index.md
│       └── ...
├── skills/
│   └── {skill-name}/
│       ├── index.md
│       └── ...
└── plugins/
    └── {plugin-name}/
        ├── index.md
        └── ...
```

### 5.2 统一的 index.md 格式约定

所有 Tool、Skill、Plugin 的 index.md 均采用 **YAML front matter + Markdown 正文** 的统一格式。

- front matter 必须包含 **version** 字段（当前固定为 1），用于后续格式演进时做兼容判断
- front matter 定义结构化元数据，正文提供面向模型或面向用户的描述内容
- Agent 加载时解析 front matter 获取元数据，正文根据组件类型有不同用途

### 5.3 Tool 的 index.md 格式

front matter 字段：
- **version**：格式版本号（必须，当前固定为 1）
- **name**：Tool 唯一名称（必须，须与文件夹名一致）
- **mutating**：是否有副作用，布尔值，默认 false
- **parameters**：参数定义列表，每个参数包含 name、type、description、required
- **execution**：执行配置
  - **command**：可执行文件或脚本路径（可使用相对路径引用同目录下的脚本）
  - **args**：参数数组（可选，用于传递固定参数）
  - **timeout_ms**：执行超时（可选，覆盖全局默认值）
  - **working_directory**：工作目录（可选，默认为当前工作目录）

正文内容为面向模型的 description，说明 Tool 的用途、使用场景和注意事项。

### 5.4 Skill 的 index.md 格式

front matter 字段：
- **version**：格式版本号（必须，当前固定为 1）
- **name**：唯一名称，用于 /name 触发（必须，须与文件夹名一致）
- **display_name**：显示名称（可选，默认使用 name）
- **description**：简短描述（必须）
- **required_tools**：依赖的 Tool 名称列表（可选）
- **allow_implicit_invocation**：是否在 System Prompt 中列出供模型参考，布尔值，默认 false

正文内容为 Skill 被触发时注入上下文的完整 prompt。同目录下的辅助文件可作为 prompt 的参考材料，在正文中通过相对路径引用。

### 5.5 Plugin 的 index.md 格式

front matter 字段：
- **version**：格式版本号（必须，当前固定为 1）
- **id**：Plugin 唯一 ID（必须，须与文件夹名一致）
- **display_name**：显示名称（必须）
- **enabled**：是否启用，布尔值，默认 true
- **config**：Plugin 自定义配置（可选，自由格式）
- **hooks**：Hook 事件映射，key 为 Hook 事件名称，value 为该阶段的执行配置
  - **command**：可执行文件或脚本路径（可使用相对路径引用同目录下的脚本）
  - **args**：参数数组（可选）
  - **timeout_ms**：执行超时（可选）

正文内容为 Plugin 的描述文本。

### 5.6 脚本执行协议

文件注册的 Tool 和 Plugin hook 共用同一套结构化脚本执行协议：

**调用方式：**
- Agent 直接执行 command 指定的可执行文件（不经过 shell 包装），通过 args 传递固定参数
- 脚本需自行声明解释器（如 #!/usr/bin/env python3、#!/bin/sh）
- 调用参数以 JSON 格式写入 stdin：Tool 接收 ToolInput，Plugin hook 接收 HookPayload（其中包含 plugin_config 字段，携带合并后的最终 Plugin 配置）
- stdin 写入后立即关闭，通知脚本输入结束
- Windows 环境下，.cmd / .bat 文件自动通过 cmd.exe 执行，其余文件直接执行

**输出约定：**
- stdout：业务输出，必须为 UTF-8 文本
- stderr：诊断日志，Agent 记录到日志但不作为业务输出
- 退出码 0：执行成功，stdout 内容作为结果
- 退出码非 0：执行失败，stdout 内容（如有）作为错误信息

**输出大小限制：** stdout 最大 1MB，超过则截断。

**Tool 脚本返回值：** stdout 内容即为 ToolOutput.content。退出码非 0 时 ToolOutput.is_error = true。

**Plugin hook 脚本返回值（stdout JSON）：**
- 无输出或空 JSON {}：等同于 Continue
- 含 data 字段：等同于 ContinueWith
- 含 abort 和 reason 字段：等同于 Abort

**环境变量：** 脚本执行时继承当前进程的环境变量。额外注入：
- YOUYOU_HOME：~/.youyou 的绝对路径
- YOUYOU_COMPONENT_DIR：当前组件文件夹的绝对路径
- YOUYOU_SESSION_ID：当前 session ID（如有）

**相对路径解析：** command 和 args 中的相对路径以组件文件夹（index.md 所在目录）为根目录解析。

### 5.7 config.yaml 格式

全局配置文件，包含以下字段：
- **default_model**：默认使用的模型 ID（新建会话时未指定 model_id 则使用此值）
- **tool_timeout_ms**：Tool 执行超时，默认 120000
- **compact_threshold**：上下文压缩阈值（0.0 - 1.0），默认 0.8
- **compact_model**：压缩使用的模型 ID（可选，默认使用对话模型）
- **compact_prompt**：压缩用的 prompt 模板（可选）
- **max_tool_calls_per_turn**：单轮最大 Tool 调用次数，默认 50
- **memory_model**：记忆提取使用的模型 ID（可选，默认使用对话模型）
- **memory_checkpoint_interval**：记忆 checkpoint 间隔（轮次），默认 10
- **memory_max_items**：每次注入 System Prompt 的记忆数量上限，默认 20
- **plugin_configs**：Plugin 配置映射，key 为 plugin_id，value 为该 Plugin 的自定义配置

---

## 6. Agent Lifecycle

### 6.1 构建阶段 (Build)

通过 AgentBuilder 注册各组件，然后调用 build 构建 Agent 实例。

Build 阶段执行以下操作：
1. 扫描 ~/.youyou/ 和 {cwd}/.youyou/ 目录，加载文件注册的 Tool、Skill、Plugin
2. 按优先级规则（见 3.1）合并编程注册与文件注册的组件，同名组件高优先级覆盖低优先级
3. 校验（见下方校验规则表）
4. 初始化所有编程注册的 Plugin（按注册顺序）
5. 调用所有 Plugin 的 apply 方法，将 hook handler 注册到 Hook Registry
6. 返回 Agent 实例

**校验规则：**

| 规则 | 行为 |
|------|------|
| 至少注册一个 ModelProvider | 构建失败，返回错误 |
| ModelProvider ID 唯一 | 构建失败，返回错误 |
| 模型 ID 跨所有 Provider 全局唯一 | 构建失败，返回错误 |
| Tool 名称在同一来源层级内唯一 | 构建失败，返回错误（跨层级同名则覆盖） |
| Skill 名称在同一来源层级内唯一 | 构建失败，返回错误（跨层级同名则覆盖） |
| Skill 依赖的 Tool 在最终合并结果中已注册 | 构建失败，返回错误 |
| Plugin ID 在同一来源层级内唯一 | 构建失败，返回错误（跨层级同名则覆盖） |
| SessionStorage 至多一个 | 重复注册直接报错 |
| MemoryStorage 至多一个 | 重复注册直接报错 |
| 文件格式解析失败 | 跳过该文件夹，记录警告日志 |
| index.md version 字段不支持 | 跳过该文件夹，记录警告日志 |

### 6.2 会话阶段 (Session)

Agent 采用**单会话模型**：同一时间只允许一个 Session 处于运行中。

**新建会话：** 指定 model_id（可选，不指定则使用 config.yaml 中的 default_model）和可选的 System Prompt 覆盖项，创建 Session。由于模型 ID 全局唯一，Agent 自动路由到对应的 Provider。若当前已有运行中的 Session，返回错误，必须先关闭当前 Session。

**恢复会话：** 指定 session_id，从 SessionStorage 加载历史消息恢复上下文。同样要求当前无运行中的 Session。

**发送消息：** 接收用户输入，返回 AgentEvent 流。调用方通过消费这个流获得实时的文本增量、Tool 调用状态和 Turn 完成通知。

**取消请求：** 通过 CancellationToken 取消正在进行的请求。取消时各组件的行为：
- Model Provider：立即停止流式生成，已接收的部分保留在上下文中标记为 incomplete
- 正在执行的只读 Tool：等待其完成（不中断），结果正常记录
- 正在执行的 mutating Tool：等待其完成（中断可能导致副作用不一致），结果正常记录
- 尚未执行的 Tool：跳过，向上下文注入"已取消"提示
- Hook：不受取消影响，AfterToolUse 等 hook 仍正常触发
- SessionStorage：已产生的事件正常持久化
- 取消后返回给前端的最后一个事件为 TurnCancelled

**关闭会话：** 触发 SessionEnd Hook，执行记忆批量提取（如已注册 MemoryStorage，提取失败不阻塞关闭），释放会话资源。关闭后才可创建或恢复另一个 Session。

### 6.3 关闭阶段 (Shutdown)

1. 关闭当前活跃 Session（触发 SessionEnd Hook 和记忆提取）
2. 按逆序调用所有编程注册 Plugin 的 shutdown
3. 释放所有资源

---

## 7. Event System

Agent 通过 AgentEvent 流向调用方通知状态变化。

**事件信封：** 每个 AgentEvent 均包含以下公共字段：
- session_id：当前会话 ID
- turn_id：当前轮次 ID
- timestamp：事件产生的时间戳
- sequence：事件序号（单调递增，保证顺序）

**事件类型：**

| 事件 | 说明 |
|------|------|
| TextDelta | 文本增量输出 |
| ReasoningDelta | 推理过程增量 |
| ToolCallStart | Tool 调用开始（含 call_id、tool_name、arguments） |
| ToolCallEnd | Tool 调用结束（含 call_id、tool_name、output、duration_ms、success） |
| ContextCompacted | 上下文压缩发生 |
| TurnComplete | 当前 Turn 完成 |
| TurnCancelled | 当前 Turn 被取消 |
| Error | 错误 |

**顺序保证：** ToolCallStart 一定在对应的 ToolCallEnd 之前。TurnComplete 或 TurnCancelled 是一轮 Turn 的最后一个事件。

---

## 8. Multi-Modal Support

消息内容支持以下类型：
- **文本**：纯文本内容
- **图片**：base64 编码的图片数据，或图片文件路径。单张图片最大 20MB。支持的格式：PNG、JPEG、GIF、WebP
- **文件**：文件路径引用，Agent 在发送给模型前读取内容。单个文件最大 10MB。仅允许读取工作区目录（{cwd} 及其子目录）和 ~/.youyou/ 下的文件

单条消息可包含多个内容块（如同时包含文本和图片）。Model Provider 负责将这些内容块转换为目标 API 的格式。若 Model Provider 不支持某种内容类型，应返回明确错误。超大文件应被拒绝并返回错误提示。

---

## 9. 前端动态加载

前端可在运行时通过 Tauri Command 管理 ~/.youyou/（全局级）和 {cwd}/.youyou/（项目级）下的 Tool / Skill / Plugin 文件夹。

**约束：** 动态写入的内容不会影响当前运行中的 Session。仅当创建下一个 Session 时，Agent 重新扫描目录加载最新的文件注册内容。

**前端需提供的交互：**
- 列出当前已注册的 Tool / Skill / Plugin（含来源标识：编程注册 / 全局文件 / 项目文件，以及是否被更高优先级覆盖）
- 添加新的 Tool / Skill / Plugin（创建文件夹并生成 index.md，可附带辅助文件）。前端需允许用户选择目标层级（全局 / 项目）
- 编辑已有的文件注册项（编辑 index.md 及辅助文件）
- 删除文件注册项（删除整个文件夹）
- 启用/禁用 Plugin

---

## 10. Error Handling

Agent 定义统一的错误体系，每个错误包含以下结构化字段：
- **code**：机器可读的错误码（如 SESSION_BUSY、TOOL_TIMEOUT）
- **message**：人类可读的错误描述
- **retryable**：是否可重试
- **source**：错误来源组件（agent / provider / tool / plugin / storage）

**构建阶段错误：**
- 无 Model Provider（NO_MODEL_PROVIDER）
- 名称冲突，同一层级内重复（NAME_CONFLICT）
- Skill 依赖的 Tool 未注册（SKILL_DEPENDENCY_NOT_MET）
- Plugin 初始化失败（PLUGIN_INIT_FAILED）
- 配置解析错误（CONFIG_PARSE_ERROR）
- Storage 重复注册（STORAGE_DUPLICATE）

**运行阶段错误：**
- 已有 Session 运行中（SESSION_BUSY）
- 指定模型不被任何 Provider 支持（MODEL_NOT_SUPPORTED）
- Model Provider 调用失败（PROVIDER_ERROR, retryable=true）
- Tool 执行失败（TOOL_EXECUTION_ERROR）
- Tool 执行超时（TOOL_TIMEOUT）
- Tool 未找到（TOOL_NOT_FOUND）
- Skill 未找到（SKILL_NOT_FOUND）
- Session 未找到（SESSION_NOT_FOUND）
- SessionStorage 读写失败（STORAGE_ERROR）
- 单轮 Tool 调用次数超限（MAX_TOOL_CALLS_EXCEEDED）
- 上下文压缩失败（COMPACT_ERROR）
- 请求被取消（REQUEST_CANCELLED）
- 文件大小超限（FILE_TOO_LARGE）
- 文件路径不在允许范围内（PATH_NOT_ALLOWED）

---

## 11. Thread Safety & Concurrency

- Agent 是 Send + Sync，可通过 Arc 在多线程间共享
- 单会话模型：同一时间至多一个 Session 运行，Agent 内部维护互斥状态，拒绝在已有 Session 运行时创建新 Session
- Session 拥有自己的 Context Manager 和 Turn 状态
- 同一 Turn 内 Tool 批次全为只读时并发执行，含 mutating 时整批串行执行
- 所有注册 trait 要求 Send + Sync
- 通过 CancellationToken 实现协作式取消


