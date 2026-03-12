---
title: openyouyou 的 agent 架构设计文档
date: 2026-03-13
description: agent 设计
category: 胡说八道
---
# YouYou Agent - Architecture Design

| Field       | Value                |
| ----------- | -------------------- |
| Document ID | 0006                 |
| Type        | design               |
| Status      | Draft                |
| Created     | 2026-03-13           |
| Related     | 0005 (requirements)  |
| Module Path | src-tauri/src/agent/ |

---

## 1. Design Principles

- **Clean Architecture**：依赖方向从外向内。trait（port）定义在核心层，实现由调用方提供
- **SOLID**：单一职责（每个模块一件事）、开闭原则（通过 trait 扩展，不修改核心）、依赖倒置（核心依赖抽象而非具体实现）
- **KISS**：不抽象不需要的东西。无 DI 容器、无 Actor 模型、无消息总线——直接的函数调用和 struct 组合
- **YAGNI**：仅实现需求文档 0005 中明确要求的功能

---

## 2. Module Structure

```
src-tauri/src/agent/
├── mod.rs                  // 模块入口，re-export 公共 API
├── error.rs                // AgentError 错误枚举
├── types.rs                // 共享值类型（Message, Content, TokenUsage 等）
├── event.rs                // AgentEvent 定义
├── config.rs               // AgentConfig, EnvironmentContext
│
├── traits/                 // Port 层：所有外部依赖的 trait 定义
│   ├── mod.rs
│   ├── model.rs            // ModelProvider, ModelInfo, ChatRequest, ChatEvent
│   ├── tool.rs             // ToolHandler, ToolInput, ToolOutput
│   ├── plugin.rs           // Plugin trait
│   └── storage.rs          // SessionStorage, MemoryStorage
│
├── builder.rs              // AgentBuilder：校验 + 构建
├── agent.rs                // Agent：不可变的组件持有者 + Session 守卫
├── session.rs              // Session：一次对话的可变状态
├── turn.rs                 // TurnLoop：单轮对话的执行逻辑
├── context.rs              // ContextManager：消息历史 + 压缩
├── prompt/                 // System Prompt 组装
│   ├── mod.rs              // PromptBuilder
│   └── templates.rs        // 内置 prompt 模板常量（Appendix B）
├── tool_dispatch.rs        // ToolDispatcher：路由、并发/串行、超时
├── skill.rs                // SkillManager：Skill 注册表 + 触发检测 + 注入
├── hook.rs                 // HookRegistry：事件注册 + 顺序分发
├── plugin_mgr.rs           // PluginManager：生命周期管理
└── memory.rs               // MemoryManager：加载、注入、提取
```

---

## 3. Dependency Graph

依赖方向严格从外向内，核心模块之间无循环依赖。

```
调用方 (Tauri App)
  │
  ▼
AgentBuilder ──────────► Agent
                           │
                           ▼
                        Session
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
          TurnLoop    ContextMgr    MemoryMgr
              │            │
         ┌────┼────┐       │
         ▼    ▼    ▼       ▼
      ToolDisp SkillMgr PromptBuilder
              │
              ▼
         HookRegistry
```

**依赖规则：**

- `traits/` 不依赖任何其他模块
- `types.rs`, `error.rs`, `event.rs`, `config.rs` 仅依赖标准库和 serde
- 所有 core 模块依赖 `traits/` 和 `types.rs`，但不互相依赖（通过参数传递协作）
- `TurnLoop` 是唯一的编排者，它调用其他模块但其他模块不调用它

---

## 4. Core Types

### 4.1 Message（消息）

```rust
/// 对话中的一条消息
pub enum Message {
    User {
        content: Vec<ContentBlock>,
    },
    Assistant {
        content: Vec<ContentBlock>,
        status: MessageStatus,
    },
    ToolCall {
        call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    ToolResult {
        call_id: String,
        content: String,
        is_error: bool,
    },
    System {
        content: String,
    },
}

pub enum MessageStatus {
    Complete,
    Incomplete,
}

pub enum ContentBlock {
    Text(String),
    Image {
        data: String, // base64
        media_type: String,
    },
}
```

### 4.2 AgentEvent（事件）

```rust
pub struct AgentEvent {
    pub session_id: String,
    pub turn_id: String,
    pub timestamp: DateTime<Utc>,
    pub sequence: u64,
    pub payload: AgentEventPayload,
}

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

### 4.3 SessionConfig（会话配置）

```rust
pub struct SessionConfig {
    /// 使用的模型 ID（不指定则使用 AgentConfig.default_model）
    pub model_id: Option<String>,
    /// 可选的 System Prompt 覆盖（追加到 system_instructions 之后）
    pub system_prompt_override: Option<String>,
}
```

**持久化与恢复规则：** SessionConfig 在会话创建时通过 `SessionStorage::save_event()` 持久化为 `Metadata` 事件（key="session_config"）。恢复会话时，`resume_session()` 从 Metadata 事件中还原 `model_id` 和 `system_prompt_override`，用于重建 SessionState 和 System Prompt。若 Metadata 中无 session_config（旧格式兼容），则使用 AgentConfig 的默认值。

### 4.4 UserInput（用户输入）

```rust
pub struct UserInput {
    /// 输入内容块（支持多模态：文本 + 图片混合）
    pub content: Vec<ContentBlock>,
}
```

### 4.5 SessionEvent（会话持久化事件）

```rust
pub struct SessionEvent {
    pub timestamp: DateTime<Utc>,
    pub payload: SessionEventPayload,
}

pub enum SessionEventPayload {
    UserMessage { content: Vec<ContentBlock> },
    AssistantMessage { content: Vec<ContentBlock>, status: MessageStatus },
    ToolCall { call_id: String, tool_name: String, arguments: serde_json::Value },
    ToolResult { call_id: String, content: String, is_error: bool },
    SystemMessage { content: String },
    Metadata { key: String, value: serde_json::Value },
}
```

### 4.6 HookPayload 与 HookResult

```rust
pub struct HookPayload {
    pub event: HookEvent,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub plugin_config: serde_json::Value,
    pub data: serde_json::Value, // 事件特定数据（见 3.5 Hook 事件表）
    pub timestamp: DateTime<Utc>,
}

pub enum HookResult {
    Continue,
    ContinueWith(serde_json::Value),
    Abort(String),
}

#[derive(Clone, Eq, PartialEq, Hash)]
pub enum HookEvent {
    SessionStart,
    SessionEnd,
    TurnStart,
    TurnEnd,
    BeforeToolUse,
    AfterToolUse,
    BeforeCompact,
}
```

---

## 5. Trait Definitions (Port 层)

### 5.1 ModelProvider

```rust
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

pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    pub context_window: usize,
    pub capabilities: ModelCapabilities,
}

pub struct ModelCapabilities {
    pub tool_use: bool,
    pub vision: bool,
    pub streaming: bool,
}
```

`ChatRequest` 和 `ChatEvent` 见需求文档 3.1 节，这里不重复。

### 5.2 ToolHandler

```rust
#[async_trait]
pub trait ToolHandler: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters_schema(&self) -> serde_json::Value;
    fn is_mutating(&self) -> bool;
    async fn execute(&self, input: ToolInput) -> Result<ToolOutput>;
}
```

### 5.3 Plugin

```rust
#[async_trait]
pub trait Plugin: Send + Sync {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn description(&self) -> &str;
    async fn initialize(&self, config: serde_json::Value) -> Result<()>;
    fn apply(&self, ctx: PluginContext);
    async fn shutdown(&self) -> Result<()>;
}

/// apply() 的上下文，封装 plugin 元信息和 Hook 注册能力
pub struct PluginContext<'a> {
    pub plugin_id: &'a str,
    pub plugin_config: serde_json::Value,
    registry: &'a mut HookRegistry,
}

impl<'a> PluginContext<'a> {
    /// 注册 hook handler（内部自动注入 plugin_id 和 plugin_config）
    pub fn tap(
        &mut self,
        event: HookEvent,
        handler: impl Fn(HookPayload) -> Pin<Box<dyn Future<Output = HookResult> + Send>>
            + Send + Sync + 'static,
    ) {
        self.registry.tap(event, self.plugin_id.to_string(),
            self.plugin_config.clone(), handler);
    }
}
```

这样 Plugin 在 `apply()` 中无需自行保存/传递 config，直接通过 `ctx.tap()` 注册 handler，config 由框架自动注入。

### 5.4 Storage

```rust
#[async_trait]
pub trait SessionStorage: Send + Sync {
    async fn save_event(&self, session_id: &str, event: SessionEvent) -> Result<()>;
    async fn load_session(&self, session_id: &str) -> Result<Option<Vec<SessionEvent>>>;
    async fn list_sessions(&self, cursor: Option<&str>, limit: usize) -> Result<SessionPage>;
    async fn find_session(&self, query: &str) -> Result<Vec<SessionSummary>>;
    async fn delete_session(&self, session_id: &str) -> Result<()>;
}

#[async_trait]
pub trait MemoryStorage: Send + Sync {
    async fn search(&self, namespace: &str, query: &str, limit: usize) -> Result<Vec<Memory>>;
    async fn save(&self, memory: Memory) -> Result<()>;
    async fn delete(&self, id: &str) -> Result<()>;
}
```

---

## 6. AgentBuilder

AgentBuilder 采用 typestate 模式编译期保证 `ModelProvider` 至少注册一个。其余组件可选。

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
    pub fn new(config: AgentConfig) -> Self { /* ... */ }
}

impl<S> AgentBuilder<S> {
    pub fn register_model_provider(self, p: impl ModelProvider + 'static)
        -> AgentBuilder<HasProvider> { /* ... */ }
    pub fn register_tool(mut self, t: impl ToolHandler + 'static) -> Self { /* ... */ }
    pub fn register_skill(mut self, s: SkillDefinition) -> Self { /* ... */ }
    pub fn register_plugin(mut self, p: impl Plugin + 'static, config: serde_json::Value) -> Self { /* ... */ }
    pub fn register_session_storage(mut self, s: impl SessionStorage + 'static) -> Self { /* ... */ }
    pub fn register_memory_storage(mut self, s: impl MemoryStorage + 'static) -> Self { /* ... */ }
}

impl AgentBuilder<HasProvider> {
    /// 校验所有注册项 + 初始化 Plugin + 返回 Agent
    pub async fn build(self) -> Result<Agent> { /* ... */ }
}
```

`build()` 内部执行所有校验规则（见需求文档 6.1 节），初始化 Plugin 并调用 `apply()` 注册 hook handler。

---

## 7. Agent

Agent 是一个轻量 handle，内部持有 `Arc<AgentInner>`。`AgentInner` 包含所有不可变注册表和一个可关闭的活跃 Session 状态槽。

```rust
/// 调用方持有的 handle
pub struct Agent {
    inner: Arc<AgentInner>,
}

/// 共享的内部状态，Agent 和 Session 共同持有
pub(crate) struct AgentInner {
    pub config: AgentConfig,
    // 注册表（构建后不可变）
    pub model_router: ModelRouter,
    pub tool_dispatcher: ToolDispatcher,
    pub skill_manager: SkillManager,
    pub hook_registry: HookRegistry,
    pub plugins: Vec<Arc<dyn Plugin>>,
    pub session_storage: Option<Arc<dyn SessionStorage>>,
    pub memory_storage: Option<Arc<dyn MemoryStorage>>,
    // 活跃 Session 状态槽
    pub active_session: Mutex<Option<ActiveSessionHandle>>,
}

/// Agent 持有的 Session 控制句柄，用于 shutdown 时优雅关闭
/// running_guard 的生命周期语义详见 §8 "running_guard 与 active_session 的生命周期绑定"
pub(crate) struct ActiveSessionHandle {
    pub session_id: String,
    pub cancel_token: CancellationToken,
    /// 触发完整的 Session 关闭流程（SessionEnd Hook + 记忆提取）
    pub close_signal: oneshot::Sender<()>,
    /// Session 关闭流程完全结束后发出信号
    pub completion_rx: oneshot::Receiver<()>,
    /// 当 strong count 归零时，表示 Session 已释放且所有后台 Turn task 都已结束
    pub running_guard: Weak<()>,
}
```

Session 创建时产生两对 channel：

- `close_signal`：Agent 通过它通知 Session 执行完整关闭流程（区别于 cancel_token 仅取消当前 Turn）
- `completion_tx/rx`：Session 关闭完成后通知 Agent

Session 内部有一个后台 task 监听 `close_signal`。收到信号后执行完整关闭流程：等待当前 Turn 结束 → SessionEnd Hook → 记忆提取 → 清除 active_session 槽 → completion_tx.send(())。

**公共 API：**

```rust
impl Agent {
    /// 创建新 Session
    pub async fn new_session(&self, config: SessionConfig) -> Result<Session>;

    /// 恢复已有 Session（不触发 SessionStart Hook，仅恢复上下文）
    pub async fn resume_session(&self, session_id: &str) -> Result<Session>;

    /// 关闭 Agent，释放所有资源
    pub async fn shutdown(&self) -> Result<()>;
}
```

**shutdown 执行路径：**

1. 获取 `active_session` 锁，取出 `ActiveSessionHandle`
2. 若有活跃 Session：
   a. `cancel_token.cancel()` — 取消正在运行的 Turn
   b. `close_signal.send(())` — 触发 Session 级完整关闭流程（SessionEnd Hook + 记忆提取）
   c. `completion_rx.await` — 等待关闭流程完全结束
3. 按逆序调用所有 Plugin 的 `shutdown()`
4. 释放资源

**注意：** `shutdown()` 触发的是完整关闭路径（等同于调用方调用 `Session::close()`），不是 Drop 兜底路径。

### 7.1 ModelRouter

简单的 HashMap 查找，不做额外抽象。

```rust
pub(crate) struct ModelRouter {
    providers: HashMap<String, Arc<dyn ModelProvider>>, // model_id -> provider
}

impl ModelRouter {
    pub fn resolve(&self, model_id: &str) -> Result<&Arc<dyn ModelProvider>> {
        self.providers.get(model_id).ok_or(AgentError::model_not_supported(model_id))
    }
}
```

---

## 8. Session

Session 持有一次对话的全部可变状态。内部状态通过 `Arc<Mutex<SessionState>>` 共享，使得 `send_message` 返回的事件流不借用 `&mut self`。

```rust
pub struct Session {
    id: String,
    state: Arc<Mutex<SessionState>>,
    inner: Arc<AgentInner>,  // 与 Agent 共享
}

pub(crate) struct SessionState {
    pub model_id: String,
    pub context: ContextManager,
    pub turn_counter: u64,
    pub memory_checkpoint_counter: u64,
    pub cancel_token: CancellationToken,
    /// 当前是否有 Turn 正在运行，禁止并发 send_message()
    pub turn_in_progress: bool,
}
```

**公共 API：**

```rust
impl Session {
    /// 发送消息，返回一个独立的 RunningTurn 句柄
    /// RunningTurn 不借用 Session，调用方可同时持有 Session 和 RunningTurn
    pub async fn send_message(&self, input: UserInput) -> Result<RunningTurn>;

    /// 关闭 Session（显式关闭）
    pub async fn close(self) -> Result<()>;
}

/// 一轮对话的运行句柄，持有事件流和取消能力
pub struct RunningTurn {
    events: mpsc::Receiver<AgentEvent>,
    cancel_token: CancellationToken,
}

impl RunningTurn {
    /// 获取事件流
    pub fn events(&mut self) -> &mut mpsc::Receiver<AgentEvent>;

    /// 取消当前 Turn
    pub fn cancel(&self);
}
```

`send_message` 流程：

1. 获取 `state` 锁，检查 `turn_in_progress`。若为 `true`，返回 `AgentError::TurnBusy`
2. 设置 `turn_in_progress = true`
3. 将 `running_guard: Arc<()>` clone 传入后台 task（绑定 active_session 生命周期）
4. spawn tokio task 运行 `run_turn()`，task 结束时设置 `turn_in_progress = false` 并 Drop `running_guard` clone
5. 返回 `RunningTurn`（仅包含 `events` 和 `cancel_token`，不持有 `running_guard`）

RunningTurn 不持有 Session 的任何借用，调用方可以在消费事件流的同时调用 `cancel()`。同一 Session 同一时间只允许一个 Turn 运行，并发调用 `send_message()` 将返回 `AgentError::TurnBusy`。

**running_guard 与 active_session 的生命周期绑定：**

`running_guard` 用于判定活跃 Session 是否"真正结束"。它的 strong ref 绑定到 **Session 本身**和 **后台 `run_turn()` task**，而非 `RunningTurn` 前端消费句柄。

- Session 创建时持有一个 `Arc<()>` clone
- 每次 `send_message()` spawn 后台 `run_turn()` task 时，将 `Arc<()>` clone 传入 task，task 结束时 clone 自动 Drop
- `RunningTurn` **不持有** `running_guard`，仅持有 `events` 和 `cancel_token`
- `ActiveSessionHandle` 持有 `Weak<()>`（`ActiveSessionHandle` 的完整定义见 §7，此处不重复）

Session 和后台 `run_turn()` task 都持有同一个 `Arc<()>` 的 clone。Agent 在创建新 Session 前检查：

1. `active_session` 槽是否为 Some
2. 若为 Some，检查 `running_guard.strong_count() > 0`
3. 只有槽为 None 或 strong_count == 0 时才允许创建新 Session

这保证了即使 Session 和 RunningTurn 都被 Drop，只要后台 `run_turn()` task 仍在运行，`active_session` 就不会被过早释放。因为 `RunningTurn` 不参与 `running_guard` 的引用计数，调用方丢弃 `RunningTurn` 不会影响 active_session 的判定。

### 8.1 会话恢复流程（resume_session）

`Agent::resume_session(session_id)` 从 SessionStorage 加载历史事件并重建 Session：

1. 调用 `SessionStorage::load_session(session_id)` 获取 `Vec<SessionEvent>`
2. 从 Metadata 事件中提取 `session_config`（model_id + system_prompt_override），用于重建 SessionState
3. 按顺序将每个 `SessionEvent` 映射为 `Message`：

| SessionEventPayload                              | 映射为 Message                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| UserMessage { content }                          | Message::User { content }                                                                                             |
| AssistantMessage { content, status: Complete }   | Message::Assistant { content, status: Complete }                                                                      |
| AssistantMessage { content, status: Incomplete } | Message::Assistant { content, status: Incomplete } **+ 追加** Message::System { content: "[此消息因用户取消而中断]" } |
| ToolCall { call_id, tool_name, arguments }       | Message::ToolCall { call_id, tool_name, arguments }                                                                   |
| ToolResult { call_id, content, is_error }        | Message::ToolResult { call_id, content, is_error }                                                                    |
| SystemMessage { content }                        | Message::System { content }                                                                                           |
| Metadata { .. }                                  | 跳过，不加入上下文                                                                                                    |

4. 将映射后的 Message 列表加载到 ContextManager
5. **恢复计数器**：从已加载的事件列表中推导 `turn_counter` 和 `memory_checkpoint_counter`：
   - `turn_counter`：统计 `SessionEventPayload::UserMessage` 事件的数量（每个 UserMessage 代表一轮 Turn）
   - `memory_checkpoint_counter`：`turn_counter % memory_checkpoint_interval`，延续原有的 checkpoint 节奏
   - 这保证了恢复后 turn 编号不重复、checkpoint 间隔不漂移
6. 不触发 SessionStart Hook（resume 不是新建会话）
7. 重新从 MemoryStorage 加载最新记忆（因为 Memory 是动态 System Prompt 段，在 resume 时可能已有新的记忆写入，需要获取最新视图）
8. 使 stable_prompt 缓存失效，下一轮 Turn 时 PromptBuilder 会用恢复的 session_config 重建

**三条关闭路径：**

| 路径                               | 触发方                | SessionEnd Hook | 记忆提取           | active_session 释放时机                        |
| ---------------------------------- | --------------------- | --------------- | ------------------ | ---------------------------------------------- |
| `Session::close()`                 | 调用方显式调用        | 执行            | 执行（失败不阻塞） | close 完成后，running_guard 归零时             |
| `Agent::shutdown()` → close_signal | Agent 内部触发        | 执行            | 执行（失败不阻塞） | close 完成后，running_guard 归零时             |
| `Drop`（未调用 close）             | Session handle 被丢弃 | 不执行          | 不执行             | running_guard 归零时（后台 Turn task 全部结束后） |

- `close()` 和 `shutdown()` 触发的是同一条内部关闭流程，只是入口不同
- `Drop` 跳过 Hook 和记忆提取，但 cancel_token 被触发以通知运行中的 Turn 停止
- active_session 槽的释放绑定到 `running_guard` 的 strong count 归零，而非 Session handle 的 Drop。这保证了后台 Turn task 仍在运行时不会过早允许创建新 Session。`RunningTurn` 不持有 `running_guard`，其生命周期不影响 active_session 的判定
- 无论哪条路径，`completion_tx.send(())` 都会被调用，确保 `shutdown()` 不会永远挂起

---

## 9. TurnLoop

TurnLoop 是一个无状态的 async 函数，不是 struct。它是整个 Agent 运行时的唯一编排者。

```rust
pub(crate) async fn run_turn(
    state: Arc<Mutex<SessionState>>,
    inner: Arc<AgentInner>,
    input: UserInput,
    event_tx: mpsc::Sender<AgentEvent>,
) -> Result<()>
```

### 9.1 执行流程

```
run_turn(state, inner, input, event_tx)
│
├─ 1. Hook: TurnStart → DispatchOutcome.payload.data 即为 dynamic_sections
│     多个 Plugin 的 ContinueWith 采用链式传递：后一个 handler 看到前一个修改后的 data
│     TurnLoop 从最终 payload.data 中提取 dynamic_sections（约定为 JSON string array）
├─ 2. SkillManager: 检测 /skill_name → 注入 Skill prompt
├─ 3. ContextManager: 追加用户消息
│
├─ 4. LOOP {
│   ├─ 4a. PromptBuilder: 组装 System Prompt（每轮重建 dynamic 段）
│   ├─ 4b. ContextManager: 检查是否需要压缩（含 prompt + tools 估算）
│   │     └─ 是 → Hook: BeforeCompact → 执行压缩 → emit ContextCompacted
│   ├─ 4c. 构建 ChatRequest（消息历史 + tool specs）
│   ├─ 4d. ModelProvider: 流式调用
│   │     └─ 逐个 ChatEvent → emit TextDelta / ReasoningDelta / Error
│   │     → 聚合本轮 assistant 输出为完整 Message
│   ├─ 4e. ContextManager: 追加 assistant message（无论是否有 ToolCall）
│   ├─ 4f. 收集 ToolCall 列表
│   │     └─ 无 ToolCall → BREAK
│   ├─ 4g. ToolDispatcher: 执行 ToolCall 批次
│   │     ├─ 全只读 → 并发执行
│   │     └─ 含 mutating → 串行执行
│   │     每个 ToolCall:
│   │       ├─ Hook: BeforeToolUse（可 Abort）
│   │       ├─ emit ToolCallStart
│   │       ├─ ToolHandler.execute()（带超时）
│   │       ├─ emit ToolCallEnd
│   │       └─ Hook: AfterToolUse
│   ├─ 4h. ContextManager: 追加 tool results
│   ├─ 4i. tool_call_count += batch.len()
│   │     └─ 超限 → 注入超限提示 → BREAK
│   └─ } // 回到 4a
│
├─ 5. SessionStorage: 持久化事件
├─ 6. MemoryManager: checkpoint 检查（每 N 轮）
├─ 7. Hook: TurnEnd
└─ 8. emit TurnComplete / TurnCancelled
```

**关键设计点：** assistant message 在步骤 4e 中无条件追加到上下文——无论模型是返回纯文本还是带 ToolCall。这保证了：

- 多轮对话中后续 Turn 可以看到上一轮回答
- SessionStorage 在 Turn 结束时能拿到完整 assistant message
- 取消导致的 incomplete message 也能被正确记录

### 9.2 取消处理

取消信号通过 `CancellationToken` 传播。TurnLoop 在以下 yield 点检查：

- 模型流式接收的每个 event 之间
- Tool 批次中每个 Tool 执行前（尚未开始的 Tool 跳过）
- 压缩请求发起前

已开始的 Tool 执行不中断（等待完成）。取消后 TurnLoop 发出 `TurnCancelled` 事件并退出。

---

## 10. ContextManager

ContextManager 拥有消息历史，负责追加、查询和压缩。

```rust
pub(crate) struct ContextManager {
    messages: Vec<Message>,
    /// 缓存的稳定 System Prompt 段（system_instructions + personality + skills + plugins）
    /// 仅在压缩后失效重建
    stable_prompt: Option<String>,
    context_window: usize,
    compact_threshold: f64,
}
```

**System Prompt 分段策略：** System Prompt 分为"稳定段"和"动态段"两部分：

- **稳定段**（缓存）：system_instructions、personality、skill list、plugin list。这些在 Session 生命周期内不变，可在首次 Turn 构建后缓存，仅压缩后重建。
- **动态段**（每轮重建）：memories（可能随 Turn 变化）、environment context、TurnStart Hook 的 ContinueWith 返回值。这部分在每轮 Turn 开始时重新获取并拼接到稳定段之后。

**最终顺序与需求文档 0005 §5.3 保持一致：** System Instructions → Personality → (Tool Definitions via API) → Skill List → Plugin List → Memories → Environment Context → Dynamic Sections。

**关键方法：**

```rust
impl ContextManager {
    /// 追加消息
    pub fn push(&mut self, msg: Message);

    /// 获取当前消息历史（供 ChatRequest 使用）
    pub fn messages(&self) -> &[Message];

    /// 估算当前完整请求的 token 数（含 prompt + messages + tools 预算）
    pub fn estimated_total_tokens(
        &self,
        prompt_chars: usize,
        tools_chars: usize,
    ) -> usize {
        let messages_chars: usize = self.messages.iter().map(|m| m.char_count()).sum();
        (messages_chars + prompt_chars + tools_chars) / 4
    }

    /// 是否需要压缩
    pub fn needs_compaction(&self, prompt_chars: usize, tools_chars: usize) -> bool {
        let estimated = self.estimated_total_tokens(prompt_chars, tools_chars);
        let threshold = (self.context_window as f64 * self.compact_threshold) as usize;
        estimated > threshold
    }

    /// 执行压缩：用摘要替换早期消息
    pub fn compact(&mut self, summary: String, prefix: &str) {
        let keep_count = /* 保留最近的消息，约占窗口 20% */;
        let kept = self.messages.split_off(self.messages.len() - keep_count);
        self.messages.clear();
        self.messages.push(Message::System {
            content: format!("{}\n\n{}", prefix, summary),
        });
        self.messages.extend(kept);
        self.stable_prompt = None; // 稳定段缓存失效，下轮重建
    }
}
```

---

## 11. PromptBuilder

PromptBuilder 提供两个方法：`build_stable()` 构建可缓存的稳定段，`build_dynamic()` 构建每轮变化的动态段。TurnLoop 将两者拼接为完整 System Prompt。

```rust
pub(crate) struct PromptBuilder;

impl PromptBuilder {
    /// 构建稳定段（Session 内可缓存，仅压缩后重建）
    pub fn build_stable(
        config: &AgentConfig,
        skills: &[SkillDefinition],
        plugins: &[(String, String, String)], // (id, display_name, description)
    ) -> String {
        let mut parts = Vec::new();

        // 1. System Instructions
        if !config.system_instructions.is_empty() {
            parts.push(wrap_tag("system_instructions",
                &config.system_instructions.join("\n\n")));
        }

        // 2. Personality
        if let Some(p) = &config.personality {
            parts.push(Self::render_personality(p));
        }

        // 3. Tool Definitions → 不在这里，通过 ChatRequest.tools 传递

        // 4. Skill List
        if let Some(s) = Self::render_skills(skills) {
            parts.push(s);
        }

        // 5. Plugin List
        if let Some(p) = Self::render_plugins(plugins) {
            parts.push(p);
        }

        parts.join("\n\n")
    }

    /// 构建动态段（每轮 Turn 重建）
    /// 顺序：Memories → Environment Context → Dynamic Sections（与需求文档 0005 §5.3 一致）
    pub fn build_dynamic(
        memories: &[Memory],
        environment_context: Option<&EnvironmentContext>,
        dynamic_sections: &[String], // 来自 TurnStart Hook 的 ContinueWith
    ) -> String {
        let mut parts = Vec::new();

        // 6. Memories
        if !memories.is_empty() {
            parts.push(Self::render_memories(memories));
        }

        // 7. Environment Context
        if let Some(env) = environment_context {
            parts.push(Self::render_environment(env));
        }

        // 8. Dynamic Sections
        for section in dynamic_sections {
            parts.push(section.clone());
        }

        parts.join("\n\n")
    }

    /// 拼接稳定段 + 动态段为完整 System Prompt
    pub fn combine(stable: &str, dynamic: &str) -> String {
        if dynamic.is_empty() {
            stable.to_string()
        } else {
            format!("{}\n\n{}", stable, dynamic)
        }
    }
}
```

内置的 prompt 模板独立在 `prompt/templates.rs` 中（对应需求文档 Appendix B）：

```rust
// prompt/templates.rs

// B.1 上下文压缩
pub(crate) const DEFAULT_COMPACT_PROMPT: &str = "You are performing a CONTEXT CHECKPOINT COMPACTION...";
// B.2 压缩摘要前缀
pub(crate) const COMPACT_SUMMARY_PREFIX: &str = "Another language model started to solve...";
// B.4 Skill 列表固定文本
pub(crate) const SKILL_SECTION_HEADER: &str = "## Skills\n\nBelow is the list of skills...";
pub(crate) const SKILL_USAGE_RULES: &str = "### How to use skills\n- Trigger rules: ...";
// B.5 Plugin 列表固定文本
pub(crate) const PLUGIN_SECTION_HEADER: &str = "## Plugins\n\nThe following plugins are active...";
// B.6 Memory 使用指令
pub(crate) const MEMORY_INSTRUCTIONS: &str = "## Memory\n\nYou have access to memories from prior sessions...";
// B.10 Memory 提取 prompt
pub(crate) const MEMORY_EXTRACTION_PROMPT: &str = "You are a Memory Writing Agent...";
// B.11 Memory 提取输入模板
pub(crate) const MEMORY_EXTRACTION_INPUT_TEMPLATE: &str = "Analyze this session and produce JSON...";
// B.12 Memory 整合 prompt
pub(crate) const MEMORY_CONSOLIDATION_PROMPT: &str = "You are a Memory Writing Agent. Your job: consolidate...";
```

---

## 12. ToolDispatcher

```rust
pub(crate) struct ToolDispatcher {
    handlers: HashMap<String, Arc<dyn ToolHandler>>,
    timeout: Duration,
}

impl ToolDispatcher {
    /// 执行一批 ToolCall，根据 mutating 标记决定并发或串行
    pub async fn execute_batch(
        &self,
        calls: Vec<ToolCallRequest>,
        hooks: &HookRegistry,
        cancel: &CancellationToken,
        event_tx: &mpsc::Sender<AgentEvent>,
    ) -> Vec<ToolResult> {
        let has_mutating = calls.iter().any(|c| {
            self.handlers.get(&c.tool_name)
                .map_or(false, |h| h.is_mutating())
        });

        if has_mutating {
            self.execute_serial(calls, hooks, cancel, event_tx).await
        } else {
            self.execute_concurrent(calls, hooks, cancel, event_tx).await
        }
    }
}
```

**单个 Tool 执行流程：**

```
┌─ Hook: BeforeToolUse
│   └─ Abort? → 不执行 handler，生成 synthetic ToolResult:
│               ToolResult { is_error: true, content: "Tool aborted by hook: {reason}" }
│               emit ToolCallStart + ToolCallEnd(success=false)
│               → 继续下一个 Tool
├─ emit ToolCallStart
├─ tokio::time::timeout(handler.execute())
│   └─ 超时? → ToolResult { is_error: true, content: "Tool timed out after {ms}ms" }
├─ 输出截断：若 output.content.len() > 1MB → 截断 + 追加 "\n\n[output truncated at 1MB]"
├─ emit ToolCallEnd(success = !output.is_error)
└─ Hook: AfterToolUse
```

**关键契约：**

- Abort 不执行 handler，但仍发出 ToolCallStart/ToolCallEnd 事件对（前端可感知）
- 1MB 截断在 handler 返回后、事件发送前执行，保证事件、上下文、持久化看到的是同一份截断后结果
- 截断提示固定为 `\n\n[output truncated at 1MB]`

---

## 13. HookRegistry

```rust
pub struct HookRegistry {
    handlers: HashMap<HookEvent, Vec<HookEntry>>,
}

struct HookEntry {
    plugin_id: String,
    plugin_config: serde_json::Value,
    handler: Arc<dyn Fn(HookPayload) -> Pin<Box<dyn Future<Output = HookResult> + Send>> + Send + Sync>,
}

impl HookRegistry {
    /// Plugin 在 apply() 中调用此方法注册 handler
    pub fn tap(
        &mut self,
        event: HookEvent,
        plugin_id: String,
        plugin_config: serde_json::Value,
        handler: impl Fn(HookPayload) -> Pin<Box<dyn Future<Output = HookResult> + Send>> + Send + Sync + 'static,
    );

    /// 按注册顺序依次执行，遇 Abort 立即停止
    /// 返回 DispatchOutcome，调用方可获取最终修改后的 payload
    pub(crate) async fn dispatch(
        &self,
        event: HookEvent,
        mut payload: HookPayload,
    ) -> DispatchOutcome {
        let handlers = match self.handlers.get(&event) {
            Some(h) => h,
            None => return DispatchOutcome { payload, aborted: None },
        };
        for entry in handlers {
            payload.plugin_config = entry.plugin_config.clone();
            match (entry.handler)(payload.clone()).await {
                HookResult::Continue => {}
                HookResult::ContinueWith(data) => { payload.data = data; }
                HookResult::Abort(reason) => {
                    return DispatchOutcome {
                        payload,
                        aborted: Some(reason),
                    };
                }
            }
        }
        DispatchOutcome { payload, aborted: None }
    }
}

/// dispatch 的返回值，携带最终修改后的 payload
pub(crate) struct DispatchOutcome {
    /// 经所有 handler 修改后的最终 payload
    pub payload: HookPayload,
    /// 若被 Abort，携带 reason；None 表示正常完成
    pub aborted: Option<String>,
}
```

---

## 14. SkillManager

```rust
pub(crate) struct SkillManager {
    skills: HashMap<String, SkillDefinition>,
}

impl SkillManager {
    /// 从用户输入中检测 /skill_name 触发
    pub fn detect_invocations(&self, input: &str) -> Vec<&SkillDefinition> {
        // 正则匹配 /word_chars，查表返回
    }

    /// 将触发的 Skill 渲染为注入消息
    pub fn render_injection(&self, skill: &SkillDefinition) -> Message {
        Message::System {
            content: format!("<skill>\n<name>{}</name>\n{}\n</skill>",
                skill.name, skill.prompt),
        }
    }

    /// 返回 allow_implicit_invocation=true 的 Skill（供 PromptBuilder 使用）
    pub fn implicit_skills(&self) -> Vec<&SkillDefinition> {
        self.skills.values().filter(|s| s.allow_implicit_invocation).collect()
    }
}
```

---

## 15. MemoryManager

```rust
pub(crate) struct MemoryManager {
    storage: Arc<dyn MemoryStorage>,
    namespace: String,
    max_items: usize,
}

impl MemoryManager {
    /// Session 开始时加载记忆
    pub async fn load_memories(&self) -> Result<Vec<Memory>> {
        self.storage.search(&self.namespace, "", self.max_items).await
    }

    /// 提取记忆（Session 结束或 checkpoint 时调用）
    pub async fn extract_memories(
        &self,
        session_messages: &[Message],
        provider: &dyn ModelProvider,
        model_id: &str,
    ) -> Result<()> {
        // 1. 将 session_messages 渲染为文本
        // 2. 使用 MEMORY_EXTRACTION_PROMPT + MEMORY_EXTRACTION_INPUT_TEMPLATE 构建请求
        // 3. 调用 provider.chat() 获取提取结果
        // 4. 解析 JSON → Memory 列表
        // 5. 对每条 Memory 调用 storage.save()
        Ok(())
    }
}
```

---

## 16. Error Handling

```rust
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    // 构建阶段
    #[error("[NO_MODEL_PROVIDER] at least one ModelProvider is required")]
    NoModelProvider,
    #[error("[NAME_CONFLICT] {kind} name '{name}' is duplicated")]
    NameConflict { kind: &'static str, name: String },
    #[error("[SKILL_DEPENDENCY_NOT_MET] skill '{skill}' requires tool '{tool}'")]
    SkillDependencyNotMet { skill: String, tool: String },
    #[error("[PLUGIN_INIT_FAILED] plugin '{id}': {source}")]
    PluginInitFailed { id: String, source: anyhow::Error },
    #[error("[STORAGE_DUPLICATE] {kind} storage registered more than once")]
    StorageDuplicate { kind: &'static str },
    #[error("[INVALID_DEFAULT_MODEL] model '{0}' is not registered")]
    InvalidDefaultModel(String),

    // 运行阶段
    #[error("[SESSION_BUSY] a session is already running")]
    SessionBusy,
    #[error("[TURN_BUSY] a turn is already running in this session")]
    TurnBusy,
    #[error("[MODEL_NOT_SUPPORTED] model '{0}' is not supported by any provider")]
    ModelNotSupported(String),
    #[error("[PROVIDER_ERROR] {message}")]
    ProviderError { message: String, source: anyhow::Error, retryable: bool },
    #[error("[TOOL_EXECUTION_ERROR] tool '{name}': {source}")]
    ToolExecutionError { name: String, source: anyhow::Error },
    #[error("[TOOL_TIMEOUT] tool '{name}' timed out after {timeout_ms}ms")]
    ToolTimeout { name: String, timeout_ms: u64 },
    #[error("[TOOL_NOT_FOUND] tool '{0}'")]
    ToolNotFound(String),
    #[error("[SKILL_NOT_FOUND] skill '{0}'")]
    SkillNotFound(String),
    #[error("[SESSION_NOT_FOUND] session '{0}'")]
    SessionNotFound(String),
    #[error("[STORAGE_ERROR] {0}")]
    StorageError(anyhow::Error),
    #[error("[MAX_TOOL_CALLS_EXCEEDED] limit is {limit}")]
    MaxToolCallsExceeded { limit: usize },
    #[error("[COMPACT_ERROR] {0}")]
    CompactError(anyhow::Error),
    #[error("[REQUEST_CANCELLED]")]
    RequestCancelled,
}

impl AgentError {
    pub fn code(&self) -> &'static str { /* match self => "NO_MODEL_PROVIDER" etc */ }
    pub fn retryable(&self) -> bool { matches!(self, Self::ProviderError { retryable: true, .. }) }
    pub fn source_component(&self) -> &'static str {
        match self {
            Self::ProviderError { .. } => "provider",
            Self::ToolExecutionError { .. } | Self::ToolTimeout { .. } => "tool",
            Self::PluginInitFailed { .. } => "plugin",
            Self::StorageError(_) => "storage",
            _ => "agent",
        }
    }
}
```

---

## 17. Public API Summary

调用方看到的全部公共类型：

```
// 构建
AgentBuilder::new(config) -> AgentBuilder<NoProvider>
  .register_model_provider(p) -> AgentBuilder<HasProvider>
  .register_tool(t) -> Self
  .register_skill(s) -> Self
  .register_plugin(p, config) -> Self
  .register_session_storage(s) -> Self
  .register_memory_storage(s) -> Self
  .build() -> Result<Agent>

// 运行
Agent::new_session(config) -> Result<Session>
Agent::resume_session(id) -> Result<Session>
Agent::shutdown() -> Result<()>

Session::send_message(input) -> Result<RunningTurn>
Session::close() -> Result<()>

RunningTurn::events() -> &mut mpsc::Receiver<AgentEvent>
RunningTurn::cancel()

// 类型
AgentConfig, SessionConfig, UserInput, RunningTurn
AgentEvent, AgentEventPayload
AgentError
Message, ContentBlock, MessageStatus
SessionEvent, SessionEventPayload
SkillDefinition, Memory
HookEvent, HookPayload, HookResult
PluginContext (传给 Plugin::apply)

// Traits
ModelProvider, ModelInfo, ChatRequest, ChatEvent
ToolHandler, ToolInput, ToolOutput
Plugin
SessionStorage, SessionEvent, SessionPage, SessionSummary
MemoryStorage
```

---

## 18. Design Decisions

### D1: 为什么 TurnLoop 是函数而非 struct？

TurnLoop 没有自己的状态——它操作 Session 的状态。将它做成函数而非 Actor/struct 避免了状态管理复杂度。Session 本身已经是一个状态容器，不需要再套一层。

### D2: 为什么不用 Actor 模型？

需求是单会话模型，不存在多个并发 Actor 的场景。Agent 的互斥只需要一个 `Mutex<Option<ActiveSessionHandle>>` 守卫。Actor 模型引入的 channel/mailbox 机制对这个场景过重。

### D3: 为什么 AgentBuilder 用 typestate？

编译期保证至少注册一个 ModelProvider，比运行时检查更安全。只用了一个 typestate 参数（NoProvider/HasProvider），没有过度泛型化。

### D4: 为什么 PromptBuilder 无状态？

System Prompt 的组装是纯函数：相同输入必须产出相同输出。没有理由让它持有状态。将它做成 struct 的静态方法（或关联函数）最简单。

### D5: 为什么 Hook handler 是 Fn 而非独立 trait？

Plugin trait 已经是注册入口。Hook handler 只是 Plugin 内部注册的回调。用 `Fn` 闭包比再定义一个 `HookHandler` trait 更轻量，Plugin 可以在 `apply()` 中直接用闭包捕获 self。

### D6: 为什么 ContextManager 用 Vec<Message> 而非自定义数据结构？

KISS。消息历史本质是有序列表，Vec 完全够用。不需要 ring buffer（压缩不是删除头部而是替换为摘要）、不需要 B-tree（不按 key 查找）。
