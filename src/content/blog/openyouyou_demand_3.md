---
title: openyouyou 的 agent 需求文档第三版
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

YouYou Agent 是一个无状态多轮对话 Agent 框架。它本身不内置任何 Model Provider、Tool、Skill、Plugin 或 Storage 实现，也不关心这些组件的来源（文件系统、数据库、网络等）。所有能力均由调用方在构建阶段通过编程接口注册。

设计参考 codex-rs 的核心架构，Plugin 系统参考 webpack 的 tapable hook 设计。

### 1.1 设计目标

- **无状态核心**：Agent 不持有任何持久状态，不访问文件系统，不关心组件来源，所有输入由调用方提供
- **全编程注册**：所有组件通过 Rust trait 接口在构建阶段注册
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
- 文件系统访问、配置文件加载、目录扫描等 I/O 操作（全部由调用方负责）

---

## 2. Architecture Overview

系统分为两层：

**注册层**：AgentBuilder 接受调用方通过 trait 接口注册的各类组件和配置，校验后构建 Agent 实例。

**核心层**：Agent 内部由以下组件构成：
- Turn Loop：驱动多轮对话的主循环
- Context Manager：管理对话上下文窗口与压缩
- System Prompt Builder：拼接系统指令
- Tool Dispatcher：路由和执行 Tool 调用
- Skill Manager：管理 Skill 定义与触发
- Hook Registry：维护可 tap 的生命周期钩子
- Plugin Manager：管理 Plugin 的注册与生命周期
- Memory Manager：协调跨会话记忆的加载与提取

Agent 同一时间只允许运行一个 Session（单会话模型）。运行中的 Session 必须关闭后才能创建或恢复另一个 Session。

---

## 3. 注册接口

所有组件均通过 AgentBuilder 的编程接口注册。

### 3.1 ModelProvider（必须，至少一个）

Model Provider 负责与 LLM API 通信。Agent 不关心底层是 OpenAI、Anthropic 还是本地模型。

**职责：**
- 声明自身的唯一标识（Provider ID）
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

**约束：** 多个 Provider 可共存。Provider ID 必须唯一，所有 Provider 声明的模型 ID 必须跨 Provider 全局唯一，构建阶段校验。

### 3.2 ToolHandler（可选，零个或多个）

Tool 是 Agent 可调用的外部能力（文件读写、Shell 执行、搜索等）。

**每个 Tool 需声明：**
- 唯一名称
- 描述文本（用于 System Prompt 中向模型说明用途）
- 参数格式（JSON Schema）
- 是否具有副作用（mutating 标记）

**执行模型：** 接收结构化的 ToolInput（call_id、tool_name、arguments），返回 ToolOutput（内容文本、是否出错、可选的结构化元数据）。所有已注册 Tool 均可被模型自由调用，无额外鉴权机制。

**约束：** Tool 名称全局唯一，重复则构建失败。

### 3.3 SkillDefinition（可选，零个或多个）

Skill 是可复用的 prompt 模板。触发方式仅有一种：**用户显式调用** — 用户在输入中使用 /skill_name 语法触发，Agent 将 Skill 的 prompt 注入当前 Turn 上下文。

标记为 allow_implicit_invocation 的 Skill 会将名称和描述列入 System Prompt，供模型在回复中建议用户使用（如"你可以使用 /commit 来完成这个操作"）。但 Agent 不会因模型建议而自动注入 Skill prompt，始终需要用户主动触发。

**每个 Skill 包含：**
- 唯一名称（用于 /name 触发）
- 显示名称
- 简短描述
- 完整的 prompt 内容
- 依赖的 Tool 名称列表
- 是否在 System Prompt 中列出供模型参考（allow_implicit_invocation）

**约束：** Skill 名称全局唯一，重复则构建失败。Skill 依赖的 Tool 必须在最终注册结果中存在，否则构建失败。

### 3.4 Plugin（可选，零个或多个）

Plugin 的设计参考 webpack 的 tapable 架构。Plugin 不是 Tool + Skill 的打包单元，而是 Hook 生命周期的消费者。每个 Plugin 可以 tap 到任意 Hook 阶段执行自定义逻辑。

**每个 Plugin 需声明：**
- 唯一 ID
- 显示名称
- 描述
- 需要 tap 的 Hook 事件列表，以及每个事件对应的处理逻辑

**Plugin 生命周期：**
1. 注册：通过 AgentBuilder 注册，传入 Plugin 实现和可选的配置
2. 初始化：Agent 构建时按注册顺序调用 initialize，传入配置
3. apply：Plugin 将自身的 hook handler 注册到 Hook Registry
4. 运行：Agent 运行期间，Hook 触发时按注册顺序执行各 Plugin 的 handler
5. 关闭：Agent 关闭时按逆序调用 shutdown

**约束：** Plugin ID 全局唯一，重复则构建失败。

### 3.5 Hook Registry

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

**公共 Payload 字段：** 所有 Hook 事件的 Payload 除上表所列的事件特定数据外，还包含 plugin_config 字段（该 Plugin 注册时传入的配置）。

**Hook Handler 返回值：**
- Continue：继续执行
- ContinueWith(modified_data)：继续执行，但使用修改后的数据（如修改 Tool 参数）
- Abort(reason)：中止当前操作

**执行顺序：** 同一 Hook 上的多个 handler 按 Plugin 注册顺序依次执行。遇到 Abort 立即停止后续 handler。

**Hook Registry 不直接对外注册。** 所有 hook handler 通过 Plugin 的 apply 方法间接注册。

### 3.6 SessionStorage（可选，至多一个）

会话持久化与发现。不注册时 Agent 仅支持内存中的单次会话。

**职责：**
- 按 session_id 保存会话事件（UserMessage / AssistantMessage / ToolCall / ToolResult / SystemMessage / Metadata）
- 加载完整会话历史
- 分页列出会话（返回 SessionSummary 列表，含 session_id、title、created_at、updated_at、message_count）
- 按 ID 前缀或名称查找会话
- 删除会话

**消息状态：** 每条 AssistantMessage 事件携带 status 字段，取值为 complete / incomplete。取消导致的中断消息标记为 incomplete。恢复会话时，Context Manager 将 incomplete 消息以原样加载到上下文中，并在其后追加系统提示"[此消息因用户取消而中断]"，让模型知晓上一轮未完成。

**约束：** 重复注册直接报错。

### 3.7 MemoryStorage（可选，至多一个）

跨会话的持久化记忆。不注册时 Agent 无记忆能力。

**职责：**
- 加载记忆（Memory 包含 id、namespace、content、source、tags、created_at、updated_at）
- 保存/更新记忆（按 id 做 upsert，内容相同则更新时间戳，内容不同则更新内容）
- 删除记忆
- 按 namespace + 查询搜索相关记忆（用于注入上下文）

**约束：** 重复注册直接报错。

---

## 4. Configuration

Agent 的运行参数通过 AgentConfig 在构建阶段传入，不依赖任何配置文件。

**AgentConfig 字段：**
- **default_model**：默认使用的模型 ID（新建会话时未指定 model_id 则使用此值）
- **system_instructions**：系统指令文本列表（按序拼接注入 System Prompt，由调用方自行从文件或其他来源加载）
- **personality**：人设定义文本（可选，注入 System Prompt）
- **tool_timeout_ms**：Tool 执行超时，默认 120000
- **compact_threshold**：上下文压缩阈值（0.0 - 1.0），默认 0.8
- **compact_model**：压缩使用的模型 ID（可选，默认使用当前对话模型）
- **compact_prompt**：压缩用的 prompt 模板（可选）
- **max_tool_calls_per_turn**：单轮最大 Tool 调用次数，默认 50
- **memory_model**：记忆提取使用的模型 ID（可选，默认使用当前对话模型）
- **memory_checkpoint_interval**：记忆 checkpoint 间隔（轮次），默认 10
- **memory_max_items**：每次注入 System Prompt 的记忆数量上限，默认 20
- **memory_namespace**：当前会话的记忆 namespace（用于记忆隔离，由调用方决定如何生成）

---

## 5. Core Components

### 5.1 Turn Loop（对话循环）

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

### 5.2 Context Manager

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

### 5.3 System Prompt Builder

System Prompt 由以下部分按序拼接：

1. **System Instructions**：AgentConfig 中传入的 system_instructions 列表，按序拼接
2. **Personality**：AgentConfig 中传入的 personality 文本
3. **Tool Definitions**：已注册 Tool 的名称、描述、参数 Schema
4. **Skill List**：已注册且标记为 allow_implicit_invocation 的 Skill 名称和描述
5. **Active Plugin Info**：已启用 Plugin 的描述
6. **Memories**：从 Memory Storage 加载的相关记忆（按 namespace 过滤，限制注入条数，详见 5.7）
7. **Environment Context**：运行环境信息（OS、工作目录、时间等，由调用方通过 AgentConfig 或 SessionConfig 传入）
8. **Dynamic Sections**：通过 TurnStart Hook 动态注入的自定义段

### 5.4 Tool Dispatcher

**职责：**
- 维护 name -> ToolHandler 的映射
- 根据 mutating 标记决定并发或串行执行（见 5.1）
- 可配置的执行超时（超时后取消 Tool 执行并返回超时错误）
- 执行前触发 BeforeToolUse Hook，执行后触发 AfterToolUse Hook
- Hook 返回 Abort 时中止 Tool 执行并向模型返回错误信息
- 单次 Tool 输出大小上限为 1MB，超过则截断并附加截断提示

### 5.5 Skill Manager

**职责：**
- 维护 name -> SkillDefinition 的映射
- 解析用户输入中的 /skill_name 显式调用
- 将 Skill 的 prompt 注入当前 Turn 的上下文
- 向 System Prompt Builder 提供标记为 allow_implicit_invocation 的 Skill 列表
- 校验 Skill 依赖的 Tool 是否已注册

### 5.6 Plugin Manager

**职责：**
- 管理 Plugin 的完整生命周期（注册 -> 初始化 -> apply -> 运行 -> 关闭）
- 在 Agent 构建阶段依次初始化所有 Plugin，然后调用 apply 将 handler tap 到 Hook Registry
- Agent 关闭时按逆序调用 shutdown

### 5.7 Memory Manager

**职责：**
- 会话开始时从 MemoryStorage 加载相关记忆（按 AgentConfig.memory_namespace 过滤），注入 System Prompt
- 会话结束时批量提取新记忆并保存（主要策略）
- 每 N 轮做一次增量 checkpoint 提取（兜底策略，防止会话异常中断丢失记忆）
- 记忆提取使用的模型可配置（compact_model），不配置则使用当前对话模型
- Checkpoint 间隔可配置

**Memory Namespace：** 记忆按 namespace 隔离，namespace 由调用方通过 AgentConfig.memory_namespace 传入。Agent 本身不关心 namespace 的生成规则（可以是项目路径、用户 ID 或任意字符串），隔离策略完全由调用方决定。

**去重与更新：** MemoryStorage 按 id 做 upsert。Agent 在提取记忆时，由模型判断是否为已有记忆的更新或重复。若模型输出的记忆 id 与已有记忆匹配，则更新内容；否则作为新记忆插入。

**注入预算：** 每次注入 System Prompt 的记忆数量上限可配置（memory_max_items，默认 20）。MemoryStorage 的 search 方法负责按相关度排序，Agent 取 top_k 结果。

**失败隔离：** 记忆提取失败不阻塞会话关闭流程。提取失败时记录错误日志，会话正常关闭。

---

## 6. Agent Lifecycle

### 6.1 构建阶段 (Build)

通过 AgentBuilder 注册各组件和 AgentConfig，然后调用 build 构建 Agent 实例。

Build 阶段执行以下操作：
1. 校验（见下方校验规则表）
2. 初始化所有 Plugin（按注册顺序）
3. 调用所有 Plugin 的 apply 方法，将 hook handler 注册到 Hook Registry
4. 返回 Agent 实例

**校验规则：**

| 规则 | 行为 |
|------|------|
| 至少注册一个 ModelProvider | 构建失败，返回错误 |
| ModelProvider ID 唯一 | 构建失败，返回错误 |
| 模型 ID 跨所有 Provider 全局唯一 | 构建失败，返回错误 |
| Tool 名称全局唯一 | 构建失败，返回错误 |
| Skill 名称全局唯一 | 构建失败，返回错误 |
| Skill 依赖的 Tool 已注册 | 构建失败，返回错误 |
| Plugin ID 全局唯一 | 构建失败，返回错误 |
| SessionStorage 至多一个 | 重复注册直接报错 |
| MemoryStorage 至多一个 | 重复注册直接报错 |
| default_model 对应的模型 ID 已注册 | 构建失败，返回错误 |

### 6.2 会话阶段 (Session)

Agent 采用**单会话模型**：同一时间只允许一个 Session 处于运行中。

**新建会话：** 指定 model_id（可选，不指定则使用 AgentConfig 中的 default_model）和可选的 System Prompt 覆盖项，创建 Session。由于模型 ID 全局唯一，Agent 自动路由到对应的 Provider。若当前已有运行中的 Session，返回错误，必须先关闭当前 Session。

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
2. 按逆序调用所有 Plugin 的 shutdown
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
- **图片**：base64 编码的图片数据。单张图片最大 20MB。支持的格式：PNG、JPEG、GIF、WebP
- **文件内容**：由调用方读取后以文本形式传入。Agent 不直接读取文件系统

单条消息可包含多个内容块（如同时包含文本和图片）。Model Provider 负责将这些内容块转换为目标 API 的格式。若 Model Provider 不支持某种内容类型，应返回明确错误。

---

## 9. Error Handling

Agent 定义统一的错误体系，每个错误包含以下结构化字段：
- **code**：机器可读的错误码（如 SESSION_BUSY、TOOL_TIMEOUT）
- **message**：人类可读的错误描述
- **retryable**：是否可重试
- **source**：错误来源组件（agent / provider / tool / plugin / storage）

**构建阶段错误：**
- 无 Model Provider（NO_MODEL_PROVIDER）
- 名称冲突（NAME_CONFLICT）
- Skill 依赖的 Tool 未注册（SKILL_DEPENDENCY_NOT_MET）
- Plugin 初始化失败（PLUGIN_INIT_FAILED）
- Storage 重复注册（STORAGE_DUPLICATE）
- default_model 无效（INVALID_DEFAULT_MODEL）

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

---

## 10. Thread Safety & Concurrency

- Agent 是 Send + Sync，可通过 Arc 在多线程间共享
- 单会话模型：同一时间至多一个 Session 运行，Agent 内部维护互斥状态，拒绝在已有 Session 运行时创建新 Session
- Session 拥有自己的 Context Manager 和 Turn 状态
- 同一 Turn 内 Tool 批次全为只读时并发执行，含 mutating 时整批串行执行
- 所有注册 trait 要求 Send + Sync
- 通过 CancellationToken 实现协作式取消



