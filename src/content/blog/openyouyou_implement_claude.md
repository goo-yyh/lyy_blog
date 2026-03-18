---
title: openyouyou 的 agent 实施文档 by claude
date: 2026-03-17
description: agent 设计
category: 胡说八道
---
# YouYou Agent - Implementation Plan by Claude

| Field | Value |
|---|---|
| Document ID | 0007-claude |
| Type | implement |
| Status | Draft |
| Created | 2026-03-16 |
| Based On | `0005_youyou_demand.md`, `0006_youyou_agent_design_claude.md` |
| Target Module Path | `/src` |
| Note | 当前仓库是 Rust library crate，因此 crate root 使用 `src/lib.rs`；其余模块结构按 `0006` 的 `/src/{api,application,domain,ports,prompt}` 落地 |

## 1. 实施目标

本实施方案以 `0006_youyou_agent_design_claude.md` 作为唯一设计基线，以 `0005_youyou_demand.md` 作为需求和验收边界，目标是在当前几乎空白的仓库中，按可验证、可恢复、可扩展的顺序落地单会话 Agent 内核。

实施原则：

- 先固定公共契约、状态边界和持久化协议，再实现长链路编排。
- 严格按 `0006` 的四层结构落地，不在本轮引入额外中间层或重型框架。
- 优先复用 `../codex` 已验证过的模板、纯函数、状态拆分思路和测试场景；不重复实现等价逻辑。
- 不直接依赖 `codex-core` 或 `codex-hooks` 作为运行时依赖，默认采用“源码迁移 + 适配”的方式复用。
- 每个 phase 都必须能单独验证，至少落一个可执行的测试入口。

## 2. 约束与前提

- 当前目录结构以本仓库现状为准，所有 agent 代码都写在 `/src` 下，不再使用旧的 `src-tauri/src/agent/` 路径。
- `0006` 中的核心约束必须在实施顺序中优先体现：
  - 双层锁模型：`AgentControl` 用 `std::sync::Mutex`，`SessionRuntime` 用 `tokio::sync::Mutex`
  - `SessionLedger` 是事实源，`ContextManager` 只是投影
  - `TurnEngine` 是唯一编排者
  - 关键事件必须先持久化，再写入内存投影
  - 恢复只依赖 Ledger 重放
- 本轮不做：
  - 多 Session 并行
  - 动态注册/卸载 Provider、Tool、Skill、Plugin
  - v2 两阶段 Memory consolidation
  - 快照恢复协议
  - 内建的文件系统/数据库/网络 adapter

## 3. Codex 复用策略

### 3.1 复用标记

- `[直接复用模板]`：直接迁移模板或常量文本，语义保持一致。
- `[适配复用]`：迁移源码结构、算法或测试骨架，但按 YouYou 的 trait、命名和状态协议裁剪。
- `[仅参考测试]`：不直接搬实现，只复用测试场景、断言口径或 fake 组件组织方式。
- `[不直接复用]`：能力边界与 `0006` 不一致，不能直接引入。

### 3.2 建议复用清单

| 能力域 | `../codex` 真实来源 | 复用方式 | 说明 |
|---|---|---|---|
| Turn loop 主流程 | `../codex/codex-rs/core/src/codex.rs` | `[适配复用]` | 参考流式消费、tool loop、取消传播和事件发射时序 |
| Provider 请求模型 | `../codex/codex-rs/core/src/client.rs`, `../codex/codex-rs/core/src/client_common.rs` | `[适配复用]` | 参考 `Prompt`/请求结构拆分，不直接照搬字段 |
| Session/Turn 状态拆分 | `../codex/codex-rs/core/src/agent/control.rs`, `../codex/codex-rs/core/src/state/{session,turn,service}.rs` | `[适配复用]` | 参考状态所有权切分；实际实现按 `0006` 双锁模型重写 |
| Ledger 持久化和索引 | `../codex/codex-rs/core/src/rollout/{recorder,session_index}.rs` | `[适配复用]` | 参考 append-only 写入顺序和 list/find 组织方式 |
| Context 历史和估算 | `../codex/codex-rs/core/src/context_manager/history.rs` | `[适配复用]` | 复用估算与可见历史过滤思路 |
| Compact 协议 | `../codex/codex-rs/core/src/compact.rs` | `[适配复用]` | 复用摘要 compact 和 truncation fallback 的思路 |
| Compact 模板 | `../codex/codex-rs/core/templates/compact/{prompt,summary_prefix}.md` | `[直接复用模板]` | 直接放入 `src/prompt/templates.rs` 或等价常量 |
| Skill 列表/注入渲染 | `../codex/codex-rs/core/src/skills/{render,injection}.rs`, `../codex/codex-rs/core/src/instructions/user_instructions.rs` | `[适配复用]` | 复用 section 文案结构和 `<skill>` 注入格式 |
| Plugin 列表渲染 | `../codex/codex-rs/core/src/plugins/render.rs` | `[适配复用]` | 只复用 section 渲染格式，不复用 marketplace/plugin bundle 语义 |
| Environment Context XML | `../codex/codex-rs/core/src/environment_context.rs` | `[适配复用]` | 直接复用 XML 序列化思路 |
| Tool spec/registry | `../codex/codex-rs/core/src/tools/{spec,registry}.rs` | `[适配复用]` | 复用 schema 输出和 registry 组织方式 |
| Hook 顺序分发 | `../codex/codex-rs/hooks/src/{registry,types}.rs` | `[适配复用]` | 仅复用顺序 dispatch 和 abort 即停；typed patch 合同本地实现 |
| Memory prompt 模板 | `../codex/codex-rs/core/templates/memories/{read_path,stage_one_system,stage_one_input,consolidation}.md` | `[直接复用模板]` | `v1` 直接用前 3 个；`consolidation` 只保留升级位 |
| Memory prompt/render 管线 | `../codex/codex-rs/core/src/memories/{prompts,mod,phase1}.rs` | `[适配复用]` | 复用 prompt 渲染和测试组织，不复用文件系统写路径 |
| 验收测试场景 | `../codex/codex-rs/core/tests/suite/{skills,tool_parallelism,compact,resume,memories,plugins,turn_state,model_visible_layout}.rs` | `[仅参考测试]` | 直接翻译成 YouYou 的 integration tests |

### 3.3 不建议直接复用的部分

- `../codex/codex-rs/core/src/plugins/manager.rs`
  - 面向插件市场、本地 bundle 和 capability 聚合，不符合 `0006` 的 typed plugin lifecycle。
- `../codex/codex-rs/core/src/skills/manager.rs`
  - 依赖文件系统扫描，与 YouYou 的纯编程注册模型不符。
- `../codex/codex-rs/hooks` crate 的公共接口
  - 当前只覆盖有限 hook 类型，不满足 `0006` 的 `TurnStart/BeforeToolUse/BeforeCompact/...` typed payload 契约。
- `../codex/codex-rs/core/src/memories/storage.rs`
  - 基于文件系统布局，不符合 `MemoryStorage` trait 抽象。

### 3.4 复用落地方式

- 模板类内容统一放入 `src/prompt/templates.rs`，并在注释中标明原始来源。
- 小型渲染器和纯函数直接迁移到 `src/application/*` 或 `src/prompt/templates.rs`，优先保留原有测试语义。
- 状态机和编排逻辑只复用拆分方式，不复制与 Codex 运行环境强耦合的实现。
- 测试优先参考 `../codex/codex-rs/core/tests/suite/*` 的场景，而不是重新发明新的验收口径。

## 4. 建议目录落地

按 `0006` 的模块结构在当前 crate 中落地，crate root 使用 `src/lib.rs`：

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
│   ├── hook_registry.rs
│   ├── memory_manager.rs
│   ├── plugin_manager.rs
│   ├── prompt_builder.rs
│   ├── skill_manager.rs
│   ├── tool_dispatcher.rs
│   └── turn_engine.rs
├── domain/
│   ├── mod.rs
│   ├── config.rs
│   ├── error.rs
│   ├── event.rs
│   ├── hook.rs
│   ├── ledger.rs
│   ├── state.rs
│   └── types.rs
├── ports/
│   ├── mod.rs
│   ├── model.rs
│   ├── plugin.rs
│   ├── storage.rs
│   └── tool.rs
└── prompt/
    ├── mod.rs
    └── templates.rs
tests/
├── builder_contract.rs
├── session_lifecycle.rs
├── prompt_layout.rs
├── turn_engine.rs
├── tool_hooks.rs
├── compact_resume.rs
├── memory_pipeline.rs
└── acceptance.rs
```

推荐在 Phase 1 一次性补齐依赖：

- `async-trait`
- `chrono` with `serde`
- `futures`
- `indexmap`
- `tokio-stream`
- `tokio-util`
- `tracing`
- `uuid`

## 5. 分 Phase 实施方案

下面按 8 个 phase 展开。每个 phase 都能单独验收，并且后一个 phase 只建立在前一个 phase 已稳定的契约之上。

### Phase 1: 领域契约、Ports 与 Builder 骨架

目标：

- 先把 `0006` 中的 domain/ports/API 契约落地为可编译骨架。
- 把所有构建期错误提前固定，避免后续 phase 一边写主流程一边改契约。

具体内容：

- 建立 `src/lib.rs` 与 `src/{api,application,domain,ports,prompt}/mod.rs`。
- 落地 `domain/types.rs`、`domain/config.rs`、`domain/error.rs`、`domain/event.rs`、`domain/hook.rs`、`domain/ledger.rs`、`domain/state.rs`。
- 落地 `ports/model.rs`、`ports/tool.rs`、`ports/plugin.rs`、`ports/storage.rs`。
- 在 `api/builder.rs` 中实现：
  - provider/tool/skill/plugin 唯一性校验
  - `default_model`、`compact_model`、`memory_model` 的存在性校验
  - `compact_threshold`、`tool_timeout_ms`、`memory_checkpoint_interval`、`memory_max_items`、`memory_namespace` 等配置值校验
  - skill 依赖 tool 校验
  - plugin 初始化、apply 回滚协议的最小骨架
- 只产出不可变注册表和 `Agent` 壳结构，不进入 session/runtime。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/client_common.rs`
- `[适配复用]` `../codex/codex-rs/core/src/error.rs`
- `[适配复用]` `../codex/codex-rs/core/src/tools/spec.rs`

验证方式：

- `cargo test --test builder_contract`
- 关键测试：
  - `rejects_missing_model_provider`
  - `rejects_duplicate_model_id_across_providers`
  - `rejects_duplicate_tool_name`
  - `rejects_duplicate_skill_name`
  - `rejects_invalid_default_model`
  - `rejects_invalid_compact_threshold`
  - `rejects_invalid_memory_namespace`
  - `rejects_skill_missing_tool_dependency`
  - `plugin_initialize_failure_rolls_back_prior_plugins`

完成判定：

- `AgentBuilder<HasProvider>::build()` 可以稳定返回 `Agent` 或结构化 `AgentError`。
- 后续 phase 不再需要改公共 trait 或错误码。

### Phase 2: AgentControl、SessionRuntime 与 Ledger 持久化协议

目标：

- 落实 `0006` 的双锁模型、单会话槽和 `SessionLedger` 事实源。
- 在不进入 turn loop 的前提下，先把 `new_session / resume_session / close / list / find / delete` 的生命周期和恢复协议固定。

具体内容：

- 实现 `AgentControl`、`SessionSlotState`、`RunningTurnHandle`、`SessionRuntime`、`SessionLedger`。
- 在 `api/agent.rs` 与 `api/session.rs` 中实现：
  - `new_session()`
  - `resume_session()`
  - `shutdown()` 的最小骨架
  - `list_sessions()` / `find_sessions()` / `delete_session()`
- 实现 `MetadataKey::{SessionConfig, MemoryNamespace, ContextCompaction, MemoryCheckpoint}`。
- 建立统一写入 helper：
  - 关键事件先 `SessionStorage.save_event()`
  - 成功后再 append 到内存 ledger
  - 最后更新 `ContextManager` 投影占位
- 落地恢复协议：
  - resume 从 Ledger 恢复 `model_id`、`system_prompt_override`、`memory_namespace`
  - `memory_namespace` 优先以 Ledger Metadata 为准
  - `SessionSummary` 采用 adapter 最终一致模型

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/agent/control.rs`
- `[适配复用]` `../codex/codex-rs/core/src/state/{session,service}.rs`
- `[适配复用]` `../codex/codex-rs/core/src/rollout/{recorder,session_index}.rs`

验证方式：

- `cargo test --test session_lifecycle`
- 关键测试：
  - `new_session_claims_slot_with_reservation`
  - `session_start_abort_rolls_back_reserved_slot`
  - `resume_restores_pinned_model_and_memory_namespace`
  - `critical_metadata_persist_failure_aborts_session_creation`
  - `session_busy_when_active_session_exists`
  - `delete_active_session_returns_session_busy`
  - `discovery_apis_require_session_storage`
  - `summary_is_eventually_consistent_with_ledger`

完成判定：

- 还没有 turn，也能完整创建、恢复、关闭、列出和删除 session。
- `SessionLedger` 成为后续所有 phase 的事实源。

### Phase 3: SkillManager、PromptBuilder 与 Prompt 模板落地

目标：

- 固定 system prompt 的组装顺序和 skill 注入协议。
- 把 `0005 Appendix B` 中可复用的 prompt 模板正式落入代码。

具体内容：

- 实现 `application/skill_manager.rs`：
  - 解析 `UserInput` 中 `ContentBlock::Text` 的 `/skill_name`
  - 返回 `SkillDefinition` 列表和未识别 skill 名称
  - 渲染 `<skill>` 注入消息
- 实现 `application/prompt_builder.rs`：
  - 严格按 `0005 §5.3` 顺序组装：
    1. `system_instructions`
    2. `system_prompt_override`
    3. `personality`
    4. skill list
    5. plugin list
    6. memories
    7. environment context
    8. dynamic sections
  - tool definitions 仅通过 `ChatRequest.tools` 暴露，不进入 prompt 文本
- 在 `prompt/templates.rs` 中落地：
  - compact prompt
  - compact summary prefix
  - memory read_path
  - memory stage_one_system
  - memory stage_one_input
  - `consolidation` 作为保留模板
- 在 `ports/model.rs` 中补齐 `ChatRequest`/`ChatEvent` 的最小可用结构，供后续 turn loop 使用。

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/skills/render.rs`
- `[适配复用]` `../codex/codex-rs/core/src/instructions/user_instructions.rs`
- `[适配复用]` `../codex/codex-rs/core/src/plugins/render.rs`
- `[适配复用]` `../codex/codex-rs/core/src/environment_context.rs`
- `[直接复用模板]` `../codex/codex-rs/core/templates/compact/{prompt,summary_prefix}.md`
- `[直接复用模板]` `../codex/codex-rs/core/templates/memories/{read_path,stage_one_system,stage_one_input,consolidation}.md`

验证方式：

- `cargo test --test prompt_layout`
- 关键测试：
  - `implicit_skill_list_only_contains_allow_implicit_invocation`
  - `unknown_skill_fails_before_turn_starts`
  - `system_prompt_sections_follow_requirement_order`
  - `tool_definitions_do_not_appear_in_prompt_text`
  - `environment_context_serializes_to_expected_xml`
  - `personality_is_wrapped_with_personality_spec_tag`

完成判定：

- Prompt 组装顺序与 `0005/0006` 固定。
- 所有模板都已有代码落点，不再在后续 phase 中散落定义。

### Phase 4: RunningTurn 与无 Tool 的最小 TurnEngine

目标：

- 先打通最小对话闭环：输入校验、事件流、provider streaming、turn outcome、取消和 incomplete assistant message。
- 暂时不接入 tool loop、compact、memory checkpoint，先把 `RunningTurn` 和 `TurnOutcome` 做稳。

具体内容：

- 实现 `api/running_turn.rs`。
- 在 `application/turn_engine.rs` 中实现基础路径：
  - `TurnStart` 前的输入校验
  - `UserMessage` 持久化
  - provider 流式消费 `TextDelta` / `ReasoningDelta`
  - assistant 最终输出持久化为 `AssistantMessage`
  - 用户取消时持久化 `AssistantMessage(status=Incomplete)`
  - 最终返回 `TurnOutcome::{Completed, Cancelled, Failed, Panicked}`
- 在 `api/session.rs` 中实现 `send_message()`：
  - 锁外做输入校验与 skill 解析
  - 锁内做 turn 原子启动
  - 两层 task supervisor，保证 panic 时能回收 `turn_state`

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/codex.rs`
- `[适配复用]` `../codex/codex-rs/core/src/client.rs`
- `[适配复用]` `../codex/codex-rs/core/src/state/turn.rs`

验证方式：

- `cargo test --test turn_engine`
- 关键测试：
  - `turn_complete_is_last_event`
  - `event_sequence_is_monotonic_per_turn`
  - `cancel_is_idempotent`
  - `cancelled_turn_persists_incomplete_assistant_message`
  - `join_returns_outcome_after_events_are_consumed`
  - `turn_busy_when_active_turn_exists`
  - `invalid_multimodal_input_fails_before_turn_spawn`

完成判定：

- 从 `SessionHandle::send_message()` 到 `RunningTurn::join()` 的基础链路可用。
- 取消协议和 `incomplete` 持久化已经固定。

### Phase 5: HookRegistry、PluginManager 与 ToolDispatcher

目标：

- 打通 typed hook contract、plugin 生命周期和 tool 执行批次。
- 让 `TurnEngine` 具备完整的 tool loop，符合 `0006` 的并发、超时、取消和 synthetic result 语义。

具体内容：

- 实现 `application/hook_registry.rs`：
  - 顺序 dispatch
  - `Abort` 立即停止后续 handler
  - `TurnStart` patch append-only
  - `BeforeToolUse` patch last-write-wins
- 实现 `application/plugin_manager.rs`：
  - `initialize -> apply -> runtime -> shutdown`
  - apply 阶段 hook 合同校验
- 实现 `application/tool_dispatcher.rs`：
  - tool registry lookup
  - mutating 串行、只读并行
  - per-tool timeout token
  - output 总预算和 metadata 子限额
  - `BeforeToolUse` / `AfterToolUse`
  - synthetic skipped/cancelled tool results
- 将 tool loop 接入 `TurnEngine`：
  - provider 返回 `ToolCall`
  - 记账 `ToolCall`
  - 执行工具并记账 `ToolResult`
  - 超过 `max_tool_calls_per_turn` 时注入超限提示并走 tools-empty 收尾请求

Codex 复用：

- `[适配复用]` `../codex/codex-rs/hooks/src/{registry,types}.rs`
- `[适配复用]` `../codex/codex-rs/core/src/tools/{registry,spec}.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/tool_parallelism.rs`

验证方式：

- `cargo test --test tool_hooks`
- 关键测试：
  - `turn_start_patch_appends_dynamic_sections_in_order`
  - `before_tool_use_patch_updates_effective_arguments`
  - `read_only_tools_execute_in_parallel`
  - `mutating_tools_execute_in_model_order`
  - `mutating_batch_short_circuits_after_failure`
  - `tool_timeout_cancels_only_timeout_token`
  - `after_tool_use_abort_stops_follow_up_loop`
  - `tool_output_respects_total_and_metadata_budgets`
  - `max_tool_calls_exceeded_injects_limit_message_and_returns_failed_outcome`

完成判定：

- Tool loop、hook、plugin 的公共协议不再变化。
- 事件流、真实执行参数和 ledger 三者保持一致。

### Phase 6: ContextManager、Compact 与 Resume 一致性

目标：

- 落实 `ContextManager` 作为 `SessionLedger` 投影的职责。
- 实现 compact、truncation fallback 和 resume 重建一致性。

具体内容：

- 实现 `application/context_manager.rs`：
  - `rebuild_from_ledger()`
  - `push()`
  - `needs_compaction()`
  - `generate_compaction_marker()`
  - `apply_compaction_marker()`
- 在 `TurnEngine` 中接入 compact 编排：
  - 预估触发
  - `context_length_exceeded` 兜底触发
  - `BeforeCompact` hook
  - 关键事件 `Metadata(ContextCompaction)` 持久化
  - `ContextCompacted` 事件
- 落实 `CompactionMarker { replaces_through_seq, rendered_summary }`
  - `Summary Compaction`
  - `Truncation Fallback`
- 恢复路径严格只重放：
  - 最新 compaction marker
  - `seq > replaces_through_seq` 的消息事件
  - `AssistantMessage(status=Incomplete)` 后追加恢复提示

Codex 复用：

- `[适配复用]` `../codex/codex-rs/core/src/context_manager/history.rs`
- `[适配复用]` `../codex/codex-rs/core/src/compact.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/{compact,compact_resume_fork,resume}.rs`

验证方式：

- `cargo test --test compact_resume`
- 关键测试：
  - `summary_compaction_resume_matches_live_projection`
  - `truncation_compaction_resume_matches_live_projection`
  - `before_compact_abort_skips_only_estimate_trigger`
  - `context_length_exceeded_retry_happens_once`
  - `incomplete_message_resume_appends_cancel_notice_without_writing_ledger`
  - `compact_marker_is_not_applied_if_persistence_fails`

完成判定：

- 实时路径和恢复路径使用同一套可见上下文规则。
- compact 成功/失败、abort、fallback 的边界全部固定。

### Phase 7: MemoryManager、Checkpoint 与 Session Close 提取

目标：

- 完成 `0006` 里的 memory bootstrap、turn search、checkpoint 和 close extraction。
- 保证 memory 流程不破坏 session close 和 turn 正常收尾。

具体内容：

- 实现 `application/memory_manager.rs`：
  - `list_recent()` 加载 bootstrap memories
  - turn 开始前按文本 query 做 `search()`
  - bootstrap + query memories 去重合并
  - checkpoint 按 ledger seq 提取增量
  - close 时做收尾提取
- 实现 `ExtractionResult` 和 `MemoryOperation::{Create,Update,Delete}` 的 JSON 解析。
- 落实执行策略：
  - update 找不到 `target_id` 时降级为 create
  - delete 找不到 `target_id` 时跳过
  - 提取失败只记 warn，不阻断 close
- 在 turn 结束与 session close 中接入 `MemoryCheckpoint` metadata。

Codex 复用：

- `[直接复用模板]` `../codex/codex-rs/core/templates/memories/{stage_one_system,stage_one_input,read_path}.md`
- `[适配复用]` `../codex/codex-rs/core/src/memories/{prompts,mod,phase1}.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/memories.rs`

验证方式：

- `cargo test --test memory_pipeline`
- 关键测试：
  - `bootstrap_memories_follow_list_recent_order`
  - `search_uses_only_explicit_text_blocks`
  - `pure_image_or_file_turn_skips_memory_search`
  - `checkpoint_uses_ledger_seq_not_message_index`
  - `update_missing_target_id_degrades_to_create`
  - `delete_missing_target_id_is_ignored`
  - `close_extraction_failure_does_not_block_session_close`
  - `resume_reuses_pinned_memory_namespace_from_ledger`

完成判定：

- Memory 读取和写入都已打通，但仍与主对话可解耦失败。
- `memory_namespace` 的会话绑定得到验证。

### Phase 8: 验收收口、示例与文档

目标：

- 按 `0006` 的验收重点做一次端到端收口。
- 把库整理成“外部项目可直接接入”的状态。

具体内容：

- 编写 `tests/acceptance.rs`，覆盖以下高风险场景：
  - `shutdown()` 与 `new_session()` 并发
  - `SessionStart` hook abort 回滚
  - compact 后 resume 一致性
  - cancel 发生在模型流式中 / 只读 tool 中 / mutating tool 中
  - 关键事件持久化失败即终止 turn
  - `AfterToolUse` abort 的串行/并行差异
  - `MAX_TOOL_CALLS_EXCEEDED` 收尾路径
  - plugin 初始化失败回滚
  - synthetic message 的 ledger 恢复一致性
- 增加 `examples/minimal_agent.rs` 或等价最小示例：
  - fake provider
  - fake tool
  - in-memory storage
  - session create -> send -> cancel -> resume -> close
- 更新 `README.md`/`examples/README.md`，明确：
  - 如何注册 provider/tool/skill/plugin/storage
  - 如何消费 `RunningTurn.events` 和 `join()`
  - 自定义 `SessionStorage` / `MemoryStorage` 的一致性要求

Codex 复用：

- `[仅参考测试]` `../codex/codex-rs/core/tests/suite/{skills,tool_parallelism,compact,resume,memories,plugins,turn_state,model_visible_layout}.rs`
- `[仅参考测试]` `../codex/codex-rs/core/tests/common/*`

验证方式：

- `cargo test`
- `cargo fmt --check`
- `cargo clippy --all-targets --all-features -- -D warnings`

完成判定：

- 关键验收条目均有自动化测试覆盖。
- 调用方不需要阅读内部实现即可完成接入。

## 6. Phase 依赖关系

| Phase | 依赖 | 不能提前的原因 |
|---|---|---|
| Phase 1 | 无 | 必须先固定 domain/ports/error/builder 契约 |
| Phase 2 | Phase 1 | session/runtime/ledger 依赖稳定的配置和错误模型 |
| Phase 3 | Phase 1, 2 | prompt 和 skill 依赖 registries 与 session config |
| Phase 4 | Phase 2, 3 | turn loop 需要 runtime、event、prompt、request 契约已经稳定 |
| Phase 5 | Phase 4 | hook/plugin/tool loop 必须建立在可用的 turn 基础之上 |
| Phase 6 | Phase 2, 4, 5 | compact/resume 依赖真实 ledger、tool 和 turn 编排链路 |
| Phase 7 | Phase 2, 3, 4 | memory 依赖 session 生命周期、prompt 模板和 turn 边界 |
| Phase 8 | 全部 | 端到端验收只能在所有核心模块稳定后进行 |

## 7. 关键实施注意点

- `persist_and_project()` 必须在 Phase 2 就定义出来，并在后续 phase 统一复用。不要让 Skill 注入、Tool 超限提示、synthetic ToolResult 走不同写入路径。
- `SessionRuntime.memory_namespace` 必须在 `new_session()` 时固化并写入 Ledger Metadata；`resume_session()` 必须优先读 Ledger，而不是重新读当前 `AgentConfig`。
- `ContextManager` 不能直接碰 Hook、Event 和 Storage；这些都必须由 `TurnEngine` 编排，避免职责扩散。
- Tool 取消要严格区分：
  - `turn_cancel_token` 只停止 provider 和后续调度
  - `tool_timeout_token` 只服务单个 tool 超时
- 恢复提示 `"[此消息因用户取消而中断]"` 只能在 resume 投影时动态追加，不能写回 Ledger。
- `PluginContext::tap()` 的合同校验必须在 build 阶段失败，而不是运行期 panic。

## 8. 建议的里程碑验收顺序

为了减少返工，建议按以下顺序提交和评审：

1. Phase 1 + Phase 2 合并成“协议与生命周期基础设施”里程碑。
2. Phase 3 + Phase 4 合并成“可对话最小闭环”里程碑。
3. Phase 5 + Phase 6 合并成“工具与恢复一致性”里程碑。
4. Phase 7 + Phase 8 合并成“记忆与验收收口”里程碑。

每个里程碑结束都要求：

- 所有新增测试通过
- 公共 API 不再出现破坏性改动
- 文档中的 phase 完成判定全部满足

## 9. 结论

推荐按 8 个 phase 推进，而不是一次性平铺实现。这样能先把 `0006` 中最容易出错、最难回滚的部分固定住：

- Phase 1-2 固定契约、双锁模型和 Ledger 事实源
- Phase 3-4 固定 prompt 与最小 turn 闭环
- Phase 5-6 固定 hooks/tools/compact/resume 的长链路一致性
- Phase 7-8 收 memory 和验收测试

这样推进的直接收益是：

- 每一层都可以独立验证
- `../codex` 的复用点可以逐步迁移，不会在后期混进大量重写
- 关键风险点都能在前两个里程碑暴露，而不是等到 end-to-end 阶段才集中爆炸
