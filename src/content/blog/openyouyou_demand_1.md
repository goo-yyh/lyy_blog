---
title: openyouyou 的 agent 需求文档第一版
date: 2026-03-12
description: agent 设计
category: 胡说八道
---
# YouYou Agent Module - Requirements Document

| Field         | Value                            |
|---------------|----------------------------------|
| Document ID   | 0001                             |
| Type          | demand                           |
| Status        | Draft                            |
| Created       | 2026-03-11                       |
| Module Path   | `src-tauri/src/agent/`           |

## 1. Overview

YouYou Agent 是一个运行在 Tauri 后端的**无状态多轮对话 Agent 框架**。它本身不内置任何 Model Provider、Tool、Skill、Plugin 或 Session Storage 实现，所有能力均通过注册接口由外部提供。设计参考 codex-rs 的核心架构，但移除了 MCP、多 Agent 协调、安全审批/沙箱等功能，保留核心对话循环与可扩展性。

### 1.1 设计目标

- **无状态核心**：Agent 本身不持有任何持久状态，所有持久化由外部注册的 Storage 实现负责。
- **全注册制**：Model、Tool、Skill、Plugin、Hook、Session Storage、Memory Storage 均通过 trait + 注册接口接入。
- **多轮对话**：支持完整的多轮对话循环，包括上下文管理、Tool 调用、流式输出。
- **可组合**：各子系统独立，可按需注册，缺失非核心注册项时 Agent 仍可降级运行。

### 1.2 Non-Goals

以下功能明确不在范围内：

- MCP (Model Context Protocol) 服务器集成
- 多 Agent 协调/编排
- 安全确认与人工审批流程
- 沙箱隔离执行环境
- 内置任何具体的 Model Provider / Tool / Skill / Plugin 实现

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Tauri App                         │
│  ┌───────────────────────────────────────────────┐  │
│  │              AgentBuilder                      │  │
│  │  .register_model_provider(impl ModelProvider)  │  │
│  │  .register_tool(impl ToolHandler)              │  │
│  │  .register_skill(SkillDefinition)              │  │
│  │  .register_plugin(impl Plugin)                 │  │
│  │  .register_hook(HookEvent, impl HookHandler)   │  │
│  │  .register_session_storage(impl SessionStorage)│  │
│  │  .register_memory_storage(impl MemoryStorage)  │  │
│  │  .build() -> Agent                             │  │
│  └───────────────────────────────────────────────┘  │
│                       │                              │
│                       ▼                              │
│  ┌───────────────────────────────────────────────┐  │
│  │                  Agent                         │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐  │  │
│  │  │ Context  │ │  Turn    │ │   Tool        │  │  │
│  │  │ Manager  │ │  Loop    │ │   Dispatcher  │  │  │
│  │  └─────────┘ └──────────┘ └───────────────┘  │  │
│  │  ┌─────────┐ ┌──────────┐ ┌───────────────┐  │  │
│  │  │ Skill   │ │  Hook    │ │   Plugin      │  │  │
│  │  │ Manager │ │  Dispatch│ │   Manager     │  │  │
│  │  └─────────┘ └──────────┘ └───────────────┘  │  │
│  │  ┌─────────┐ ┌──────────┐                     │  │
│  │  │ System  │ │  Memory  │                     │  │
│  │  │ Prompt  │ │  Manager │                     │  │
│  │  │ Builder │ │          │                     │  │
│  │  └─────────┘ └──────────┘                     │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

---

## 3. Core Abstractions & Registration Interfaces

### 3.1 ModelProvider (Required, at least one)

Model Provider 负责与 LLM API 通信。Agent 不关心底层是 OpenAI、Anthropic 还是本地模型。

```rust
#[async_trait]
pub trait ModelProvider: Send + Sync {
    /// Provider 唯一标识
    fn id(&self) -> &str;

    /// 该 Provider 支持的模型列表
    fn supported_models(&self) -> Vec<ModelInfo>;

    /// 发送请求并以流式方式返回响应
    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<ChatEvent>> + Send>>>;

    /// 可选：取消正在进行的请求
    async fn cancel(&self, request_id: &str) -> Result<()> { Ok(()) }
}
```

**关键类型：**

- `ModelInfo`：模型 ID、显示名称、上下文窗口大小、支持的能力（tool_use / vision / streaming）
- `ChatRequest`：模型 ID、消息列表、可用工具定义列表、temperature、max_tokens、reasoning_effort 等
- `ChatEvent`：流式事件枚举
  - `TextDelta(String)` - 文本增量
  - `ReasoningDelta(String)` - 推理过程增量
  - `ToolCall { call_id, tool_name, arguments }` - 工具调用请求
  - `Done { usage: TokenUsage }` - 完成
  - `Error(String)` - 错误

### 3.2 ToolHandler (Optional, zero or more)

Tool 是 Agent 可调用的外部能力（文件读写、Shell 执行、搜索等）。

```rust
#[async_trait]
pub trait ToolHandler: Send + Sync {
    /// Tool 唯一名称
    fn name(&self) -> &str;

    /// Tool 描述（用于 system prompt 中向模型说明）
    fn description(&self) -> &str;

    /// JSON Schema 定义 Tool 的参数格式
    fn parameters_schema(&self) -> serde_json::Value;

    /// 该工具调用是否具有副作用（写文件、执行命令等）
    fn is_mutating(&self) -> bool;

    /// 执行工具调用
    async fn execute(&self, input: ToolInput) -> Result<ToolOutput>;
}
```

**关键类型：**

- `ToolInput`：call_id、tool_name、arguments (serde_json::Value)
- `ToolOutput`：content (String)、is_error (bool)、metadata (可选的结构化数据)

### 3.3 SkillDefinition (Optional, zero or more)

Skill 是可复用的 prompt 模板，可以被用户显式调用（`/skill_name`）或被 Agent 隐式触发。

```rust
pub struct SkillDefinition {
    /// Skill 唯一名称（用于 /name 触发）
    pub name: String,

    /// 显示名称
    pub display_name: String,

    /// 简短描述
    pub description: String,

    /// Skill 的完整 prompt 内容
    pub prompt: String,

    /// 该 Skill 依赖的 Tool 名称列表
    pub required_tools: Vec<String>,

    /// 是否允许模型隐式调用（根据上下文自动触发）
    pub allow_implicit_invocation: bool,

    /// 来源标识（global / plugin:{id} / project）
    pub source: SkillSource,
}
```

### 3.4 Plugin (Optional, zero or more)

Plugin 是一组 Tool + Skill + 配置的打包单元，用于扩展 Agent 能力。

```rust
#[async_trait]
pub trait Plugin: Send + Sync {
    /// Plugin 唯一 ID
    fn id(&self) -> &str;

    /// 显示名称
    fn display_name(&self) -> &str;

    /// Plugin 描述
    fn description(&self) -> &str;

    /// 该 Plugin 提供的 Tool 列表
    fn tools(&self) -> Vec<Arc<dyn ToolHandler>>;

    /// 该 Plugin 提供的 Skill 列表
    fn skills(&self) -> Vec<SkillDefinition>;

    /// Plugin 初始化（在注册后、Agent 启动前调用）
    async fn initialize(&self, config: serde_json::Value) -> Result<()>;

    /// Plugin 关闭清理
    async fn shutdown(&self) -> Result<()>;
}
```

### 3.5 HookHandler (Optional, zero or more per event)

Hook 在特定事件发生时被触发，用于日志、审计、自定义逻辑注入。

```rust
#[async_trait]
pub trait HookHandler: Send + Sync {
    /// Hook 名称（调试用）
    fn name(&self) -> &str;

    /// 处理 Hook 事件，返回是否继续
    async fn handle(&self, payload: HookPayload) -> HookResult;
}
```

**Hook 事件类型：**

```rust
pub enum HookEvent {
    /// Agent 开始新一轮对话
    TurnStart,
    /// Agent 完成一轮对话
    TurnEnd,
    /// Tool 调用前
    BeforeToolUse,
    /// Tool 调用后
    AfterToolUse,
    /// 会话开始
    SessionStart,
    /// 会话结束
    SessionEnd,
    /// 上下文压缩前
    BeforeCompact,
}
```

**HookPayload** 根据事件类型携带不同数据：

```rust
pub struct HookPayload {
    pub event: HookEvent,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub data: serde_json::Value,  // 事件相关的结构化数据
    pub timestamp: DateTime<Utc>,
}

pub enum HookResult {
    /// 继续执行
    Continue,
    /// 继续执行但附带修改后的数据
    ContinueWith(serde_json::Value),
    /// 中止当前操作
    Abort(String),
}
```

### 3.6 SessionStorage (Optional, at most one)

会话持久化与发现。不注册时 Agent 仅支持内存中的单次会话。

```rust
#[async_trait]
pub trait SessionStorage: Send + Sync {
    /// 保存会话事件
    async fn save_event(&self, session_id: &str, event: SessionEvent) -> Result<()>;

    /// 加载完整会话历史
    async fn load_session(&self, session_id: &str) -> Result<Option<Vec<SessionEvent>>>;

    /// 列出会话（分页）
    async fn list_sessions(&self, cursor: Option<String>, limit: usize) -> Result<SessionPage>;

    /// 删除会话
    async fn delete_session(&self, session_id: &str) -> Result<()>;

    /// 根据 ID 前缀或名称查找会话
    async fn find_session(&self, query: &str) -> Result<Vec<SessionSummary>>;
}
```

**关键类型：**

- `SessionEvent`：时间戳 + 事件枚举（UserMessage / AssistantMessage / ToolCall / ToolResult / SystemMessage / Metadata）
- `SessionPage`：items (Vec<SessionSummary>)、next_cursor (Option<String>)
- `SessionSummary`：session_id、title、created_at、updated_at、message_count

### 3.7 MemoryStorage (Optional, at most one)

跨会话的持久化记忆。不注册时 Agent 无记忆能力。

```rust
#[async_trait]
pub trait MemoryStorage: Send + Sync {
    /// 读取所有记忆内容
    async fn load_memories(&self) -> Result<Vec<Memory>>;

    /// 保存/更新记忆
    async fn save_memory(&self, memory: Memory) -> Result<()>;

    /// 删除记忆
    async fn delete_memory(&self, memory_id: &str) -> Result<()>;

    /// 搜索相关记忆（用于注入上下文）
    async fn search_memories(&self, query: &str, limit: usize) -> Result<Vec<Memory>>;
}
```

**关键类型：**

- `Memory`：id、content、source (user / agent / system)、tags、created_at、updated_at

---

## 4. Core Components (Agent 内部)

### 4.1 Turn Loop (对话循环)

Turn Loop 是 Agent 的核心驱动逻辑：

```
用户输入 → System Prompt 构建 → 模型调用 → 流式输出
                                      ↓
                               Tool 调用请求?
                              ┌─── 是 ──────────────────────┐
                              │  执行 Tool → 结果注入上下文  │
                              │  → 再次调用模型               │
                              └──────────────────────────────┘
                              ┌─── 否 ──────────────────────┐
                              │  Turn 结束，等待下一轮输入    │
                              └──────────────────────────────┘
```

**Turn Loop 的职责：**

1. 接收用户输入（文本 / 文件 / Skill 调用）
2. 通过 Context Manager 组装完整消息历史
3. 注入 System Prompt（含 Tool 定义、Skill 列表、Memories、用户指令等）
4. 调用 Model Provider 进行流式推理
5. 处理模型返回的 Tool Call，分发到 Tool Dispatcher
6. 将 Tool 结果注入上下文，循环调用模型直到不再产生 Tool Call
7. 通过 Hook 系统在各节点发送事件
8. 通过 Session Storage 持久化事件

**并发 Tool 调用：** 当模型在单次响应中返回多个 Tool Call 时，Agent 应并发执行这些 Tool 调用（使用 `JoinSet`），然后将所有结果一起注入上下文。

### 4.2 Context Manager

Context Manager 负责管理对话上下文窗口：

- **消息历史维护**：维护有序的消息列表（user / assistant / tool_result / system）
- **Token 计数**：跟踪当前上下文的 token 使用量
- **上下文压缩（Compact）**：当上下文接近模型窗口限制时，自动压缩早期对话
  - 压缩策略由外部配置（摘要式压缩 / 截断式压缩）
  - 压缩前触发 `BeforeCompact` Hook
  - 压缩使用注册的 Model Provider 生成摘要
- **消息格式标准化**：统一不同来源的消息格式

### 4.3 System Prompt Builder

System Prompt 由以下部分按序拼接：

1. **Base Instructions**：通过 `AgentConfig.base_instructions` 配置的基础指令
2. **User Instructions**：从 `~/.youyou/AGENT.md` 和项目级 `.youyou/AGENT.md` 加载的用户指令（层级合并）
3. **Personality**：从 `~/.youyou/SOUL.md` 加载的人设定义
4. **Tool Definitions**：已注册 Tool 的名称、描述、参数 Schema
5. **Skill List**：已注册 Skill 的名称、描述、触发方式
6. **Active Plugin Info**：已启用 Plugin 的描述与能力摘要
7. **Memories**：从 Memory Storage 加载的相关记忆
8. **Environment Context**：运行环境信息（OS、工作目录、时间等）
9. **Custom Sections**：通过 Hook（`TurnStart`）动态注入的自定义段

### 4.4 Tool Dispatcher

Tool Dispatcher 负责路由和执行 Tool 调用：

- 维护 `name -> ToolHandler` 的映射
- 支持并发执行多个 Tool Call
- 执行超时控制（可配置）
- 触发 `BeforeToolUse` / `AfterToolUse` Hook
- Hook 的 `Abort` 结果会中止 Tool 执行并向模型返回错误信息

### 4.5 Skill Manager

Skill Manager 管理已注册的 Skill：

- 维护 `name -> SkillDefinition` 的映射
- 解析用户输入中的 `/skill_name` 调用
- 渲染 Skill prompt 并注入当前 Turn 的上下文
- 向 System Prompt Builder 提供 Skill 列表（供隐式调用）
- 检查 Skill 依赖的 Tool 是否已注册，未满足时返回错误

### 4.6 Plugin Manager

Plugin Manager 管理已注册的 Plugin 生命周期：

- 在 Agent 构建时调用 `plugin.initialize(config)`
- 将 Plugin 提供的 Tool 注册到 Tool Dispatcher
- 将 Plugin 提供的 Skill 注册到 Skill Manager
- 在 Agent 关闭时调用 `plugin.shutdown()`
- 维护 Plugin 启用/禁用状态

### 4.7 Memory Manager

Memory Manager 协调 Memory 的加载和写入：

- 在会话开始时从 Memory Storage 加载相关记忆
- 向 System Prompt Builder 提供记忆内容
- 在会话结束时，根据对话内容提取新记忆并保存
- 记忆提取策略可配置（由外部通过 `AgentConfig` 控制）

---

## 5. Agent Lifecycle

### 5.1 构建阶段 (Build)

```rust
let agent = AgentBuilder::new(config)
    .register_model_provider(my_openai_provider)
    .register_tool(file_read_tool)
    .register_tool(shell_exec_tool)
    .register_skill(commit_skill)
    .register_plugin(git_plugin)
    .register_hook(HookEvent::AfterToolUse, my_logger_hook)
    .register_session_storage(sqlite_storage)
    .register_memory_storage(file_memory_storage)
    .build()
    .await?;
```

**Build 阶段的校验：**

- 至少注册了一个 Model Provider
- Tool 名称无重复（Plugin 提供的 Tool 与直接注册的 Tool 之间也不能冲突）
- Skill 名称无重复
- Skill 依赖的 Tool 已注册
- 所有 Plugin 初始化成功

### 5.2 会话阶段 (Session)

```rust
// 新建会话
let session = agent.new_session(SessionConfig {
    model: "claude-sonnet-4-6".to_string(),
    system_prompt_overrides: None,
}).await?;

// 或恢复已有会话
let session = agent.resume_session("session_id").await?;

// 发送消息并获取流式响应
let mut stream = session.send_message("Hello").await?;
while let Some(event) = stream.next().await {
    match event? {
        AgentEvent::TextDelta(text) => print!("{}", text),
        AgentEvent::ToolCallStart { name, .. } => println!("[calling {}]", name),
        AgentEvent::ToolCallEnd { name, output, .. } => { /* ... */ },
        AgentEvent::TurnComplete { usage } => break,
        AgentEvent::Error(e) => eprintln!("Error: {}", e),
    }
}

// 结束会话
session.close().await?;
```

### 5.3 关闭阶段 (Shutdown)

- 所有活跃 Session 被关闭
- 触发 `SessionEnd` Hook
- 所有 Plugin 的 `shutdown()` 被调用
- 释放所有资源

---

## 6. Configuration

```rust
pub struct AgentConfig {
    /// 默认使用的模型 ID
    pub default_model: String,

    /// 默认 Model Provider ID
    pub default_provider: String,

    /// 基础 System Prompt 指令
    pub base_instructions: Option<String>,

    /// 工作目录（用于 project-level 指令加载）
    pub working_directory: PathBuf,

    /// YouYou Home 目录（默认 ~/.youyou）
    pub youyou_home: PathBuf,

    /// Tool 执行超时（毫秒）
    pub tool_timeout_ms: u64,

    /// 上下文窗口使用率阈值，超过后触发压缩（0.0 - 1.0）
    pub compact_threshold: f64,

    /// 压缩时使用的 prompt（用于指导摘要生成）
    pub compact_prompt: Option<String>,

    /// 单轮对话最大 Tool 调用次数（防止无限循环）
    pub max_tool_calls_per_turn: usize,

    /// Plugin 配置（plugin_id -> JSON config）
    pub plugin_configs: HashMap<String, serde_json::Value>,
}
```

---

## 7. Event System

Agent 通过事件流向外部通知状态变化：

```rust
pub enum AgentEvent {
    /// 文本增量输出
    TextDelta(String),
    /// 推理过程增量（如支持）
    ReasoningDelta(String),
    /// Tool 调用开始
    ToolCallStart {
        call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    /// Tool 调用结束
    ToolCallEnd {
        call_id: String,
        tool_name: String,
        output: ToolOutput,
        duration_ms: u64,
    },
    /// 上下文压缩发生
    ContextCompacted {
        before_tokens: usize,
        after_tokens: usize,
    },
    /// 当前 Turn 完成
    TurnComplete {
        usage: TokenUsage,
    },
    /// 错误
    Error(AgentError),
}
```

---

## 8. User Instruction Loading

参考 codex 的 CLAUDE.md 加载机制，YouYou Agent 支持分层指令加载：

| 层级 | 路径 | 说明 |
|------|------|------|
| Global | `~/.youyou/AGENT.md` | 用户全局指令 |
| Project | `{cwd}/.youyou/AGENT.md` | 项目级指令 |
| Personality | `~/.youyou/SOUL.md` | 人设定义 |

加载规则：
- 所有层级的指令**按序拼接**注入 System Prompt
- Project 级指令优先级高于 Global
- 任何层级的文件不存在则跳过，不报错

---

## 9. Error Handling

Agent 定义统一的错误类型：

```rust
pub enum AgentError {
    /// 没有注册 Model Provider
    NoModelProvider,
    /// 指定的模型不被任何 Provider 支持
    ModelNotSupported(String),
    /// Model Provider 调用失败
    ProviderError { provider: String, source: anyhow::Error },
    /// Tool 执行失败
    ToolExecutionError { tool_name: String, source: anyhow::Error },
    /// Tool 执行超时
    ToolTimeout { tool_name: String, timeout_ms: u64 },
    /// Tool 未找到
    ToolNotFound(String),
    /// Skill 未找到
    SkillNotFound(String),
    /// Skill 依赖的 Tool 未注册
    SkillDependencyNotMet { skill: String, missing_tool: String },
    /// Plugin 初始化失败
    PluginInitError { plugin_id: String, source: anyhow::Error },
    /// Session Storage 错误
    StorageError(anyhow::Error),
    /// 会话未找到
    SessionNotFound(String),
    /// 配置错误
    ConfigError(String),
    /// 单轮 Tool 调用次数超限
    MaxToolCallsExceeded { limit: usize },
    /// 上下文压缩失败
    CompactError(anyhow::Error),
}
```

---

## 10. Thread Safety & Concurrency

- `Agent` 是 `Send + Sync`，可在多线程间共享（通过 `Arc<Agent>`）
- 每个 `Session` 独立拥有自己的 Context Manager 和 Turn 状态
- 多个 Session 可并发运行，共享同一个 Agent 的注册表
- Tool 并发执行使用 `tokio::task::JoinSet`
- 所有 trait 要求 `Send + Sync`

---

## 11. Registration Validation Rules

| 规则 | 时机 | 行为 |
|------|------|------|
| 至少一个 ModelProvider | build() | 返回 `AgentError::NoModelProvider` |
| Tool 名称全局唯一 | register_tool() / build() | 返回 `ConfigError` |
| Skill 名称全局唯一 | register_skill() / build() | 返回 `ConfigError` |
| Skill 依赖 Tool 已注册 | build() | 返回 `SkillDependencyNotMet` |
| Plugin ID 全局唯一 | register_plugin() | 返回 `ConfigError` |
| SessionStorage 最多一个 | register_session_storage() | 覆盖已有注册 |
| MemoryStorage 最多一个 | register_memory_storage() | 覆盖已有注册 |

---

## 12. Open Questions

以下问题需要在设计阶段进一步明确：

1. **Token 计数策略**：Context Manager 的 token 计数是由 Model Provider 提供 tokenizer，还是使用近似估算？不同模型的 tokenizer 不同，如何适配？

2. **上下文压缩模型选择**：压缩上下文时使用哪个模型？是否与对话使用同一个模型，还是允许配置为更轻量的模型？

3. **Memory 提取时机与策略**：记忆提取是在每个 Turn 结束后执行，还是在 Session 结束时批量执行？提取使用的模型如何配置？

4. **流式取消**：用户中途取消请求时，如何通知 Model Provider 停止生成？已生成的部分是否保留在上下文中？

5. **Plugin 热加载**：是否需要支持运行时动态加载/卸载 Plugin？当前设计仅支持 build 阶段注册。

6. **Tool 调用鉴权**：是否需要为某些 Tool 添加调用权限控制？当前设计中所有已注册 Tool 均可被模型自由调用。

7. **多模态支持**：是否需要支持图片/文件等多模态输入？如果需要，`ChatRequest` 的消息格式需要扩展。
