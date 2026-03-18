---
title: openyouyou 的 agent 实施文档 by codex
date: 2026-03-17
description: agent 设计
category: 胡说八道
---
# YouYou Agent - Implementation Plan by Codex

| Field | Value |
|---|---|
| Document ID | 0007 |
| Type | implement |
| Status | Draft |
| Created | 2026-03-16 |
| Based On | 0005 (requirements), 0006 (design) |
| Target Module Path | `src/` |
| Tauri Mapping | 后续如需接回 `src-tauri/src/agent/`，将当前 `src/` 下 agent 相关模块整体平移到目标目录即可 |

> Source note: 当前仓库中不存在 `specs/0005_youyou_agent_demand.md`。本文按 `specs/0005_youyou_demand.md` 作为需求基线，并以其中 Appendix A 及文内标注的 Codex 参考路径作为复用依据。

---

## 1. 实施目标

本实施方案以 `specs/0006_youyou_agent_design_codex.md` 为唯一设计基线，以 `specs/0005_youyou_demand.md` 为需求和验收边界，目标是把当前几乎空白的仓库逐步落成一个可测试、可恢复、可扩展的单会话 Agent 内核。

实施原则：

- 先把协议和状态边界做对，再补主流程。
- 优先复用 `../codex` 已验证过的模板、渲染逻辑、状态管理思路和测试案例，不重复实现相同逻辑。
- 不直接依赖 `codex-core` 这样的重型 crate；优先做“源码迁移适配”而不是引入大体量耦合。
- 每个 phase 都必须可独立验证，至少包含单元测试、集成测试或示例程序中的一种。
- 当前仓库没有 `src-tauri/`，因此本轮直接在 `src/` 下按扁平模块结构落地。

---

## 2. Codex 复用策略

### 2.1 复用标记

- `[直接复用模板]`：直接复制模板或常量文本，保持语义一致。
- `[适配复用]`：迁移源码结构或算法，但按 YouYou 的协议和命名做裁剪。
- `[仅参考测试]`：不直接搬代码，但复用测试场景和断言结构。
- `[不建议直接复用]`：与 YouYou 设计不一致，不能直接引入。

### 2.2 对 `0005 Appendix A` 的实际路径校正

`0005` Appendix A 中大量路径写成了 `codex/codex-rs/core/src/...`，这在当前 `../codex` 仓库里基本成立，但有些能力应复用真实文件而不是继续沿用旧描述。下面给出本次实施的校正映射。

| 能力域 | `../codex` 真实来源 | 复用方式 | 结论 |
|---|---|---|---|
| Turn Loop | `../codex/codex-rs/core/src/codex.rs` | 看主循环拆分、事件发送、取消传播 | `[适配复用]` |
| Provider 请求协议 | `../codex/codex-rs/core/src/client_common.rs`, `../codex/codex-rs/core/src/client.rs` | 看 `Prompt`、turn-scoped session、流式请求模型 | `[适配复用]` |
| Context 历史与估算 | `../codex/codex-rs/core/src/context_manager/history.rs` | 看 history 记录、估算策略、图片过滤逻辑 | `[适配复用]` |
| Compact 协议 | `../codex/codex-rs/core/src/compact.rs`, `../codex/codex-rs/core/templates/compact/*` | 摘要模板、summary prefix、截断回退思路 | `[直接复用模板]` + `[适配复用]` |
| Skills 渲染与注入 | `../codex/codex-rs/core/src/skills/render.rs`, `../codex/codex-rs/core/src/instructions/user_instructions.rs`, `../codex/codex-rs/core/src/skills/injection.rs` | 渲染格式、`<skill>` XML 包裹、注入顺序 | `[适配复用]` |
| Plugin 渲染 | `../codex/codex-rs/core/src/plugins/render.rs` | 列表渲染格式与空集合处理 | `[适配复用]` |
| Environment Context | `../codex/codex-rs/core/src/environment_context.rs` | XML 序列化 | `[适配复用]` |
| Tool Registry / Tool Spec | `../codex/codex-rs/core/src/tools/registry.rs`, `../codex/codex-rs/core/src/tools/spec.rs` | 名称映射、mutating 判定、schema 结构 | `[适配复用]` |
| Session/Turn 状态脚手架 | `../codex/codex-rs/core/src/state/session.rs`, `../codex/codex-rs/core/src/state/turn.rs`, `../codex/codex-rs/core/src/state/service.rs` | Session/Turn scoped state 的拆分方法 | `[适配复用]` |
| Session 录制与索引 | `../codex/codex-rs/core/src/rollout/recorder.rs`, `../codex/codex-rs/core/src/rollout/session_index.rs` | append-only 事件落盘、索引查询模式 | `[适配复用]` |
| Hooks | `../codex/codex-rs/hooks/src/*` | 顺序 dispatch、abort 停止后续 handler 的基本机制 | `[适配复用]` |
| Memory 模板 | `../codex/codex-rs/core/templates/memories/*` | 读路径和提取 prompt 模板 | `[直接复用模板]` |
| Memory 管线 | `../codex/codex-rs/core/src/memories/*` | 只复用阶段划分、prompt 渲染与测试思路 | `[适配复用]` |
| 错误模型 | `../codex/codex-rs/core/src/error.rs` | 错误分类、retryable 处理方式 | `[适配复用]` |
| 验收测试场景 | `../codex/codex-rs/core/tests/suite/{skills,tool_parallelism,compact,resume,memories,plugins,turn_state,model_visible_layout}.rs` | 作为 YouYou 集成测试模板 | `[仅参考测试]` |

### 2.3 不建议直接引入的 Codex 代码

以下部分不要直接作为依赖接入：

- `codex-core`
  - 依赖图过大，包含 MCP、sandbox、cloud tasks、review、plugin marketplace 等大量非本次目标能力。
- `codex-hooks` crate
  - 当前只覆盖 `after_agent` / `after_tool_use`，与 `0006` 的 typed hook contract 不一致。
- `core/src/skills/manager.rs`
  - 面向磁盘扫描的技能系统，不符合 YouYou “全编程注册”的约束。
- `core/src/plugins/manager.rs`
  - 面向 marketplace / 本地插件目录，不符合 YouYou 的 plugin 生命周期设计。
- `core/src/memories/storage.rs`
  - 依赖文件系统布局，不符合 `MemoryStorage` trait 抽象。

结论：

- 模板、渲染器、估算算法、状态拆分和测试用例可以大量复用。
- 注册体系、typed hooks、ledger/recovery、memory mutation pipeline 必须按 `0006` 本地实现。

### 2.4 复用落地方式

为避免“名义上参考，实际上重写”，本次实施统一按下面方式落地：

- 模板类复用
  - 直接复制到 `src/support/templates/`，并在文件头标明原始来源路径。
- 小型渲染器和纯函数
  - 直接迁移源码并按 YouYou 协议改名，优先保留原测试语义。
- 状态管理和主流程
  - 只复用结构拆分和状态机思路，不直接复制大段耦合代码。
- 测试场景
  - 直接把 `../codex/codex-rs/core/tests/suite/*` 的场景翻译成 YouYou 的 fake provider/fake tool 测试，不重新设计另一套验收口径。

因此，“复用”在本项目中的默认含义不是新增对 `../codex` 的运行时依赖，而是做可追溯的源码迁移和测试迁移。

---

## 3. 建议代码布局

建议一次性建立 `src/` 下的扁平模块树，避免后续 phase 中反复搬文件：

```text
src/
├── lib.rs
├── api/
│   ├── mod.rs
│   ├── agent.rs
│   ├── builder.rs
│   ├── running_turn.rs
│   └── session.rs
├── application/
│   ├── mod.rs
│   ├── context_manager.rs
│   ├── memory_manager.rs
│   ├── plugin_manager.rs
│   ├── prompt_builder.rs
│   ├── request_builder.rs
│   ├── session_service.rs
│   ├── skill_resolver.rs
│   ├── tool_dispatcher.rs
│   └── turn_engine.rs
├── domain/
│   ├── mod.rs
│   ├── config.rs
│   ├── content.rs
│   ├── error.rs
│   ├── event.rs
│   ├── hook.rs
│   ├── ledger.rs
│   ├── memory.rs
│   ├── plugin.rs
│   ├── session.rs
│   ├── state.rs
│   ├── tool.rs
│   └── turn.rs
├── ports/
│   ├── mod.rs
│   ├── memory_storage.rs
│   ├── model.rs
│   ├── plugin.rs
│   ├── session_storage.rs
│   └── tool.rs
└── support/
    ├── mod.rs
    ├── templates/
    ├── token_estimate.rs
    └── xml.rs
tests/
├── support/
│   ├── fake_memory_storage.rs
│   ├── fake_plugin.rs
│   ├── fake_provider.rs
│   ├── fake_session_storage.rs
│   └── fake_tool.rs
├── builder_contract.rs
├── session_lifecycle.rs
├── prompt_request_builder.rs
├── turn_engine.rs
├── tool_dispatcher.rs
├── context_compaction_resume.rs
├── memory_pipeline.rs
└── acceptance.rs
```

建议补充依赖：

- `async-trait`
- `chrono` with `serde`
- `futures`
- `tokio-stream`
- `tokio-util`
- `uuid`
- `tracing`
- `indexmap`

---

## 4. 分 Phase 实施方案

下面按 8 个 phase 展开。顺序上每个 phase 都依赖前一个 phase 的可运行结果。

### Phase 1: 契约落盘与 Builder 骨架

目标：

- 把 `0006` 中的领域模型、配置模型、错误模型、ports、注册表和 `AgentBuilder` 校验逻辑落成最小可编译骨架。
- 让 “构建期失败” 提前在编译期和单元测试中稳定下来。

主要内容：

- 在 `src/lib.rs` 声明并导出根模块：`api`、`application`、`domain`、`ports`、`support`，同时按需要 re-export 对外公共 API。
- 创建 `domain/config.rs`、`domain/error.rs`、`domain/content.rs`、`domain/tool.rs`、`domain/plugin.rs`、`domain/turn.rs`、`domain/session.rs`。
- 创建 `ports/model.rs`、`ports/tool.rs`、`ports/plugin.rs`、`ports/session_storage.rs`、`ports/memory_storage.rs`。
- 实现 `api/builder.rs`，完成以下校验：
  - 至少一个 `ModelProvider`
  - provider/tool/skill/plugin 名称唯一
  - `default_model` 有效
  - `memory_namespace`、timeout、threshold 等配置合法
  - skill 依赖 tool 存在
- 只生成不可变注册表，不进入 session 生命周期。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/client_common.rs`
  - 借鉴 `Prompt` 与 tool spec 的分层，不直接照搬字段。
- `[适配复用]` `../codex/codex-rs/core/src/error.rs`
  - 借鉴错误枚举和 `retryable` 思路，落成 `AgentError`。
- `[适配复用]` `../codex/codex-rs/core/src/tools/spec.rs`
  - 借鉴 JSON schema 类型建模。

本 phase 产物：

- `AgentConfig` / `SessionConfig` / `ResolvedSessionConfig` / `AgentError`
- `ModelRegistry` / `ToolRegistry` / `SkillRegistry` / `PluginCatalog`
- `AgentBuilder::build()`

验证方式：

- `cargo test --test builder_contract`
- 核心测试点：
  - `rejects_missing_model_provider`
  - `rejects_duplicate_tool_name`
  - `rejects_duplicate_skill_name`
  - `rejects_invalid_default_model`
  - `rejects_invalid_memory_namespace`
  - `rejects_skill_missing_tool_dependency`

完成判定：

- 仓库可编译。
- 所有构建期错误码都能稳定命中。

### Phase 2: SessionRuntime、Ledger 与 SessionService

目标：

- 建立单会话运行时、事实账本、session summary 投影和 session 生命周期编排。
- 让 `new_session / resume_session / close_session / list / find / delete` 的数据边界固定下来。

主要内容：

- 实现 `AgentControl`、`SessionRuntime`、`SessionLedger`、`SessionSummaryProjection`。
- 实现 `application/session_service.rs`：
  - `new_session`
  - `resume_session`
  - `close_session`
  - `record_event`
  - `list/find/delete`
- 落地 `session_profile`、`skill_invocations`、`context_compaction`、`memory_checkpoint` metadata 协议。
- 提供 `SessionCatalog` 只读查询面。
- 先提供测试用 `InMemorySessionStorage`，再定义正式 trait 行为。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/agent/control.rs`
  - 借鉴 session slot / reservation guard 的控制思路。
- `[适配复用]` `../codex/codex-rs/core/src/state/session.rs`
  - 借鉴 session-scoped mutable state 分层。
- `[适配复用]` `../codex/codex-rs/core/src/state/service.rs`
  - 借鉴 services 容器和 session 级依赖注入思路。
- `[适配复用]` `../codex/codex-rs/core/src/rollout/recorder.rs`
  - 借鉴 append-only 持久化时序。
- `[适配复用]` `../codex/codex-rs/core/src/rollout/session_index.rs`
  - 借鉴 query projection / 查找策略。

本 phase 产物：

- `Agent::new_session()`
- `Agent::session_catalog()`
- `SessionSummary`、`LedgerEvent`、`SessionEventPayload`
- `SessionService::record_event()`

验证方式：

- `cargo test --test session_lifecycle`
- 核心测试点：
  - `new_session_writes_session_profile_first`
  - `session_busy_when_active_session_exists`
  - `close_releases_slot`
  - `resume_uses_pinned_model_and_namespace`
  - `list_find_delete_use_projection_not_runtime_guess`
  - `append_event_failure_does_not_mutate_memory_state`

完成判定：

- 不跑 turn 也能完整创建、恢复、关闭、列出 session。
- 账本和投影更新顺序符合 `0006 9.1`。

### Phase 3: SkillResolver、PromptBuilder 与 ChatRequestBuilder

目标：

- 打通 turn 级增强、system prompt 文本渲染和正式 `ChatRequest` 组装。
- 明确 “tool definitions 只走 request.tools，不进 prompt 文本”。

主要内容：

- 实现 `application/skill_resolver.rs`：
  - 只解析顶层 `Text` 块中的 `/skill_name`
  - 去重并保序
  - 输出 `ResolvedSkillInjection`
- 实现 `application/prompt_builder.rs`：
  - `system_instructions`
  - `system_prompt_override`
  - `personality`
  - Skill List
  - Active Plugin Info
  - Memories
  - Environment Context
  - Dynamic Sections
- 实现 `application/request_builder.rs`：
  - `RenderedPrompt` + `RequestContext` -> `ChatRequest`
  - `Text` / `FileContent` / `Image` 通道映射
  - `Vision` / `ToolUse` 能力预检

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/skills/render.rs`
- `[适配复用]` `../codex/codex-rs/core/src/instructions/user_instructions.rs`
- `[适配复用]` `../codex/codex-rs/core/src/plugins/render.rs`
- `[适配复用]` `../codex/codex-rs/core/src/environment_context.rs`
- `[直接复用模板]` `../codex/codex-rs/core/templates/compact/prompt.md`
- `[直接复用模板]` `../codex/codex-rs/core/templates/compact/summary_prefix.md`
- `[直接复用模板]` `../codex/codex-rs/core/templates/memories/read_path.md`

本 phase 产物：

- `SkillResolver`
- `PromptBuilder`
- `ChatRequestBuilder`
- `RenderedPrompt`
- `RequestBuildOptions`

验证方式：

- `cargo test --test prompt_request_builder`
- 核心测试点：
  - `skill_list_only_contains_allow_implicit_invocation`
  - `explicit_skill_injection_is_not_written_into_user_message`
  - `tool_definitions_only_exist_in_request_tools`
  - `file_content_uses_text_channel_without_vision`
  - `image_requires_vision_capability`
  - `allow_tools_false_sends_empty_tools`

完成判定：

- Prompt 文本可单独 snapshot。
- `ChatRequestBuilder` 不再读取原始 `AgentConfig` / `SessionConfig`，只消费 `ResolvedSessionConfig`。

### Phase 4: RunningTurn、TurnController 与基础 TurnEngine

目标：

- 实现不含 tool loop 的最小对话闭环：输入校验、provider streaming、事件序号、turn outcome、取消和 incomplete assistant message。

主要内容：

- 实现 `api/running_turn.rs` 和 `domain/event.rs`。
- 实现 `TurnController` 幂等取消。
- 实现 `application/turn_engine.rs` 的基础路径：
  - 输入校验
  - 写入 `UserMessage`
  - 调用 provider
  - 转发 `TextDelta` / `ReasoningDelta`
  - 写入最终 `AssistantMessage`
  - 处理中途取消并标记 `status=incomplete`
- 暂时不进入 tools / compact / memory checkpoint，只保证基础 turn 能走通。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/codex.rs`
  - 看 turn loop 的组织方式和 provider 消费方式。
- `[适配复用]` `../codex/codex-rs/core/src/client.rs`
  - 借鉴 session-scoped client + turn-scoped request session。
- `[适配复用]` `../codex/codex-rs/core/src/state/turn.rs`
  - 借鉴 active turn / cancellation token / pending state 拆分。

本 phase 产物：

- `SessionHandle::send_message()`
- `RunningTurn`
- `TurnOutcome`
- `AgentEventEnvelope`

验证方式：

- `cargo test --test turn_engine`
- 核心测试点：
  - `text_delta_sequence_starts_from_one`
  - `turn_complete_is_last_event`
  - `cancel_is_idempotent`
  - `cancelled_turn_persists_incomplete_assistant_message`
  - `turn_busy_when_active_turn_exists`
  - `input_validation_rejects_empty_or_invalid_image`

完成判定：

- 前端或示例程序可以消费事件流并等待 `join()`。
- 取消后的事件和最终 outcome 与 `0006 11.2` 一致。

### Phase 5: Typed Hooks、PluginManager 与 ToolDispatcher

目标：

- 打通 tool loop、typed hook contract、plugin 生命周期和 tool 并发/串行策略。
- 固化 `RequestedToolBatch -> ResolvedToolCall` 协议。

主要内容：

- 实现 `domain/hook.rs` 和 `application/plugin_manager.rs`。
- 实现 typed `PluginRegistrar` 与 hook dispatch 机制。
- 实现 `application/tool_dispatcher.rs`：
  - `BeforeToolUse` patch
  - `AfterToolUse`
  - mutating 串行 / read-only 并发
  - synthetic cancelled tool output
  - 1MB tool output truncation
- 在 `TurnEngine` 中接入 tool loop。
- 增加 `max_tool_calls_per_turn` 收尾请求逻辑。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/hooks/src/registry.rs`
  - 借鉴顺序 dispatch 和 abort 即停。
- `[适配复用]` `../codex/codex-rs/hooks/src/types.rs`
  - 借鉴 payload/response 序列化方式，但本地实现 typed patch。
- `[适配复用]` `../codex/codex-rs/core/src/tools/registry.rs`
  - 借鉴 registry + dispatch 结构。
- `[适配复用]` `../codex/codex-rs/core/src/tools/spec.rs`
  - 借鉴 tool spec / schema 输出。
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/tool_parallelism.rs`

本 phase 产物：

- `PluginManager`
- `HookRegistry`
- `ToolDispatcher`
- `RequestedToolBatch`
- `ResolvedToolCall`

验证方式：

- `cargo test --test tool_dispatcher`
- 核心测试点：
  - `before_tool_use_patch_updates_effective_arguments`
  - `tool_call_start_arguments_equal_effective_arguments`
  - `read_only_tools_execute_in_parallel`
  - `mutating_tools_execute_serially_in_model_order`
  - `tool_output_truncates_at_1mb_with_fixed_suffix`
  - `before_tool_use_abort_returns_synthetic_error_output`
  - `after_tool_use_abort_stops_followup_tool_loop`
  - `max_tool_calls_limit_triggers_tools_disabled_final_request`

完成判定：

- 进入 tool loop 后，账本、事件流、真实执行参数三者一致。
- hooks 和 plugins 已成为稳定协议，不再依赖外部框架。

### Phase 6: ContextManager、Compact 与 Resume 一致性

目标：

- 落实 `ContextState + CompactionRecord + CurrentTurn Preservation + shared rebuild functions`。
- 确保实时 compact 与 resume 重建得到同一份模型可见上下文。

主要内容：

- 实现 `application/context_manager.rs`。
- 实现：
  - `rebuild_visible_messages()`
  - `build_request_context()`
  - `render_compaction_summary()`
  - request 级 token 估算
  - 摘要 compact
  - truncation fallback
  - `ContextLengthExceeded` 单次重试
- 恢复路径统一走相同的 rebuild 逻辑。
- 处理多条 incomplete assistant message 的取消提示回放。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/context_manager/history.rs`
  - 借鉴 token 估算和 history 过滤思路。
- `[适配复用]` `../codex/codex-rs/core/src/compact.rs`
  - 借鉴 compact 请求、摘要注入、回退策略。
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/compact.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/compact_resume_fork.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/resume.rs`

本 phase 产物：

- `ContextState`
- `CompactionRecord`
- `CompactionMode`
- `RequestContext`
- `ContextCompacted` 事件

验证方式：

- `cargo test --test context_compaction_resume`
- 核心测试点：
  - `summary_compaction_resume_matches_live_projection`
  - `truncation_compaction_resume_matches_live_projection`
  - `current_turn_anchor_is_preserved_during_compact`
  - `compact_error_when_pinned_range_alone_exceeds_budget`
  - `incomplete_assistant_message_replays_with_cancel_notice`
  - `request_estimated_tokens_includes_prompt_and_augmentations`

完成判定：

- compact 触发、resume 恢复、tool loop 中重建请求三条链路使用同一套函数。

### Phase 7: MemoryManager、Checkpoint 与 Close 提取

目标：

- 落实 `SessionMemoryState + MemoryMutationPipeline`，打通启动 bootstrap、turn search、checkpoint 和 close 提取。

主要内容：

- 实现 `application/memory_manager.rs`。
- 实现：
  - `load_bootstrap_memories()`
  - `prepare_turn_memories()`
  - `run_checkpoint_extraction()`
  - `run_close_extraction()`
- 使用 `memory_checkpoint` metadata 保存进度。
- 只对显式 `Text` 块做 search query，`FileContent` 和纯图片跳过 search。
- 提供测试用 `InMemoryMemoryStorage`。

Codex 复用：

- `[直接复用模板]` `../codex/codex-rs/core/templates/memories/stage_one_system.md`
- `[直接复用模板]` `../codex/codex-rs/core/templates/memories/stage_one_input.md`
- `[适配复用]` `../codex/codex-rs/core/src/memories/prompts.rs`
  - 借鉴 prompt 渲染方式。
- `[适配复用]` `../codex/codex-rs/core/src/memories/mod.rs`
  - 借鉴读写路径拆分。
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/memories.rs`

本 phase 产物：

- `SessionMemoryState`
- `MemoryMutation`
- `MemoryManager`
- memory checkpoint ledger metadata

验证方式：

- `cargo test --test memory_pipeline`
- 核心测试点：
  - `bootstrap_uses_list_recent_order_without_reordering`
  - `search_only_uses_explicit_text_blocks`
  - `file_content_and_image_skip_memory_search`
  - `checkpoint_uses_ledger_seq_window`
  - `checkpoint_updates_last_memory_checkpoint_seq_after_success`
  - `close_extraction_failure_does_not_block_session_close`

完成判定：

- `close_session()` / `shutdown()` 都能在 memory 失败时继续收尾。
- memory 注入和 memory 提取都只依赖 `ResolvedSessionConfig`。

### Phase 8: 验收收口、示例与文档

目标：

- 对齐 `0006` 第 12 节验收重点，补足缺失的端到端测试和最小示例。
- 把库变成“可被外部工程实际接入”的状态。

主要内容：

- 建立 `tests/acceptance.rs`，逐项覆盖 `0006` 的关键验收条目。
- 补一个最小示例：
  - fake provider
  - fake tool
  - in-memory storages
  - 一个 session 的创建、发送、取消、恢复
- 更新 `README.md` 或新增 `examples/README.md`，说明：
  - 如何注册 provider/tool/skill/plugin/storage
  - 如何消费 `RunningTurn.events`
  - 如何实现自定义 `SessionStorage` / `MemoryStorage`
- 如有必要，补 `cargo fmt --check`、`cargo clippy` 到 CI。

Codex 复用：

- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/{skills,tool_parallelism,compact,resume,memories,plugins,turn_state,model_visible_layout}.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/common/*`
  - 只借鉴 fake server / SSE mock / snapshot 验证思路，不直接引入 workspace 依赖。

本 phase 产物：

- `tests/acceptance.rs`
- `examples/minimal_agent.rs` 或等价示例
- 项目级接入文档

验证方式：

- `cargo test`
- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`

完成判定：

- `0006 12. 验收重点` 中至少前 30 条均有对应测试。
- 外部调用方无需阅读内部实现即可完成接入。

---

## 5. Phase 依赖关系

| Phase | 依赖 | 不能提前的原因 |
|---|---|---|
| Phase 1 | 无 | 需要先固定协议、注册表和错误码 |
| Phase 2 | Phase 1 | SessionService 必须依赖已稳定的 config / error / ports |
| Phase 3 | Phase 1, 2 | Prompt/Request 构建需要 session config 和 registry |
| Phase 4 | Phase 2, 3 | TurnEngine 必须建立在 session 和 request builder 之上 |
| Phase 5 | Phase 4 | tool loop 与 hook 需要 running turn、event stream、provider 消费框架 |
| Phase 6 | Phase 3, 4, 5 | compact/rebuild 要依赖真实 turn/tool/ledger 数据流 |
| Phase 7 | Phase 2, 3, 4, 6 | memory 读写依赖 session config、ledger seq、close/shutdown 语义 |
| Phase 8 | 全部 | 最终验收必须建立在所有主链路完成后 |

---

## 6. 建议的首批任务拆分

如果按实际开发节奏推进，建议先提交以下 3 个 PR，再进入后续 phase：

1. `PR-1`：Phase 1 全量完成
2. `PR-2`：Phase 2 + Phase 3 完成，能 new session 并构建 request
3. `PR-3`：Phase 4 完成，能跑无 tool 的基础多轮对话

原因：

- 这样可以最早暴露协议设计问题。
- `Phase 5-7` 都依赖前面三步的边界稳定。
- 当前仓库是空骨架，先把“能编译、能建会话、能发请求”做出来，比一开始就追求 compact/memory 更稳妥。

---

## 7. 风险与控制点

主要风险：

- Hook 契约与 plugin 生命周期容易在实现时重新耦合到 runtime 私有状态。
- compact 与 resume 若分叉实现，后续一定会出现上下文漂移。
- tool loop 中 `requested_arguments` / `effective_arguments` / 真实执行参数不一致，会直接破坏审计和恢复。
- memory pipeline 最容易被“先做简单版”带偏，必须从第一版就使用 ledger seq 做 checkpoint 边界。

控制策略：

- 所有 request build 都只能经过 `PromptBuilder + ChatRequestBuilder`。
- 所有恢复都只能经过 `SessionLedger + rebuild_visible_messages()`。
- 所有 tool 调用都必须先生成 `ResolvedToolCall` 再发事件、记账和执行。
- 所有 phase 都先写测试桩，再写实现。

---

## 8. 最终结论

推荐按 8 个 phase 实施，而不是一次性把 `TurnEngine + Tool + Compact + Memory` 全部同时落地。这样可以保证：

- 每个阶段都能验证，不会在空仓库里堆出难以调试的大块代码。
- `../codex` 中真正值得复用的能力都被明确标出来了：模板、渲染器、状态拆分、估算算法和测试案例。
- 与 YouYou 设计不一致的 Codex 子系统没有被误引入，例如磁盘扫描型 skills、marketplace 型 plugins、文件系统型 memories。

按本方案推进，Phase 4 结束时就会得到一个可用的基础 Agent；Phase 6 结束时，核心协议基本闭环；Phase 8 结束时，可以对照 `0006` 的验收条目做完整收口。
