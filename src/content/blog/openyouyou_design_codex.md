---
title: openyouyou 的 agent 架构设计文档 by codex
date: 2026-03-16
description: agent 设计
category: 胡说八道
---
# YouYou Agent - Architecture Design by Codex

| Field | Value |
|---|---|
| Document ID | 0006 |
| Type | design |
| Status | Revised Draft |
| Created | 2026-03-14 |
| Related | 0005 (requirements), 0007 (design review) |
| Baseline Module Path | `src-tauri/src/agent/` |
| Repo-local Adaptation | `src/agent/` |

> Path policy: `0005` 将 `src-tauri/src/agent/` 作为规范化模块路径。当前仓库只有 `src/`，因此本文以 `src/agent/` 展示同一套逻辑模块树；如果后续接回 Tauri，只需整体平移目录，不改变内部边界、类型或协议。

---

## 1. 设计目标

本设计以 `specs/0005_youyou_demand.md` 为唯一需求基线，并吸收 `0007` 中成立的评审意见。目标不是继续堆主流程，而是把 v1 必须稳定的底层协议一次定死：

- `SessionLedger + SessionSummaryProjection`：统一恢复事实源和会话发现查询面。
- `TurnAugmentation + RequestContext`：让显式 Skill 注入只作用于当前 turn，但在 tool loop、compact 和请求重建中走唯一传递路径。
- `ContextState + CompactionRecord + CurrentTurn Preservation`：统一实时 compact 路径和 resume 路径，并把当前 turn 锚点保留写成硬约束。
- `RenderedPrompt + RequestBuildOptions + ChatRequestBuilder`：彻底分离 prompt 文本渲染与 API `tools` 请求通道，并把 tool 可用性降到 request 级决策。
- `RequestedToolBatch + ResolvedToolCall`：统一模型原始参数、Hook 改参、外部事件、账本审计和真实执行参数。
- `ContentBlock Contract + Capability Guard`：把图片和文本型文件输入拆开，避免错误绑定 `Vision` 能力。
- `AgentConfig + SessionConfig + SessionPinnedConfig + SessionRuntimePolicy + ResolvedSessionConfig`：把会话稳定字段与可重算运行策略拆开，彻底消除 resume 漂移。
- `SessionMemoryState + MemoryMutationPipeline`：把记忆读写都收敛到同一套生命周期模型。
- `TurnController + Turn-scoped AgentEvent.sequence`：让取消能力和事件顺序成为可实现、可测试的公开协议。
- `Typed Hook Contract + Error Matrix`：让 Plugin 行为和失败路径具备可实现、可测试的边界。

设计原则：

- `Clean Architecture`：领域规则在内层，外部依赖通过 port 注入。
- `Single Source of Truth`：恢复只依赖 `SessionLedger`，不依赖快照。
- `Descriptor First`：Prompt、Hook、Registry 只读取 descriptor，不窥探 runtime 私有状态。
- `Recoverability First`：实时路径和恢复路径必须产出同一份模型可见上下文。
- `Capability Guard Before IO`：能力不满足时，在发起 provider 请求前返回结构化错误。
- `YAGNI`：只覆盖 `0005` 明确要求，不引入多 session、snapshot、两阶段 memory。

---

## 2. 总体架构

```text
+------------------------------------------------------------------+
| Interface / API                                                  |
| AgentBuilder, Agent, SessionHandle, RunningTurn, TurnController, |
| SessionCatalog                                                   |
+------------------------------------------------------------------+
| Application                                                      |
| SessionService, TurnEngine, SkillResolver, ContextManager,       |
| PromptBuilder, ChatRequestBuilder, ToolDispatcher,               |
| MemoryManager, PluginManager                                     |
+------------------------------------------------------------------+
| Domain                                                           |
| SessionLedger, SessionSummary, TurnAugmentation, RequestContext, |
| ContentBlock, ContextState, CompactionRecord,                    |
| ResolvedSessionConfig, SessionMemoryState, ToolOutput,           |
| HookPayload, TurnOutcome, AgentError                             |
+------------------------------------------------------------------+
| Ports / Adapters                                                 |
| ModelProvider, ToolHandler, Plugin, SessionStorage,              |
| MemoryStorage                                                    |
+------------------------------------------------------------------+
```

关键边界调整：

1. `PromptBuilder` 只负责 system prompt 文本段的渲染。
2. 新增 `SkillResolver`，专门把显式 `/skill_name` 解析为 `TurnAugmentation`。
3. `ContextManager` 不再只保存一串 `visible_messages`，而是维护可重建的 `CompactionRecord`，并负责把 turn 级增强叠加成 `RequestContext`。
4. `ChatRequestBuilder` 负责把 `RenderedPrompt`、`RequestContext`、多模态内容、request 级 tool 策略和 sampling 参数组装成正式 `ChatRequest`。
5. `ToolDispatcher` 先把 provider 产出的 `RequestedToolBatch` 解析为 `ResolvedToolCall`，再发事件、记账和执行。
6. Hook 改为 typed registrar；只有 `TurnStart` 与 `BeforeToolUse` 两类 hook 在类型层面允许 patch。

---

## 3. 模块划分

建议目录如下：

```text
src/agent/
├── mod.rs
├── api/
│   ├── agent.rs
│   ├── builder.rs
│   ├── session.rs
│   └── running_turn.rs
├── application/
│   ├── session_service.rs
│   ├── turn_engine.rs
│   ├── skill_resolver.rs
│   ├── context_manager.rs
│   ├── prompt_builder.rs
│   ├── request_builder.rs
│   ├── tool_dispatcher.rs
│   ├── memory_manager.rs
│   └── plugin_manager.rs
├── domain/
│   ├── config.rs
│   ├── content.rs
│   ├── error.rs
│   ├── event.rs
│   ├── hook.rs
│   ├── ledger.rs
│   ├── memory.rs
│   ├── model.rs
│   ├── plugin.rs
│   ├── session.rs
│   ├── state.rs
│   ├── turn.rs
│   └── tool.rs
└── ports/
    ├── model.rs
    ├── tool.rs
    ├── plugin.rs
    ├── session_storage.rs
    └── memory_storage.rs
```

各模块职责：

| 模块 | 职责 |
|---|---|
| `api/builder.rs` | 收集注册项、执行 build 校验、构建不可变内核 |
| `api/agent.rs` | 暴露 `new_session`、`shutdown`、`session_catalog()` |
| `api/session.rs` | 活跃会话句柄、发送消息、取消、关闭 |
| `application/session_service.rs` | 会话创建、恢复、关闭、账本写入、列表、搜索、删除 |
| `application/turn_engine.rs` | 单轮对话循环、provider 路由、tool loop、终态管理 |
| `application/skill_resolver.rs` | 解析显式 Skill、生成 turn 级增强 |
| `application/context_manager.rs` | 可见上下文投影、compact、恢复、`RequestContext` 组装 |
| `application/prompt_builder.rs` | system prompt 文本渲染 |
| `application/request_builder.rs` | `ChatRequest` 组装、内容块序列化、能力预检、`tools` 注入 |
| `application/tool_dispatcher.rs` | Tool 执行策略、Hook 包装、错误归一 |
| `application/memory_manager.rs` | bootstrap/search/extract/checkpoint/close 全链路 |
| `application/plugin_manager.rs` | Plugin 初始化、typed hook 注册、关闭 |
| `domain/config.rs` | `AgentConfig` / `SessionConfig` / `SessionPinnedConfig` / `SessionRuntimePolicy` / `ResolvedSessionConfig` 契约 |
| `domain/content.rs` | `ContentBlock` 与输入能力映射 |
| `domain/turn.rs` | `TurnAugmentation`、`RequestContext`、`TurnController` 协议 |
| `domain/*` | 纯领域模型、状态机和协议 |
| `ports/*` | 外部依赖抽象，暴露稳定强类型契约 |

---

## 4. 核心领域模型

### 4.1 不可变注册表

build 完成后，以下注册表均不可变：

- `ModelRegistry`：`provider_id -> provider`，`model_id -> provider_id + ModelInfo`
- `ToolRegistry`：`tool_name -> ToolDescriptor + ToolHandler`
- `SkillRegistry`：`skill_name -> SkillDefinition`
- `PluginCatalog`：`plugin_id -> PluginDescriptor + plugin_config + Plugin runtime`

约束：

- 运行期禁止动态注册和卸载。
- `PromptBuilder`、`ChatRequestBuilder`、`ToolDispatcher`、`PluginManager` 只读取 descriptor。
- descriptor 是系统 prompt、hook 暴露信息、请求构建和日志字段的唯一来源。

### 4.1.1 SkillDefinition 正式契约

`SkillRegistry` 中保存的不是松散对象，而是正式的 `SkillDefinition`：

```rust
pub struct SkillDefinition {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub prompt: String,
    pub tool_dependencies: Vec<String>,
    pub allow_implicit_invocation: bool,
}
```

约束：

- `name` 是全局唯一主键，同时也是 `/skill_name` 的唯一匹配键。
- `display_name`、`description`、`prompt` 都必须来自同一份 `SkillDefinition`，不得由调用方在别处重复提供。
- `display_name` 保留为正式字段，供未来 UI 或其他非 prompt 展示面复用；v1 的 `Skill List` 仍按 `0005` 只使用 `name + description` 渲染。
- `tool_dependencies` 必须全部命中 `ToolRegistry`；缺失任一依赖时，`AgentBuilder` 直接返回 `SKILL_DEPENDENCY_NOT_MET`。
- `PromptBuilder` 的 `Skill List` 只渲染 `allow_implicit_invocation = true` 的 Skill，且列表项使用 `name + description`。
- `SkillResolver` 使用 `name` 做显式匹配，使用 `prompt` 渲染 `<skill>` 注入内容；不得从渲染列表反向推断 prompt。

### 4.2 AgentControl 状态机

生命周期与单会话槽由同一把锁保护：

```rust
enum LifecycleState {
    Running,
    ShuttingDown,
    Shutdown,
}

enum SessionSlotState {
    Empty,
    Reserved { reservation_id: String, session_id: String },
    Active(Arc<SessionRuntime>),
}

struct AgentControl {
    lifecycle: LifecycleState,
    slot: SessionSlotState,
}
```

约束：

1. `claim_session_slot()` 在同一临界区同时检查 `lifecycle == Running` 和 `slot == Empty`。
2. `new_session()` 与 `resume_session()` 先写 `Reserved`，成功后提交 `Active`。
3. `shutdown()` 原子切到 `ShuttingDown`；此后任何新会话创建都返回 `AGENT_SHUTDOWN`。
4. 初始化失败必须按 `reservation_id` 回滚，避免误释放并发路径写入的占槽。

### 4.3 SessionRuntime

`SessionRuntime` 保存当前活跃 session 的全部易失状态：

| 字段 | 说明 |
|---|---|
| `session_id` | 当前会话 ID |
| `resolved_session_config` | 解析默认值后的会话运行配置视图 |
| `ledger` | `SessionLedger`，唯一事实源 |
| `context_state` | 当前模型可见上下文与最近一次 compact 结果 |
| `memory_state` | bootstrap memory 与本轮 query memory 视图 |
| `catalog_state` | 当前 `SessionSummary` 投影 |
| `turn_state` | `Idle / Running / Closing / Closed` |
| `turn_index` | 当前轮次编号 |
| `last_memory_checkpoint_seq` | 记忆 checkpoint 已覆盖到的 ledger seq |
| `session_cancel_token` | 会话级取消令牌 |

`memory_state` 与 `catalog_state` 是本版的两个关键运行态：

- `memory_state` 让 bootstrap memory 在 session 生命周期内稳定存在，不必每轮重读。
- `catalog_state` 让列表/搜索使用的 `SessionSummary` 成为领域投影，而不是 adapter 自行推断。
- `resolved_session_config` 让 `TurnEngine`、`ContextManager`、`ToolDispatcher`、`MemoryManager` 不再各自解释默认值。

### 4.4 TurnAugmentation 与 RequestContext

显式 Skill 注入不进入账本，而是作为 turn 级增强在请求组装阶段叠加：

```rust
pub struct ResolvedSkillInjection {
    pub skill_name: String,
    pub rendered_xml: String,
}

pub struct TurnAugmentation {
    pub origin_user_seq: u64,
    pub skill_injections: Vec<ResolvedSkillInjection>,
}

pub struct RequestContext {
    pub pre_anchor_messages: Vec<Message>,
    pub anchor_message: Message,
    pub post_anchor_augmentations: Vec<Message>,
    pub post_anchor_messages: Vec<Message>,
}
```

语义：

- `origin_user_seq` 锚定当前 turn 的 `UserMessage`；所有增强都插在这条消息之后。
- `TurnAugmentation` 由 `SkillResolver` 在本轮创建，只在当前 `RunningTurn` 生命周期内有效。
- `ContextManager` 每次重建请求时，都把 `skill_injections` 渲染为 synthetic `SystemMessage`，放在 `anchor_message` 之后、同 turn 的 `Assistant/Tool` 消息之前。
- `TurnAugmentation` 不写入 `SessionLedger`，不参与 `CompactionRecord` 持久化，也不会在 `resume_session()` 时恢复。
- 当前 turn 结束后立即丢弃增强；如果调用方希望下一轮继续使用该 Skill，必须再次显式发送 `/skill_name`。

这样可以固定唯一链路：

`TurnEngine -> SkillResolver -> TurnAugmentation -> ContextManager::build_request_context() -> ChatRequestBuilder`

### 4.5 ContentBlock 与输入 capability

`ContentBlock` 是输入协议，而不是 provider 能力的别名：

```rust
pub enum ContentBlock {
    Text { text: String },
    Image { mime_type: String, data_base64: String },
    FileContent {
        file_name: Option<String>,
        media_type: Option<String>,
        text: String,
    },
}
```

能力映射：

| 变体 | Provider 通道 | 需要的能力 |
|---|---|---|
| `Text` | 文本消息 | 无 |
| `FileContent` | 文本消息 | 无 |
| `Image` | 图片消息 | `Vision` |

约束：

- `FileContent` 表示“调用方已读取好的文本载荷”，不是文件句柄，也不是二进制附件。
- `FileContent` 与 `Text` 一样可参与 title 生成、普通上下文压缩和模型请求构造；但 v1 的 memory search query 只从显式 `Text` 块提取，以保持与 `0005` 的“纯文件输入跳过 search”一致。
- 只有 `Image` 会触发 `Vision` 预检。
- 若未来需要真正的二进制附件协议，必须新增独立 `ContentBlock` 变体和 capability，不得复用 `FileContent`。

### 4.6 SessionSummaryProjection

`SessionSummary` 是会话发现的统一结构：

```rust
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub message_count: u64,
}
```

投影规则由核心层定义：

- `created_at`：session 第一条账本事件时间戳。
- `updated_at`：最近一条成功写入账本事件时间戳。
- `title`：首条包含 `Text` 或 `FileContent.text` 的 `UserMessage` 第一行；若标题来源于顶层 `Text` 块，则在裁剪前忽略前导显式 `/skill_name` 触发词；若标题来源于 `FileContent.text`，则按原文保留，不做 skill 前缀剥离；若清洗后为空则为 `Untitled session`。
- `message_count`：仅统计 `UserMessage`、`AssistantMessage`、`SystemMessage`。

`SessionStorage` 只保存 projection，不自行解释业务规则。

### 4.7 SessionLedger 是唯一事实源

账本使用单调递增序号：

```rust
pub struct LedgerEvent {
    pub seq: u64,
    pub timestamp: DateTime<Utc>,
    pub payload: SessionEventPayload,
}

pub struct ToolOutput {
    pub content: String,
    pub is_error: bool,
    pub metadata: Option<Value>,
}

pub struct ToolResultRecord {
    pub call_id: String,
    pub tool_name: String,
    pub output: ToolOutput,
}

pub struct ToolCallRecord {
    pub call_id: String,
    pub tool_name: String,
    pub requested_arguments: Value,
    pub effective_arguments: Value,
}

pub enum SessionEventPayload {
    UserMessage { content: Vec<ContentBlock> },
    AssistantMessage { content: Vec<ContentBlock>, status: MessageStatus },
    ToolCall { call: ToolCallRecord },
    ToolResult { result: ToolResultRecord },
    SystemMessage { content: String },
    Metadata { key: String, value: Value },
}
```

标准 metadata 键：

| key | value | 用途 |
|---|---|---|
| `session_profile` | `SessionPinnedConfig` | 恢复会话稳定字段并重新解析 `ResolvedSessionConfig`；也是 `SessionStart` hook 之前的第一条 durable 账本事件 |
| `skill_invocations` | `[{ skill_name }]` | 审计本 turn 触发的显式 Skill，不参与 replay |
| `context_compaction` | `CompactionRecord` | 恢复 compact 边界和模式 |
| `memory_checkpoint` | `{ last_seq, turn_index }` | 恢复记忆提取进度 |

补充约束：

- `ToolCallRecord.effective_arguments` 是唯一允许流入 `ToolCallStart`、`ToolHandler::call()` 和后续 replay 的参数。
- `ToolCallRecord.requested_arguments` 只保留模型原始输出，供审计和调试对比；即使与 `effective_arguments` 相同，也要显式持久化，避免恢复逻辑猜测。

### 4.7.1 RequestedToolBatch 与 ResolvedToolCall

Tool 执行协议分三层对象：

```rust
pub struct RequestedToolCall {
    pub call_id: String,
    pub tool_name: String,
    pub requested_arguments: Value,
}

pub struct RequestedToolBatch {
    pub calls: Vec<RequestedToolCall>,
}

pub struct ResolvedToolCall {
    pub call_id: String,
    pub tool_name: String,
    pub requested_arguments: Value,
    pub effective_arguments: Value,
    pub mutating: bool,
}
```

语义：

- `RequestedToolBatch` 表示单次 provider 响应里返回的一个有序 Tool 批次。
- `ResolvedToolCall` 是 `BeforeToolUse` patch 应用完成后的稳定执行单元。
- 同一批次内始终保留模型原始顺序；即使只读 tool 并发执行，账本写入顺序和对模型回注顺序也不得重排。

### 4.8 ContextState 与 CompactionRecord

compact 协议拆成两种正式模式：

```rust
pub enum CompactionMode {
    Summary,
    TruncationFallback,
}

pub struct CompactionRecord {
    pub mode: CompactionMode,
    pub replaces_through_seq: u64,
    pub summary_body: Option<String>,
}

pub struct VisibleMessage {
    pub source_seq: Option<u64>,
    pub message: Message,
}

pub struct ContextState {
    pub latest_compaction: Option<CompactionRecord>,
    pub visible_messages: Vec<VisibleMessage>,
    pub history_estimated_tokens: usize,
}
```

语义：

- `Summary`：把 `seq <= replaces_through_seq` 的可见历史替换为一条合成 system message。
- `TruncationFallback`：直接丢弃 `seq <= replaces_through_seq` 的可见历史，不写失败摘要。
- `summary_body` 只存摘要正文，不存最终前缀文本。
- synthetic compaction summary 的 `VisibleMessage.source_seq` 固定为 `None`；普通账本消息必须保留 `Some(seq)`。

统一渲染函数：

```rust
fn render_compaction_summary(summary_body: &str) -> String
```

约束：

- 该函数固定输出 `Appendix B.2 prefix + "\n\n" + summary_body`。
- 实时 compact 路径和 resume 路径都必须复用它。
- `Appendix B.2` 前缀不可配置。
- `history_estimated_tokens` 只估算可见历史消息本身；不包含 `RenderedPrompt.system_prompt`、当前 turn 的 skill augmentation，或其他 request 级附加段。
- 真实的 compact 预估触发必须使用 request 级估算值：`history_estimated_tokens + prompt_tokens + augmentation_tokens`。
- `ContextState` 只保存账本可投影出的可见消息，不直接持有 `TurnAugmentation`。

### 4.9 SessionMemoryState 与 MemoryMutation

```rust
pub struct SessionMemoryState {
    pub bootstrap_memories: Vec<Memory>,
    pub last_turn_memories: Vec<Memory>,
}

pub enum MemoryMutation {
    Create(Memory),
    Update(Memory),
    Delete { id: String },
    Skip { reason: Option<String> },
}
```

语义：

- `bootstrap_memories`：session 启动或恢复时一次加载。
- `last_turn_memories`：每轮 `search()` 的结果，轮结束后可被下一轮覆盖。
- v1 记忆提取通过 `Create / Update / Delete / Skip` 表达，不依赖 adapter 自己做整合判断。

### 4.10 PluginDescriptor

```rust
pub struct PluginDescriptor {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub tapped_hooks: Vec<HookKind>,
}
```

约束：

- `PluginCatalog` 存 descriptor、config 和 runtime。
- Active Plugin Info 只读取 `PluginDescriptor`。
- `apply()` 只能注册 `descriptor.tapped_hooks` 中声明过的 hook。

### 4.11 RunningTurn、TurnController 与事件序号

```rust
pub enum TurnOutcome {
    Completed,
    Cancelled,
    Failed(AgentError),
    Panicked,
}

pub struct RunningTurn {
    pub events: ReceiverStream<AgentEvent>,
    controller: TurnController,
    outcome_rx: oneshot::Receiver<TurnOutcome>,
}

#[derive(Clone)]
pub struct TurnController {
    cancel: CancellationToken,
}
```

约束：

- `TurnController::cancel()` 与 `RunningTurn::cancel()` 都必须幂等；turn 已结束时再次取消是空操作。
- 取消后允许继续消费 `events`，也允许继续等待 `join()`。
- `events` 被消费完不影响 `join()`。
- `join()` 只读取 `outcome_rx`；若 turn 在取消信号到达前已完成，则仍返回真实终态而不是强行改写为 `Cancelled`。
- `AgentEvent.sequence` 的作用域限定为单个 `RunningTurn.events` 流，从 `1` 开始单调递增；resume 或新 turn 都重新起号。
- 跨 turn 排序或去重必须使用 `(session_id, turn_id, sequence)`，不能只依赖 `sequence`。
- `Panicked` 只承接后台 task panic，对应 `INTERNAL_PANIC`。

---

## 5. Configuration Contract

### 5.1 AgentConfig 与 SessionConfig

```rust
pub struct AgentConfig {
    pub default_model: String,
    pub system_instructions: Vec<String>,
    pub personality: Option<String>,
    pub environment_context: Option<EnvironmentContext>,
    pub tool_timeout_ms: u64,
    pub compact_threshold: f32,
    pub compact_model: Option<String>,
    pub compact_prompt: Option<String>,
    pub max_tool_calls_per_turn: usize,
    pub memory_model: Option<String>,
    pub memory_checkpoint_interval: u32,
    pub memory_max_items: usize,
    pub memory_namespace: String,
}

pub struct SessionConfig {
    pub model_id: Option<String>,
    pub system_prompt_override: Option<String>,
}
```

边界：

- `AgentConfig` 只表达构建期默认值与可在 resume 时重算的运行策略。
- `SessionConfig` 只表达 `new_session()` 调用时的输入，不直接持久化。
- v1 不额外暴露 `tool_use_policy`、`temperature`、`max_tokens`、`reasoning_effort` 这类公共配置面；若未来确有需要，必须先升级 `0005` 再进入设计。
- 运行时组件不得直接同时读取 `AgentConfig` 与 `SessionConfig`；它们只能消费解析后的 `ResolvedSessionConfig`。

### 5.2 SessionPinnedConfig、SessionRuntimePolicy 与 ResolvedSessionConfig

```rust
pub struct SessionPinnedConfig {
    pub model_id: String,
    pub system_prompt_override: Option<String>,
    pub memory_namespace: String,
}

pub struct SessionRuntimePolicy {
    pub tool_timeout_ms: u64,
    pub compact_threshold: f32,
    pub compact_model_id: String,
    pub compact_prompt: String,
    pub max_tool_calls_per_turn: usize,
    pub memory_model_id: String,
    pub memory_checkpoint_interval: u32,
    pub memory_max_items: usize,
}

pub struct ResolvedSessionConfig {
    pub pinned: SessionPinnedConfig,
    pub runtime_policy: SessionRuntimePolicy,
}
```

生成规则：

- `resolve_session_pinned_config(agent_config, session_config)` 只在 `new_session()` 时执行一次。
- `SessionPinnedConfig.model_id` 由 `SessionConfig.model_id.unwrap_or(AgentConfig.default_model)` 得出，并在建会话时立刻固化。
- `SessionPinnedConfig.system_prompt_override` 由 `SessionConfig.system_prompt_override` 归一化得到；空白串按 `None` 处理。
- `SessionPinnedConfig.memory_namespace` 来自 `AgentConfig.memory_namespace`，在 `new_session()` 时 trim 并固化；`resume_session()` 绝不重新读取当前 `AgentConfig.memory_namespace`。
- `SessionService` 必须把 `SessionPinnedConfig` 作为第一条 `Metadata(session_profile)` 写入账本；恢复时只读取该快照，不再重跑默认模型选择。
- `resolve_session_runtime_policy(agent_config, pinned)` 在 `new_session()` 和 `resume_session()` 都会执行，用于解析可重算的运行策略。
- `SessionRuntimePolicy.compact_model_id` 与 `memory_model_id` 的默认值都继承 `SessionPinnedConfig.model_id`。
- `SessionRuntimePolicy.compact_prompt` 未配置时使用 `Appendix B.1` 默认模板。
- `ResolvedSessionConfig` 写入 `SessionRuntime` 后，后续组件不得再次回退到原始 `AgentConfig` 或 `SessionConfig`。

这组拆分是 v1 的正式恢复契约：

- `SessionPinnedConfig` 定义“恢复后必须保持稳定”的会话语义边界。
- `SessionRuntimePolicy` 定义“恢复后允许继承当前 agent”的运行策略。
- 任何字段若会影响会话隔离、Provider 路由或 session 级可见行为，都必须进入 `SessionPinnedConfig`，不能留在“resume 时重算”的模糊区域。

### 5.3 默认值、消费组件与校验规则

| 字段 | 默认值 / 解析方式 | 消费组件 | 校验 |
|---|---|---|---|
| `default_model` | 必填；仅在 `new_session()` 且 `SessionConfig.model_id=None` 时用于解析 `SessionPinnedConfig.model_id` | `SessionService` | 必须命中 `ModelRegistry` |
| `system_instructions` | 必填 | `PromptBuilder` | 允许空列表；渲染时按序过滤空白项 |
| `personality` | `None` | `PromptBuilder` | 可空；空白串按 `None` 处理 |
| `environment_context` | `None` | `PromptBuilder` | 若存在则字段格式合法 |
| `tool_timeout_ms` | `120000` | `ToolDispatcher`（经 `SessionRuntimePolicy`） | `> 0` |
| `compact_threshold` | `0.8` | `ContextManager`（经 `SessionRuntimePolicy`） | `0.0 < x < 1.0` |
| `compact_model` | 默认 `SessionPinnedConfig.model_id` | `ContextManager`（经 `SessionRuntimePolicy`） | 若显式配置，必须命中 `ModelRegistry` |
| `compact_prompt` | `Appendix B.1` | `ContextManager`（经 `SessionRuntimePolicy`） | 可空；空白串按未配置处理 |
| `max_tool_calls_per_turn` | `50` | `TurnEngine`（经 `SessionRuntimePolicy`） | `> 0` |
| `memory_model` | 默认 `SessionPinnedConfig.model_id` | `MemoryManager`（经 `SessionRuntimePolicy`） | 若显式配置，必须命中 `ModelRegistry` |
| `memory_checkpoint_interval` | `10` | `MemoryManager`（经 `SessionRuntimePolicy`） | `> 0` |
| `memory_max_items` | `20` | `MemoryManager`、`PromptBuilder`（经 `SessionRuntimePolicy`） | `> 0` |
| `memory_namespace` | 必填；仅在 `new_session()` 时固化到 `SessionPinnedConfig.memory_namespace` | `SessionService` | trim 后非空 |
| `SessionConfig.model_id` | `None` 时回退到 `default_model`，解析后固化到 `SessionPinnedConfig.model_id` | `SessionService` | 若显式配置，必须命中 `ModelRegistry` |
| `SessionConfig.system_prompt_override` | `None`；空白串归一为 `None`，解析后固化到 `SessionPinnedConfig.system_prompt_override` | `SessionService` | 空白串按 `None` 处理 |

这张表是唯一合法归属：

- `system_prompt_override` 只能通过 `ResolvedSessionConfig.pinned` 暴露给 `PromptBuilder`。
- `memory_namespace` 只能通过 `ResolvedSessionConfig.pinned` 暴露给 `MemoryManager`。
- `tool_timeout_ms`、`compact_*`、`max_tool_calls_per_turn`、`memory_*` 只能通过 `ResolvedSessionConfig.runtime_policy` 暴露给对应组件。
- `ChatRequestBuilder` 虽然仍构造带 `temperature` / `max_tokens` / `reasoning_effort` 的 provider 请求结构，但 v1 固定显式传 `None`，不在本版规范中新增公开配置入口。

---

## 6. Port 设计

### 6.1 ModelProvider

`ModelProvider` 需要从“只有 trait 轮廓”提升到正式协议。

```rust
pub enum ProviderCapability {
    ToolUse,
    Vision,
    Streaming,
}

pub struct ModelInfo {
    pub model_id: String,
    pub display_name: String,
    pub context_window: usize,
    pub capabilities: BTreeSet<ProviderCapability>,
}

pub enum ModelMessageRole {
    System,
    User,
    Assistant,
    Tool,
}

pub struct ModelMessage {
    pub role: ModelMessageRole,
    pub content: Vec<ContentBlock>,
    pub tool_call_id: Option<String>,
}

pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: Option<u64>,
    pub total_tokens: u64,
}

pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Cancelled,
    Error,
}

pub struct ChatRequest {
    pub model_id: String,
    pub system_prompt: String,
    pub messages: Vec<ModelMessage>,
    pub tools: Vec<ToolDescriptor>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
}

pub enum ProviderErrorKind {
    ContextLengthExceeded,
    UnsupportedCapability { capability: ProviderCapability },
    Transport,
    Provider,
}

pub struct ProviderError {
    pub kind: ProviderErrorKind,
    pub message: String,
    pub retryable: bool,
}

pub enum ChatEvent {
    TextDelta { text: String },
    ReasoningDelta { text: String },
    ToolCall { call_id: String, tool_name: String, arguments: Value },
    Done { finish_reason: FinishReason, usage: Usage },
    Error(ProviderError),
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn provider_id(&self) -> &str;
    fn models(&self) -> &[ModelInfo];
    async fn chat(
        &self,
        request: ChatRequest,
        cancel: CancellationToken,
    ) -> Result<ChatEventStream, ProviderError>;
}
```

约束：

- 至少注册一个 provider。
- `provider_id` 唯一；所有 `model_id` 跨 provider 全局唯一。
- `chat()` 必须支持协作式取消。
- `Done.usage` 为正式字段；Provider 不允许把 usage 藏在 adapter 私有日志里。
- provider 内部错误统一先归一到 `ProviderErrorKind`，再由 `TurnEngine` 映射到 `AgentError.code`。
- 单次 provider 响应里出现的多个 `ChatEvent::ToolCall` 构成一个有序 `RequestedToolBatch`；批次边界由终止事件 `Done { finish_reason: ToolCalls }` 唯一确定。
- 若响应流中出现任意 `ToolCall`，终止事件的 `finish_reason` 必须为 `ToolCalls`；否则视为 provider 协议错误，归一为 `PROVIDER_ERROR`。
- `TurnEngine` 必须先完整收集一个 `RequestedToolBatch`，再交给 `ToolDispatcher`；禁止边流式接收边交错执行 tool。

### 6.2 ToolHandler

```rust
pub struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub parameters_schema: Value,
    pub mutating: bool,
}

#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn descriptor(&self) -> &ToolDescriptor;
    async fn call(
        &self,
        input: ToolInput,
        cancel: CancellationToken,
    ) -> Result<ToolOutput, AgentError>;
}
```

`ToolOutput` 贯穿：

- Tool handler 返回值
- `ToolCallEnd.output`
- `AfterToolUse.output`
- `SessionLedger::ToolResult`

### 6.3 Plugin

```rust
#[async_trait]
pub trait Plugin: Send + Sync {
    fn descriptor(&self) -> &PluginDescriptor;
    async fn initialize(&mut self, config: Value) -> Result<(), AgentError>;
    fn apply(&self, registrar: &mut PluginRegistrar) -> Result<(), AgentError>;
    async fn shutdown(&mut self) -> Result<(), AgentError>;
}
```

`PluginRegistrar` 是 typed registrar，不是无类型字符串接口：

- `tap_session_start(handler)`
- `tap_session_end(handler)`
- `tap_turn_start(handler)`
- `tap_turn_end(handler)`
- `tap_before_tool_use(handler)`
- `tap_after_tool_use(handler)`
- `tap_before_compact(handler)`

只有 `tap_turn_start` 和 `tap_before_tool_use` 暴露 patch-capable 的 handler 签名；其余 hook 在类型层面只允许 `Continue` 或 `Abort`。

### 6.4 SessionStorage

```rust
pub struct SessionListQuery {
    pub cursor: Option<String>,
    pub limit: usize,
}

pub enum SessionSearchQuery {
    IdPrefix(String),
    TitleContains(String),
    IdPrefixOrTitle(String),
}

pub struct SessionPage {
    pub items: Vec<SessionSummary>,
    pub next_cursor: Option<String>,
}

#[async_trait]
pub trait SessionStorage: Send + Sync {
    async fn append_event(
        &self,
        session_id: &str,
        event: &LedgerEvent,
        summary: &SessionSummary,
    ) -> Result<(), AgentError>;

    async fn load_events(&self, session_id: &str) -> Result<Vec<LedgerEvent>, AgentError>;

    async fn list_sessions(
        &self,
        query: SessionListQuery,
    ) -> Result<SessionPage, AgentError>;

    async fn find_sessions(
        &self,
        query: SessionSearchQuery,
        limit: usize,
    ) -> Result<Vec<SessionSummary>, AgentError>;

    async fn delete_session(&self, session_id: &str) -> Result<(), AgentError>;
}
```

设计约束：

- `append_event()` 必须将 ledger event 和对应 `SessionSummary` 视为同一次持久化单元。
- `SessionSummary` 是查询加速面，不是恢复事实源。
- 删除仅允许针对非活跃 session。

### 6.5 MemoryStorage

`MemoryStorage` 既要有方法签名，也要有明确行为语义。

```rust
#[async_trait]
pub trait MemoryStorage: Send + Sync {
    async fn search(
        &self,
        namespace: &str,
        query: &str,
        top_k: usize,
    ) -> Result<Vec<Memory>, AgentError>;

    async fn list_recent(
        &self,
        namespace: &str,
        limit: usize,
    ) -> Result<Vec<Memory>, AgentError>;

    async fn list_all(&self, namespace: &str) -> Result<Vec<Memory>, AgentError>;

    async fn upsert(&self, memory: &Memory) -> Result<(), AgentError>;

    async fn delete(&self, namespace: &str, id: &str) -> Result<(), AgentError>;
}
```

行为约束：

- `search()`：按相关度降序返回 top-k。
- `list_recent()`：按 `updated_at desc` 返回。
- `list_all()`：返回 namespace 下的完整集合，顺序不重要。
- `upsert()`：若内容相同，只更新时间戳；若内容不同，更新内容并刷新 `updated_at`；`created_at` 保留首次写入值。
- `MemoryManager` 不再对 `list_recent()` 的结果二次重排，避免双重语义。

---

## 7. Hook 契约

### 7.1 HookPayload

所有 hook payload 都带 `plugin_config`，事件特化字段如下：

```rust
pub enum SessionTerminationMode {
    Close,
    Shutdown,
}

pub struct SessionStartPayload {
    pub session_id: String,
    pub model_id: String,
    pub plugin_config: Value,
}

pub struct SessionEndPayload {
    pub session_id: String,
    pub message_count: u64,
    pub termination_mode: SessionTerminationMode,
    pub plugin_config: Value,
}

pub struct TurnStartPayload {
    pub session_id: String,
    pub turn_id: String,
    pub user_input: UserInput,
    pub resolved_skills: Vec<String>,
    pub dynamic_sections: Vec<String>,
    pub plugin_config: Value,
}

pub struct TurnEndPayload {
    pub session_id: String,
    pub turn_id: String,
    pub assistant_output: Vec<ContentBlock>,
    pub tool_calls_count: usize,
    pub cancelled: bool,
    pub plugin_config: Value,
}

pub struct BeforeToolUsePayload {
    pub session_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub requested_arguments: Value,
    pub current_arguments: Value,
    pub plugin_config: Value,
}

pub struct AfterToolUsePayload {
    pub session_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub effective_arguments: Value,
    pub output: ToolOutput,
    pub duration_ms: u64,
    pub success: bool,
    pub plugin_config: Value,
}

pub struct BeforeCompactPayload {
    pub session_id: String,
    pub message_count: usize,
    pub history_estimated_tokens: usize,
    pub request_estimated_tokens: usize,
    pub plugin_config: Value,
}
```

约束：

- `TurnStartPayload.user_input` 保留调用方原始输入，不做隐式改写。
- `TurnStartPayload.resolved_skills` 暴露本轮显式命中的 skill 名，Plugin 不需要自行重解析 `/skill_name`。
- `BeforeToolUsePayload.current_arguments` 初始值等于 `requested_arguments`；多个 handler 按注册顺序串行修改它，最终产出 `ResolvedToolCall.effective_arguments`。
- `BeforeCompactPayload.request_estimated_tokens` 必须覆盖完整模型请求预算，而不仅是历史消息体积。
- `SessionStartPayload` 只会在第一条 `Metadata(session_profile)` 成功持久化之后触发。
- `SessionEndPayload.termination_mode` 让 Plugin 能区分“普通 close”与“shutdown 强制收尾”。

### 7.2 HookResult

```rust
pub struct TurnStartPatch {
    pub append_dynamic_sections: Vec<String>,
}

pub struct BeforeToolUsePatch {
    pub arguments: Value,
}

pub enum HookResult<Patch> {
    Continue,
    ContinueWith(Patch),
    Abort { reason: String },
}
```

约束：

- `TurnStart` 使用 `HookResult<TurnStartPatch>`。
- `BeforeToolUse` 使用 `HookResult<BeforeToolUsePatch>`。
- 其余 hook 不暴露 `ContinueWith`。
- 同一 hook 上多个 handler 按 Plugin 注册顺序执行；遇到 `Abort` 立即停止后续 handler。

### 7.3 Abort 处理矩阵

| Hook | Abort 生效点 | 结果 | 对外错误 |
|---|---|---|---|
| `SessionStart` | 第一条 `Metadata(session_profile)` 已入账、session 尚未激活时 | 始终回滚内存态 session 并释放 `Reserved`；若存在 `SessionStorage`，则额外调用 `delete_session(session_id)` 回滚持久化结果；删除失败则返回 `STORAGE_ERROR` | `PLUGIN_ABORTED` / `STORAGE_ERROR` |
| `TurnStart` | `UserMessage` 入账前 | 当前 turn 直接失败，不写 user message | `PLUGIN_ABORTED` |
| `TurnEnd` | assistant message 已入账后 | 不回滚消息；跳过 checkpoint；turn 以失败结束 | `PLUGIN_ABORTED` |
| `BeforeToolUse` | tool 调用前 | 不执行 tool，生成 synthetic error `ToolOutput` 并回注模型 | 无直接 `AgentError`，除非后续流程再失败 |
| `AfterToolUse` | 当前 tool 已完成后 | 不回滚结果；停止剩余 tool loop，并发起一次禁用 tools 的收尾请求 | 若收尾阶段无法完成则 `PLUGIN_ABORTED` |
| `BeforeCompact` | 摘要压缩开始前 | 直接跳过摘要尝试，进入 `TruncationFallback` | 仅当截断回退也无法完成时为 `COMPACT_ERROR` |
| `SessionEnd`（普通 `close_session`） | 关闭提交前 | 中止 close，session 保持 active | `PLUGIN_ABORTED` |
| `SessionEnd`（`shutdown` 路径） | 强制关闭前 | 仅记录 warning，不得阻断 shutdown；后续继续 close / plugin shutdown | 无 |

统一规则：

- `Abort.reason` 不作为独立 metadata 落盘。
- 只有 `BeforeToolUse` 的 abort reason 会被嵌入 synthetic `ToolOutput`，因为它本身需要回注模型。
- 运行中若已有 `RunningTurn.events`，`PLUGIN_ABORTED` 必须先发一条 `AgentEvent::Error`，再结束 turn。
- `shutdown()` 期间收到 `SessionEnd -> Abort` 时，`LifecycleState` 不得回滚到 `Running`。

---

## 8. 关键应用层设计

### 8.1 AgentBuilder

`AgentBuilder` 负责：

1. 收集 Provider/Tool/Skill/Plugin/Storage/Config。
2. 校验注册与配置。
3. 构建不可变 `AgentKernel` 与空 `AgentControl`。

构建顺序：

1. 按 `Configuration Contract` 校验 Provider/Tool/Skill/Plugin/Storage 唯一性、数值配置、模型引用合法性，以及 `SkillDefinition` 的全字段契约和依赖 Tool 完整性。
2. 构造 `ModelRegistry`、`ToolRegistry`、`SkillRegistry`、`PluginCatalog`。
3. 初始化 `HookRegistry`。
4. 按注册顺序执行 Plugin `initialize()`。
5. 为每个 Plugin 创建受限 `PluginRegistrar` 并执行 `apply()`。
6. 校验所有实际 tap 的 hooks 均已出现在 `PluginDescriptor.tapped_hooks` 中。
7. 生成 `AgentKernel` 与空 `AgentControl`。

说明：

- 未注册 `SessionStorage` 时，Agent 仅支持内存态单 session，不暴露 `SessionCatalog`。
- 未注册 `MemoryStorage` 时，`MemoryManager` 退化为空实现。

### 8.2 SessionService

`SessionService` 是所有 session 用例的统一编排者，负责：

- `new_session`
- `resume_session`
- `close_session`
- `record_event`
- `list_sessions`
- `find_sessions`
- `delete_session`

#### 新建会话流程

1. 在 `AgentControl` 上 claim `Reserved`。
2. 先以 `AgentConfig + SessionConfig + ModelRegistry` 解析 `SessionPinnedConfig`，再基于 `AgentConfig + SessionPinnedConfig` 解析 `SessionRuntimePolicy`，最终组装 `ResolvedSessionConfig`；失败则回滚 reservation。
3. 创建空 `SessionRuntime`，写入 `resolved_session_config`。
4. 将 `SessionPinnedConfig` 作为第一条 `Metadata(session_profile)` 写入账本，并同步写 `SessionSummary` 初始投影。
5. 触发 `SessionStart` hook。
6. 若 `SessionStart` 返回 `Abort`，则回滚内存态 session 并释放 `Reserved`；若存在 `SessionStorage`，则额外调用 `SessionStorage::delete_session(session_id)` 回滚已落盘的 session；删除成功则返回 `PLUGIN_ABORTED`，删除失败则返回 `STORAGE_ERROR`。
7. 若已注册 `MemoryStorage`，调用 `MemoryManager::load_bootstrap_memories()`；失败只记录 warn，以空 bootstrap 继续。
8. 提交 `Reserved -> Active`。

#### 恢复会话流程

1. claim `Reserved`。
2. 从 `SessionStorage` 读取完整账本。
3. 解析最新 `session_profile`、`memory_checkpoint`、`context_compaction`。
4. 以 `session_profile + 当前 AgentConfig` 重新解析 `SessionRuntimePolicy` 并组装 `ResolvedSessionConfig`；若 `session_profile.model_id` 或其派生策略引用的模型已不再存在，返回 `MODEL_NOT_SUPPORTED`。
5. 用共享恢复函数重建 `SessionLedger`、`ContextState`、`catalog_state`。
6. 若已注册 `MemoryStorage`，重新加载 `bootstrap_memories`；失败只记录 warn。
7. 提交 `Reserved -> Active`。

说明：

- `resume_session()` 只在存在 `SessionStorage` 时可用。
- 恢复不会再次触发 `SessionStart`。
- `SessionStart` hook 只会观察到已经完成首条 durable 账本写入的 session，不会出现 false start。
- `SessionPinnedConfig` 在整个会话生命周期内保持稳定；resume 时只允许重算 `SessionRuntimePolicy`，不得重新解释 `default_model` 或 `memory_namespace`。

### 8.3 SkillResolver

`SkillResolver` 负责把显式 `/skill_name` 从“语法触发”转换为“turn 级增强”：

```rust
pub struct ResolvedTurnInput {
    pub input: UserInput,
    pub skill_injections: Vec<ResolvedSkillInjection>,
}
```

规则：

1. 只解析显式 `/skill_name`，绝不做隐式激活。
2. 只从顶层 `Text` 块识别 skill 触发语法；`FileContent.text` 与图片内容都不参与 skill 解析。
3. 输出顺序按用户输入中的首次出现顺序，重复 skill 按首次出现去重。
4. `SkillResolver` 不改写调用方原始输入；账本中的 `UserMessage` 与调用方提交内容保持一致。
5. `SkillResolver` 只产出 turn 级增强和显式 skill 名列表，不负责输入校验和持久化；`ResolvedSkillInjection.rendered_xml` 必须直接来自对应 `SkillDefinition.prompt` 的 `<skill>` 封装。
6. `SkillResolver` 本身不写账本；由 `TurnEngine` 负责把命中的 skill 名写入 `Metadata(skill_invocations)` 供审计。

### 8.4 PromptBuilder 与 ChatRequestBuilder

这是本版最重要的职责拆分。

#### PromptBuilder

`PromptBuilder` 只渲染文本段，不触碰 API `tools` 通道。它负责：

1. `system_instructions`
2. `ResolvedSessionConfig.pinned.system_prompt_override`
3. `personality`
4. `Skill List`
5. `Active Plugin Info`
6. `Memories`
7. `Environment Context`
8. `Dynamic Sections`

输出：

```rust
pub struct RenderedPrompt {
    pub system_prompt: String,
}
```

渲染规则：

- `system_instructions` 在渲染前按序过滤空白项；过滤后若为空，则不输出空的 `<system_instructions>` section。
- `Skill List` 必须复用 Appendix `B.4` 的固定格式，且只包含 `allow_implicit_invocation = true` 的 Skill；若过滤后为空则整个 section 不渲染。
- `Active Plugin Info` 必须复用 Appendix `B.5` 的固定格式；无 Plugin 时不渲染空 section。
- `Memories` 必须复用 Appendix `B.6` 的固定格式；只有在已注册 `MemoryStorage` 且最终合并结果非空时才渲染，禁止注入空 `Memory` 段。
- `Dynamic Sections` 只接受 `TurnStartPatch.append_dynamic_sections` 追加的文本，不得被其他组件复写。

#### ChatRequestBuilder

`ChatRequestBuilder` 负责把 `RenderedPrompt`、`RequestContext`、`ToolDescriptor`、`RequestBuildOptions` 和 `ResolvedSessionConfig` 组装成正式 `ChatRequest`。

```rust
pub struct RequestBuildOptions {
    pub allow_tools: bool,
}
```

职责：

1. 把 prompt 文本放入 `ChatRequest.system_prompt`。
2. 按 `pre_anchor_messages -> anchor_message -> post_anchor_augmentations -> post_anchor_messages` 的固定顺序序列化 `ChatRequest.messages`。
3. 把 `Text` 与 `FileContent` 都映射到文本消息通道；把 `Image` 映射到图片通道。
4. 根据 `RequestBuildOptions.allow_tools` 解析本次 request 的 `tools` 列表：允许时暴露全部已注册 Tool，否则发送空列表。
5. `temperature`、`max_tokens`、`reasoning_effort` 在 v1 固定显式传 `None`，不在本版公共配置中暴露。
6. 在 provider 请求发出前做能力预检。

能力预检规则：

- 本轮消息含 `Image`，而目标模型无 `Vision`：返回 `MODEL_NOT_SUPPORTED`。
- `RequestBuildOptions.allow_tools = false` 时，本次请求固定发送 `tools = []`。
- `RequestBuildOptions.allow_tools = true` 且存在已注册 Tool，而目标模型无 `ToolUse`：在 provider 请求前直接返回 `MODEL_NOT_SUPPORTED`。
- `ResolvedSessionConfig` 中的模型引用在 session 创建 / 恢复时已校验完毕，`ChatRequestBuilder` 不再重复解释默认值。

因此，`Tool Definitions` 在 `0005` 第 5.3 节中仍然是“组装顺序中的第 4 项”，但其归属明确落在 `ChatRequestBuilder.tools`，不是 prompt 文本。

#### Request / Tool Execution Invariants

以下约束是 `TurnEngine + ChatRequestBuilder + ToolDispatcher` 的共享协议：

1. 一个 provider 响应内的全部 `ChatEvent::ToolCall` 必须先聚合成一个 `RequestedToolBatch`，直到收到 `Done { finish_reason: ToolCalls }`。
2. `BeforeToolUse` patch 必须在 `ToolCallStart` 发射、`SessionLedger::ToolCall` 持久化和 `ToolHandler::call()` 执行之前完成。
3. `ToolCallStart.arguments`、`SessionLedger::ToolCall.call.effective_arguments` 和真实执行参数必须完全一致。
4. `requested_arguments` 只作为审计字段保留，不得参与 replay 时的二次推断。
5. 同一批次的 tool 结果回注给模型时必须保持模型原始顺序；并发只改变执行时机，不改变提交顺序。

### 8.5 TurnEngine

`TurnEngine` 是唯一的 turn 编排核心。单轮执行顺序：

1. 校验 `UserInput`。
2. 获取 turn 互斥，创建带 fresh `TurnController` 的 `RunningTurn`，事件序号从 `1` 开始。
3. 调用 `SkillResolver`，得到 `ResolvedTurnInput`。
4. 触发 `TurnStart` hook，收集 `dynamic_sections`。
5. 通过 `SessionService::record_event()` 写入原始 `UserMessage`，拿到 `origin_user_seq`。
6. 若本轮命中显式 skill，写入 `Metadata(skill_invocations)`。
7. 生成 `TurnAugmentation { origin_user_seq, skill_injections }`。
8. 由 `MemoryManager` 基于原始 `UserInput` 生成本轮 memory view。
9. 由 `PromptBuilder` 渲染 `RenderedPrompt`。
10. 由 `ContextManager` 基于目标 `ModelInfo.context_window` 计算完整 request 级 token 估算值（`visible history + RenderedPrompt.system_prompt + TurnAugmentation`），判断是否需要 compact，并在有活跃 turn 时 pin 当前 turn 区间后构建 `RequestContext`。
11. 由 `ChatRequestBuilder` 使用 `RequestBuildOptions { allow_tools: true }` 组装正式 `ChatRequest` 并执行能力预检。
12. 路由到目标 `ModelProvider`，消费流式 `ChatEvent`。
13. 转发 `TextDelta` / `ReasoningDelta` 为 `AgentEvent`。
14. 若收到 `Done { finish_reason: ToolCalls }`，把当前 provider 响应里缓存的全部 `ToolCall` 作为一个 `RequestedToolBatch` 交给 `ToolDispatcher`。
15. `ToolDispatcher` 先解析 `RequestedToolCall -> ResolvedToolCall`，再按稳定顺序记账 `ToolCallRecord` / `ToolResultRecord`；若需要继续请求模型，复用同一份 `TurnAugmentation` 重新构建 `RequestContext`。
16. 无更多 ToolCall 时，提交最终 `AssistantMessage`。
17. 触发 `TurnEnd` hook。
18. 到达 checkpoint 条件时，触发 `MemoryManager::run_checkpoint_extraction()`。
19. 写入 `TurnOutcome`，释放 turn 锁。

补充规则：

- `UserInput` 在任何状态修改前校验：内容不能为空；图片不得超过 20MB；仅支持 PNG/JPEG/GIF/WebP；文件内容必须由调用方以文本形式传入。
- 达到 `ResolvedSessionConfig.runtime_policy.max_tool_calls_per_turn` 后，写入 `<turn_aborted>` system message，并发起一次 `RequestBuildOptions { allow_tools: false }` 的最终收尾请求；若仍无法收敛则返回 `MAX_TOOL_CALLS_EXCEEDED`。
- provider 返回 `ContextLengthExceeded` 时，只允许触发一次兜底 compact 并重建请求；第二次仍失败则返回 `COMPACT_ERROR`。
- `TurnAugmentation` 只在当前 turn 内存活；turn 结束后必须被释放，不进入下一轮基础上下文。

### 8.6 ToolDispatcher

执行策略：

- 批次全部 `mutating=false`：并发执行。
- 只要存在一个 `mutating=true`：整批串行。

执行细节：

1. 输入必须是一个完整 `RequestedToolBatch`，且顺序与 provider 原始输出一致。
2. 先按顺序执行 `BeforeToolUse`，把每个 `RequestedToolCall` 解析成 `ResolvedToolCall`；`current_arguments` 初始等于 `requested_arguments`。
3. `BeforeToolUse` hook `Abort` 时，不执行真实 tool，但仍要产出带同一 `call_id` 的 synthetic error `ToolOutput`。
4. 每个 `ResolvedToolCall` 在真正进入执行或生成 synthetic 结果之前，都必须先发送 `ToolCallStart`，并记账 `SessionEventPayload::ToolCall { call: ToolCallRecord { requested_arguments, effective_arguments } }`。
5. 全只读批次可以在统一启动并发执行前按模型顺序发出全部 `ToolCallStart`；含 `mutating` 的批次必须严格保持“单个 call 的 `ToolCallStart -> execute -> ToolCallEnd`”串行顺序。
6. 在每个 call 真正进入执行前，`ToolDispatcher` 都必须再次检查 turn cancel token；若此时取消已生效，则不执行真实 handler，而是为该 call 生成固定 synthetic cancelled `ToolOutput`：`content = "[tool skipped: cancelled before execution]"`，`is_error = true`，`metadata = {"synthetic": true, "skipped": true, "reason": "cancelled_before_execution"}`。
7. 对未被 `BeforeToolUse` 中止、也未命中“cancelled before execution”的 call，应用 `ResolvedSessionConfig.runtime_policy.tool_timeout_ms`，然后执行 `ToolHandler::call()`。
8. 对含 `mutating` 的串行批次，一旦取消在某个已启动 call 之后生效，后续尚未开始的 calls 都必须按模型原始顺序生成同一类 synthetic cancelled `ToolOutput`，不得静默丢弃。
9. 对全只读并发批次，取消只影响尚未真正 dispatch 到 handler 的 calls；已经 in-flight 的 calls 允许自然完成，尚未 dispatch 的 calls 使用同一类 synthetic cancelled `ToolOutput`。
10. tool 输出统一走 `truncate_tool_output(output)`：`content` 的 UTF-8 字节预算上限为 `1_048_576`，若超限则裁剪正文并在末尾追加固定提示 `[tool output truncated: original content exceeded 1MB]`；该提示计入 1MB 预算，`metadata` 保持原样不变。
11. 真实输出、`BeforeToolUse` synthetic error 输出和 cancelled synthetic 输出，都在“提交阶段”按模型原始顺序依次触发 `AfterToolUse`、记账 `ToolResultRecord`、发送 `ToolCallEnd`。
12. `AfterToolUse` abort 不回滚已完成结果；若当前批次是只读并发批次，已 in-flight 的 tool 允许继续完成，但整个批次提交完成后必须停止后续 tool loop，并发起一次 `allow_tools = false` 的收尾请求。

`ToolDispatcher` 返回值必须保留批次原始顺序，不允许把并发完成顺序泄漏到账本或回放协议。

### 8.7 ContextManager

`ContextManager` 只管理模型可见上下文和 `RequestContext` 组装，不修改事实账本。

#### Compact 触发

双触发机制保持不变：

1. 预估触发：`request_estimated_tokens >= model.context_window * ResolvedSessionConfig.runtime_policy.compact_threshold`
2. provider 兜底触发：收到 `ContextLengthExceeded`

其中：

- `history_estimated_tokens` 只统计 `ContextState.visible_messages`。
- `request_estimated_tokens` 必须统计“本次真正要发给 provider 的完整请求体”，至少包括：`visible_messages`、`RenderedPrompt.system_prompt`、当前 turn 的 skill augmentation。
- `RenderedPrompt` 已经包含 `system_instructions`、`system_prompt_override`、`personality`、Skill List、Plugin List、Memories、Environment Context、Dynamic Sections，因此这些段都天然计入 request 预算。

#### Compact 协议

1. 触发 `BeforeCompact`。
2. 选择 `ResolvedSessionConfig.runtime_policy.compact_model_id`。
3. 尝试生成摘要；成功则得到 `CompactionMode::Summary`。
4. 若摘要模型不可用、请求失败、hook abort，进入 `CompactionMode::TruncationFallback`。
5. 记账 `Metadata(context_compaction)`。
6. 用共享 `rebuild_visible_messages()` 函数重建上下文。
7. 发送 `ContextCompacted { mode, replaces_through_seq }`。

`BeforeCompactPayload` 的两个估算字段由同一次请求构建计算得出：

- `history_estimated_tokens = ContextState.history_estimated_tokens`
- `request_estimated_tokens = history_estimated_tokens + prompt_tokens + augmentation_tokens`

#### Current turn preservation

- 当 compact 发生在活跃 turn 内，`ContextManager` 必须接收 `origin_user_seq` 作为 pinned anchor。
- `Summary` 与 `TruncationFallback` 都只允许替换或丢弃 `source_seq < origin_user_seq` 的历史；当前 turn 的 `UserMessage`、其后的 synthetic skill 注入位置，以及同 turn 的 `ToolCall` / `ToolResult` / `AssistantMessage` 都不得被 compact 掉。
- 若仅保留 pinned 区间仍然超出目标 budget，说明问题已不在“历史过长”而在“当前 turn 自身过大”，此时直接返回 `COMPACT_ERROR`，不得静默丢弃锚点。

#### 截断回退算法

- 仅按消息边界裁剪，不拆分单条消息。
- 无活跃 turn 时，保留“最近 N 条可见消息”的后缀；其中 `N` 由当前 budget 动态算出，即保留能够装入目标 token budget 的最长后缀。
- 有活跃 turn 时，只能在 `origin_user_seq` 之前裁剪，并保证 `replaces_through_seq < origin_user_seq`。
- `replaces_through_seq` 表示被丢弃的最后一条消息序号。
- 不写入固定失败摘要文本。

#### RequestContext 组装函数

```rust
fn build_request_context(
    context: &ContextState,
    augmentation: &TurnAugmentation,
) -> Result<RequestContext, AgentError>
```

规则：

1. 在 `visible_messages` 中查找 `source_seq == Some(origin_user_seq)` 的锚点消息；该消息必须是当前 turn 的 `UserMessage`。
2. `pre_anchor_messages` 收集锚点之前的可见消息。
3. `post_anchor_augmentations` 由 `skill_injections` 渲染成 synthetic `SystemMessage`，顺序与触发顺序一致。
4. `post_anchor_messages` 收集锚点之后的可见消息，包括同 turn 的 `AssistantMessage`、`ToolCall`、`ToolResult`。
5. 若 compact 后找不到锚点消息，说明当前 turn preservation 协议被破坏，直接返回 `COMPACT_ERROR`。

#### 统一恢复函数

```rust
fn rebuild_visible_messages(
    ledger: &SessionLedger,
    compaction: Option<&CompactionRecord>,
) -> Vec<VisibleMessage>
```

规则：

1. 无 compact 时，按账本顺序投影全部普通消息，并保留 `source_seq = Some(seq)`。
2. `Summary` 模式：先插入 `VisibleMessage { source_seq: None, message: Message::System { content: render_compaction_summary(summary_body) } }`，再重放 `seq > replaces_through_seq` 的普通消息。
3. `TruncationFallback` 模式：直接重放 `seq > replaces_through_seq` 的普通消息。
4. 每遇到一条 `AssistantMessage.status == incomplete`，都必须紧跟追加 `VisibleMessage { source_seq: None, message: Message::System { content: "[此消息因用户取消而中断]".into() } }`。

实时路径、provider 重试路径与恢复路径都必须调用这两组共享函数，不允许分叉实现。

### 8.8 MemoryManager

`MemoryManager` 使用严格的 v1 单阶段协议。

#### 读路径

1. `load_bootstrap_memories()`：
   - 调用 `list_recent(ResolvedSessionConfig.pinned.memory_namespace, ResolvedSessionConfig.runtime_policy.memory_max_items)`
   - 成功时写入 `runtime.memory_state.bootstrap_memories`
   - 失败时 warn 并置空

2. `prepare_turn_memories(user_input, runtime.memory_state)`：
   - 只有输入包含显式 `Text` 块时，才提取文本 query（忽略显式 `/skill_name` 触发词）并调用 `search(ResolvedSessionConfig.pinned.memory_namespace, query, top_k)`
   - 纯图片输入和纯 `FileContent` 输入都跳过 `search()`
   - 查询失败时 warn 并将 `last_turn_memories` 置空
   - 与 `bootstrap_memories` 按 `id` 去重，裁剪到 `ResolvedSessionConfig.runtime_policy.memory_max_items`

#### 写路径

`run_checkpoint_extraction()` 与 `run_close_extraction()` 共享协议：

1. 取账本窗口：`(last_memory_checkpoint_seq, current_ledger_seq]`
2. 调用 `list_all(ResolvedSessionConfig.pinned.memory_namespace)` 读取已有记忆全集
3. 使用 `ResolvedSessionConfig.runtime_policy.memory_model_id` + Appendix B.10 + B.11，把“账本窗口 + 已有记忆”一起发给记忆模型
4. 解析为 `Vec<MemoryMutation>`
5. 对 `Create` / `Update` 调用 `upsert()`，对 `Delete` 调用 `delete()`，`Skip` 不落存储
6. 成功后更新 `runtime.last_memory_checkpoint_seq`
7. 写入 `Metadata(memory_checkpoint)`

关键约束：

- v1 的整合判断由模型完成，存储 adapter 不能自定义去重语义。
- checkpoint 边界只使用 ledger seq，不使用消息数组下标。
- close 提取失败只记录日志和事件，不阻断关闭。

### 8.9 PluginManager

`PluginManager` 负责：

- build 阶段初始化 plugin
- 维护 typed hook registry
- 在 shutdown 时按逆序调用 `Plugin::shutdown()`

额外约束：

- `descriptor.tapped_hooks` 与实际注册结果必须一致。
- plugin 不得绕过 registrar 直接持有 hook registry。

---

## 9. 持久化、恢复与查询协议

### 9.1 账本写入规则

所有改变后续上下文的事实，都必须先写账本，再更新内存投影。

写入流程：

1. 基于当前 `catalog_state` 与待写事件计算下一版 `SessionSummary`
2. 分配下一个 `seq`
3. 构造 `LedgerEvent`
4. 若存在 `SessionStorage`，调用 `append_event(session_id, event, summary)`
5. 持久化成功后 append 到内存账本
6. 更新 `catalog_state`
7. 用共享投影函数更新 `ContextState`
8. 若当前存在 `TurnAugmentation`，仅重建 `RequestContext`，不把增强写回账本

这样可以保证：

- 不会出现“事件写入成功但列表页未更新”
- 恢复始终只依赖账本
- 查询投影的业务语义由核心定义
- 显式 Skill 只留下 `Metadata(skill_invocations)` 审计记录，不会在 replay 时被误当作普通 system message

### 9.2 恢复算法

恢复只依赖账本：

1. `load_events(session_id)`
2. 读取最新 `session_profile`
3. 读取最新 `memory_checkpoint`
4. 读取最新 `context_compaction`
5. 以 `session_profile + 当前 AgentConfig` 重建 `ResolvedSessionConfig`
6. 重建 `SessionLedger`
7. 调用 `rebuild_visible_messages()` 重建 `ContextState`
8. 重建 `catalog_state`
9. 初始化 `memory_state.bootstrap_memories`
10. 激活 `SessionRuntime`

恢复约束：

- `skill_invocations` metadata 只用于审计，不参与 `RequestContext` 重建。
- `session_profile` 是恢复的唯一会话稳定事实源；不得用当前 `default_model` 或 `memory_namespace` 覆写它。
- `TurnAugmentation` 是活跃 turn 的易失态；`resume_session()` 不恢复未完成 turn，也不会重放旧 skill 注入。

### 9.3 SessionCatalog 查询面

```rust
pub trait SessionCatalog {
    async fn list(&self, query: SessionListQuery) -> Result<SessionPage, AgentError>;
    async fn find(
        &self,
        query: SessionSearchQuery,
        limit: usize,
    ) -> Result<Vec<SessionSummary>, AgentError>;
    async fn resume(&self, session_id: &str) -> Result<SessionHandle, AgentError>;
    async fn delete(&self, session_id: &str) -> Result<(), AgentError>;
}
```

说明：

- `SessionCatalog` 只在注册了 `SessionStorage` 时暴露。
- `delete()` 必须先检查目标 session 不是当前活跃 session。

### 9.4 为什么 v1 仍然不用 Session Snapshot

- `0005` 没有性能强制要求。
- 单会话模型下，账本重放足够简单。
- snapshot 会引入版本兼容、增量合并、一致性校验的新复杂度。

如未来需要优化，可由 `SessionStorage` adapter 在内部实现快照，但对外 trait 保持不变。

---

## 10. 对外 API 草案

```rust
let agent = AgentBuilder::new(config)
    .register_model_provider(provider)
    .register_tool(tool)
    .register_skill(skill)
    .register_plugin(plugin, plugin_config)
    .register_session_storage(session_storage)
    .register_memory_storage(memory_storage)
    .build()?;

if let Some(catalog) = agent.session_catalog() {
    let page = catalog
        .list(SessionListQuery { cursor: None, limit: 20 })
        .await?;

    let hits = catalog
        .find(SessionSearchQuery::IdPrefixOrTitle("checkout".into()), 10)
        .await?;
}

let session = agent.new_session(SessionConfig::default()).await?;
let mut turn = session.send_message(user_input).await?;
let controller = turn.controller();

while let Some(event) = turn.events.next().await {
    // TextDelta / ToolCallStart / ToolCallEnd / ContextCompacted / ...
}

// controller.cancel();

match turn.join().await? {
    TurnOutcome::Completed => {}
    TurnOutcome::Cancelled => {}
    TurnOutcome::Failed(err) => {}
    TurnOutcome::Panicked => {}
}
```

约束：

- `new_session()`、`resume()`、`shutdown()` 都经过同一个 `AgentControl` 状态机。
- `send_message()` 在 session 内再次做 turn 级互斥，命中则返回 `TURN_BUSY`。
- `RunningTurn::controller()` 返回 cloneable `TurnController`；`RunningTurn::cancel()` 是它的便捷封装。
- `cancel()` 幂等，调用后仍允许继续消费 `events` 并等待 `join()`。
- `delete()` 不允许删除当前活跃 session。

### 10.1 AgentEvent

对外事件流使用统一信封：

```rust
pub struct AgentEventEnvelope<T> {
    pub session_id: String,
    pub turn_id: String,
    pub timestamp: DateTime<Utc>,
    pub sequence: u64,
    pub payload: T,
}
```

事件类型：

- `TextDelta`
- `ReasoningDelta`
- `ToolCallStart`
- `ToolCallEnd`
- `ContextCompacted { mode, replaces_through_seq }`
- `TurnComplete`
- `TurnCancelled`
- `Error`

顺序保证：

- `sequence` 的作用域限定为单个 `RunningTurn.events` 流，并从 `1` 开始。
- `ToolCallStart` 的 `arguments` 必须等于对应 `ResolvedToolCall.effective_arguments`。
- `ToolCallStart` 一定先于对应 `ToolCallEnd`。
- `TurnComplete` 或 `TurnCancelled` 是该 turn 的最后一个非错误事件。
- `ContextCompacted.mode` 必须与 `CompactionRecord.mode` 一致。

### 10.2 多模态支持

`ContentBlock` 支持三类内容：

- 文本
- 图片
- 文件内容

约束：

- 图片由调用方以内容数据传入，Agent 不直接读取文件系统。
- 单张图片最大 20MB。
- 支持 PNG/JPEG/GIF/WebP。
- `FileContent` 必须是调用方已经读取好的文本内容，不是路径或二进制附件。
- 单条消息可包含多个内容块。
- `ChatRequestBuilder` 负责把这些内容块转换为 `ModelMessage`；只有 `Image` 会触发 `Vision` 预检。
- `FileContent` 与普通文本一样参与 title 生成和上下文压缩；但 v1 memory search 只从显式 `Text` 块提取 query，Skill 解析也只看顶层 `Text` 块。

---

## 11. 并发、取消与错误处理

### 11.1 并发边界

- Agent：`Send + Sync`
- 同一时刻最多一个 `Active` session
- 同一 session 同一时刻最多一个 `Running` turn
- Tool 批次仅在“全只读”时并发
- `SessionCatalog::list/find` 可与活跃 session 并发；`delete` 必须先检查目标不是当前活跃 session

### 11.2 取消语义

取消链路：

`session_cancel_token -> turn_cancel_token(TurnController) -> provider request`

行为约定：

1. `TurnController` 是 `CancellationToken` 的稳定 API 包装；调用方不需要感知内部任务结构。
2. provider 收到取消后立即停止流式输出。
3. 正在执行的 tool 不强杀，只等待完成。
4. 未开始的 tool 不执行真实 handler；而是沿用正常的 `ToolCall -> synthetic cancelled ToolResult -> ToolCallEnd` 协议，并通过固定 `ToolOutput.content = "[tool skipped: cancelled before execution]"` 回注模型，作为唯一正式的取消提示。
5. 已收到的 assistant 文本保存为 `status=incomplete`。
6. 若取消在终态落定前生效，则最终 `TurnOutcome` 为 `Cancelled`，最后一个 `AgentEvent` 为 `TurnCancelled`。
7. 若 turn 已自然完成，再调用 `cancel()` 不会改写已确定的 outcome。

### 11.3 关闭语义

普通 `close_session()` 顺序：

1. 若存在 running turn，请求取消并等待收尾
2. 触发 `SessionEnd { termination_mode: Close }`
3. 若 `SessionEnd` 返回 `Abort`，close 失败并保持 session active
4. 执行 `MemoryManager::run_close_extraction()`
5. 释放 session 槽

`shutdown()` 顺序：

1. 原子切换 `Running -> ShuttingDown`
2. 若存在活跃 session，请求当前 turn 取消并等待收尾
3. 触发 `SessionEnd { termination_mode: Shutdown }`
4. 执行 `MemoryManager::run_close_extraction()`
5. 释放 session 槽
6. 按逆序执行 Plugin `shutdown()`
7. 切换 `ShuttingDown -> Shutdown`

关闭约束：

- 只有普通 `close_session()` 会把 `SessionEnd -> Abort` 暴露给调用方并保持 session active。
- `shutdown()` 遇到 `SessionEnd -> Abort` 时，只记录 warning 和诊断信息，不得回滚 `LifecycleState`，也不得跳过后续 resource release。
- `MemoryManager::run_close_extraction()` 失败仍然不阻断 `close_session()` 或 `shutdown()`。

### 11.4 错误模型

统一结构：

```rust
pub struct AgentError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub source: ErrorSource,
}
```

#### 构建阶段错误码

| code | 抛出组件 | 触发条件 | retryable |
|---|---|---|---|
| `NO_MODEL_PROVIDER` | `AgentBuilder` | 未注册任何 `ModelProvider` | 否 |
| `NAME_CONFLICT` | `AgentBuilder` | Provider/Tool/Skill/Plugin 名称冲突 | 否 |
| `INVALID_CONFIG` | `AgentBuilder` | 配置值非法，如空 `memory_namespace`、非正超时、非法 threshold | 否 |
| `SKILL_DEPENDENCY_NOT_MET` | `AgentBuilder` | Skill 依赖的 Tool 未注册 | 否 |
| `PLUGIN_INIT_FAILED` | `PluginManager` | Plugin `initialize()` 或 `apply()` 失败 | 否 |
| `STORAGE_DUPLICATE` | `AgentBuilder` | `SessionStorage` 或 `MemoryStorage` 重复注册 | 否 |
| `INVALID_DEFAULT_MODEL` | `AgentBuilder` | `default_model` 未命中任何 `ModelInfo` | 否 |

#### 运行阶段错误码

| code | 抛出组件 | 触发条件 | retryable | `AgentEvent::Error` |
|---|---|---|---|---|
| `SESSION_BUSY` | `SessionService` | 已有 active session | 否 | 否 |
| `TURN_BUSY` | `TurnEngine` | 同一 session 已有 running turn | 否 | 否 |
| `INPUT_VALIDATION` | `TurnEngine` | 空输入、图片超限、格式不支持等 | 否 | 否 |
| `MODEL_NOT_SUPPORTED` | `SessionService` / `TurnEngine` | 会话引用模型不存在，或请求需要目标模型不具备的必需能力（如 `Vision`，或 `allow_tools=true` 时缺少 `ToolUse`） | 否 | 若 turn 已创建则是 |
| `PROVIDER_ERROR` | `TurnEngine` | provider transport/provider error | 是 | 是 |
| `TOOL_EXECUTION_ERROR` | `ToolDispatcher` | tool handler 返回失败 | 视具体实现 | 是 |
| `TOOL_TIMEOUT` | `ToolDispatcher` | tool 超时 | 是 | 是 |
| `TOOL_NOT_FOUND` | `ToolDispatcher` | provider 请求了未注册 tool | 否 | 是 |
| `SKILL_NOT_FOUND` | `SkillResolver` | 显式 `/skill_name` 未命中 | 否 | 否 |
| `SESSION_NOT_FOUND` | `SessionService` | resume/delete 目标不存在 | 否 | 否 |
| `STORAGE_ERROR` | `SessionService` / `MemoryManager` | SessionStorage/MemoryStorage 读写失败 | 视 adapter | 若 turn 已运行则是 |
| `MAX_TOOL_CALLS_EXCEEDED` | `TurnEngine` | 单轮 tool 调用次数超上限且收尾失败 | 否 | 是 |
| `COMPACT_ERROR` | `ContextManager` | compact 一次重试后仍无法收敛，或 compact 后找不到当前 turn 锚点 | 视 provider | 是 |
| `REQUEST_CANCELLED` | `TurnEngine` | 用户取消请求 | 否 | 否，改发 `TurnCancelled` |
| `PLUGIN_ABORTED` | `PluginManager` / `TurnEngine` / `SessionService` | hook `Abort` 直接中止当前操作 | 否 | 若存在事件流则先发 |
| `INTERNAL_PANIC` | `TurnEngine` | 后台 task panic | 否 | 是 |
| `AGENT_SHUTDOWN` | `Agent` | `shutdown()` 后的任何新操作 | 否 | 否 |

映射规则：

- `ProviderErrorKind::ContextLengthExceeded` 不直接暴露，先触发 compact 重试；仅二次失败时归一为 `COMPACT_ERROR`。
- `ProviderErrorKind::UnsupportedCapability` 归一为 `MODEL_NOT_SUPPORTED`；理论上 `Vision` 和 `ToolUse` 都应在 provider 请求前被能力预检拦截，provider 侧同类错误视为 guard 漏网。
- `FileContent` 走文本通道，不得因为缺少 `Vision` 被映射成 `MODEL_NOT_SUPPORTED`。
- `BeforeToolUse` abort 不生成 `PLUGIN_ABORTED`，而是生成 synthetic tool error 回注模型。

---

## 12. 验收重点

进入实现前，至少覆盖以下场景：

1. `shutdown()` 与 `new_session()` 并发时，shutdown 后不会成功 claim 新 session。
2. `append_event()` 失败时，不会只更新内存账本而漏掉持久化。
3. `SessionCatalog::list/find/delete/resume` 在有无活跃 session 时语义正确。
4. `Summary` compact 后立即 resume，恢复出的可见消息与实时路径一致。
5. `TruncationFallback` compact 后立即 resume，恢复出的可见消息与实时路径一致。
6. 显式 Skill 命中后，账本里保留原始 `UserMessage`，同时存在 `Metadata(skill_invocations)` 审计记录。
7. `allow_implicit_invocation=false` 的 Skill 不进入 `Skill List`；缺失依赖 Tool 的 Skill 在 build 阶段直接失败。
8. 同一 turn 内若经历 tool loop 和 compact，`build_request_context()` 仍会把同一份 skill augmentation 插在当前用户消息之后。
9. turn 结束后立即 resume，不会错误重放旧 skill augmentation；仅账本事实和审计 metadata 被恢复。
10. `SessionPinnedConfig` 在 resume 后保持稳定：即使当前 `AgentConfig.default_model` 或 `memory_namespace` 已变更，恢复出来的 `model_id` 与 `memory_namespace` 仍与建会话时一致。
11. `ContextCompacted` 事件包含正确 `mode`。
12. `ToolOutput.metadata` 能贯通 Tool handler、Hook payload、账本和 `ToolCallEnd`。
13. tool 输出超过 1MB 时，`content` 会以固定提示 `[tool output truncated: original content exceeded 1MB]` 结尾，且提示本身计入 1MB 预算。
14. `PromptBuilder` 不拼接 tool schema 文本；`ChatRequestBuilder.tools` 才是 tool definitions 的唯一出口。
15. 文本型 `FileContent` 在非 `Vision` 模型下可正常发起请求；`Image` + 非 `Vision` 模型会在 provider 请求前返回 `MODEL_NOT_SUPPORTED`。
16. `TurnController::cancel()` 幂等；取消后继续 `join()` 的返回契约与文档一致。
17. `AgentEvent.sequence` 仅在单个 `RunningTurn` 内单调递增；新 turn 从 `1` 重新开始。
18. `SessionStart`、`TurnStart`、`SessionEnd`、`BeforeToolUse`、`BeforeCompact` 的 abort 语义都符合矩阵，且 `shutdown()` 不会被 `SessionEnd` veto。
19. `MemoryStorage::list_recent()` 的返回顺序会直接影响 bootstrap 注入，核心层不会再二次改写。
20. checkpoint / close 都严格按 `list_all -> mutation -> upsert/delete -> memory_checkpoint` 执行。
21. provider 只有在收到 `Done { finish_reason: ToolCalls }` 后，当前响应中的 `ToolCall` 才会被视作一个完整批次并进入 `ToolDispatcher`。
22. `BeforeToolUse` 改参后，`ToolCallStart`、`SessionLedger::ToolCall.call.effective_arguments` 和真实执行参数严格一致；`requested_arguments` 仅作审计。
23. 全只读并发批次中若某个 `AfterToolUse` abort，已 in-flight tool 会自然完成，但不会再开启下一轮带 tools 的模型请求。
24. 有已注册 Tool 且 `allow_tools=true` 时，不支持 `ToolUse` 的模型会在 provider 请求前返回 `MODEL_NOT_SUPPORTED`；`allow_tools=false` 的内部收尾请求仍可继续纯对话。
25. 同一 session 出现多条 `status=incomplete` 的 assistant message 后再 resume，每条消息后都能恢复出对应的取消提示。
26. 长 tool loop 期间触发 compact 时，当前 turn 的锚点 user message 及其后续消息不会被截断；若 pinned 区间本身超窗，则返回 `COMPACT_ERROR`。
27. `RenderedPrompt` 很大而历史消息很短时，compact 仍会基于 `request_estimated_tokens` 在 provider 报 `ContextLengthExceeded` 之前触发。
28. 用户上传包含 `/commit` 等字样的 `FileContent` 时，不会触发 Skill；只有顶层 `Text` 块中的显式 `/skill_name` 会命中 `SkillResolver`。
29. mutating 串行批次在中途取消后，后续未开始 calls 会按原始顺序产生 synthetic cancelled `ToolResult`，并保持稳定的 `ToolCallStart -> ToolCallEnd` / 账本顺序。
30. `SessionStart` 只会在第一条 `Metadata(session_profile)` durable write 成功后触发；若注册了 `SessionStorage` 且 hook abort 后 `delete_session()` 失败，则建会话流程返回 `STORAGE_ERROR`。

---

## 13. 非目标

当前版本明确不做：

- 多 session 并行
- 动态注册/卸载 Provider、Tool、Skill、Plugin
- 自动隐式激活 Skill
- 两阶段记忆整合
- 跨版本 session snapshot 协议
- 内建文件系统、数据库或网络 adapter

---

## 14. 结论

这版设计把 `0007` 中成立的问题收敛成九条底层协议，而不是继续在原方案上补例外：

1. `SkillDefinition + SkillRegistry + PromptBuilder/SkillResolver single source of truth`
2. `SessionPinnedConfig + SessionRuntimePolicy + ResolvedSessionConfig`
3. `SessionLedger + SessionSummaryProjection + session_profile / skill_invocations audit metadata`
4. `VisibleMessage + ContextState + CompactionRecord + current turn preservation + shared rebuild functions`
5. `TurnAugmentation + RequestContext`
6. `RequestBuildOptions + ChatRequestBuilder + capability guard`
7. `RequestedToolBatch + ResolvedToolCall + stable batch commit order`
8. `ToolOutput truncation contract + Memory search / checkpoint lane`
9. `TurnController + turn-scoped AgentEvent.sequence + Typed Hook Contract + Error Matrix`

在这九条协议稳定后，`AgentControl`、`TurnEngine`、`ContextManager`、`MemoryManager`、`ToolDispatcher` 的主骨架已经闭环，可以作为实现基线。

---

## Appendix B. 内置模板与标签约定

说明：

- 本附录沿用 `0005` / `0004` 的编号体系，只重述当前设计真正依赖的条目。
- v1 需要稳定的是“格式和归属”，不是把完整长 prompt 再复制一遍；长模板正文仍以实现时的模板文件为准。

### B.1 Compact Prompt

- 作用：驱动摘要式 context compaction。
- 默认来源：Agent 内置模板。
- 覆盖方式：`AgentConfig.compact_prompt`。
- 使用组件：`ContextManager`。
- 约束：只有 compact 请求可以读取它，普通对话请求不得复用。

### B.2 Compact Summary Prefix

- 作用：为压缩后 summary 提供固定前缀，帮助模型理解这是一段历史摘要。
- 默认来源：Agent 内置常量。
- 使用组件：`render_compaction_summary()`。
- 约束：不可配置；实时 compact 与 resume 都必须复用同一前缀。

### B.4 Skill 列表渲染

- 注入时机：每轮 `PromptBuilder` 渲染 system prompt 时。
- 使用组件：`PromptBuilder`。
- 数据来源：`SkillRegistry` 中全部 `allow_implicit_invocation = true` 的 `SkillDefinition`。
- 空集行为：若过滤后无可渲染 Skill，则整段不输出。
- 固定结构：

```text
## Skills

### Available skills
- {name}: {description}

### How to use skills
- 仅当用户显式使用 /skill_name 时激活
- 不得自行激活 Skill
- 可建议用户使用 Skill，但不可替用户触发
```

### B.5 Plugin 列表渲染

- 注入时机：每轮 `PromptBuilder` 渲染 system prompt 时。
- 使用组件：`PromptBuilder`。
- 数据来源：`PluginCatalog` 中全部已激活 Plugin 的 `PluginDescriptor`。
- 空集行为：无 Plugin 时不渲染空 section。
- 固定结构：

```text
## Plugins

### Active plugins
- {id} ({display_name}): {description}
```

### B.6 记忆使用指令

- 注入时机：每轮 `PromptBuilder` 渲染 system prompt 时，且仅在已注册 `MemoryStorage` 且最终记忆集合非空时注入。
- 使用组件：`PromptBuilder`。
- 数据来源：`bootstrap_memories + last_turn_memories` 合并去重后的最终集合。
- 空集行为：不输出空 `Memory` section。
- 固定结构：

```text
## Memory

{memory usage instructions}

### Memories
{rendered_memories}
```

- `memory usage instructions` 的正文沿用 `0005 Appendix B.6`；本设计只固定其注入条件、标题结构与归属组件。

### B.7 Environment Context 格式

- 注入时机：每轮 `PromptBuilder` 渲染 system prompt 时。
- 作用：告知模型当前运行环境。
- 数据来源：`AgentConfig.environment_context`。

```xml
<environment_context>
  <cwd>{cwd}</cwd>
  <shell>{shell}</shell>
  <current_date>{date}</current_date>
  <timezone>{timezone}</timezone>
</environment_context>
```

### B.8 上下文片段标签约定

当前设计使用以下 XML 标签：

| 标签 | 用途 |
|---|---|
| `<system_instructions>` | 调用方传入的系统指令 |
| `<system_prompt_override>` | 会话级 system prompt 覆写 |
| `<personality_spec>` | 人设定义 |
| `<skill>` | 当前 turn 触发的 Skill 内容 |
| `<environment_context>` | 环境上下文 |
| `<turn_aborted>` | Tool loop 超限后的收尾提示 |

### B.9 Skill 注入格式

- 注入时机：`SkillResolver` 命中显式 `/skill_name` 后，在当前 turn 的 `RequestContext` 中插入。
- 生命周期：只存在于当前 `TurnAugmentation`，不写入 `SessionLedger`，turn 结束即丢弃。
- 使用组件：`SkillResolver` 负责渲染，`ContextManager::build_request_context()` 负责插入。

```xml
<skill>
<name>{skill_name}</name>
{skill_prompt_content}
</skill>
```

### B.10 Memory 提取 Prompt（Phase 1）

- 注入时机：checkpoint 或 session close 时，作为记忆提取模型的 system prompt。
- 使用组件：`MemoryManager`。
- v1 语义：一次调用同时完成提取和整合判断（`Create / Update / Delete / Skip`）。
- 完整正文：实现期模板文件。

### B.11 Memory 提取输入模板（Phase 1）

- 注入时机：与 B.10 配套，作为记忆提取模型的 user message。
- 输入内容：
  - 本次 ledger 窗口内的会话事件
  - 当前 namespace 下的已有记忆全集
- 输出目标：结构化 `Vec<MemoryMutation>`。
