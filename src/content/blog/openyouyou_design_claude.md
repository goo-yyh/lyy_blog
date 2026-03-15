---
title: openyouyou 的 agent 架构设计文档 by claude
date: 2026-03-16
description: agent 设计
category: 胡说八道
---
# YouYou Agent - Architecture Design

| Field       | Value               |
|-------------|---------------------|
| Document ID | 0006-claude         |
| Type        | design              |
| Status      | Draft               |
| Review Status | revised after 0007-claude review |
| Created     | 2026-03-14          |
| Related     | 0005 (requirements) |
| Module Path | `src-tauri/src/agent/` |

> **Note**: 本设计以当前仓库的 Tauri 集成路径 `src-tauri/src/agent/` 为目标。若后续抽离为独立 crate，应保持公共 API 和模块边界不变，并由宿主层做 re-export / 适配。

### Requirement Alignment Notes

本设计以 `0005` 为**唯一规范基线**。以下内容仅记录实现层细化和内部约束，不覆盖 `0005` 的公共契约；若未来需要修改公共契约，应先回写 `0005`，再同步更新本设计。

#### A1 — Hook 能力分类仅作为内部实现细化

**对齐原则：** 对外 Plugin / Hook 契约仍使用 `0005 §3.5` 的统一 `HookResult { Continue, ContinueWith(patch), Abort(reason) }`。

**内部实现细化：** HookRegistry 在内部可按“是否允许 patch”“是否需要累积 patch”等能力做分支处理，但这不改变对外 API。

#### A2 — 压缩统一持久化已渲染文本

**对齐原则：** 仍满足 `0005 §5.2` 中“压缩完成后向模型明确说明摘要来源 / 压缩来源”的要求。

**内部实现细化：** `CompactionMarker.rendered_summary` 持久化最终渲染文本；Summary 模式使用 `Appendix B.2 + 模型摘要正文`，Truncation 模式使用 `Appendix B.2 + 固定截断说明`。恢复路径只重放最终文本，避免两条路径重复渲染前缀导致不一致。

#### A3 — Tool 超时取消协议与外部 CancellationToken

**对齐原则：** `0005 §5.4` 要求"超时后取消 Tool 执行并返回超时错误"；`0005 §6.2` 要求"用户取消时，已在执行的 Tool 等待完成并正常记录结果"。本设计同时满足这两个约束。

**内部实现细化：**
1. `ToolHandler::execute()` 接收的是 **per-tool timeout token**，仅在 Tool 自身超时时触发，使 Tool 实现可感知超时并主动中止。
2. Turn / 用户取消只停止 Provider 继续生成和后续 Tool 调度，不向已在执行的 Tool 下发取消信号；已启动 Tool 仍等待完成并正常记账。
3. `send_message()` 可额外接受宿主系统传入的外部 `CancellationToken`，用于与 HTTP 连接、窗口生命周期或上层任务树集成。这是增量能力，不改变上述取消语义。

#### A4 — Memory 提取：模型输出操作类型，Agent 做校验和执行

**对齐原则：** v1 单阶段记忆提取的模型输入输出仍遵循 `0005 Appendix B.10 + B.11`。`0005 §5.7` 明确要求"一次 LLM 调用同时完成提取和整合判断（create/update/delete/skip）"。

**内部实现细化：** 模型输出结构化 JSON，每条记忆项携带操作类型（`create / update / delete / skip`）和目标 id（update/delete 时）。Agent 内部 planner 仅负责校验（如 id 存在性）和映射到 Storage 的 `upsert / delete` 操作，不重新做整合判断决策。

#### A5 — Tool 输出 metadata 子限额（细化 0005 §5.4）

**0005 原始定义：** "单次 Tool 输出大小上限为 1MB"。

**本设计细化：** 保持总预算 1MB 不变，在总预算内对 `metadata` 增加独立子限额（默认 64KB）。`metadata` 穿透事件流、Hook、Ledger、恢复链路，若不受控会放大写入和重放成本。总预算与 0005 一致，子限额是内部实现细化，不影响外部契约。

---

## 1. Design Principles

- **Clean Architecture**: 依赖方向严格从外向内。Domain 层定义 trait（port），Application 层编排业务逻辑，API 层暴露公共接口。外部实现由调用方注入
- **SOLID**: 单一职责（每个模块一件事）、开闭原则（通过 trait 扩展）、里氏替换（trait 契约一致）、接口隔离（细粒度 trait）、依赖倒置（核心依赖抽象）
- **KISS**: 不引入 DI 容器、Actor 系统、消息总线。直接的 struct 组合和函数调用
- **YAGNI**: 仅实现 0005 中明确要求的功能。不预实现 v2 两阶段记忆、多会话并行、动态注册等

---

## 2. Architecture Overview

四层架构，依赖方向从上到下：

```text
┌──────────────────────────────────────────────────────┐
│  API Layer                                           │
│  AgentBuilder, Agent, SessionHandle, RunningTurn     │
├──────────────────────────────────────────────────────┤
│  Application Layer                                   │
│  TurnEngine, ContextManager, PromptBuilder,          │
│  ToolDispatcher, SkillManager, MemoryManager,        │
│  PluginManager, HookRegistry                         │
├──────────────────────────────────────────────────────┤
│  Domain Layer                                        │
│  Message, ContentBlock, AgentEvent, AgentError,      │
│  SessionLedger, CompactionMarker, TurnOutcome,       │
│  HookPayload, AgentConfig, validation rules          │
├──────────────────────────────────────────────────────┤
│  Port Layer (traits)                                 │
│  ModelProvider, ToolHandler, Plugin,                  │
│  SessionStorage, MemoryStorage                       │
└──────────────────────────────────────────────────────┘
```

核心设计判断：

1. **Agent 是不可变内核 + 受控的单会话槽**。构建完成后注册表全部冻结
2. **SessionLedger 是会话事实源**。ContextManager 仅是 Ledger 的投影，不是独立的事实源
3. **TurnEngine 是唯一编排者**。其他 Application 层组件不反向依赖它
4. **AgentEvent 是过程反馈，TurnOutcome 是终态语义**。二者分离，由独立通道承接

---

## 3. Module Structure

```text
src-tauri/src/agent/
├── mod.rs                      // 模块入口，re-export 公共 API
│
├── domain/                     // 领域层：值类型、错误、规则
│   ├── mod.rs
│   ├── types.rs                // Message, ContentBlock, MessageStatus, Memory 等
│   ├── event.rs                // AgentEvent, AgentEventPayload
│   ├── error.rs                // AgentError 错误枚举
│   ├── config.rs               // AgentConfig, SessionConfig, EnvironmentContext
│   ├── ledger.rs               // SessionLedger, LedgerEvent, CompactionMarker
│   ├── hook.rs                 // HookEvent, HookPayload, HookData, HookResult, HookPatch
│   └── state.rs                // LifecycleState, SessionSlotState, TurnOutcome
│
├── ports/                      // 端口层：所有外部依赖的 trait 定义
│   ├── mod.rs
│   ├── model.rs                // ModelProvider, ModelInfo, ChatRequest, ChatEvent
│   ├── tool.rs                 // ToolHandler, ToolInput, ToolOutput
│   ├── plugin.rs               // Plugin trait, PluginContext
│   └── storage.rs              // SessionStorage, MemoryStorage
│
├── application/                // 应用层：业务编排
│   ├── mod.rs
│   ├── turn_engine.rs          // run_turn()：单轮对话编排
│   ├── context_manager.rs      // ContextManager：上下文投影 + 压缩
│   ├── prompt_builder.rs       // PromptBuilder：System Prompt 组装
│   ├── tool_dispatcher.rs      // ToolDispatcher：路由、并发/串行、超时
│   ├── skill_manager.rs        // SkillManager：注册表 + 触发检测
│   ├── memory_manager.rs       // MemoryManager：加载、注入、提取
│   ├── plugin_manager.rs       // PluginManager：生命周期管理
│   └── hook_registry.rs        // HookRegistry：事件注册 + 顺序分发
│
├── api/                        // API 层：对外接口
│   ├── mod.rs
│   ├── builder.rs              // AgentBuilder：校验 + 构建
│   ├── agent.rs                // Agent：不可变内核 + 单会话槽
│   ├── session.rs              // SessionHandle：会话操作入口
│   └── running_turn.rs         // RunningTurn：Turn 句柄
│
└── prompt/                     // 内置 prompt 模板（Appendix B）
    └── templates.rs
```

当前设计文档直接对应仓库内的 `src-tauri/src/agent/` 目录。若后续需要拆分成独立 crate，保持目录分层和 public API 不变，由宿主层做包装即可。

### 依赖规则

| 层        | 可依赖        | 不可依赖            |
|-----------|--------------|-------------------|
| API       | Application, Domain, Ports | -     |
| Application | Domain, Ports | API              |
| Domain    | 标准库, serde, chrono | Ports, Application, API |
| Ports     | Domain       | Application, API   |

模块间无循环依赖。Application 层模块之间不直接互相调用，由 TurnEngine 统一编排。

---

## 4. Domain Layer

### 4.1 Message

```rust
/// 对话中的一条消息
#[derive(Debug, Clone)]
pub enum Message {
    User { content: Vec<ContentBlock> },
    Assistant { content: Vec<ContentBlock>, status: MessageStatus },
    ToolCall { call_id: String, tool_name: String, arguments: serde_json::Value },
    ToolResult { call_id: String, output: ToolOutput },
    System { content: String },
}

/// Tool 执行结果，统一用于 Message、LedgerEvent、AgentEvent、HookData
#[derive(Debug, Clone)]
pub struct ToolOutput {
    /// 输出文本内容（进入 LLM 上下文）
    pub content: String,
    /// 是否出错
    pub is_error: bool,
    /// 可选的结构化元数据（不进入 LLM 上下文，但持久化到 Ledger，
    /// 透传给 AgentEvent::ToolCallEnd 和 HookData::AfterToolUse）
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageStatus {
    Complete,
    Incomplete,
}

#[derive(Debug, Clone)]
pub enum ContentBlock {
    Text(String),
    Image { data: String, media_type: String },
    File { name: String, media_type: String, text: String },
}
```

### 4.2 SessionLedger — 会话事实源

所有会改变后续上下文的事实，都必须先写账本，再更新内存投影。Ledger 使用单调递增序号，所有持久化与恢复都围绕它展开。

```rust
/// 账本事件，每个事件分配唯一的单调递增序号
#[derive(Debug, Clone)]
pub struct LedgerEvent {
    pub seq: u64,
    pub timestamp: DateTime<Utc>,
    pub payload: LedgerEventPayload,
}

#[derive(Debug, Clone)]
pub enum LedgerEventPayload {
    UserMessage { content: Vec<ContentBlock> },
    AssistantMessage { content: Vec<ContentBlock>, status: MessageStatus },
    ToolCall { call_id: String, tool_name: String, arguments: serde_json::Value },
    ToolResult { call_id: String, output: ToolOutput },
    SystemMessage { content: String },
    /// 元数据事件，仅支持以下标准 key
    Metadata { key: MetadataKey, value: serde_json::Value },
}

/// 标准化的 Metadata key，避免 stringly-typed 错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetadataKey {
    /// 会话配置：model_id, system_prompt_override
    SessionConfig,
    /// 会话绑定的 memory namespace（new_session 时固化，resume 时原样恢复）
    MemoryNamespace,
    /// 上下文压缩标记：replaces_through_seq, rendered_summary
    ContextCompaction,
    /// 记忆 checkpoint 边界：last_seq, turn_index
    MemoryCheckpoint,
}
```

**为什么不直接用 `Vec<Message>` 做事实源？**

- compact 会替换历史消息，导致 `Vec` 下标不稳定
- 记忆 checkpoint 的增量边界需要稳定的序号
- 恢复会话时需要从账本重放可见上下文，下标无法正确表达"替换边界"

### 4.3 CompactionMarker — 压缩恢复协议

```rust
/// 压缩标记，不删除历史账本事件，只标记哪些事件被摘要替代
#[derive(Debug, Clone)]
pub struct CompactionMarker {
    /// 此摘要替代了 seq <= replaces_through_seq 的所有消息事件
    pub replaces_through_seq: u64,
    /// 已渲染的合成 system message 文本。
    /// 在 compact 执行时一次性渲染完毕并持久化，恢复路径直接插入此文本，
    /// 无需区分压缩模式或重新拼接前缀。
    /// - Summary 模式：`COMPACT_SUMMARY_PREFIX + 摘要文本`
    /// - Truncation 模式：截断专用提示文本
    pub rendered_summary: String,
}
```

**设计决策：持久化已渲染文本而非原始数据 + 模式标记。**

备选方案是增加 `mode: Summary | Truncation` 字段，让恢复路径根据 mode 选择不同前缀。但这需要恢复路径维护与实时路径相同的前缀渲染逻辑，二者一旦不同步就会打破一致性。直接持久化最终文本，恢复路径只需 `Message::System(rendered_summary)`，正确性显而易见（见 D16）。

**恢复时的可见上下文重建算法：**

1. 取最后一个 `ContextCompaction` Metadata
2. 若存在，先插入合成的 `Message::System(marker.rendered_summary)`
3. 仅重放 `seq > replaces_through_seq` 的消息事件（包括 `SystemMessage`）

步骤 2 不做任何前缀拼接或模式判断。除 `Incomplete` AssistantMessage 的恢复提示外，恢复路径不推断其他 synthetic message；事实源仍以 Ledger 为准（完整算法见 §8.2）。

### 4.4 AgentControl 与 SessionRuntime — 双层锁模型

系统使用**两把锁**，职责严格分离：

- **AgentControl**（`std::sync::Mutex`）：管理 Agent 生命周期和 Session 槽的所有权。短暂持有，绝不跨 `.await`
- **SessionRuntime**（`tokio::sync::Mutex`）：管理会话内部易失状态。可以跨 `.await` 持有（如 TurnEngine 运行期间）

**锁职责表：**

| 字段 | 归属 | 说明 |
|------|------|------|
| `lifecycle` | AgentControl | Agent 是否在运行/关闭 |
| `slot` (Empty/Reserved/Active) | AgentControl | Session 槽的所有权转移 |
| `session_cancel_token` | AgentControl::Active | 关闭会话时取消当前 Turn |
| `turn_state` (Idle/Running) | AgentControl::Active | Turn 启动/关闭的原子切换 |
| `ledger`, `context_state`, `turn_index`, ... | SessionRuntime | Turn 运行期间的读写 |

**交互规则：**
1. `send_message()`：短暂获取 `AgentControl` 检查 lifecycle + 切换 `turn_state` → 释放 → 通过 `Arc` 访问 `SessionRuntime` 执行 Turn
2. `close()`：短暂获取 `AgentControl` 取出 cancel_token + turn_handle → 释放 → 等待 Turn → 通过 `Arc` 访问 `SessionRuntime` 做记忆提取 → 获取 `AgentControl` 清空 slot
3. TurnEngine 运行期间只持有 `SessionRuntime` 锁，不触碰 `AgentControl`

```rust
/// Agent 生命周期状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LifecycleState {
    Running,
    ShuttingDown,
    Shutdown,
}

/// Session 槽状态
#[derive(Debug)]
enum SessionSlotState {
    /// 无活跃 Session
    Empty,
    /// 已预留但未提交（构建中）
    Reserved {
        reservation_id: String,
        session_id: String,
    },
    /// 活跃 Session。持有 SessionRuntime 的 Arc 引用，
    /// 使得 TurnEngine 可在不持有 AgentControl 锁的情况下访问会话状态
    Active {
        session_id: String,
        session_cancel_token: CancellationToken,
        turn_state: TurnState,
        runtime: Arc<tokio::sync::Mutex<SessionRuntime>>,
    },
}

/// 将 lifecycle 和 slot 统一在同一个结构中，受同一把 std::sync::Mutex 保护
struct AgentControl {
    lifecycle: LifecycleState,
    slot: SessionSlotState,
}

#[derive(Debug)]
enum TurnState {
    Idle,
    Running(RunningTurnHandle),
}

/// 活跃 Turn 的控制句柄
struct RunningTurnHandle {
    turn_cancel_token: CancellationToken,
    turn_finished_rx: oneshot::Receiver<()>,
}
```

关键约束：

1. `claim_session_slot()` 在**同一临界区**内同时检查 `lifecycle == Running` 和 `slot == Empty`，二者都满足才允许 claim
2. `new_session()` / `resume_session()` 先写入 `Reserved`，成功提交后切换为 `Active`
3. `shutdown()` 在同一临界区内 `Running -> ShuttingDown`，此后任何 Session 创建返回 `AGENT_SHUTDOWN`
4. `Reserved` 状态下创建失败时，按 `reservation_id` 回滚到 `Empty`

### 4.5 SessionRuntime — 会话内部状态

`SessionRuntime` 包含 Turn 运行期间需要读写的全部会话数据，通过 `Arc<tokio::sync::Mutex<...>>` 共享，可安全跨 `.await` 持有。

```rust
/// 当前会话的全部易失状态
struct SessionRuntime {
    session_id: String,
    model_id: String,
    system_prompt_override: Option<String>,
    /// 会话绑定的 memory namespace（new_session 时从 AgentConfig 固化，
    /// resume 时从 Ledger Metadata 恢复，运行期间不可变）
    memory_namespace: String,
    /// 会话事件账本（内存态）
    ledger: SessionLedger,
    /// 上下文投影与压缩状态
    context_manager: ContextManager,
    /// 对外 AgentEvent 的序号计数器
    event_sequence: u64,
    /// 当前轮次编号
    turn_index: u64,
    /// 最近一次 checkpoint 覆盖到的 ledger seq
    last_memory_checkpoint_seq: u64,
    /// Session 启动时加载的 bootstrap 记忆
    bootstrap_memories: Vec<Memory>,
}
```

注意 `session_cancel_token` 和 `turn_state` 不在 `SessionRuntime` 中——它们归 `AgentControl::Active` 管理，保证 `close()` 无需获取 `SessionRuntime` 锁即可触发取消。

### 4.6 TurnOutcome — 终态语义

`AgentEvent` 流处理实时反馈，`TurnOutcome` 处理最终语义，二者分离、由独立通道承接。

```rust
/// Turn 的终态结果，不从事件流倒推
#[derive(Debug)]
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Failed(AgentError),
    /// 后台 task panic，对应 INTERNAL_PANIC
    Panicked,
}
```

### 4.7 AgentEvent — 过程反馈

```rust
#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub session_id: String,
    pub turn_id: String,
    pub timestamp: DateTime<Utc>,
    pub sequence: u64,
    pub payload: AgentEventPayload,
}

#[derive(Debug, Clone)]
pub enum AgentEventPayload {
    TextDelta(String),
    ReasoningDelta(String),
    ToolCallStart { call_id: String, tool_name: String, arguments: serde_json::Value },
    ToolCallEnd { call_id: String, tool_name: String, output: ToolOutput, duration_ms: u64, success: bool },
    ContextCompacted,
    TurnComplete,
    TurnCancelled,
    Error(AgentError),
}
```

边界规则：
- `AgentEvent` 只用于实时展示，不作为恢复依据。恢复 Session 只看 `SessionLedger`
- `ToolCallStart` 一定在对应 `ToolCallEnd` 之前
- `TurnComplete` 或 `TurnCancelled` 是一轮 Turn 的最后一个事件

### 4.8 AgentConfig

```rust
#[derive(Debug)]
pub struct AgentConfig {
    // -- 模型相关 --
    /// 默认模型 ID
    pub default_model: String,

    // -- Prompt 相关 --
    /// 系统指令文本列表
    pub system_instructions: Vec<String>,
    /// 人设定义（可选）
    pub personality: Option<String>,
    /// 环境上下文（可选）
    pub environment_context: Option<EnvironmentContext>,

    // -- Tool 相关 --
    /// Tool 执行超时（毫秒），默认 120_000
    pub tool_timeout_ms: u64,
    /// 单轮最大 Tool 调用次数，默认 50
    pub max_tool_calls_per_turn: usize,
    /// Tool 单次输出总预算（字节），默认 1_048_576（1MB），对齐 0005 §5.4
    /// content + metadata 序列化后的总大小不得超过此值
    pub tool_output_max_bytes: usize,
    /// Tool 输出 metadata 在总预算内的子限额（序列化后），默认 65_536（64KB）
    /// metadata 超限时被替换为截断标记，剩余预算分配给 content
    pub tool_output_metadata_max_bytes: usize,

    // -- 压缩相关 --
    /// 上下文压缩阈值（0.0-1.0），默认 0.8
    pub compact_threshold: f64,
    /// 压缩使用的模型 ID（可选）
    pub compact_model: Option<String>,
    /// 压缩 prompt 模板（可选）
    pub compact_prompt: Option<String>,

    // -- 记忆相关 --
    /// 记忆提取使用的模型 ID（可选）
    pub memory_model: Option<String>,
    /// 记忆 checkpoint 间隔（轮次），默认 10
    pub memory_checkpoint_interval: u64,
    /// 每次注入的记忆数量上限，默认 20
    pub memory_max_items: usize,
    /// 记忆 namespace
    pub memory_namespace: String,
}
```

各字段的唯一消费者：

| 字段 | 消费组件 |
|------|---------|
| `default_model` | API Layer (new_session) |
| `system_instructions`, `personality`, `environment_context` | PromptBuilder |
| `tool_timeout_ms`, `max_tool_calls_per_turn`, `tool_output_max_bytes`, `tool_output_metadata_max_bytes` | ToolDispatcher / TurnEngine |
| `compact_threshold`, `compact_model`, `compact_prompt` | ContextManager |
| `memory_*` | MemoryManager |

### 4.9 公共类型定义

以下类型在多处使用，集中定义以确保一致性。

```rust
/// 会话创建时的配置
#[derive(Debug, Clone, Default)]
pub struct SessionConfig {
    /// 覆盖默认模型（可选，不指定则使用 AgentConfig.default_model）
    pub model_id: Option<String>,
    /// 追加的系统 prompt（可选，追加在 system_instructions 之后，包裹 <system_prompt_override> 标签）
    pub system_prompt_override: Option<String>,
}

/// 用户输入
#[derive(Debug, Clone)]
pub struct UserInput {
    /// 输入内容块列表，至少包含一个非空元素
    pub content: Vec<ContentBlock>,
}

/// Skill 定义
#[derive(Debug, Clone)]
pub struct SkillDefinition {
    /// Skill 唯一名称（用于 /name 触发）
    pub name: String,
    /// 显示名称
    pub display_name: String,
    /// 简短描述（用于 System Prompt 的 Skill List）
    pub description: String,
    /// 触发时注入的 prompt 模板
    pub prompt_template: String,
    /// 该 Skill 依赖的 Tool 名称列表（build 阶段校验）
    pub required_tools: Vec<String>,
    /// 是否出现在 System Prompt 的 Skill List 中供模型建议用户使用
    pub allow_implicit_invocation: bool,
}

/// 跨会话记忆条目（字段对齐 0005 §3.7）
#[derive(Debug, Clone)]
pub struct Memory {
    /// 全局唯一 ID（建议使用 UUID）
    pub id: String,
    /// 记忆所属的 namespace
    pub namespace: String,
    /// 记忆内容文本
    pub content: String,
    /// 记忆来源标识，用于追踪、审计和 UI 展示
    /// 约定值：`"session:<session_id>"`（对话提取）、`"checkpoint"`（增量 checkpoint 提取）、
    /// `"manual"`（调用方手动写入）。Agent 不解读其内容，由写入方自行填充。
    pub source: String,
    /// 标签列表（用于分类和过滤）
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

### 4.10 Hook Contract

Hook 的**对外契约**对齐 `0005 §3.5`，统一使用 `HookResult`。实现层可以根据 Hook 是否支持 patch 做内部分类，但不改变 Plugin 作者看到的 API。

```rust
/// Hook 事件统一枚举（用于 PluginDescriptor 声明和 HookRegistry 索引）
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum HookEvent {
    SessionStart,
    SessionEnd,
    TurnStart,
    TurnEnd,
    BeforeToolUse,
    AfterToolUse,
    BeforeCompact,
}

impl HookEvent {
    /// 仅 `TurnStart` / `BeforeToolUse` 支持 ContinueWith(patch)
    pub fn supports_patch(&self) -> bool {
        match self {
            Self::TurnStart | Self::BeforeToolUse => true,
            Self::SessionStart | Self::SessionEnd
            | Self::TurnEnd | Self::AfterToolUse | Self::BeforeCompact => false,
        }
    }
}
```

```rust
#[derive(Debug, Clone)]
pub struct HookPayload {
    pub event: HookEvent,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub plugin_config: serde_json::Value,
    pub data: HookData,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub enum HookData {
    SessionStart { model_id: String },
    SessionEnd { message_count: usize },
    TurnStart { user_input: UserInput, dynamic_sections: Vec<String> },
    TurnEnd { assistant_output: String, tool_calls_count: usize, cancelled: bool },
    BeforeToolUse { tool_name: String, arguments: serde_json::Value },
    AfterToolUse { tool_name: String, output: ToolOutput, duration_ms: u64, success: bool },
    BeforeCompact { message_count: usize, estimated_tokens: usize },
}

/// 统一 Hook 返回类型（对齐 0005 §3.5）
pub enum HookResult {
    Continue,
    ContinueWith(HookPatch),
    Abort(String),
}

/// 事件特化的 patch 类型，限制可修改范围
pub enum HookPatch {
    TurnStart { append_dynamic_sections: Vec<String> },
    BeforeToolUse { arguments: serde_json::Value },
}

impl HookPatch {
    pub fn matches(&self, event: HookEvent) -> bool {
        matches!(
            (self, event),
            (Self::TurnStart { .. }, HookEvent::TurnStart)
                | (Self::BeforeToolUse { .. }, HookEvent::BeforeToolUse)
        )
    }
}
```

**约束：**

1. `ContinueWith(patch)` 只允许出现在 `TurnStart` 和 `BeforeToolUse`。
2. 对其他 Hook 返回 `ContinueWith` 属于 `PluginHookContractViolation`。
3. `Abort(reason)` 统一表示“中止当前操作”，具体到每个 Hook 的当前操作范围见 §6.8。

### 4.11 AgentError

```rust
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    // -- 构建阶段 --
    #[error("[NO_MODEL_PROVIDER] at least one ModelProvider is required")]
    NoModelProvider,
    #[error("[NAME_CONFLICT] {kind} name '{name}' is duplicated")]
    NameConflict { kind: &'static str, name: String },
    #[error("[SKILL_DEPENDENCY_NOT_MET] skill '{skill}' requires tool '{tool}'")]
    SkillDependencyNotMet { skill: String, tool: String },
    #[error("[PLUGIN_INIT_FAILED] plugin '{id}': {source}")]
    PluginInitFailed { id: String, #[source] source: anyhow::Error },
    #[error("[PLUGIN_HOOK_CONTRACT_VIOLATION] plugin '{plugin_id}': {message}")]
    PluginHookContractViolation { plugin_id: String, message: String },
    #[error("[STORAGE_DUPLICATE] {kind} storage registered more than once")]
    StorageDuplicate { kind: &'static str },
    #[error("[INVALID_DEFAULT_MODEL] default model '{0}' is not registered")]
    InvalidDefaultModel(String),
    #[error("[INVALID_MODEL_CONFIG] {kind} model '{model_id}' is not registered")]
    InvalidModelConfig { kind: &'static str, model_id: String },

    // -- 运行阶段 --
    #[error("[INPUT_VALIDATION] {message}")]
    InputValidation { message: String },
    #[error("[SESSION_BUSY] a session is already running")]
    SessionBusy,
    #[error("[TURN_BUSY] a turn is already running in this session")]
    TurnBusy,
    #[error("[MODEL_NOT_SUPPORTED] model '{0}' is not supported")]
    ModelNotSupported(String),
    #[error("[PROVIDER_ERROR] {message}")]
    ProviderError { message: String, #[source] source: anyhow::Error, retryable: bool },
    #[error("[TOOL_EXECUTION_ERROR] tool '{name}': {source}")]
    ToolExecutionError { name: String, #[source] source: anyhow::Error },
    #[error("[TOOL_TIMEOUT] tool '{name}' timed out after {timeout_ms}ms")]
    ToolTimeout { name: String, timeout_ms: u64 },
    #[error("[TOOL_NOT_FOUND] tool '{0}'")]
    ToolNotFound(String),
    #[error("[SKILL_NOT_FOUND] skill '{0}'")]
    SkillNotFound(String),
    #[error("[SESSION_NOT_FOUND] session '{0}'")]
    SessionNotFound(String),
    #[error("[STORAGE_ERROR] {0}")]
    StorageError(#[source] anyhow::Error),
    #[error("[MAX_TOOL_CALLS_EXCEEDED] exceeded {limit} tool calls in one turn")]
    MaxToolCallsExceeded { limit: usize },
    #[error("[COMPACT_ERROR] context compaction failed: {message}")]
    CompactError { message: String },
    #[error("[PLUGIN_ABORTED] hook '{hook}' aborted: {reason}")]
    PluginAborted { hook: &'static str, reason: String },
    #[error("[REQUEST_CANCELLED]")]
    RequestCancelled,
    #[error("[INTERNAL_PANIC] background task panicked: {message}")]
    InternalPanic { message: String },
    #[error("[AGENT_SHUTDOWN] agent has been shut down")]
    AgentShutdown,
}

impl AgentError {
    pub fn code(&self) -> &'static str { /* match self => error code string */ }
    pub fn retryable(&self) -> bool { matches!(self, Self::ProviderError { retryable: true, .. }) }
    pub fn source_component(&self) -> &'static str {
        match self {
            Self::ProviderError { .. } | Self::CompactError { .. } => "provider",
            Self::ToolExecutionError { .. } | Self::ToolTimeout { .. }
                | Self::ToolNotFound(_) => "tool",
            Self::PluginInitFailed { .. } | Self::PluginAborted { .. }
                | Self::PluginHookContractViolation { .. } => "plugin",
            Self::StorageError(_) => "storage",
            _ => "agent",
        }
    }
}
```

**错误码完整映射表（对齐 0005 §9）：**

| 错误码 | 触发位置 | 对外暴露方式 |
|--------|----------|-------------|
| `NO_MODEL_PROVIDER` | `build()` 校验 | `build()` 返回 `Err` |
| `NAME_CONFLICT` | `build()` 校验 | `build()` 返回 `Err` |
| `SKILL_DEPENDENCY_NOT_MET` | `build()` 校验 | `build()` 返回 `Err` |
| `PLUGIN_INIT_FAILED` | `build()` 调用 `initialize()` | `build()` 返回 `Err` |
| `PLUGIN_HOOK_CONTRACT_VIOLATION` | `apply()` 中 `tap()` 校验失败，或运行期收到不支持的 `ContinueWith` | `build()` 返回 `Err` / 当前操作失败 |
| `STORAGE_DUPLICATE` | `build()` 校验 | `build()` 返回 `Err` |
| `INVALID_DEFAULT_MODEL` | `build()` 校验 | `build()` 返回 `Err` |
| `INVALID_MODEL_CONFIG` | `build()` 校验（compact_model / memory_model） | `build()` 返回 `Err` |
| `INPUT_VALIDATION` | `send_message()` 步骤 1 | `send_message()` 返回 `Err` |
| `SESSION_BUSY` | `claim_session_slot()` | `new_session()` / `resume_session()` 返回 `Err` |
| `TURN_BUSY` | `send_message()` 步骤 2 | `send_message()` 返回 `Err` |
| `MODEL_NOT_SUPPORTED` | `ModelRegistry::resolve()` | `send_message()` 返回 `Err` |
| `PROVIDER_ERROR` | `ModelProvider::chat()` | `TurnOutcome::Failed` |
| `TOOL_EXECUTION_ERROR` | `ToolHandler::execute()` | `AgentEvent::Error` + synthetic `ToolOutput` |
| `TOOL_TIMEOUT` | `ToolHandler::execute()` 超时 | `AgentEvent::Error` + synthetic `ToolOutput` |
| `TOOL_NOT_FOUND` | `ToolDispatcher` resolve 失败 | `AgentEvent::Error` + synthetic `ToolOutput` |
| `SKILL_NOT_FOUND` | `send_message()` 步骤 2（Skill 解析） | `send_message()` 返回 `Err` |
| `SESSION_NOT_FOUND` | `resume_session()` 加载失败 | `resume_session()` 返回 `Err` |
| `STORAGE_ERROR` | `SessionStorage` / `MemoryStorage` 失败 | 关键事件：`TurnOutcome::Failed`；非关键：`AgentEvent::Error` |
| `MAX_TOOL_CALLS_EXCEEDED` | 单轮 Tool 调用超限 | `AgentEvent::Error` + `TurnOutcome::Failed`（可能伴随收尾回复） |
| `COMPACT_ERROR` | compact 摘要 + 截断都无法恢复 | `TurnOutcome::Failed` |
| `PLUGIN_ABORTED` | Hook `Abort` | 视 Hook 类型：SessionStart→`Err`；TurnStart→`TurnOutcome::Failed` |
| `REQUEST_CANCELLED` | 取消 | `TurnOutcome::Cancelled` |
| `INTERNAL_PANIC` | supervisor 检测到 panic | `TurnOutcome::Panicked` |
| `AGENT_SHUTDOWN` | `is_shutdown` 后的操作 | 返回 `Err` |

---

## 5. Port Layer

所有外部能力通过 trait 注入，核心层不依赖任何具体实现。所有 trait 要求 `Send + Sync`。

### 5.1 ModelProvider

```rust
/// 注意：此 trait 需要 object safety（用于 `Arc<dyn ModelProvider>`），
/// 使用 async-trait 而非原生 async fn in trait。
#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn id(&self) -> &str;
    fn models(&self) -> &[ModelInfo];
    async fn chat(
        &self,
        request: ChatRequest,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<ChatEvent>> + Send>>>;
}

#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub context_window: usize,
    pub capabilities: ModelCapabilities,
}

#[derive(Debug, Clone)]
pub struct ModelCapabilities {
    pub tool_use: bool,
    pub vision: bool,
    pub streaming: bool,
}

/// 发送给 ModelProvider 的请求
#[derive(Debug, Clone)]
pub struct ChatRequest {
    /// 目标模型 ID（已由 ModelRegistry 路由到对应 Provider）
    pub model_id: String,
    /// 完整消息列表。首条 `Message::System` 由 PromptBuilder 渲染并在构建请求时前置，
    /// 其后为 ContextManager 提供的可见消息历史。
    pub messages: Vec<Message>,
    /// 可用工具定义列表（空数组 = 禁用 tool 调用）
    pub tools: Vec<ToolDefinition>,
    /// 采样温度（可选，Provider 使用自身默认值）
    pub temperature: Option<f64>,
    /// 最大生成 token 数（可选）
    pub max_tokens: Option<u32>,
    /// 推理努力程度（可选，用于支持 extended thinking 的模型）
    pub reasoning_effort: Option<String>,
}

/// 工具定义，序列化后传递给模型 API
#[derive(Debug, Clone)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value, // JSON Schema
}

/// 模型流式返回的事件
#[derive(Debug, Clone)]
pub enum ChatEvent {
    /// 文本增量
    TextDelta(String),
    /// 推理过程增量
    ReasoningDelta(String),
    /// 工具调用请求
    ToolCall {
        call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    /// 完成，携带 usage 信息
    Done { usage: TokenUsage },
    /// 错误（Provider 应区分 retryable 与否）
    Error(ChatError),
}

/// Token 使用统计
#[derive(Debug, Clone, Default)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

/// Provider 级别的错误
#[derive(Debug, Clone)]
pub struct ChatError {
    pub message: String,
    pub retryable: bool,
    /// 是否为 context_length_exceeded 错误（触发兜底 compact）
    pub is_context_length_exceeded: bool,
}
```

约束：至少注册一个。Provider ID 唯一。所有 model_id 跨 Provider 全局唯一。

**Provider 能力检查边界：** Agent 不替 Provider 做能力猜测。`tool_use=false` 的模型收到非空 `tools` 时，由 Provider 自行决定行为（忽略或报错）。`vision=false` 的模型收到图片输入时，由 Provider 返回明确的 `ChatError`。Agent 将 Provider 返回的错误统一映射为 `AgentError::ProviderError`。

### 5.2 ToolHandler

```rust
#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> serde_json::Value;
    fn is_mutating(&self) -> bool;
    /// 执行 Tool。
    /// `timeout_cancel` 由 ToolDispatcher 管理，仅在该 Tool 自身超时时触发。
    /// 用户 / Turn 取消不会取消已在执行中的 Tool；运行中的 Tool 仍需完成并正常记账。
    /// 实现方应在合理时机检查 `timeout_cancel.is_cancelled()` 并提前返回错误，
    /// 以便 Agent 在超时场景下及时回收控制权。对于无法主动检查的阻塞操作
    /// （如子进程、外部 HTTP 请求），实现方应使用 `tokio::select!` 等机制
    /// 配合 `timeout_cancel` 信号实现协作式超时中止。
    async fn execute(&self, input: ToolInput, timeout_cancel: CancellationToken) -> Result<ToolOutput>;
}

/// Tool 调用的输入
#[derive(Debug, Clone)]
pub struct ToolInput {
    pub call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
}
```

`ToolOutput` 定义见 §4.1。`ToolHandler::execute()` 返回的 `ToolOutput.metadata` 由 Tool 实现方自行填充（如文件路径、行号等），Agent 不解读其内容。

**Tool 取消语义说明：**

`CancellationToken` 是**协作式超时中止**协议——Agent 在 Tool 超时时发出信号，Tool 实现方负责在合理时机响应。Agent 不对"超时后 Tool 一定立即停止"做硬保证。具体行为取决于 Tool 实现：

- **纯 async 操作**（网络请求等）：`tokio::select!` 监听 `timeout_cancel`，超时后立即返回错误
- **spawn_blocking / 子进程**：实现方应持有子进程 handle，`timeout_cancel` 触发时 kill 子进程
- **无法中止的操作**：ToolDispatcher 在超时后立即返回 `TOOL_TIMEOUT`，晚到结果被忽略；实现方仍应尽量缩短超时后的残留执行时间

ToolDispatcher 的超时实现为：为每个 Tool 创建独立的 `tool_timeout_token`，执行 `handler.execute(input, tool_timeout_token.clone())`。超时时先 `tool_timeout_token.cancel()` 通知 Tool 停止，再返回超时错误。该 token 不与 turn cancel 共享，避免用户取消误伤正在执行的 Tool。

### 5.3 Plugin

```rust
#[async_trait]
pub trait Plugin: Send + Sync {
    /// 返回 Plugin 的静态描述信息，包含声明要 tap 的 Hook 列表
    fn descriptor(&self) -> PluginDescriptor;
    async fn initialize(&self, config: serde_json::Value) -> Result<()>;
    fn apply(self: Arc<Self>, ctx: &mut PluginContext);
    async fn shutdown(&self) -> Result<()>;
}

/// Plugin 的静态描述，用于 build 阶段校验和 System Prompt 渲染
#[derive(Debug, Clone)]
pub struct PluginDescriptor {
    pub id: String,
    pub display_name: String,
    pub description: String,
    /// 该 Plugin 声明要 tap 的 Hook 事件列表（0005 §3.4 要求）
    pub tapped_hooks: Vec<HookEvent>,
}

/// apply() 的上下文，封装 Hook 注册能力
pub struct PluginContext {
    descriptor: PluginDescriptor,
    plugin_config: serde_json::Value,
    registry: HookRegistry,
}

impl PluginContext {
    /// 注册 Hook handler（对齐 0005 §3.5 统一 `tap()` 语义）
    /// 校验：event 必须在 descriptor.tapped_hooks 中声明。
    pub fn tap(
        &mut self,
        event: HookEvent,
        handler: impl Fn(HookPayload) -> Pin<Box<dyn Future<Output = HookResult> + Send>>
            + Send + Sync + 'static,
    ) -> Result<(), AgentError> {
        self.validate_tap(&event)?;
        // ... register handler
        Ok(())
    }

    fn validate_tap(&self, event: &HookEvent) -> Result<(), AgentError> {
        if !self.descriptor.tapped_hooks.contains(event) {
            return Err(AgentError::PluginHookContractViolation {
                plugin_id: self.descriptor.id.clone(),
                message: format!("attempted to tap undeclared hook {:?}", event),
            });
        }
        Ok(())
    }
}
```

`apply(self: Arc<Self>, ...)` 接收 `Arc<Self>`，handler 闭包通过 `Arc::clone` 捕获 Plugin 引用，满足 `'static` 要求。实现层若提供 `tap_turn_start()` / `tap_before_tool_use()` 等便捷 helper，也只是 `tap()` 的语法糖，不构成额外公共契约。

**build 阶段校验：** `AgentBuilder::build()` 在 Plugin `apply()` 完成后：
- `apply()` 中 `tap()` 返回的所有 `Err` 都会汇聚为 `build()` 的 `AgentError::PluginHookContractViolation`
- 检查每个 Plugin 声明的 `tapped_hooks` 是否都已实际注册。未实际注册的声明 Hook 记录 warn（Plugin 可能根据配置跳过某些 Hook）
- 注册了未声明的 Hook 时，`tap()` 返回结构化错误，build 立即失败

### 5.4 SessionStorage 与 MemoryStorage

```rust
#[async_trait]
pub trait SessionStorage: Send + Sync {
    /// 追加账本事件。adapter 应当在写入后更新 SessionSummary（updated_at、message_count 等）。
    /// 一致性要求见下方"SessionSummary 一致性模型"。
    async fn save_event(&self, session_id: &str, event: LedgerEvent) -> Result<()>;

    /// 加载完整账本（按 seq 升序）
    async fn load_session(&self, session_id: &str) -> Result<Option<Vec<LedgerEvent>>>;

    /// 分页列出会话。按 updated_at 降序排列。cursor 为上一页最后一条的 session_id。
    async fn list_sessions(&self, cursor: Option<&str>, limit: usize) -> Result<SessionPage>;

    /// 按 session_id 前缀或 title 关键词搜索会话
    async fn find_sessions(&self, query: &SessionSearchQuery) -> Result<Vec<SessionSummary>>;

    /// 删除会话及其全部账本事件
    async fn delete_session(&self, session_id: &str) -> Result<()>;
}

/// 会话搜索查询
#[derive(Debug, Clone)]
pub enum SessionSearchQuery {
    /// 按 session_id 前缀匹配
    IdPrefix(String),
    /// 按 title 关键词匹配
    TitleContains(String),
}

/// 会话摘要（由 SessionStorage adapter 维护）
#[derive(Debug, Clone)]
pub struct SessionSummary {
    pub session_id: String,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub message_count: usize,
}

/// 分页结果
#[derive(Debug, Clone)]
pub struct SessionPage {
    pub sessions: Vec<SessionSummary>,
    /// 下一页游标，None 表示已到最后一页
    pub next_cursor: Option<String>,
}
```

**SessionSummary 推导规则（adapter 应当遵守）：**
- `created_at`：首条 `LedgerEvent` 的 timestamp
- `updated_at`：最新 `LedgerEvent` 的 timestamp（每次 `save_event` 更新）
- `message_count`：`UserMessage` + `AssistantMessage` 事件数量（不含 ToolCall/ToolResult/System/Metadata）
- `title`：可选，由 adapter 自行实现（如取首条 UserMessage 的前 N 字符，或由调用方显式设置）

**SessionSummary 一致性模型（Eventual Consistency）：**

`SessionSummary` 是发现型数据，用于 `list_sessions` / `find_sessions` 的展示和搜索，不是会话恢复的依据（恢复只依赖 Ledger）。因此，Agent 对 adapter 的一致性要求是 **最终一致**，而非强事务一致：

- adapter **应当**在 `save_event()` 后尽快更新对应的 `SessionSummary`
- `list_sessions` / `find_sessions` **允许**返回短暂过时的 summary（如 `updated_at` 或 `message_count` 稍有滞后）
- adapter **必须**保证：在没有新事件写入的静止状态下，summary 最终与 Ledger 一致
- 数据库型 adapter 可选择使用事务保证强一致；文件型、对象存储型 adapter 使用最终一致即可满足契约

**设计理由：** 0005 §1.1 要求"不关心组件来源"。若要求 `save_event()` 和 summary 更新在同一原子操作内完成，实际上将 adapter 实现限定为"必须有事务能力"的狭窄集合，与存储来源无关的设计目标冲突。

```rust
#[async_trait]
pub trait MemoryStorage: Send + Sync {
    /// 按相关度搜索记忆，返回 top-k 结果，按相关度降序排列
    async fn search(&self, namespace: &str, query: &str, limit: usize) -> Result<Vec<Memory>>;
    /// 列出最近更新的记忆，按 updated_at 降序排列
    async fn list_recent(&self, namespace: &str, limit: usize) -> Result<Vec<Memory>>;
    /// 列出 namespace 下的所有记忆（用于提取时加载已有记忆供模型做整合判断）
    async fn list_by_namespace(&self, namespace: &str) -> Result<Vec<Memory>>;
    /// 按 id 做 upsert：内容相同则仅更新 updated_at，内容不同则更新内容和时间戳
    async fn upsert(&self, memory: Memory) -> Result<()>;
    /// 按全局唯一 id 删除记忆（无需额外传入 namespace）
    async fn delete(&self, id: &str) -> Result<()>;
}
```

**Memory ID 全局唯一约束：** Memory 的 `id` 在所有 namespace 中全局唯一（建议使用 UUID）。因此 `delete(id)` 无需额外传入 namespace。`upsert` 按 id 匹配：内容相同则仅更新 `updated_at`，内容不同则更新内容和时间戳。

关键变化：`SessionStorage` 保存的是 `LedgerEvent`（含 seq），不是无序号的 `SessionEvent`。这是实时路径与恢复路径一致性的基础。

---

## 6. Application Layer

### 6.1 AgentKernel — 不可变注册表

构建完成后，以下注册表全部不可变。运行期不再处理"重复注册""依赖缺失"类错误。

```rust
/// Agent 的不可变内核，构建后冻结
struct AgentKernel {
    config: AgentConfig,
    model_registry: ModelRegistry,
    tool_registry: ToolRegistry,
    skill_registry: SkillRegistry,
    hook_registry: HookRegistry,
    /// Plugin 实例（用于 shutdown 逆序调用）
    plugins: Vec<Arc<dyn Plugin>>,
    /// Plugin 描述（用于 System Prompt 渲染，不依赖运行实例）
    plugin_descriptors: Vec<PluginDescriptor>,
    session_storage: Option<Arc<dyn SessionStorage>>,
    memory_storage: Option<Arc<dyn MemoryStorage>>,
}
```

其中：
- `ModelRegistry`: `provider_id -> Arc<dyn ModelProvider>` + `model_id -> (provider_id, ModelInfo)` 双索引
- `ToolRegistry`: `tool_name -> (ToolDescriptor, Arc<dyn ToolHandler>)`
- `SkillRegistry`: `skill_name -> SkillDefinition`

### 6.2 ContextManager — 账本的投影

`ContextManager` 不是消息存储，只管理"当前模型应该看到什么"。它是 `SessionLedger` 的投影。

```rust
pub(crate) struct ContextManager {
    /// 最近一次压缩标记
    latest_compaction: Option<CompactionMarker>,
    /// 当前对模型可见的消息视图
    visible_messages: Vec<Message>,
    /// 粗略 token 估算值
    estimated_tokens: usize,
    /// 模型上下文窗口大小（从 ModelInfo 获取）
    context_window: usize,
    /// 压缩阈值
    compact_threshold: f64,
}

impl ContextManager {
    /// 从 Ledger 全量重建可见上下文
    pub fn rebuild_from_ledger(
        ledger: &SessionLedger,
        context_window: usize,
        compact_threshold: f64,
    ) -> Self { /* 见 4.3 重建算法 */ }

    /// 追加消息（增量更新）
    pub fn push(&mut self, msg: Message) { /* ... */ }

    /// 获取当前可见消息
    pub fn visible_messages(&self) -> &[Message] { &self.visible_messages }

    /// 估算是否需要压缩
    pub fn needs_compaction(&self, prompt_chars: usize, tools_chars: usize) -> bool {
        let total = (self.message_chars() + prompt_chars + tools_chars) / 4;
        total > (self.context_window as f64 * self.compact_threshold) as usize
    }

    /// 生成压缩标记。
    /// 仅负责根据当前 ledger 计算 `CompactionMarker`，
    /// 不触发 Hook、不持久化、不发送事件。
    pub async fn generate_compaction_marker(
        &self,
        ledger: &SessionLedger,
        model_router: &ModelRegistry,
        compact_model_id: &str,
        compact_prompt: &str,
    ) -> Result<CompactionMarker> { /* ... */ }

    /// 应用已经持久化成功的压缩标记，重建可见上下文。
    pub fn apply_compaction_marker(
        &mut self,
        ledger: &SessionLedger,
        marker: CompactionMarker,
    ) { /* ... */ }
}
```

**职责边界：**

1. `ContextManager` 只负责 token 估算、压缩内容生成、可见上下文重建
2. `TurnEngine` 是 compact 的唯一编排者，负责：
   - 触发 `BeforeCompact` Hook
   - 调用 `ContextManager::generate_compaction_marker()`
   - 持久化 `Metadata(ContextCompaction)`（关键事件）
   - 调用 `ContextManager::apply_compaction_marker()`
   - 发出 `ContextCompacted` 事件
3. 因此，Hook、持久化、事件发送都不在 `ContextManager` 内部重复实现

**压缩模式：**

compact 有两种模式，失败时依次降级：

1. **Summary Compaction**（主策略）：调用 compact_model 生成摘要。`rendered_summary` = `COMPACT_SUMMARY_PREFIX`（Appendix B.2）+ 摘要文本
2. **Truncation Fallback**（降级策略）：纯截断，保留最近 N 条消息使预估 token 降至窗口的 30% 以内。`rendered_summary` = `COMPACT_SUMMARY_PREFIX`（Appendix B.2）+ `"\n\n[System note: Earlier context was truncated because summary compaction was unavailable. Continue from the most recent messages and treat missing earlier details as potentially incomplete.]"`。不再引入新的公共前缀文本

两种模式产出的 `CompactionMarker` 结构完全相同（`replaces_through_seq` + `rendered_summary`），恢复路径无需区分。

**终止策略：**

1. `TurnEngine` 先触发 `BeforeCompact` Hook；预估触发场景下 Hook `Abort` 则跳过本次 compact，Turn 继续
2. `ContextManager::generate_compaction_marker()` 中 Summary 失败 → 降级为 Truncation
3. Truncation 后仍超窗（截断到仅剩最后一条消息仍超出 `context_window`）→ 返回 `AgentError::CompactError`，Turn 以 `TurnOutcome::Failed(CompactError)` 终止
4. 兜底触发（Provider 返回 `context_length_exceeded`）→ `TurnEngine` 触发 `BeforeCompact` Hook → 执行一次 compact（Summary → Truncation 降级），成功后仅重试当前请求一次；重试仍失败则返回 `CompactError`。**注意**：兜底路径上 `BeforeCompact` Hook 返回 `Abort` 时，不跳过 compact（因为此时必须压缩才能继续），而是直接返回 `CompactError` 终止 Turn

### 6.3 TurnEngine — 唯一编排者

TurnEngine 是无状态的 async 函数，不是 struct。它通过 `Arc<tokio::sync::Mutex<SessionRuntime>>` 访问会话状态。

```rust
pub(crate) async fn run_turn(
    runtime: Arc<tokio::sync::Mutex<SessionRuntime>>,
    kernel: &AgentKernel,
    input: UserInput,
    skill_injections: Vec<Message>, // 已在 send_message() 中解析完毕
    event_tx: mpsc::Sender<AgentEvent>,
    outcome_tx: oneshot::Sender<TurnOutcome>,
    cancel: CancellationToken,
) {
    let outcome = match run_turn_inner(
        &runtime, kernel, input, &skill_injections, &event_tx, &cancel,
    ).await {
        Ok(()) => TurnOutcome::Completed,
        Err(e) if e.is_cancelled() => TurnOutcome::Cancelled,
        Err(e) => TurnOutcome::Failed(e),
    };
    let _ = outcome_tx.send(outcome);
}
```

**Synthetic Message 统一写入规则：**

所有会进入模型可见上下文、但不是用户原始输入或模型原始输出的内容，统一归类为 **synthetic message**。所有 synthetic message 必须通过 `persist_and_project()` helper 写入：

```rust
/// 统一的 synthetic message 写入路径
/// 先持久化到 SessionStorage，再 append 到内存 Ledger，再更新 ContextManager 投影
/// 关键事件：失败即终止 Turn
fn persist_and_project(
    runtime: &mut SessionRuntime,
    storage: Option<&dyn SessionStorage>,
    msg: Message,
) -> Result<()>;
```

涉及的 synthetic message 类型：

| 来源 | Message 类型 | 账本载体 | 何时写入 |
|------|-------------|---------|---------|
| Skill 注入 | `Message::System(skill_prompt)` | `LedgerEvent::SystemMessage` | TurnEngine 步骤 2 |
| Tool 超限提示 | `Message::System(limit_text)` | `LedgerEvent::SystemMessage` | TurnEngine 步骤 5i |
| 未执行 Tool 的取消结果 | `Message::ToolResult(synthetic)` | `LedgerEvent::ToolResult` | 取消路径 |

**设计理由：** 统一 helper 保证所有**需要持久化**的 synthetic message 经过相同的"先持久化，再内存 append，再更新投影"流水线。取消导致的“中断提示”按照 `0005 §3.6` 在恢复阶段基于 `AssistantMessage(status=Incomplete)` 动态追加，不作为 Ledger 事实源持久化。

**执行流程：**

```text
run_turn(runtime, kernel, input, skill_injections, event_tx, outcome_tx, cancel)
│
├─ 1. Hook: TurnStart
│     ├─ Abort → return Failed(PluginAborted)
│     └─ 正常 → 收集 dynamic_sections
│
├─ 2. 注入 Skill prompt（已在 send_message 中解析，这里只注入）
│     └─ 对每个 skill_injection: persist_and_project(SystemMessage) → Ledger（关键事件）
│
├─ 3. MemoryManager: 加载 turn 级记忆，与 bootstrap 合并
│
├─ 4. 记账: UserMessage → Ledger（关键事件，失败即终止 Turn）
│
├─ 5. LOOP {
│   ├─ 5a. PromptBuilder: 渲染本轮前导 `Message::System`，与可见消息拼成 `ChatRequest.messages`
│   ├─ 5b. ContextManager: 检查是否需要压缩
│   │     └─ 是 → BeforeCompact Hook → generate_compaction_marker
│   │              → persist Metadata(ContextCompaction)
│   │              → apply_compaction_marker → emit ContextCompacted
│   │     └─ compact 失败（含截断仍超窗）→ return Failed(CompactError)
│   ├─ 5c. 构建 ChatRequest
│   ├─ 5d. ModelProvider: 流式调用
│   │     ├─ 正常 → 转发 TextDelta / ReasoningDelta
│   │     ├─ 取消 → 走取消路径（见 §9.2）
│   │     └─ context_length_exceeded → 兜底 compact → 重试一次 → 仍失败则 CompactError
│   ├─ 5e. 记账: AssistantMessage → Ledger（关键事件，失败即终止 Turn）
│   ├─ 5f. 收集 ToolCall 列表
│   │     └─ 无 ToolCall → BREAK
│   ├─ 5f'. 记账: 每个 ToolCall → Ledger（关键事件）
│   ├─ 5g. ToolDispatcher: 执行批次（取消时走取消路径，见 §9.2）
│   ├─ 5h. 记账: 每个 ToolResult → Ledger（关键事件）
│   ├─ 5i. tool_call_count += batch.len()
│   │     └─ 超限 → emit Error(MaxToolCallsExceeded)
│   │           → persist_and_project(SystemMessage: 超限提示) → Ledger（关键事件）
│   │           → 最终无 tool 的模型调用
│   │           → return Failed(MaxToolCallsExceeded)（见"Tool 超限收尾"）
│   └─ } // 回到 5a
│
├─ 6. Checkpoint 检查（每 N 轮，用 ledger seq 做边界）
│     Metadata(MemoryCheckpoint) 持久化失败 → 记录 warn，不终止 Turn
├─ 7. Hook: TurnEnd
│     └─ Abort → return Failed(PluginAborted)
└─ 8. emit TurnComplete / TurnCancelled
```

**Tool 超限收尾流程：**

当 `tool_call_count > max_tool_calls_per_turn` 时：

1. emit `Error(MaxToolCallsExceeded { limit })` 事件，通知调用方
2. 通过 `persist_and_project()` 注入超限提示为 SystemMessage：`"[TOOL_LIMIT_REACHED] You have reached the maximum number of tool calls ({limit}) for this turn. You MUST NOT call any more tools. Summarize your progress and provide a final response."`（关键事件，写入 Ledger）
3. 构建 ChatRequest 时 `tools` 设为空数组，强制模型生成纯文本
4. 将模型回复追加到上下文，随后结束当前 Turn
5. `join()` 返回 `TurnOutcome::Failed(AgentError::MaxToolCallsExceeded { limit })`

若最终模型调用失败，Turn 以 `TurnOutcome::Failed(ProviderError)` 结束。

**终态说明：**  
`MAX_TOOL_CALLS_EXCEEDED` 仍属于运行期错误；区别在于，用户可能已经拿到一段有价值的收尾回复。调用方应同时消费：

1. 事件流中的最终文本 / Error 事件；
2. `join()` 返回的 `TurnOutcome::Failed(MaxToolCallsExceeded)`。

这样既不丢失最终可见输出，也不会把超限误判为健康完成。

### 6.4 ToolDispatcher

```rust
pub(crate) struct ToolDispatcher {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
    timeout: Duration,
}

impl ToolDispatcher {
    pub async fn execute_batch(
        &self,
        calls: Vec<ToolCallRequest>,
        hooks: &HookRegistry,
        turn_cancel: &CancellationToken,
        event_tx: &mpsc::Sender<AgentEvent>,
    ) -> Vec<ToolOutput> { /* ... */ }
}
```

**执行策略：**
- 批次全部 `mutating=false` → 并发执行（best-effort 模式，单个失败不影响其他）
- 存在任一 `mutating=true` → 整批按模型返回顺序串行（短路模式，失败即停止剩余）

**Mutating 串行批次短路规则：**

对包含 mutating Tool 的串行批次，一旦某个 Tool 出现以下任一错误，**立即停止执行剩余 Tool**，为所有未执行 Tool 写入 synthetic `ToolResult`（`"[Tool skipped: previous tool in batch failed]"`），将全部结果返回给模型重新规划：

| 触发条件 | synthetic ToolResult 内容 |
|---------|--------------------------|
| `TOOL_NOT_FOUND` | `"[Tool skipped: previous tool '{name}' not found]"` |
| `BeforeToolUse` Hook `Abort` | `"[Tool skipped: previous tool aborted by plugin]"` |
| `TOOL_TIMEOUT` | `"[Tool skipped: previous tool '{name}' timed out]"` |
| `TOOL_EXECUTION_ERROR` | `"[Tool skipped: previous tool '{name}' failed]"` |

**设计理由：** 0005 §5.1 明确指出 mutating 批次的顺序具有语义——模型可能假设前一个 Tool 的副作用已经生效。当前序 Tool 未正常执行时，后续 Tool 的前提条件可能不成立。继续执行可能在错误的前置状态下产生真实副作用，且模型得不到重新推理的机会。短路后模型可以看到完整的错误信息和跳过原因，自行决定下一步操作。

**只读并行批次：** 全只读批次中，单个 Tool 的失败不影响其他 Tool 的执行。所有结果（包括成功和失败）统一返回。`BeforeToolUse` Abort 仅影响被 Abort 的 Tool，不取消已在飞行中的并行 Tool。

**Turn 取消与 Tool 超时的分工：**

- `turn_cancel`：用于停止 Provider 继续生成、阻止新的 Tool 启动、在批次末尾决定是否结束 Tool loop
- `tool_timeout_token`：仅用于单个 Tool 的超时中止，不受用户 / Turn 取消影响
- 因此，用户取消时：
  - 已启动 Tool 全部继续执行到完成，并正常触发 `AfterToolUse`、写入 `ToolResult`
  - 尚未启动的 Tool 全部写入 synthetic cancel result
  - Tool 批次完成后退出 Tool loop，Turn 以 `Cancelled` 结束

**单个 Tool 执行流程：**

1. Resolve handler → 未找到则 synthetic error `ToolOutput`（mutating 批次：触发批次短路，见下方）
2. `BeforeToolUse` Hook → `Abort` 则 synthetic error（mutating 批次：触发批次短路，见下方）
3. emit `ToolCallStart`
4. 创建独立的 `tool_timeout_token`，执行 `tokio::time::timeout(handler.execute(input, tool_timeout_token.clone()))` → 超时时先 `tool_timeout_token.cancel()` 通知 Tool 停止，再返回 `TOOL_TIMEOUT` error result（mutating 批次：触发批次短路）
5. **输出体积控制**（总预算 `tool_output_max_bytes`，默认 1MB，对齐 0005 §5.4）：
   - 先处理 `metadata`：计算 `serde_json::to_vec(&metadata).len()`，超过 `tool_output_metadata_max_bytes`（默认 64KB）时替换为 `json!({"_truncated": true, "_original_bytes": N})`
   - 再处理 `content`：可用预算 = `tool_output_max_bytes` - 实际 metadata 字节数。`content` 超过可用预算则截断，追加 `"\n\n[output truncated]"`
   - 保证：处理后 content + metadata 总大小 ≤ `tool_output_max_bytes`
6. emit `ToolCallEnd`
7. `AfterToolUse` Hook → `Abort` 则触发批次中止（mutating 批次短路 / 只读批次等待已飞行 Tool），进入最终收尾请求

**串行批次的取消检查点：**

- 启动每个 Tool 前先检查 `turn_cancel.is_cancelled()`；若已取消，则当前 Tool 及其后续 Tool 不再启动，全部写入 synthetic cancel result
- 某个 Tool 运行中收到用户取消时，不中断该 Tool；等待其完成后再检查 `turn_cancel`
- 只读并行批次在启动整批后即不再新增任务；若批次运行中收到用户取消，则等待整批已启动 Tool 全部完成，再退出 Tool loop

返回的 `Vec<ToolOutput>` 始终按输入 `calls` 的原始顺序排列。

**ToolOutput 的数据流向：** 同一个 `ToolOutput` 实例依次流经 `ToolCallEnd` 事件 → `AfterToolUse` Hook → `Message::ToolResult` → `LedgerEvent::ToolResult`，全程共享同一结构，不做字段裁剪。模型只看到 `content`（`metadata` 不进入 `ChatRequest.messages`），但 `metadata` 持久化到 Ledger 供恢复和审计使用。

### 6.5 SkillManager

```rust
pub(crate) struct SkillManager {
    skills: HashMap<String, SkillDefinition>,
}

impl SkillManager {
    /// 从 UserInput 的 Text 块中解析 /skill_name 调用。
    /// 返回匹配到的 SkillDefinition 列表 + 未识别的 skill 名称列表。
    /// 仅扫描 ContentBlock::Text，不扫描 File/Image。
    pub fn parse_invocations(&self, input: &UserInput) -> (Vec<&SkillDefinition>, Vec<String>);

    /// 渲染 Skill 注入消息
    pub fn render_injection(&self, skill: &SkillDefinition) -> Message;

    /// 返回 allow_implicit_invocation=true 的 Skill（供 PromptBuilder）
    pub fn implicit_skills(&self) -> Vec<&SkillDefinition>;
}
```

**Skill 未找到的处理：** `parse_invocations()` 返回未识别的 skill 名称。`send_message()` 在 Turn 启动前（步骤 2）检查未识别列表：若非空，返回 `AgentError::SkillNotFound(name)`，Turn 不启动。这是同步错误路径，调用方可立即告知用户。

Skill 只允许用户显式触发。`allow_implicit_invocation=true` 的 Skill 进入 Skill List 供模型"建议用户使用"，但 Agent 不自动注入。Skill 依赖的 Tool 在 build 阶段一次性校验。

### 6.6 PromptBuilder

无状态，每轮完整拼接。按 0005 §5.3 的顺序组装：

1. System Instructions（`<system_instructions>` 标签）
2. System Prompt Override（`<system_prompt_override>` 标签，可选）
3. Personality（`<personality_spec>` 标签，可选）
4. Tool Definitions（通过 `ChatRequest.tools`，不是 prompt 文本）
5. Skill List
6. Active Plugin Info
7. Memories + 使用指令
8. Environment Context（`<environment_context>` 标签）
9. Dynamic Sections（来自 TurnStart Hook）

`PromptBuilder` 只做渲染，不做存储访问。记忆文本由 `MemoryManager` 产出，`PromptBuilder` 的输出会在构建 `ChatRequest` 时以前导 `Message::System` 的形式插入 `messages[0]`。

### 6.7 MemoryManager

```rust
pub(crate) struct MemoryManager {
    storage: Arc<dyn MemoryStorage>,
    max_items: usize,
}
```

`MemoryManager` 不再自行持有 `namespace`。运行时从 `SessionRuntime.memory_namespace` 获取，保证 namespace 始终与会话绑定值一致，不受 `AgentConfig` 变更影响。

**职责：**

1. **Session 启动时**：`list_recent(namespace, max_items)` 加载 bootstrap 记忆（namespace 从 SessionRuntime 获取）
2. **每轮 Turn 开始时**：若输入含文本，`search()` 获取相关记忆；纯图片/文件跳过。与 bootstrap 合并去重（按 id），受 `max_items` 限制
3. **Checkpoint**：每 `memory_checkpoint_interval` 轮，以 **ledger seq** 为边界提取增量消息
4. **Session 关闭时**：全量收尾提取

**关键：checkpoint 使用 ledger seq 而非 Vec 下标。**

**记忆提取写路径协议（v1 单阶段，对齐 0005 Appendix B.10 + B.11）：**

v1 单阶段提取的核心契约：**模型在一次 LLM 调用中同时完成提取和整合判断**。模型输出结构化 JSON，每条记忆项携带操作类型（`create / update / delete`）。Agent 内部仅做校验和执行，不重新做整合决策。

每次提取（checkpoint 或 session close）执行以下固定步骤：

```text
1. list_by_namespace(namespace)          → existing_memories: Vec<Memory>
   （namespace 从 SessionRuntime.memory_namespace 获取）
2. ledger.events_after(last_checkpoint_seq) → incremental_events
3. 若 incremental_events 为空 → 跳过，返回 last_checkpoint_seq
4. 渲染模型输入：
   - system prompt：Appendix B.10
   - user message：Appendix B.11
     - 增量对话内容（从 incremental_events 渲染）
     - 已有记忆列表（existing_memories，JSON 格式，供模型判断 update/delete/skip）
5. 调用提取模型 → 解析 JSON → ExtractionResult
   - 解析失败 → 记录 warn 日志，视为空结果，跳过本次提取
   - `memory_operations` 为空数组 → 正常，无需写入
6. 校验并执行 memory_operations（Agent 自动填充 source 和 id）：
   - Create { content, tags } → storage.upsert(Memory { id: new_uuid, source, ... })
   - Update { target_id, content, tags }
     → 校验 target_id 存在于 existing_memories
     → storage.upsert(Memory { id: target_id, source, ... })
     → target_id 不存在 → 记录 warn，降级为 create（生成新 id）
   - Delete { target_id }
     → 校验 target_id 存在于 existing_memories
     → storage.delete(target_id)
     → target_id 不存在 → 记录 warn，跳过
   （模型判断为 skip 的记忆不出现在 memory_operations 中）
7. 写入 Metadata(MemoryCheckpoint) 到 Ledger
8. 返回新的 checkpoint seq
```

```rust
/// 解析自 Appendix B.10/B.11 输出格式。
/// 模型在一次调用中同时完成提取和整合判断，输出结构化操作列表。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractionResult {
    /// 模型输出的记忆操作列表，每项携带操作类型
    pub memory_operations: Vec<MemoryOperation>,
    pub rollout_summary: String,
    pub rollout_slug: String,
}

/// 模型输出的单条记忆操作（操作类型由模型决定，Agent 仅校验和执行）
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum MemoryOperation {
    /// 新建记忆
    Create {
        content: String,
        #[serde(default)]
        tags: Vec<String>,
    },
    /// 更新已有记忆
    Update {
        /// 目标记忆 ID（必须存在于 existing_memories）
        target_id: String,
        content: String,
        #[serde(default)]
        tags: Vec<String>,
    },
    /// 删除已有记忆
    Delete {
        /// 目标记忆 ID（必须存在于 existing_memories）
        target_id: String,
    },
}
```

**source 字段规则：** `Memory.source` 由 Agent 在执行操作时自动填充，不依赖模型输出：
- checkpoint 提取 → `"checkpoint"`
- session close 提取 → `"session:<session_id>"`
- 调用方手动写入 → `"manual"`

**责任分工：** 模型负责判断"做什么"（create/update/delete/skip），Agent 负责"怎么做"（校验 id 存在性、填充 source/id/namespace/timestamp、调用 Storage API）。模型判断为 skip 的记忆不出现在输出中，Agent 无需处理。

Checkpoint 成功后写入 `Metadata(MemoryCheckpoint)` 到 Ledger，恢复时从最新值继续。提取失败只记日志，不阻断 Session close。

升级为两阶段时，Phase 1 可继续使用 B.10 / B.11 的 `MemoryOperation` 输出（仅含 `Create`），Phase 2 再引入 B.12 的整合流程处理 `Update / Delete`；`MemoryStorage` trait 无需变更。

### 6.8 HookRegistry 与 PluginManager

**HookEntry — 注册单元：**

```rust
/// 单个 Hook handler 的注册记录
struct HookEntry {
    /// 所属 Plugin 的 ID（用于日志和调试）
    plugin_id: String,
    /// 该 Plugin 的配置（注册时快照，dispatch 时注入 payload.plugin_config）
    plugin_config: serde_json::Value,
    /// 类型擦除的 handler（统一返回 HookResult）
    handler: ErasedHandler,
}
```

```rust
pub(crate) struct HookRegistry {
    /// 按 HookEvent 索引，每个事件的 handler 列表按 Plugin 注册顺序排列
    handlers: HashMap<HookEvent, Vec<HookEntry>>,
}

impl HookRegistry {
    /// 内部注册方法，由 PluginContext::tap() 调用
    pub(crate) fn register(&mut self, event: HookEvent, entry: HookEntry);

    /// 统一分发：按注册顺序执行，遇 Abort 立即停止后续 handler。
    /// 若返回 ContinueWith，则仅 `TurnStart` / `BeforeToolUse` 可累积 patch。
    pub async fn dispatch(&self, event: HookEvent, payload: HookPayload)
        -> Result<Option<HookPatch>, AgentError>;
}
```

**多 Plugin 分发算法（dispatch 伪代码）：**

```text
fn dispatch(event, base_payload) -> Result<Option<HookPatch>, AgentError>:
    entries = self.handlers[event]  // 按 Plugin 注册顺序排列
    if entries.is_empty():
        return Ok(None)

    accumulated_patch = None       // 累积的 patch 结果
    working_payload = base_payload // 当前工作副本

    for entry in entries:
        // 1. 为每个 handler 注入该 Plugin 的专属 plugin_config
        working_payload.plugin_config = entry.plugin_config.clone()

        // 2. 调用 handler
        match entry.handler.call(working_payload.clone()).await:
            Continue → continue
            ContinueWith(patch):
                if !event.supports_patch() or !patch.matches(event):
                    return Err(PluginHookContractViolation)
                // 3. 立即将 patch 作用到工作副本（供下一个 handler 看到）
                apply_patch(&mut working_payload, &patch)
                // 4. 累积到最终 patch
                accumulated_patch = merge_patch(accumulated_patch, patch)
            Abort(reason):
                // 5. 立即停止后续 handler
                return Err(PluginAborted(event, reason))

    return Ok(accumulated_patch)
```

**Patch 累积规则：**

| Hook | Patch 类型 | 累积策略 | 示例 |
|------|-----------|---------|------|
| `TurnStart` | `append_dynamic_sections: Vec<String>` | **Append-only**：后续 Plugin 的 sections 追加到前序结果之后。工作副本的 `dynamic_sections` 同步更新，后续 handler 可看到前序 handler 追加的 sections | Plugin A 追加 `["section_a"]`，Plugin B 追加 `["section_b"]` → 最终 `["section_a", "section_b"]` |
| `BeforeToolUse` | `arguments: serde_json::Value` | **Last-write-wins**：后续 Plugin 的 arguments 完全覆盖前序结果。工作副本的 `arguments` 同步更新，后续 handler 基于前序修改后的 arguments 继续改写 | Plugin A 改为 `{"x": 1}`，Plugin B 改为 `{"x": 2}` → 最终 `{"x": 2}` |

不支持 patch 的 Hook 若返回 `ContinueWith`，视为 `PluginHookContractViolation`。

**Abort 行为表：**

| Hook | Abort 行为 |
|------|-----------|
| `SessionStart` | 会话创建失败，回滚 `Reserved` → `Empty`，不持久化 |
| `TurnStart` | Turn 直接失败，返回 `PLUGIN_ABORTED` |
| `BeforeToolUse`（只读并行批次） | 该 Tool 变成 synthetic error，其他并行 Tool 不受影响，Turn 继续 |
| `BeforeToolUse`（mutating 串行批次） | 该 Tool 变成 synthetic error，**停止剩余批次**，为未执行 Tool 写入 synthetic ToolResult，所有结果返回模型重新规划 |
| `AfterToolUse`（只读并行批次） | 所有已在飞行中的 Tool 等待完成（结果正常记账），未启动的 Tool 写入 synthetic ToolResult，退出 Tool loop，发起无 Tool 的收尾请求 |
| `AfterToolUse`（mutating 串行批次） | 停止剩余批次，为未执行 Tool 写入 synthetic ToolResult，退出 Tool loop，发起无 Tool 的收尾请求 |
| `BeforeCompact`（预估触发） | 跳过本次 compact，Turn 继续 |
| `BeforeCompact`（`context_length_exceeded` 兜底触发） | 不跳过（此时必须压缩），直接返回 `CompactError` 终止 Turn |
| `TurnEnd` | 当前 Turn 终态改为 `Failed(PluginAborted)`，不发送 `TurnComplete` |
| `SessionEnd` | 当前 `close()` / `shutdown()` 操作中止，Session 保持 active，Memory 提取与槽位释放不继续；若为 `close()`，handle 未被消费，可在修复条件后重试 |

`PluginManager` 管理 Plugin 生命周期：注册顺序 `initialize()` → `apply()` → 运行 → 逆序 `shutdown()`。

---

## 7. API Layer

### 7.1 AgentBuilder

Typestate 模式编译期保证至少注册一个 `ModelProvider`。

```rust
pub struct AgentBuilder<S = NoProvider> {
    config: AgentConfig,
    providers: Vec<Arc<dyn ModelProvider>>,
    tools: Vec<Arc<dyn ToolHandler>>,
    skills: Vec<SkillDefinition>,
    plugins: Vec<(Arc<dyn Plugin>, serde_json::Value)>,
    session_storage: Option<Arc<dyn SessionStorage>>,
    memory_storage: Option<Arc<dyn MemoryStorage>>,
    _state: PhantomData<S>,
}

pub struct NoProvider;
pub struct HasProvider;

impl AgentBuilder<NoProvider> {
    pub fn new(config: AgentConfig) -> Self;
}

impl<S> AgentBuilder<S> {
    pub fn register_model_provider(self, p: impl ModelProvider + 'static) -> AgentBuilder<HasProvider>;
    pub fn register_tool(mut self, t: impl ToolHandler + 'static) -> Self;
    pub fn register_skill(mut self, s: SkillDefinition) -> Self;
    pub fn register_plugin(mut self, p: impl Plugin + 'static, config: serde_json::Value) -> Self;
    pub fn register_session_storage(mut self, s: impl SessionStorage + 'static) -> Self;
    pub fn register_memory_storage(mut self, s: impl MemoryStorage + 'static) -> Self;
}

impl AgentBuilder<HasProvider> {
    pub async fn build(self) -> Result<Agent>;
}
```

`build()` 内部流程：

1. **校验**（所有校验规则见需求 6.1 节）：
   - Provider ID 唯一、model_id 全局唯一
   - Tool/Skill/Plugin 名称唯一
   - Skill 依赖的 Tool 已注册
   - SessionStorage/MemoryStorage 至多各一个
   - `default_model` 对应的 model_id 已注册（`InvalidDefaultModel`）
   - `compact_model` 对应的 model_id 已注册（`InvalidModelConfig { kind: "compact" }`）
   - `memory_model` 对应的 model_id 已注册（`InvalidModelConfig { kind: "memory" }`）
   - **配置值合法性校验**：
     - `compact_threshold` ∈ (0.0, 1.0)，否则 `InputValidation`
     - `memory_checkpoint_interval` > 0，否则 `InputValidation`
     - `memory_max_items` > 0，否则 `InputValidation`
     - `tool_timeout_ms` > 0，否则 `InputValidation`
     - `max_tool_calls_per_turn` > 0，否则 `InputValidation`
     - `tool_output_max_bytes` > `tool_output_metadata_max_bytes`，否则 `InputValidation`
     - `memory_namespace` 非空，否则 `InputValidation`
2. 构建不可变注册表（ModelRegistry、ToolRegistry、SkillRegistry）
3. 实例化 `HookRegistry`
4. **按注册顺序执行 Plugin `initialize()`**（含失败回滚）
5. 按注册顺序执行 Plugin `apply()`，将 handler tap 到 Registry
6. 创建 `AgentKernel` + `AgentControl(Running, Empty)`
7. 返回 `Agent`

**Plugin 初始化失败回滚协议（步骤 4）：**

按注册顺序依次调用 `Plugin::initialize(config)`。若第 N 个 Plugin 的 `initialize()` 失败：

1. 对已成功 `initialize()` 的前 N-1 个 Plugin，按**逆序**调用 `shutdown()`
2. `shutdown()` 的失败仅记录 warn 日志，不覆盖原始 `PluginInitFailed` 错误
3. `build()` 返回 `Err(AgentError::PluginInitFailed { id, source })`

**`apply()` 阶段失败：** 若某个 Plugin 的 `tap()` 返回错误，所有已 `initialize()` 的 Plugin 按逆序 `shutdown()`，`build()` 返回 `Err(PluginHookContractViolation)`。

### 7.2 Agent

```rust
pub struct Agent {
    kernel: Arc<AgentKernel>,
    /// std::sync::Mutex — 仅用于微秒级状态切换，绝不跨 .await
    control: Arc<std::sync::Mutex<AgentControl>>,
}

impl Agent {
    // -- Session 生命周期 --
    pub async fn new_session(&self, config: SessionConfig) -> Result<SessionHandle>;
    pub async fn resume_session(&self, session_id: &str) -> Result<SessionHandle>;
    pub async fn shutdown(&self) -> Result<()>;

    // -- Session 发现（委托给 SessionStorage）--
    /// 未注册 SessionStorage 时统一返回 AgentError::StorageError("SessionStorage not registered")
    pub async fn list_sessions(&self, cursor: Option<&str>, limit: usize) -> Result<SessionPage>;
    pub async fn find_sessions(&self, query: &SessionSearchQuery) -> Result<Vec<SessionSummary>>;
    /// 删除指定会话。若 session_id 为当前活跃会话，返回 AgentError::SessionBusy。
    /// 调用方须先 close 活跃会话再删除。
    pub async fn delete_session(&self, session_id: &str) -> Result<()>;
}
```

**`new_session()` 流程：**

1. 在 `AgentControl` 锁内：检查 `lifecycle == Running` 且 `slot == Empty` → 写入 `Reserved`
2. 确定 `model_id`，从 `AgentConfig.memory_namespace` 固化 `memory_namespace`，加载 bootstrap 记忆，构建 `SessionRuntime`
3. 触发 `SessionStart` Hook
   - `Abort` → 回滚 `Reserved` → `Empty`（按 `reservation_id` 匹配），返回 `PluginAborted`
4. 若存在 `SessionStorage`，持久化 `Metadata(SessionConfig)` 和 `Metadata(MemoryNamespace)` 到 Ledger（关键事件，失败则回滚 `Reserved` → `Empty`，返回 `StorageError`）
5. 在 `AgentControl` 锁内：`Reserved` → `Active`（将 `Arc<tokio::sync::Mutex<SessionRuntime>>` 存入 `Active`）
6. 返回 `SessionHandle`

**为什么先 Hook 后持久化？** 将持久化放在 `SessionStart` Hook 之后，避免 Hook Abort 时需要 `delete_session()` 回滚。`delete_session()` 失败会导致"内存里失败，存储里成功了一半"的脏状态。先 Hook 后持久化消除了这个补偿问题。

**`resume_session()` 流程：**

1. 校验 `SessionStorage` 已注册，否则返回 `AgentError::StorageError("SessionStorage not registered")`
2. 在 `AgentControl` 锁内：检查 `lifecycle == Running` 且 `slot == Empty` → 写入 `Reserved`
3. 从 `SessionStorage` 加载完整 Ledger，若返回 `None` → 回滚 `Reserved` → `Empty`，返回 `SessionNotFound`
4. 解析最新 `session_config`、`memory_namespace`、`memory_checkpoint`、`context_compaction` Metadata
   - `memory_namespace` **必须**从 Ledger 恢复，不使用当前 `AgentConfig.memory_namespace`（保证会话级记忆隔离一致性）
   - 若 Ledger 中无 `MemoryNamespace` Metadata（历史兼容），降级使用 `AgentConfig.memory_namespace` 并记录 warn
5. 从 Ledger 重建 `SessionRuntime`（包括 ContextManager 投影，memory_namespace 使用步骤 4 恢复的值）
6. 加载最新 bootstrap 记忆（使用恢复后的 memory_namespace）
7. `Reserved` → `Active`
8. 返回 `SessionHandle`（不触发 SessionStart Hook）

**`shutdown()` 流程：**

1. 在 `AgentControl` 锁内：`Running -> ShuttingDown`（此后 claim 必失败）
2. 若存在 `Active` Session：
   - 取消当前 Turn，等待 Turn 结束
   - 触发 `SessionEnd` Hook
     - `Abort` → 回滚生命周期到 `Running`，返回 `PluginAborted`
   - 触发 MemoryManager 收尾提取
   - 释放 Session
3. 按逆序执行 Plugin `shutdown()`
4. `ShuttingDown -> Shutdown`

重复调用幂等。`shutdown` 后所有操作返回 `AGENT_SHUTDOWN`。

### 7.3 SessionHandle

```rust
pub struct SessionHandle {
    kernel: Arc<AgentKernel>,
    control: Arc<std::sync::Mutex<AgentControl>>,
    session_id: String,
}

impl SessionHandle {
    /// 发送消息并启动 Turn。
    /// `external_cancel`：可选的外部取消令牌，允许宿主系统将 Turn 纳入自身取消树
    /// （如 HTTP 断开、窗口关闭、上层任务超时）。内部 turn_cancel_token 为
    /// session_cancel_token 的 child；若提供 external_cancel，则 turn_cancel_token
    /// 同时监听 external_cancel，任一触发即取消。该取消仅停止 Provider 继续生成
    /// 和后续 Tool 调度，不取消已在执行中的 Tool（见 §9.2）。
    pub async fn send_message(
        &self,
        input: UserInput,
        external_cancel: Option<CancellationToken>,
    ) -> Result<RunningTurn>;
    /// 关闭当前 Session。失败时不消费 handle，调用方可修复条件后重试。
    /// 关闭成功后，该 handle 变为 stale；后续 `send_message()` / `close()`
    /// 返回 `SessionNotFound(session_id)`。
    pub async fn close(&self) -> Result<()>;
}
```

`send_message()` 流程：

1. **纯输入校验**（不持锁）：非空、图片大小/格式检查
2. **Skill 解析**（不持锁）：调用 `SkillManager::parse_invocations(input)` 检测显式 `/skill_name`。若有未识别的 skill 名称，返回 `AgentError::SkillNotFound(name)`
3. **原子 Turn 启动**（单次 `AgentControl` 锁，短暂持有后立即释放）：
   - 检查 `lifecycle == Running`，否则返回 `AgentShutdown`
   - 检查 `slot` 必须是 `Active` 且 `session_id == self.session_id`，否则返回 `SessionNotFound(self.session_id.clone())`
   - 检查 `turn_state == Idle`，否则返回 `TurnBusy`
   - 创建 `turn_cancel_token`（`session_cancel_token.child_token()`），若提供 `external_cancel` 则额外 spawn 监听任务：`external_cancel.cancelled() => turn_cancel_token.cancel()`
   - `turn_cancel_token` 传给 Provider 和 ToolDispatcher 作为 **Turn 调度取消信号**；运行中的 Tool 仅接收各自的 `tool_timeout_token`
   - 创建 `oneshot::channel<TurnOutcome>`（outcome_tx, outcome_rx）
   - 创建 `oneshot::channel<()>`（turn_finished_tx, turn_finished_rx）
   - `turn_state = Running(RunningTurnHandle { turn_cancel_token, turn_finished_rx })`
   - 取出 `runtime: Arc<tokio::sync::Mutex<SessionRuntime>>` 的 clone
   - 释放锁
4. **spawn supervisor task**（两层 task 结构）：
   ```rust
   // supervisor task（持有 turn_finished_tx）
   let inner_handle = tokio::spawn(run_turn(runtime, kernel, input,
       skill_injections, event_tx, outcome_tx, cancel));
   match inner_handle.await {
       Ok(()) => { /* outcome 已通过 outcome_tx 发送 */ }
       Err(join_err) if join_err.is_panic() => {
           let _ = outcome_tx.send(TurnOutcome::Panicked);
           emit Error(InternalPanic);
       }
       Err(_) => { /* task cancelled */ }
   }
   // 统一清理：获取 AgentControl 锁 → turn_state = Idle → 释放
   // turn_finished_tx 自动 drop → 通知 close_session()
   ```
5. 返回 `RunningTurn`

**步骤 1-2 在任何锁之外完成**：校验失败和 Skill 解析失败都是同步错误，不会修改任何状态。步骤 3 在单次 `AgentControl` 临界区内原子完成 Turn 启动，释放锁后步骤 4 通过 `Arc<tokio::sync::Mutex<SessionRuntime>>` 独立访问会话状态。

### 7.4 RunningTurn

```rust
pub struct RunningTurn {
    /// 实时事件流
    pub events: ReceiverStream<AgentEvent>,
    /// Turn 级取消令牌
    cancel: CancellationToken,
    /// 终态结果（独立通道）
    outcome_rx: oneshot::Receiver<TurnOutcome>,
}

impl RunningTurn {
    /// 取消当前 Turn
    pub fn cancel(&self) { self.cancel.cancel(); }

    /// 获取 Turn 级取消令牌的只读引用，供外部系统组合到自身的取消树中
    pub fn cancel_token(&self) -> &CancellationToken { &self.cancel }

    /// 等待 Turn 完成，返回终态
    pub async fn join(self) -> Result<TurnOutcome> {
        self.outcome_rx.await.map_err(|_| AgentError::InternalPanic {
            message: "outcome channel dropped".into(),
        })
    }
}
```

**关键契约：**
- `events` 被消费完不影响 `join()` 获取终态结果
- `join()` 的结果只来自 `outcome_rx`，不从事件流倒推
- `Panicked` 专门承接后台 task panic

---

## 8. 持久化与恢复协议

### 8.1 写入规则与持久化失败处理

**核心原则：事实一致性优先于可用性。** 任何会影响后续上下文的事件，只要未成功落入事实源，就不能继续后续流程。

**写入流水线：**

```text
event → allocate seq → SessionStorage.save_event() → 内存 Ledger.append() → ContextManager.push()
```

存储失败 → 不 append 到内存 Ledger → 不更新投影 → 不产生"幽灵消息"。

**事件分级与失败策略：**

| 事件类型 | 级别 | 持久化失败行为 |
|---------|------|-------------|
| `UserMessage` | 关键 | Turn 立即终止，`TurnOutcome::Failed(StorageError)` |
| `AssistantMessage` | 关键 | Turn 立即终止，`TurnOutcome::Failed(StorageError)` |
| `ToolCall` | 关键 | Turn 立即终止，`TurnOutcome::Failed(StorageError)` |
| `ToolResult` | 关键 | Turn 立即终止，`TurnOutcome::Failed(StorageError)` |
| `SystemMessage`（Skill 注入、超限提示） | 关键 | Turn 立即终止，`TurnOutcome::Failed(StorageError)` |
| `Metadata(SessionConfig)` | 关键 | 会话创建失败，回滚 `Reserved` → `Empty` |
| `Metadata(ContextCompaction)` | 关键 | compact 视为失败；未持久化成功的 marker 不得应用，Turn 立即终止（通常为 `Failed(StorageError)`） |
| `Metadata(MemoryCheckpoint)` | 非关键 | 记录 warn 日志 + emit `Error(StorageError)` 事件，不终止 Turn |

**设计理由：** 关键事件构成模型可见的上下文链。如果 `UserMessage` 持久化失败但 Turn 继续运行，恢复时会缺少用户输入，实时路径与恢复路径分叉。非关键的 `MemoryCheckpoint` 仅影响提取边界，下次 checkpoint 会重新覆盖，不影响上下文一致性。

**统一写入路径：** 所有关键事件（包括 synthetic message）通过 §6.3 定义的 `persist_and_project()` helper 写入，保证"先持久化，再内存 append，再更新投影"的流水线一致性。

**无 SessionStorage 时：** 所有持久化操作静默跳过。内存 Ledger 仍正常追加。

### 8.2 恢复算法

不依赖任何内存快照，只依赖 Ledger 纯重放重建。恢复路径除重放 Ledger 外，还需按 `0005 §3.6` 对 `AssistantMessage(status=Incomplete)` 在可见上下文中追加一条合成提示 `System("[此消息因用户取消而中断]")`；该提示**不写回 Ledger**。

1. 载入按 `seq` 排序的完整 `LedgerEvent` 列表
2. 扫描所有 `Metadata` 事件：
   - 取最新 `SessionConfig` → 恢复 model_id, system_prompt_override
   - 取最新 `MemoryNamespace` → 恢复 memory_namespace（若缺失则降级使用 AgentConfig，记录 warn）
   - 取最新 `MemoryCheckpoint` → 恢复 last_memory_checkpoint_seq
   - 取最新 `ContextCompaction` → 得到 CompactionMarker
3. 重建可见消息：
   - 若有 CompactionMarker：先插入 `System(marker.rendered_summary)`，仅重放 `seq > replaces_through_seq` 的消息事件（包括 `SystemMessage`）
   - 若无：重放所有消息事件（包括 `SystemMessage`）
   - 每当重放到 `AssistantMessage(status=Incomplete)`，都在其后追加一条合成 `System("[此消息因用户取消而中断]")`
4. 计算 `turn_index`（统计 UserMessage 事件数量）
5. 构建 `SessionRuntime`

### 8.3 为什么不用快照

- 0005 无性能强制需求
- 单会话模型下，Ledger 重放足够简单
- 快照引入版本兼容、回放一致性等额外复杂度
- 保留升级路径：若未来 Ledger 规模成为瓶颈，存储实现可自行做内部优化

---

## 9. 并发、取消与关闭

### 9.1 并发边界

- `Agent` 是 `Send + Sync`，可通过 `Arc` 共享
- 同一时刻最多一个 Active Session
- 同一 Session 同一时刻最多一个 Running Turn
- Tool 批次全只读时并发，含 mutating 时串行

### 9.2 取消链路

```text
session_cancel_token ─┬→ turn_cancel_token ─┬→ provider request
external_cancel ──────┘                     └→ ToolDispatcher scheduling only

tool_timeout_token (per started tool) ─────→ running Tool
```

**行为约定：**

1. Provider 收到取消后停止流式输出
2. 正在执行的 Tool 不接收 `turn_cancel_token`；它们继续执行到完成，ToolResult 正常写入 Ledger
3. 未开始的 Tool 跳过，写入 synthetic `ToolResult` 到 Ledger：`ToolResult { call_id, output: ToolOutput { content: "[Tool cancelled]", is_error: true, metadata: json!(null) } }`
4. 已收到的 assistant 文本通过 `persist_and_project()` 保存为 `AssistantMessage { status: Incomplete }` 到 Ledger
5. 恢复路径在看到 `AssistantMessage(status=Incomplete)` 时，会在可见上下文中追加 `"[此消息因用户取消而中断]"` 的系统提示
6. `TurnOutcome` 为 `Cancelled`，最后一个 `AgentEvent` 为 `TurnCancelled`

**取消时机与 Ledger 写入协议：**

取消可能发生在两个阶段，Ledger 写入规则如下：

| 取消时机 | Ledger 写入内容（按顺序） |
|---------|------------------------|
| 模型流式输出期间 | ① `AssistantMessage(status=Incomplete)` |
| Tool 执行期间 | ① 已完成 Tool 的 `ToolResult`（正常结果） ② 正在执行 Tool 的 `ToolResult`（等待完成） ③ 未开始 Tool 的 synthetic `ToolResult`（`[Tool cancelled]`） |

**关键约束：** 取消路径的所有 Ledger 写入都通过 `persist_and_project()` 完成，保证持久化与内存投影一致。synthetic `ToolResult` 是为了保证每个已记账的 `ToolCall` 都有对应的 `ToolResult`；取消提示不进入 Ledger，而是在恢复时基于 `Incomplete` 状态生成。

### 9.3 关闭语义

`SessionHandle::close()` 和 `Agent::shutdown()` 共用 `close_session()` 内部函数：

1. **获取 `AgentControl` 锁**：
   - 若由 `close(&self)` 调用：校验 `slot` 必须是当前 handle 对应的 active session，否则返回 `SessionNotFound(session_id)`
   - 若由 `shutdown()` 调用：直接读取当前 active session
   - 取出 `session_cancel_token`、`turn_state`（若为 `Running` 则取出 handle）、`runtime` 的 Arc clone → **释放锁**
2. 取消当前 Turn（`session_cancel_token.cancel()`）
3. 若步骤 1 取到了 `RunningTurnHandle`：await `turn_finished_rx`（等待 Turn 真正结束）
4. 通过 `runtime` Arc 获取 `SessionRuntime` 锁 → 触发 `SessionEnd` Hook
   - `Abort` → 释放 `SessionRuntime` 锁并返回 `PluginAborted`；Session 保持 active，`close(&self)` 可重试
5. MemoryManager 收尾提取（通过同一 `runtime` Arc，失败不阻塞）→ 释放 `SessionRuntime` 锁
6. **获取 `AgentControl` 锁** → 释放 Session 槽 → `Empty` → **释放锁**

`close()` 是同步关闭。调用方 await 完成后槽才清空。成功关闭后原 `SessionHandle` 变为 stale；再次调用 `send_message()` / `close()` 返回 `SessionNotFound(session_id)`。Session 的 `Drop` 仅记录 warn，不做后台异步关闭。

**注意两把锁的获取时机**：步骤 1 和步骤 6 各获取一次 `AgentControl`，中间步骤 4-5 获取 `SessionRuntime`。两把锁不存在嵌套。

### 9.4 锁安全

**双层锁模型：**

| 锁 | 类型 | 持有时间 | 跨 `.await` |
|----|------|---------|------------|
| `AgentControl` | `std::sync::Mutex` | 微秒级，仅读写状态 | **禁止** |
| `SessionRuntime` | `tokio::sync::Mutex` | Turn 运行期间 | 允许 |

**规则：**
- `AgentControl` 锁内只做状态检查和原子切换，不做任何 I/O 或 `.await`
- `SessionRuntime` 锁由 TurnEngine 在整个 Turn 执行期间持有（通过 `tokio::sync::Mutex::lock().await`）
- 两把锁绝不嵌套获取：任何路径不会在持有一把锁时尝试获取另一把
- `close_session()` 通过 `AgentControl` 取出 cancel_token 和 turn_handle（释放 `AgentControl`），await Turn 结束后再通过 `Arc` 获取 `SessionRuntime` 做记忆提取

---

## 10. 使用示例

```rust
let agent = AgentBuilder::new(config)
    .register_model_provider(anthropic_provider)
    .register_tool(file_read_tool)
    .register_tool(shell_tool)
    .register_skill(commit_skill)
    .register_plugin(audit_plugin, audit_config)
    .register_session_storage(sqlite_storage)
    .register_memory_storage(tantivy_storage)
    .build()
    .await?;

// 创建会话
let session = agent.new_session(SessionConfig::default()).await?;

// 发送消息
let mut turn = session.send_message(
    UserInput { content: vec![ContentBlock::Text("Hello".into())] },
    None, // 不使用外部取消令牌
).await?;

// 消费事件流
while let Some(event) = turn.events.next().await {
    match event.payload {
        AgentEventPayload::TextDelta(text) => print!("{text}"),
        AgentEventPayload::ToolCallStart { tool_name, .. } => println!("[calling {tool_name}]"),
        AgentEventPayload::TurnComplete => println!("\n[done]"),
        _ => {}
    }
}

// 获取终态
match turn.join().await? {
    TurnOutcome::Completed => {}
    TurnOutcome::Cancelled => println!("cancelled"),
    TurnOutcome::Failed(err) => eprintln!("error: {err}"),
    TurnOutcome::Panicked => eprintln!("internal panic"),
}

// 关闭
session.close().await?;
agent.shutdown().await?;
```

---

## 11. 验收重点

以下场景必须在进入实现前明确可测试：

1. **shutdown 与 new_session 并发**：`shutdown()` 后不可能成功 claim 新 Session（AgentControl 同一临界区保证）
2. **compact 后 resume（含截断降级）**：Summary Compaction 和 Truncation Fallback 两种模式下分别 `resume_session()`，恢复出的可见消息序列（含首条合成 system message）与实时路径完全一致；两种模式都复用 Appendix B.2 前缀，`rendered_summary` 消除了恢复路径的再次拼接歧义
3. **事件流消费完后 join()**：`join()` 仍能稳定返回 `TurnOutcome`（独立 oneshot 通道保证）
4. **compact 后 checkpoint**：不会漏提或重复提取（ledger seq 做边界，不用 Vec 下标）
5. **SessionStart Hook Abort**：不留下半创建 Session（Reserved → Empty 回滚，先 Hook 后持久化）
6. **cancel 发生在各阶段**：model 流式中、只读 tool 中、mutating tool 中，行为符合 §9.2 取消协议
7. **关键事件持久化失败**：UserMessage/AssistantMessage/ToolCall/ToolResult/SystemMessage 写入 SessionStorage 失败时，Turn 立即以 `Failed(StorageError)` 终止，不继续编排
8. **Skill 未找到**：用户输入 `/nonexistent` 时，`send_message()` 同步返回 `SkillNotFound`，Turn 不启动
9. **Tool 超限收尾**：超过 `max_tool_calls_per_turn` 后，emit `MaxToolCallsExceeded` 事件，超限提示作为 SystemMessage 写入 Ledger，模型生成收尾回复，`join()` 返回 `Failed(MaxToolCallsExceeded)`
10. **compact 终态失败**：摘要 + 截断都无法恢复时，Turn 以 `Failed(CompactError)` 终止
11. **resume 无 SessionStorage**：未注册 SessionStorage 时调用 `resume_session()` 返回明确错误
12. **Session 发现最终一致性**：在没有新事件写入的静止状态下，`list_sessions()` 返回的 `updated_at` 和 `message_count` 与 Ledger 一致（允许短暂滞后）
13. **ToolOutput 全链路**：Tool 返回的 metadata 在 `ToolCallEnd` 事件、`AfterToolUse` Hook、Ledger 持久化、resume 恢复路径中全部一致
14. **Plugin hook 校验**：Plugin `apply()` 中 `tap()` 对未声明的 Hook 返回 `PluginHookContractViolation`；运行期若在不支持 patch 的 Hook 上返回 `ContinueWith`，当前操作同样返回结构化错误（不 panic）
15. **Tool 输出体积控制**：`ToolOutput` 的 content + metadata 总大小 ≤ `tool_output_max_bytes`（默认 1MB）；metadata 单独受 `tool_output_metadata_max_bytes` 子限额约束；超限后 metadata 被替换为截断标记，content 被截断
16. **delete_session 活跃会话**：删除当前活跃会话时返回 `SessionBusy`，不执行删除
17. **无 SessionStorage 时 discovery API**：`list_sessions` / `find_sessions` / `delete_session` / `resume_session` 统一返回 `StorageError("SessionStorage not registered")`
18. **外部 CancellationToken**：通过 `send_message(input, Some(external_token))` 传入外部令牌，外部取消触发后 Turn 行为与 `cancel()` 一致：Provider 停止继续生成，已启动 Tool 等待完成并正常记账，未启动 Tool 写入 synthetic cancel result
19. **多 Plugin Hook patch 累积**：`TurnStart` 和 `BeforeToolUse` 上存在多个 Plugin 同时返回 `ContinueWith` 时，最终 payload 的组合结果唯一且可重复（`TurnStart` append-only，`BeforeToolUse` last-write-wins）
20. **Synthetic message Ledger 一致性**：Skill 注入、Tool 超限提示在 `SessionStorage` 中以 `SystemMessage` 形式恢复；取消导致的中断提示在 resume 时基于 `AssistantMessage(status=Incomplete)` 追加，符合 `0005 §3.6`
21. **记忆提取输出解析**：Memory extraction 的模型输出按 Appendix B.10 / B.11 的 JSON 格式解析；`memory_operations` 为空数组正常处理；非法 JSON 视为空结果（记录 warn）；模型输出 `update` 操作时 `target_id` 不存在则降级为 `create`；模型输出 `delete` 操作时 `target_id` 不存在则跳过
22. **AfterToolUse Abort 批处理（mutating 串行）**：`AfterToolUse` Abort 发生在 mutating 串行批次中间时，已完成 Tool 的 ToolResult 已在 Ledger 中，剩余 Tool 短路跳过写入 synthetic ToolResult，退出 Tool loop 发起收尾请求
23. **Plugin 初始化失败回滚**：第 N 个 Plugin `initialize()` 失败时，前 N-1 个已初始化的 Plugin 按逆序 `shutdown()`，`build()` 返回 `PluginInitFailed`
24. **Tool 超时取消协议**：Tool 执行超时后，`tool_timeout_token` 被取消，Tool 实现方可通过 `CancellationToken` 感知并主动中止；超时后 ToolDispatcher 返回 `TOOL_TIMEOUT`
25. **memory_namespace 会话绑定**：用不同 `AgentConfig.memory_namespace` 重启进程并 `resume_session()` 同一 session，验证记忆操作仍落在原 namespace（从 Ledger Metadata 恢复）
26. **mutating 串行批次短路**：mutating 串行批次中第一个 Tool 被 `BeforeToolUse` Abort / `TOOL_NOT_FOUND` / `TOOL_TIMEOUT` / `TOOL_EXECUTION_ERROR` 后，后续 Tool 不再执行，全部写入 synthetic ToolResult 返回模型
27. **BeforeCompact Abort 在兜底路径**：Provider 返回 `context_length_exceeded` 触发兜底 compact 时，`BeforeCompact` Hook 返回 `Abort`，Turn 以 `CompactError` 终止（不跳过 compact）
28. **AfterToolUse Abort 并行批次**：只读并行批次中 `AfterToolUse` Abort 时，已在飞行中的 Tool 等待完成并正常记账，未启动的 Tool 写入 synthetic ToolResult
29. **配置值合法性校验**：`compact_threshold` 超出 (0.0,1.0) 范围、`memory_checkpoint_interval` 为 0、`memory_namespace` 为空等非法配置在 `build()` 阶段即返回 `InputValidation` 错误

---

## 12. Non-Goals

当前版本明确不做：

- 多 Session 并行
- 动态注册/卸载 Provider、Tool、Skill、Plugin
- 自动隐式激活 Skill
- 两阶段记忆整合（B.12 Phase 2）
- Session 快照和增量快照协议
- 内建文件系统、数据库或网络实现

---

## 13. Design Decisions

### D1: 为什么把 lifecycle 和 session slot 合并到同一把锁？

原设计中 `is_shutdown`（AtomicBool）和 `active_session`（Mutex）是独立的。`claim_session_slot()` 先读 `is_shutdown` 再获取锁，`shutdown()` 先 store 再获取锁。两者不在同一原子临界区，并发时存在 `new_session()` 读到 `false` 后 `shutdown()` store `true` 的竞态窗口。

统一到 `AgentControl` 后，任何修改生命周期或 slot 的操作都在同一把锁内完成，彻底消除竞态。

### D2: 为什么用 SessionLedger + CompactionMarker 而不是直接用 Vec<Message>？

compact 会替换历史消息，`Vec<Message>` 的下标在 compact 后不稳定。用 Ledger 的单调 seq：
- 恢复时根据 `replaces_through_seq` 精确重建可见上下文
- checkpoint 的增量边界用 seq 表达，不受 compact 影响
- 实时路径和恢复路径可证明一致

### D3: 为什么 TurnOutcome 用独立的 oneshot 通道？

`RunningTurn` 如果只持有 `mpsc::Receiver<AgentEvent>` 和 `JoinHandle<()>`，`join()` 无法可靠区分"正常完成""取消""错误"等终态。事件流可能已被消费完，`JoinHandle` 最多感知 panic。独立的 `oneshot::Receiver<TurnOutcome>` 由 supervisor 在退出前写入，`join()` 语义清晰、可直接写成测试。

### D4: 为什么先 Hook 后持久化（new_session 流程）？

先持久化后 Hook 的问题：Hook Abort 时需要 `delete_session()` 回滚。若 delete 失败，存储中留下脏数据。先 Hook 后持久化完全避免了补偿逻辑。代价是 Hook 中无法查询到 SessionStorage 中的当前 session——但 SessionStart Hook 的场景不需要这个能力。

### D5: 为什么 TurnLoop 是函数而非 struct？

TurnLoop 没有自己的状态。将它做成函数避免了不必要的状态管理。Session 本身已是状态容器。

### D6: 为什么不用 Actor 模型？

单会话模型，不存在多个并发 Actor 的场景。一个 `Mutex<AgentControl>` 足以保证互斥。Actor 引入的 channel/mailbox 机制对此场景过重。

### D7: 为什么两层 task spawn？

单层 spawn 中 `run_turn()` panic 会击穿 supervisor，导致 `TurnState` 无法归位。两层 task 确保 panic 被 tokio 捕获为 `JoinError`，supervisor 可安全执行清理和写入 `TurnOutcome::Panicked`。

### D8: 为什么关键事件持久化失败要终止 Turn？

"持久化失败不终止 Turn"会导致实时路径和恢复路径分叉——`UserMessage` 没落盘但 Turn 继续执行，恢复时缺少用户输入，上下文完全错位。**事实一致性优先于可用性**是本设计的核心原则：影响模型可见上下文的事件一旦未成功落入事实源，就必须停止后续编排。非关键事件（如 `MemoryCheckpoint`）不影响上下文一致性，允许失败后继续。

### D9: 为什么用 `std::sync::Mutex` + `tokio::sync::Mutex` 双层锁而非单一锁？

单一 `std::sync::Mutex` 无法跨 `.await` 持有，但 TurnEngine 需要在整个 Turn 执行期间访问 `SessionRuntime`（涉及大量异步操作）。单一 `tokio::sync::Mutex` 会让所有状态（包括 lifecycle、slot）都需要 `.await` 获取，增加了 `send_message()` 和 `close()` 的使用复杂度。

双层分离：`AgentControl`（`std::sync::Mutex`）只做微秒级的状态原子切换；`SessionRuntime`（`tokio::sync::Mutex`）可安全跨 `.await`。两把锁绝不嵌套，不存在死锁风险。

### D10: 为什么 Skill 解析在 send_message() 中完成而非 TurnEngine 中？

`SKILL_NOT_FOUND` 是同步错误——用户输入了一个不存在的 skill，应该在 Turn 启动前就告知调用方。如果放在 TurnEngine 内部（Turn 已 spawn），错误只能通过事件流异步传递，调用方无法直接从 `send_message()` 的 `Result` 中捕获。将 Skill 解析提前到 `send_message()` 步骤 2（不持任何锁），保持同步错误路径的简洁性。

### D11: 为什么 ToolOutput 要统一穿透到 Message 和 Ledger？

原设计中 `Message::ToolResult` 和 `LedgerEventPayload::ToolResult` 只保存 `content + is_error`，而事件流和 Hook 使用完整的 `ToolOutput`（含 metadata）。这导致三处数据结构不一致：Tool 的元数据在持久化时丢失，恢复路径拿不到原始 metadata。统一为共享的 `ToolOutput` 后，数据只有一份定义，流经事件、Hook、消息、账本全程不裁剪。模型只看到 `content`（`metadata` 不进入 `ChatRequest.messages`），但 `metadata` 持久化到 Ledger 供审计和扩展使用。

### D12: 为什么引入 PluginDescriptor 而非直接从 Plugin trait 获取元信息？

0005 §3.4 要求 Plugin 声明"需要 tap 的 Hook 事件列表"。如果只在 `apply()` 时动态注册，build 阶段无法校验 Plugin 声明了哪些 Hook。引入 `PluginDescriptor` 作为 Plugin 的静态描述：build 阶段即可获取完整元信息，`PluginContext::tap()` 可在注册时校验是否声明过该 Hook，System Prompt 渲染使用 descriptor 而非运行实例。

### D13: 为什么 SessionSummary 由 adapter 维护且采用最终一致性？

Agent 核心层不持有会话历史的全局视图（Session 关闭后状态释放）。`list_sessions()` 需要跨所有历史会话的摘要数据，只有 SessionStorage adapter 能高效提供。将 `SessionSummary` 的维护义务交给 adapter，避免核心层引入额外的全局状态。

一致性要求从"原子事务"放宽为"最终一致"，原因是：0005 §1.1 要求 Agent 不关心组件来源，Storage 可以来自文件系统、对象存储、网络等。强事务要求会将 adapter 实现限定为数据库类存储，与"来源无关"目标冲突。`SessionSummary` 仅用于发现和展示，不是恢复依据，短暂滞后对用户体验影响极小。

### D14: 为什么对外保持统一 HookResult，同时内部仍保留能力分支？

`0005` 已把 Hook 的公共契约定义为统一 `HookResult { Continue, ContinueWith, Abort }`。为了保持需求对齐，本设计继续沿用这一外部接口。  

同时，HookRegistry 在内部仍区分“是否支持 patch”，以便：

1. 对 `TurnStart` / `BeforeToolUse` 正确做 patch 累积；
2. 对其他 Hook 返回 `ContinueWith` 时给出明确的 `PluginHookContractViolation`；
3. 避免把实现优化上升成未经审批的公共接口变化。

### D15: 为什么 PluginContext::tap 返回 Result 而非 panic？

本库作为 crate 设计，可能被嵌入 Tauri 应用、Web Server 或其他宿主进程。Plugin 配置错误（如 tap 了未声明的 Hook）属于可预见的编程错误，不应升级为进程崩溃。返回 `Result<(), AgentError::PluginHookContractViolation>` 与 `build()` 的 `Result<Agent, AgentError>` 错误模型保持一致，宿主程序可优雅地处理和报告错误。

### D16: 为什么 CompactionMarker 持久化已渲染文本而非原始数据 + 模式标记？

备选方案是 `CompactionMarker` 存储原始摘要文本 + `mode: Summary | Truncation`，恢复路径根据 mode 再拼接 Appendix B.2 前缀和附加说明。问题在于：恢复路径和实时路径必须维护完全一致的渲染逻辑，一旦某个路径修改了前缀格式或截断说明而另一个没有，就会打破"实时/恢复一致"的核心承诺。

直接持久化 `rendered_summary`（最终合成 system message 文本），恢复路径只需 `Message::System(marker.rendered_summary)`，前缀和截断说明的一致性是构造性保证——因为同一份文本只在 compact 时渲染一次，恢复时原样读回。不存在两个路径对同一数据做不同渲染的可能。

### D17: 为什么 ToolHandler::execute() 接收 timeout CancellationToken？

`0005 §5.4` 要求"超时后取消 Tool 执行"，而 `0005 §6.2` 又要求"用户取消时已启动 Tool 等待完成"。因此，Tool 需要一个**只服务于超时场景**的取消信号，而不能直接复用 turn cancel。

通过在 trait 层传入 per-tool 的 `CancellationToken`，Tool 实现方可在合理时机检查超时信号并主动中止（协作式超时中止）。ToolDispatcher 在超时时 cancel `tool_timeout_token`，而用户 / Turn 取消只停止 Provider 和后续调度，不触碰已在执行的 Tool。这样同时满足"Tool 超时可中止"和"用户取消不打断已启动 Tool"两个约束。

### D18: 为什么 memory_namespace 要固化到 Ledger Metadata？

`memory_namespace` 原本只存在于 `AgentConfig` 中。如果进程重启时 `AgentConfig` 的 `memory_namespace` 发生了变化（例如配置文件修改、部署更新），恢复的 Session 会读写错误的 namespace，直接破坏记忆隔离。

将 `memory_namespace` 在 `new_session()` 时作为 `Metadata(MemoryNamespace)` 写入 Ledger，`resume_session()` 优先从 Ledger 恢复该值。这保证同一 Session 的全生命周期内 namespace 不会因外部配置变化而漂移，是数据隔离的必要条件。

### D19: 为什么 mutating 串行批次要短路而只读并行批次不用？

`0005 §5.1` 强调 mutating 批次的顺序"具有语义"——模型可能假设前一个 Tool 的副作用已经生效。当前序 Tool 失败时，后续 Tool 的前提条件可能不成立，继续执行可能在错误状态下产生真实副作用。短路后将所有结果（含跳过原因）返回模型，让模型重新规划。

只读批次没有副作用依赖，单个失败不影响其他 Tool 的正确性。保持 best-effort 并发可以最大化利用模型的一次批量调用，减少不必要的重试往返。

### D20: 为什么 Memory 提取由模型直接输出操作类型？

`0005 §5.7` 要求 v1 单阶段提取"一次 LLM 调用同时完成提取和整合判断（create/update/delete/skip）"。如果模型只输出原始记忆文本（无操作类型），再由 Agent 本地 heuristics 做整合判断，本质上是把"整合判断"从模型侧移到了 Agent 侧，偏离了需求定义的单阶段语义。

让模型直接输出带操作类型的结构化 JSON，Agent 仅做校验（id 存在性检查）和执行（映射到 Storage API），职责边界清晰：模型负责"决策"，Agent 负责"执行"。

---

## 14. Requirements Traceability

下表给出 `0005 -> 0006` 的关键追踪关系，便于实现、测试和后续评审统一口径。

| 0005 条款 | 0006 对应章节 | 状态 | 说明 |
|-----------|---------------|------|------|
| `§3.1 ModelProvider` | `§5.1` | Aligned | `ChatRequest` 回到消息列表主契约，Tool 定义仍经 `tools` 传递 |
| `§3.3 SkillDefinition` | `§4.9`, `§6.5` | Aligned | 仅显式 `/skill_name` 触发，隐式能力只用于建议 |
| `§3.4 Plugin` / `§3.5 Hook Registry` | `§4.10`, `§5.3`, `§6.8` | Aligned with internal refinement | 对外保持统一 `HookResult`，内部按 patch 能力分支；Abort 行为表细化了批次类型和 compact 触发路径的差异 |
| `§3.6 SessionStorage` | `§5.4`, `§8` | Aligned | 恢复阶段按 `Incomplete` 追加中断提示 |
| `§3.7 MemoryStorage` / `§5.7 Memory Manager` | `§5.4`, `§6.7` | Aligned | v1 提取模型直接输出操作类型（create/update/delete），Agent 校验并执行 |
| `§4 AgentConfig.memory_namespace` | `§4.2`, `§4.5`, `§6.7`, `§7.2`, `§8.2` | Aligned | memory_namespace 在 new_session 时固化到 Ledger Metadata，resume 时从 Ledger 恢复，保证会话级隔离 |
| `§5.1 Tool 调用并发策略` | `§6.4` | Aligned | mutating 串行批次增加短路规则，失败即停止剩余 Tool 返回模型重新规划 |
| `§5.2 Context Manager` | `§4.3`, `§6.2`, `§8.2` | Aligned with refinement | `rendered_summary` 持久化是内部一致性细化；Summary / Truncation 都复用 Appendix B.2 前缀 |
| `§5.3 System Prompt Builder` | `§5.1`, `§6.6` | Aligned | PromptBuilder 输出作为前导 `Message::System` 注入 `ChatRequest.messages` |
| `§5.4 Tool Dispatcher` | `§5.2`, `§6.4` | Aligned | ToolHandler 接收 per-tool timeout token，实现"超时可中止、用户取消不打断已启动 Tool" |
| `§6.2 Session / Cancellation` | `§7.2`, `§7.3`, `§9.2`, `§9.3` | Aligned with additive extension | 外部 `CancellationToken` 是增量增强；取消语义仍保持"已启动 Tool 等待完成" |
| `§9 Error Handling` | `§4.11`, `§6.3`, `§8.1` | Aligned | `MAX_TOOL_CALLS_EXCEEDED` 记为失败终态，但允许伴随收尾回复 |
| `Appendix B.1-B.12` | `§6.2`, `§6.6`, `§6.7`, `prompt/templates.rs` | Aligned | 保持 0005 appendix 为唯一 prompt 契约来源 |
