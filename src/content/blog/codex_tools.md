---
title: Codex Agent Tools 清单
date: 2026-03-09
description: codex 分析文档 by claude opus
category: 架构分析
---
本文档整理了 OpenAI Codex 项目中所有提供给 agent 的 tools，基于 Rust 核心实现 (`codex-rs/core`)。

> 代码主入口：`codex-rs/core/src/tools/spec.rs` 中的 `build_tool_registry_with_optional_mcp_tools()` 函数（第 1839 行起）负责注册所有 tools。

---

## 1. Shell / 命令执行类

### 1.1 `shell`

| 项目 | 内容 |
|------|------|
| **作用** | 执行 shell 命令并返回输出。Windows 上使用 PowerShell，Unix 上使用 bash。参数以数组形式传递给 `execvp()` |
| **参数** | `command` (必填, array), `workdir`, `timeout_ms` |
| **定义** | `codex-rs/core/src/tools/spec.rs:523` (`create_shell_tool`) |
| **Handler** | `ShellHandler` — `codex-rs/core/src/tools/handlers/shell.rs:38` |
| **别名** | `local_shell`, `container.exec`（均路由到同一 handler） |
| **启用条件** | `shell_type == Default` |

### 1.2 `shell_command`

| 项目 | 内容 |
|------|------|
| **作用** | 以用户默认 shell 执行命令字符串（非数组），更贴近自然的 shell 脚本写法 |
| **参数** | `command` (必填, string), `workdir`, `timeout_ms`, `login` (可选) |
| **定义** | `codex-rs/core/src/tools/spec.rs:576` (`create_shell_command_tool`) |
| **Handler** | `ShellCommandHandler` — `codex-rs/core/src/tools/handlers/shell.rs:46` |
| **启用条件** | `shell_type == ShellCommand` |

### 1.3 `exec_command`

| 项目 | 内容 |
|------|------|
| **作用** | 在 PTY 中执行命令，返回输出或 session ID 以便后续交互（适用于需要持续交互的场景） |
| **参数** | `cmd` (必填), `workdir`, `shell`, `tty`, `yield_time_ms`, `max_output_tokens`, `login` (可选) |
| **定义** | `codex-rs/core/src/tools/spec.rs:400` (`create_exec_command_tool`) |
| **Handler** | `UnifiedExecHandler` — `codex-rs/core/src/tools/handlers/unified_exec.rs:33` |
| **启用条件** | `shell_type == UnifiedExec` |

### 1.4 `write_stdin`

| 项目 | 内容 |
|------|------|
| **作用** | 向已有的 `exec_command` session 写入字符并返回最新输出（配合 `exec_command` 使用） |
| **参数** | `session_id` (必填), `chars`, `yield_time_ms`, `max_output_tokens` |
| **定义** | `codex-rs/core/src/tools/spec.rs:476` (`create_write_stdin_tool`) |
| **Handler** | `UnifiedExecHandler` — `codex-rs/core/src/tools/handlers/unified_exec.rs:33` |
| **启用条件** | `shell_type == UnifiedExec` |

---

## 2. 文件操作类

### 2.1 `apply_patch`

| 项目 | 内容 |
|------|------|
| **作用** | 对文件应用补丁，支持新建、删除、更新文件。有 Freeform 和 JSON 两种变体 |
| **Freeform 变体** | 使用 Lark 语法定义的自由格式补丁语言 |
| **JSON 变体** | 将补丁内容包装在 JSON 的 `input` 字段中（用于 gpt-oss 模型） |
| **定义** | Freeform: `codex-rs/core/src/tools/handlers/apply_patch.rs:290` / JSON: `codex-rs/core/src/tools/handlers/apply_patch.rs:303` |
| **Handler** | `ApplyPatchHandler` — `codex-rs/core/src/tools/handlers/apply_patch.rs:36` |
| **注册** | `codex-rs/core/src/tools/spec.rs:1949-1959` |
| **启用条件** | `apply_patch_tool_type` 配置 |

### 2.2 `read_file` (experimental)

| 项目 | 内容 |
|------|------|
| **作用** | 读取本地文件内容，支持 slice（按行范围）和 indentation（按缩进层级展开）两种模式 |
| **参数** | `file_path` (必填), `offset`, `limit`, `mode`, `indentation` (含 `anchor_line`, `max_levels`, `include_siblings`, `include_header`, `max_lines`) |
| **定义** | `codex-rs/core/src/tools/spec.rs:1303` (`create_read_file_tool`) |
| **Handler** | `ReadFileHandler` — `codex-rs/core/src/tools/handlers/read_file.rs:17` |
| **启用条件** | `experimental_supported_tools` 包含 `"read_file"` |

### 2.3 `list_dir` (experimental)

| 项目 | 内容 |
|------|------|
| **作用** | 列出本地目录的条目，带 1-indexed 编号和类型标签 |
| **参数** | `dir_path` (必填), `offset`, `limit`, `depth` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1406` (`create_list_dir_tool`) |
| **Handler** | `ListDirHandler` — `codex-rs/core/src/tools/handlers/list_dir.rs:21` |
| **启用条件** | `experimental_supported_tools` 包含 `"list_dir"` |

### 2.4 `grep_files` (experimental)

| 项目 | 内容 |
|------|------|
| **作用** | 搜索文件内容匹配正则模式的文件，按修改时间排序 |
| **参数** | `pattern` (必填), `include` (glob 过滤), `path`, `limit` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1212` (`create_grep_files_tool`) |
| **Handler** | `GrepFilesHandler` — `codex-rs/core/src/tools/handlers/grep_files.rs:18` |
| **启用条件** | `experimental_supported_tools` 包含 `"grep_files"` |

---

## 3. 多 Agent 协作类

### 3.1 `spawn_agent`

| 项目 | 内容 |
|------|------|
| **作用** | 创建子 agent 执行独立任务，返回 agent ID。支持指定 agent 类型、fork 上下文等 |
| **参数** | `message`, `items`, `agent_type`, `fork_context` |
| **定义** | `codex-rs/core/src/tools/spec.rs:717` (`create_spawn_agent_tool`) |
| **Handler** | `MultiAgentHandler` — `codex-rs/core/src/tools/handlers/multi_agents.rs:46` |
| **启用条件** | `collab_tools == true` |

### 3.2 `send_input`

| 项目 | 内容 |
|------|------|
| **作用** | 向已有 agent 发送消息。`interrupt=true` 可立即中断当前工作 |
| **参数** | `id` (必填), `message`, `items`, `interrupt` |
| **定义** | `codex-rs/core/src/tools/spec.rs:915` (`create_send_input_tool`) |
| **Handler** | `MultiAgentHandler` — `codex-rs/core/src/tools/handlers/multi_agents.rs:46` |
| **启用条件** | `collab_tools == true` |

### 3.3 `resume_agent`

| 项目 | 内容 |
|------|------|
| **作用** | 恢复一个已关闭的 agent，使其可以继续接收 `send_input` 和 `wait` 调用 |
| **参数** | `id` (必填) |
| **定义** | `codex-rs/core/src/tools/spec.rs:957` (`create_resume_agent_tool`) |
| **Handler** | `MultiAgentHandler` — `codex-rs/core/src/tools/handlers/multi_agents.rs:46` |
| **启用条件** | `collab_tools == true` |

### 3.4 `wait`

| 项目 | 内容 |
|------|------|
| **作用** | 等待指定 agent 达到终止状态，可同时等待多个 agent（先完成的先返回） |
| **参数** | `ids` (必填, array), `timeout_ms` |
| **定义** | `codex-rs/core/src/tools/spec.rs:980` (`create_wait_tool`) |
| **Handler** | `MultiAgentHandler` — `codex-rs/core/src/tools/handlers/multi_agents.rs:46` |
| **启用条件** | `collab_tools == true` |

### 3.5 `close_agent`

| 项目 | 内容 |
|------|------|
| **作用** | 关闭不再需要的 agent，返回其最后已知状态 |
| **参数** | `id` (必填) |
| **定义** | `codex-rs/core/src/tools/spec.rs:1123` (`create_close_agent_tool`) |
| **Handler** | `MultiAgentHandler` — `codex-rs/core/src/tools/handlers/multi_agents.rs:46` |
| **启用条件** | `collab_tools == true` |

---

## 4. 批量任务类

### 4.1 `spawn_agents_on_csv`

| 项目 | 内容 |
|------|------|
| **作用** | 读取 CSV 文件，为每行生成一个 worker 子 agent。支持模板指令中使用 `{column}` 占位符 |
| **参数** | `csv_path` (必填), `instruction` (必填), `id_column`, `output_csv_path`, `max_concurrency`, `max_workers`, `max_runtime_seconds`, `output_schema` |
| **定义** | `codex-rs/core/src/tools/spec.rs:790` (`create_spawn_agents_on_csv_tool`) |
| **Handler** | `BatchJobHandler` — `codex-rs/core/src/tools/handlers/agent_jobs.rs:34` |
| **启用条件** | `agent_jobs_tools == true` |

### 4.2 `report_agent_job_result`

| 项目 | 内容 |
|------|------|
| **作用** | Worker 专用工具，向批量任务报告处理结果。主 agent 不应调用 |
| **参数** | `job_id` (必填), `item_id` (必填), `result` (必填), `stop` |
| **定义** | `codex-rs/core/src/tools/spec.rs:866` (`create_report_agent_job_result_tool`) |
| **Handler** | `BatchJobHandler` — `codex-rs/core/src/tools/handlers/agent_jobs.rs:34` |
| **启用条件** | `agent_jobs_tools == true && agent_jobs_worker_tools == true` |

---

## 5. 用户交互类

### 5.1 `request_user_input`

| 项目 | 内容 |
|------|------|
| **作用** | 向用户展示结构化的多选问题（2-3 个选项），获取用户输入 |
| **参数** | `questions` (必填, array of {`id`, `header`, `question`, `options`}) |
| **定义** | `codex-rs/core/src/tools/spec.rs:1014` (`create_request_user_input_tool`) |
| **Handler** | `RequestUserInputHandler` — `codex-rs/core/src/tools/handlers/request_user_input.rs:56` |
| **启用条件** | `request_user_input == true` |

### 5.2 `request_permissions`

| 项目 | 内容 |
|------|------|
| **作用** | 请求额外权限（网络访问、文件系统访问、macOS 特定权限等） |
| **参数** | `permissions` (必填), `reason` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1099` (`create_request_permissions_tool`) |
| **Handler** | `RequestPermissionsHandler` — `codex-rs/core/src/tools/handlers/request_permissions.rs:19` |
| **启用条件** | `request_permissions_tool_enabled == true` |

---

## 6. 规划类

### 6.1 `update_plan`

| 项目 | 内容 |
|------|------|
| **作用** | 更新任务计划。提供步骤列表及状态（pending / in_progress / completed），同一时刻最多一步为 in_progress |
| **参数** | `plan` (必填, array of {`step`, `status`}), `explanation` |
| **定义** | `codex-rs/core/src/tools/handlers/plan.rs:22` (`PLAN_TOOL` 静态变量) |
| **Handler** | `PlanHandler` — `codex-rs/core/src/tools/handlers/plan.rs:20` |
| **启用条件** | 始终启用 |

---

## 7. 代码执行类

### 7.1 `js_repl`

| 项目 | 内容 |
|------|------|
| **作用** | 在持久化的 Node.js 内核中运行 JavaScript（支持 top-level await）。Freeform 工具，直接发送 JS 源码 |
| **参数** | 自由格式 JS 源码，可选首行 pragma `// codex-js-repl: timeout_ms=15000` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1452` (`create_js_repl_tool`) |
| **Handler** | `JsReplHandler` — `codex-rs/core/src/tools/handlers/js_repl.rs:27` |
| **启用条件** | `js_repl_enabled == true` |

### 7.2 `js_repl_reset`

| 项目 | 内容 |
|------|------|
| **作用** | 重启 js_repl 内核，清除所有持久化的顶层绑定 |
| **参数** | 无 |
| **定义** | `codex-rs/core/src/tools/spec.rs:1511` (`create_js_repl_reset_tool`) |
| **Handler** | `JsReplResetHandler` — `codex-rs/core/src/tools/handlers/js_repl.rs:28` |
| **启用条件** | `js_repl_enabled == true` |

### 7.3 `artifacts`

| 项目 | 内容 |
|------|------|
| **作用** | 运行 JavaScript 调用 `@oai/artifact-tool` 运行时，用于创建演示文稿或电子表格等 artifact |
| **参数** | 自由格式 JS 源码，可选首行 pragma `// codex-artifacts: timeout_ms=15000` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1484` (`create_artifacts_tool`) |
| **Handler** | `ArtifactsHandler` — `codex-rs/core/src/tools/handlers/artifacts.rs:35` |
| **启用条件** | `artifact_tools == true` |

---

## 8. 图像 / 媒体类

### 8.1 `view_image`

| 项目 | 内容 |
|------|------|
| **作用** | 查看本地文件系统中的图片（仅在用户提供完整路径且图片未在上下文中时使用） |
| **参数** | `path` (必填) |
| **定义** | `codex-rs/core/src/tools/spec.rs:643` (`create_view_image_tool`) |
| **Handler** | `ViewImageHandler` — `codex-rs/core/src/tools/handlers/view_image.rs:23` |
| **启用条件** | 始终启用 |

### 8.2 `image_generation` (内置)

| 项目 | 内容 |
|------|------|
| **作用** | 内置图像生成工具（当模型支持时启用） |
| **定义** | `codex-rs/core/src/tools/spec.rs:2033-2037` |
| **启用条件** | `image_gen_tool == true` |

---

## 9. Web 搜索类

### 9.1 `web_search` (内置)

| 项目 | 内容 |
|------|------|
| **作用** | 内置 Web 搜索工具，支持 Cached/Live 模式，可配置过滤器和用户位置 |
| **定义** | `codex-rs/core/src/tools/spec.rs:2015-2031` |
| **启用条件** | `web_search_mode` 为 `Cached` 或 `Live` |

---

## 10. 搜索 / 发现类

### 10.1 `search_tool_bm25`

| 项目 | 内容 |
|------|------|
| **作用** | 基于 BM25 算法搜索应用工具（app tools），用于在大量可用工具中快速定位 |
| **参数** | `query` (必填), `limit` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1263` (`create_search_tool_bm25_tool`) |
| **Handler** | `SearchToolBm25Handler` — `codex-rs/core/src/tools/handlers/search_tool_bm25.rs:23` |
| **启用条件** | `search_tool == true` 且存在 `app_tools` |

---

## 11. MCP (Model Context Protocol) 资源类

### 11.1 `list_mcp_resources`

| 项目 | 内容 |
|------|------|
| **作用** | 列出 MCP 服务器提供的资源（文件、数据库 schema、应用信息等） |
| **参数** | `server`, `cursor` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1526` (`create_list_mcp_resources_tool`) |
| **Handler** | `McpResourceHandler` — `codex-rs/core/src/tools/handlers/mcp_resource.rs:34` |
| **启用条件** | 存在 MCP tools |

### 11.2 `list_mcp_resource_templates`

| 项目 | 内容 |
|------|------|
| **作用** | 列出 MCP 服务器提供的参数化资源模板 |
| **参数** | `server`, `cursor` |
| **定义** | `codex-rs/core/src/tools/spec.rs:1560` (`create_list_mcp_resource_templates_tool`) |
| **Handler** | `McpResourceHandler` — `codex-rs/core/src/tools/handlers/mcp_resource.rs:34` |
| **启用条件** | 存在 MCP tools |

### 11.3 `read_mcp_resource`

| 项目 | 内容 |
|------|------|
| **作用** | 从指定 MCP 服务器读取特定资源 |
| **参数** | `server` (必填), `uri` (必填) |
| **定义** | `codex-rs/core/src/tools/spec.rs:1594` (`create_read_mcp_resource_tool`) |
| **Handler** | `McpResourceHandler` — `codex-rs/core/src/tools/handlers/mcp_resource.rs:34` |
| **启用条件** | 存在 MCP tools |

### 11.4 MCP 动态工具

| 项目 | 内容 |
|------|------|
| **作用** | MCP 服务器提供的工具会被动态转换为 OpenAI function tools 并注册 |
| **定义** | `codex-rs/core/src/tools/spec.rs:2071-2085` |
| **Handler** | `McpHandler` — `codex-rs/core/src/tools/handlers/mcp.rs:13` |
| **启用条件** | 存在 MCP tools，数量和内容取决于连接的 MCP 服务器 |

---

## 12. 动态工具

### 12.1 Dynamic Tools

| 项目 | 内容 |
|------|------|
| **作用** | 外部系统提供的动态工具，被转换为 OpenAI function tools 后注册 |
| **定义** | `codex-rs/core/src/tools/spec.rs:2088-2102` |
| **Handler** | `DynamicToolHandler` — `codex-rs/core/src/tools/handlers/dynamic.rs:22` |
| **启用条件** | `dynamic_tools` 非空 |

---

## 13. 测试 / 内部工具

### 13.1 `test_sync_tool` (experimental)

| 项目 | 内容 |
|------|------|
| **作用** | 集成测试用的内部同步辅助工具，支持 barrier 机制 |
| **参数** | `sleep_before_ms`, `sleep_after_ms`, `barrier` (含 `id`, `participants`, `timeout_ms`) |
| **定义** | `codex-rs/core/src/tools/spec.rs:1145` (`create_test_sync_tool`) |
| **Handler** | `TestSyncHandler` — `codex-rs/core/src/tools/handlers/test_sync.rs:21` |
| **启用条件** | `experimental_supported_tools` 包含 `"test_sync_tool"` |

---

## 汇总

| 分类 | 工具数量 | 工具名称 |
|------|---------|---------|
| Shell / 命令执行 | 4 (+2 别名) | `shell`, `shell_command`, `exec_command`, `write_stdin` (+ `local_shell`, `container.exec`) |
| 文件操作 | 4 | `apply_patch`, `read_file`, `list_dir`, `grep_files` |
| 多 Agent 协作 | 5 | `spawn_agent`, `send_input`, `resume_agent`, `wait`, `close_agent` |
| 批量任务 | 2 | `spawn_agents_on_csv`, `report_agent_job_result` |
| 用户交互 | 2 | `request_user_input`, `request_permissions` |
| 规划 | 1 | `update_plan` |
| 代码执行 | 3 | `js_repl`, `js_repl_reset`, `artifacts` |
| 图像 / 媒体 | 2 | `view_image`, `image_generation` |
| Web 搜索 | 1 | `web_search` |
| 搜索 / 发现 | 1 | `search_tool_bm25` |
| MCP 资源 | 3 + 动态 | `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` + MCP 动态工具 |
| 动态工具 | 可变 | 外部动态注册 |
| 测试 / 内部 | 1 | `test_sync_tool` |
| **合计** | **29 个命名工具** + 动态工具 | |

> 注：许多工具为条件启用，取决于 feature flags、模型能力、session 配置和实验性设置。实际运行时 agent 可用的工具集由 `ToolsConfig` 决定。
