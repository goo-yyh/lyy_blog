---
title: openyouyou 实践(一)
date: 2026-03-10
description: openyouyou 实践(一)
category: 胡说八道
---

# 工具整理
首先，整理下 openclaw 和 codex 中对于工具的定义，从里面找出我们需要的工具。先用 claude code 找出这两个代码库中的所有工具，然后整理出我们所需要的工具。

```txt
## codex 工具
请阅读 ./codex 下的代码，仔细思考，整理出 codex 中所有提供给 agent 的 tools，并指出他们的作用，并标记出代码所在的位置，放在 ./specs/openyouyou/0001_codex_tools.md 下

## openclaw 工具
请阅读 ./openclaw 下的代码，仔细思考，整理出 openclaw 中所有提供给 agent 的 tools，并指出他们的作用，并标记出代码所在的位置，放在 ./specs/openyouyou/0002_openclaw_tools.md 下
```

## codex

1. shell 中的 4 个工具
2. 文件操作中的 3 个工具
3. 用户交互中的 2 个工具 （不确定）
4. 图像 / 媒体类中的 2 个工具
5. Web 搜索类中的 1 个工具
6. 搜索 / 发现类中的 2 个工具
7. 动态工具中的 1 个工具

## openclaw
OpenClaw 核心工具中
1. browser — 浏览器控制
2. canvas — Canvas UI 控制 （待定）
3. nodes — 节点/设备控制
4. message — 消息发送/管理
5. gateway — 网关控制
6. sessions_history — 获取会话历史
7. image — 图像分析 （待定）

扩展插件工具
1. 飞书相关工具

# skills 整理
整理下 codex 和 openclaw 中的内置 skills，然后筛选出我们所需要的。

```txt
## codex skills
请阅读 ./codex 下的代码，仔细思考，整理出 codex 中所有提供给 agent 的 skills，并指出他们的作用，并标记出代码所在的位置，放在 ./specs/openyouyou/0003_codex_skills.md 下

## openclaw skills
请阅读 ./openclaw 下的代码，仔细思考，整理出 openclaw 中所有提供给 agent 的 skills，并指出他们的作用，并标记出代码所在的位置，放在 ./specs/openyouyou/0004_openclaw_skills.md 下
```

## codex
1. skill-creator

## openclaw
1. coding-agent — 编码 Agent 委派
2. github — GitHub 操作
3. gemini — Gemini CLI
4. skill-creator — Skill 创建/更新 （二选一）
5. clawhub — ClawHub Skill 市场