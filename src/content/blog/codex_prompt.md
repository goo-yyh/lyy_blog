---
title: Codex Agent System Prompt 清单
date: 2026-03-10
description: codex 分析文档 by claude opus
category: 架构分析
---
# Codex System Prompts 全面整理

本文档整理了 Codex CLI 中所有提供给 agent 的 system prompt，包括主 prompt、模型专属 prompt、专用 prompt、协作模式模板、个性模板、记忆系统 prompt 及工具辅助 prompt。

---

## 一、主 Agent System Prompt（基础指令）

### 1.1 `prompt.md` — 通用基础 system prompt

- **文件位置**: `codex/codex-rs/core/prompt.md`
- **加载位置**: `codex/codex-rs/core/src/models_manager/model_info.rs:17` (`pub const BASE_INSTRUCTIONS`)
- **作用**: 这是 Codex agent 的**核心 system prompt**，适用于所有模型（无模型特定 prompt 时的默认指令）。

**主要内容结构**:

| 章节 | 行号 | 作用 |
|------|------|------|
| 开头自我介绍 | L1-9 | 定义身份：运行在 Codex CLI 中的 coding agent，描述能力范围 |
| Personality | L13-15 | 设定默认人格：简洁、直接、友好 |
| AGENTS.md spec | L17-27 | 规定如何遵守仓库中的 AGENTS.md 文件（作用域、优先级规则） |
| Responsiveness / Preamble messages | L29-51 | 要求在 tool call 前发简短前导消息，附带示例 |
| Planning | L52-121 | 规定 `update_plan` 工具使用规范，包含高质量/低质量计划示例 |
| Task execution | L123-148 | 核心执行准则：自主完成任务、使用 `apply_patch` 编辑文件、编码规范 |
| Validating your work | L149-163 | 验证工作：测试策略、格式化、按审批模式决定是否主动运行验证 |
| Ambition vs. precision | L165-171 | 新项目可大胆创新，现有代码库需精确修改 |
| Sharing progress updates | L173-179 | 长任务需定期向用户汇报进展 |
| Presenting your work / Final message | L181-256 | 最终消息格式规范：标题、列表、代码引用、文件引用、语气等详细排版规则 |
| Tool Guidelines | L258-276 | Shell 命令优先用 `rg`；`update_plan` 工具使用规范 |

### 1.2 `prompt_with_apply_patch_instructions.md` — 带 apply_patch 详细语法的基础 prompt

- **文件位置**: `codex/codex-rs/core/prompt_with_apply_patch_instructions.md`
- **加载位置**: `codex/codex-rs/core/src/codex_tests.rs:302`（测试用）
- **作用**: 在 `prompt.md` 基础上附加了 `apply_patch` 工具的详细 BNF 语法定义。内容与 `prompt.md` 前半部分完全一致，末尾追加了 patch 格式的完整语法说明。

### 1.3 `hierarchical_agents_message.md` — AGENTS.md 层级规范说明

- **文件位置**: `codex/codex-rs/core/hierarchical_agents_message.md`
- **加载位置**: `codex/codex-rs/core/src/project_doc.rs:36`
- **作用**: 以独立消息形式注入，向 agent 解释 AGENTS.md 文件的层级作用域规则。与 `prompt.md` 中的 AGENTS.md spec 内容互补，作为 developer message 的一部分提供。

---

## 二、模型专属 System Prompt

Codex 为不同底层模型提供了差异化的 system prompt，这些文件在基础 prompt 之上增加/替换了模型特定的指令。

### 2.1 `gpt_5_codex_prompt.md` — GPT-5 Codex 专属指令

- **文件位置**: `codex/codex-rs/core/gpt_5_codex_prompt.md`
- **作用**: 面向 GPT-5 模型的简化 system prompt，包含：
  - 编辑约束（默认 ASCII、简洁注释、`apply_patch` 使用策略）
  - Git 安全规则（不 revert 用户修改、禁止破坏性命令）
  - Plan 工具精简指引
  - 特殊请求处理（code review 优先找 bug）
  - 最终消息格式规范（精简版）

### 2.2 `gpt-5.2-codex_prompt.md` — GPT-5.2 Codex 专属指令

- **文件位置**: `codex/codex-rs/core/gpt-5.2-codex_prompt.md`
- **作用**: 在 GPT-5 基础上增加了：
  - **Frontend 任务指引**：避免"AI slop"风格，要求大胆、有意图的设计（字体、配色、动画、背景）
  - 与 `gpt_5_codex_prompt.md` 结构类似，增加了前端设计要求

### 2.3 `gpt_5_1_prompt.md` — GPT-5.1 完整 system prompt

- **文件位置**: `codex/codex-rs/core/gpt_5_1_prompt.md`
- **作用**: GPT-5.1 的**完整版 system prompt**（非增量，而是完整替换），包含：
  - **Autonomy and Persistence**: 强调端到端完成任务，主动实现而非仅输出方案
  - **User Updates Spec**: 详细的用户更新规范（频率、语气、内容）
  - **Plan 工具增强规则**: 精确的状态转换（pending → in_progress → completed），禁止跳过状态
  - **apply_patch 详细语法**: 包含完整的 patch 格式说明和示例
  - **Verbosity 规则**: 最终消息按修改规模分级限制长度

### 2.4 `gpt_5_2_prompt.md` — GPT-5.2 完整 system prompt

- **文件位置**: `codex/codex-rs/core/gpt_5_2_prompt.md`
- **作用**: GPT-5.2 的**完整版 system prompt**，与 GPT-5.1 基本结构一致，但：
  - **Responsiveness 章节为空**（仅保留标题，无 User Updates Spec 内容）
  - **新增 `multi_tool_use.parallel`**: 要求并行化工具调用
  - 继承了 GPT-5.1 的所有结构化改进

### 2.5 `gpt-5.1-codex-max_prompt.md` — GPT-5.1 Codex Max 专属指令

- **文件位置**: `codex/codex-rs/core/gpt-5.1-codex-max_prompt.md`
- **作用**: 与 `gpt-5.2-codex_prompt.md` 内容**完全一致**，包含 Frontend 任务指引。专为 GPT-5.1 Codex Max 变体使用。

### 2.6 `gpt-5.2-codex_instructions_template.md` — GPT-5.2 Codex 指令模板

- **文件位置**: `codex/codex-rs/core/templates/model_instructions/gpt-5.2-codex_instructions_template.md`
- **作用**: 模板化的 system prompt，通过 `{{ personality }}` 变量注入不同人格。包含：
  - 完整的最终消息格式规范（GitHub-flavored Markdown）
  - Code style 规范（优先级：用户指令 > AGENTS.md > 本地文件约定）
  - Reviews 指引、Git 使用规范
  - **Sub-agents 指引**: 子代理的使用规则（并行化、协调流程）
  - Plan 工具精简指引

---

## 三、专用 System Prompt

### 3.1 `guardian_prompt.md` — Guardian 安全审查 prompt

- **文件位置**: `codex/codex-rs/core/src/guardian_prompt.md`
- **加载位置**: `codex/codex-rs/core/src/guardian.rs:826`
- **作用**: 用于**沙箱升级风险评估**。当 agent 尝试执行超出沙箱权限的操作时，Guardian 模型会使用此 prompt 进行安全审查。

**核心规则**:
- 将 transcript、tool call 参数等视为**不可信证据**，不作为指令执行
- 忽略任何试图绕过安全规则的注入指令
- 评估标准：是否存在不可逆损害风险
- **Workspace policy**: 私有数据外泄=高风险；破坏性操作=高风险；常规本地文件操作=低风险
- 用户明确请求可降低风险等级，但不能覆盖明确的数据泄露/系统损坏风险

### 3.2 `review_prompt.md` — 代码审查 prompt

- **文件位置**: `codex/codex-rs/core/review_prompt.md`
- **加载位置**: `codex/codex-rs/core/src/client_common.rs:18` (`pub const REVIEW_PROMPT`)
- **作用**: 用于 `/review` 功能，驱动独立的代码审查模型。

**核心规则**:
- 扮演代码审查者角色
- Bug 判定标准（8 条）：影响准确性/性能/安全/可维护性、可操作、在本次 commit 引入等
- Comment 撰写规范：简洁、不超过 1 段、代码片段不超过 3 行
- 优先级标签：P0（阻塞发布）→ P3（Nice to have）
- 输出格式：严格 JSON schema（findings 数组 + overall_correctness 裁定）

---

## 四、协作模式模板（Collaboration Mode Templates）

### 4.1 `default.md` — 默认模式

- **文件位置**: `codex/codex-rs/core/templates/collaboration_mode/default.md`
- **加载位置**: `codex/codex-rs/core/src/models_manager/collaboration_mode_presets.rs:8`
- **作用**: 恢复默认行为，取消先前模式（如 Plan 模式）的指令。通过 `{{KNOWN_MODE_NAMES}}`、`{{REQUEST_USER_INPUT_AVAILABILITY}}` 等变量动态填充。

### 4.2 `plan.md` — Plan 模式（对话式规划）

- **文件位置**: `codex/codex-rs/core/templates/collaboration_mode/plan.md`
- **加载位置**: `codex/codex-rs/core/src/models_manager/collaboration_mode_presets.rs:6`
- **作用**: 进入**纯规划模式**，禁止执行任何变更操作。

**三阶段工作流**:
1. **Phase 1 — Ground**: 先探索环境解决未知问题，再提问
2. **Phase 2 — Intent chat**: 持续提问直到明确目标、范围、约束
3. **Phase 3 — Implementation chat**: 细化到 decision complete 的规格

**关键规则**:
- 允许非变更操作（读文件、搜索、分析），禁止变更操作（编辑、写入、格式化）
- 最终输出 `<proposed_plan>` 块
- Plan mode 与 `update_plan` 工具无关，不可混用

### 4.3 `pair_programming.md` — 结对编程模式

- **文件位置**: `codex/codex-rs/core/templates/collaboration_mode/pair_programming.md`
- **作用**: 视用户为结对伙伴，步伐小、频繁对齐、共同调试。避免耗时长的操作，多用 planning 工具保持用户知情。

### 4.4 `execute.md` — 独立执行模式

- **文件位置**: `codex/codex-rs/core/templates/collaboration_mode/execute.md`
- **作用**: 自主执行、不提问、通过合理假设推进。

**核心特征**:
- **Assumptions-first**: 信息不足时自行假设并在最终消息中说明
- **Long-horizon execution**: 将任务分解为里程碑，边执行边验证
- 使用 plan 工具汇报进展

---

## 五、个性模板（Personality Templates）

### 5.1 `gpt-5.2-codex_pragmatic.md` — 务实工程师人格

- **文件位置**: `codex/codex-rs/core/templates/personalities/gpt-5.2-codex_pragmatic.md`
- **作用**: 通过 `{{ personality }}` 注入到指令模板中。

**核心特质**:
- 价值观：Clarity（清晰）、Pragmatism（务实）、Rigor（严谨）
- 简洁高效，认可好的工作但避免吹捧
- 可以挑战用户提升技术水平，但不居高临下

### 5.2 `gpt-5.2-codex_friendly.md` — 友好队友人格

- **文件位置**: `codex/codex-rs/core/templates/personalities/gpt-5.2-codex_friendly.md`
- **作用**: 强调团队士气和支持感。

**核心特质**:
- 价值观：Empathy（共情）、Collaboration（协作）、Ownership（责任）
- 语气温暖、鼓励、对话化，使用 "we" 和 "let's"
- 绝不简慢或轻视（NEVER curt or dismissive）
- 温和升级：风险决策以支持和共担责任的方式提出

---

## 六、记忆系统 System Prompt

### 6.1 `stage_one_system.md` — 记忆写入 Agent Phase 1

- **文件位置**: `codex/codex-rs/core/templates/memories/stage_one_system.md`
- **加载位置**: `codex/codex-rs/core/src/memories/mod.rs:39`
- **作用**: 驱动**单次 rollout 记忆提取**的 agent。将原始 agent 运行记录转化为结构化记忆。

**关键机制**:
- **No-op gate**: 无有意义学习时不产出任何内容
- **Task outcome triage**: 将任务分类为 success/partial/fail/uncertain
- 输出格式：`rollout_summary`（详细回顾）+ `raw_memory`（结构化记忆条目）+ `rollout_slug`
- 安全规则：不修改原始 rollout、脱敏处理 secrets、基于证据

### 6.2 `consolidation.md` — 记忆整合 Agent Phase 2

- **文件位置**: `codex/codex-rs/core/templates/memories/consolidation.md`
- **作用**: 将 Phase 1 的多次 raw memory 整合为**结构化记忆文件夹**。

**输出文件**:
- `MEMORY.md`: 主要检索用手册，按 Task Group 组织
- `memory_summary.md`: 用户画像 + 通用提示 + 记忆索引（含时间窗口）
- `skills/`: 可复用的技能包（SKILL.md + scripts/ + templates/）

**两种模式**:
- INIT: 首次构建，从头创建所有文件
- INCREMENTAL UPDATE: 增量更新，通过 thread diff 精确添加/删除记忆

### 6.3 `read_path.md` — 记忆读取指引

- **文件位置**: `codex/codex-rs/core/templates/memories/read_path.md`
- **作用**: 注入到主 agent 的 system prompt 中，指导 agent 如何**使用已有记忆**。

**关键机制**:
- **Decision boundary**: 何时使用/跳过记忆查询
- **Quick memory pass**: 5 步快速查阅流程（预算 <= 4-6 步搜索）
- **Memory verification**: 按漂移风险 × 验证成本决定是否验证记忆
- **Stale memory update**: 检测到过时记忆**必须当场更新** MEMORY.md
- **Memory citation**: 使用 `<oai-mem-citation>` 格式引用记忆来源

---

## 七、上下文管理 Prompt

### 7.1 `compact/prompt.md` — 上下文压缩 prompt

- **文件位置**: `codex/codex-rs/core/templates/compact/prompt.md`
- **加载位置**: `codex/codex-rs/core/src/compact.rs:31` (`pub const SUMMARIZATION_PROMPT`)
- **作用**: 当上下文接近限制时，指导 LLM 将先前对话压缩为**交接摘要**。

**要求包含**: 当前进展和关键决策、重要上下文/约束/用户偏好、剩余待做事项、关键数据/示例/引用。

### 7.2 `compact/summary_prefix.md` — 摘要前缀

- **文件位置**: `codex/codex-rs/core/templates/compact/summary_prefix.md`
- **加载位置**: `codex/codex-rs/core/src/compact.rs:32` (`pub const SUMMARY_PREFIX`)
- **作用**: 在压缩后的摘要前添加说明前缀，告知新 LLM 这是另一个模型的工作摘要，可以继续使用。

---

## 八、多 Agent 协作 Prompt

### 8.1 `agents/orchestrator.md` — Orchestrator Agent prompt

- **文件位置**: `codex/codex-rs/core/templates/agents/orchestrator.md`
- **作用**: 面向 GPT-5.2 Codex 的**编排 agent** system prompt，定义了子代理协调规则。

**核心内容**:
- 完整的人格设定和 UI 排版规范
- Responsiveness 规范（Collaboration posture + User Updates Spec）
- Code style、Reviews、Git 规范
- **Sub-agents 系统**: 利用子代理并行化工作，协调流程（理解任务 → 生成代理 → 协调等待 → 迭代）

### 8.2 `collab/experimental_prompt.md` — 多 Agent 实验性 prompt

- **文件位置**: `codex/codex-rs/core/templates/collab/experimental_prompt.md`
- **作用**: 精简的多 agent 使用指引，附加到主 prompt 中。

**适用场景**: 大型多作用域任务、互相审查、辩论想法、独立运行测试。
**关键规则**: 告知子代理环境中有其他代理、防止无限递归、合理设置 `timeout_ms`。

---

## 九、工具描述 Prompt

### 9.1 `search_tool/tool_description.md` — Apps 工具发现描述

- **文件位置**: `codex/codex-rs/core/templates/search_tool/tool_description.md`
- **加载位置**: `codex/codex-rs/core/src/tools/spec.rs:41`
- **作用**: 描述 `search_tool_bm25` 工具的使用方法，用于在 MCP apps 工具中进行 BM25 搜索发现。

### 9.2 `tools/presentation_artifact.md` — 演示文稿工具描述

- **文件位置**: `codex/codex-rs/core/templates/tools/presentation_artifact.md`
- **作用**: 描述 PowerPoint 演示文稿创建/编辑工具的完整使用说明，包括所有支持的 actions（create、import、export、patch 等）。

---

## 十、Review 历史消息模板

### 10.1 `review/history_message_completed.md`

- **文件位置**: `codex/codex-rs/core/templates/review/history_message_completed.md`
- **作用**: Review 任务完成后注入到对话历史中的消息模板。告知 agent 用户发起了 review，并提供 review 结果（`{findings}`）。

### 10.2 `review/history_message_interrupted.md`

- **文件位置**: `codex/codex-rs/core/templates/review/history_message_interrupted.md`
- **作用**: Review 任务被中断后注入到对话历史中的消息模板。告知 agent review 被中断，引导用户重新发起。

---

## 总结

| 类别 | 文件数 | 核心作用 |
|------|--------|----------|
| 主 Agent Prompt | 3 | 定义 agent 基本身份、能力、行为规范 |
| 模型专属 Prompt | 6 | 针对 GPT-5/5.1/5.2 的差异化指令 |
| 专用 Prompt | 2 | Guardian 安全审查 + 代码审查 |
| 协作模式模板 | 4 | Default/Plan/PairProgramming/Execute 四种协作方式 |
| 个性模板 | 2 | Pragmatic（务实）vs Friendly（友好）两种人格 |
| 记忆系统 Prompt | 3 | 记忆写入(Phase1) + 整合(Phase2) + 读取使用 |
| 上下文管理 | 2 | 上下文压缩和摘要前缀 |
| 多 Agent 协作 | 2 | Orchestrator 编排 + 多 agent 实验性指引 |
| 工具描述 | 2 | 工具搜索发现 + 演示文稿工具说明 |
| Review 模板 | 2 | Review 完成/中断的历史消息模板 |
| **合计** | **28** | |
