---
title: 一人公司 的粗略想法（八）
date: 2026-04-26
description: 一人公司 的粗略想法（八）
category: 胡说八道
---
# 实施路线与里程碑

版本：2026-04-26

## 总体节奏

不要先造完整平台。论坛项目建议按 6 个阶段推进：

```text
Phase 0: 定位和内容种子
Phase 1: Vercel MVP 基础
Phase 2: 论坛核心闭环
Phase 3: 邀请、审核、反垃圾
Phase 4: 会员和支付
Phase 5: 运营增长和沉淀
```

每个阶段都要有可上线结果，而不是只产出内部基础设施。

## Phase 0：定位和内容种子

目标：确认这个论坛为什么值得存在。

任务：

- 写一句话产品定义。
- 明确目标用户。
- 明确第一批 20 个种子用户从哪里来。
- 明确 3-5 个板块。
- 明确社区规则初稿。
- 准备 20-30 个种子主题标题。
- 写 5-10 个高质量初始帖子。
- 写第一份 MVP 规格。

产出：

```text
docs/specs/0001_forum-mvp.md
docs/specs/0002_content-seeding.md
docs/specs/0003_community-rules.md
```

退出标准：

- 能用 1 页说清论坛服务谁、解决什么讨论问题。
- 首页即使没有用户也有内容可读。
- 能判断第一版不做什么。

## Phase 1：Vercel MVP 基础

目标：搭出可部署、可登录、可写数据的骨架。

任务：

- 初始化 Next.js + TypeScript + pnpm + Turborepo。
- 接入 Vercel 项目。
- 选择 Vercel Pro 或确认商业化前的计划策略。
- 通过 Vercel Marketplace 创建 Neon Postgres。
- 接入 Drizzle。
- 建立 `users`、`auth_accounts`、`sessions`。
- 接入 Auth.js 或 Better Auth。
- 接入 Vercel Blob。
- 创建 `/api/health`。
- 创建 `scripts/check-env.ts`。
- 配置 preview/staging/production 环境变量。

退出标准：

- main 分支自动部署 production。
- PR/branch 自动生成 preview。
- 用户可以登录。
- 登录后可以写入一条测试数据。
- `pnpm typecheck && pnpm lint && pnpm test` 通过。

## Phase 2：论坛核心闭环

目标：用户能读、能发、能回复，公开内容可被搜索引擎读取。

任务：

- 建立 `boards`。
- 建立 `threads`。
- 建立 `posts`。
- 建立 `post_revisions`。
- 建立 `tags` 和 `thread_tags`。
- 实现板块页。
- 实现主题页。
- 实现发主题。
- 实现回复。
- 实现 Markdown 渲染和 HTML 消毒。
- 实现主题列表排序：最新、热门、精选。
- 实现 sitemap、robots、canonical。
- 实现基础搜索。

退出标准：

- 游客能浏览公开主题。
- 登录用户能发主题和回复。
- 发帖后板块列表和主题页正确刷新。
- 被删除/隐藏内容不进入公开列表。
- 公开主题页具备基础 SEO 元信息。

## Phase 3：邀请、审核、反垃圾

目标：控制访问质量，避免论坛刚上线就被垃圾内容淹没。

任务：

- 建立 `invite_codes`、`invite_batches`、`waitlist_entries`。
- 实现邀请码生成、兑换、撤销。
- 实现候补名单。
- 实现 user status 和 trust level。
- 实现发帖/回复/上传限频。
- 接入 Upstash Redis 或 Postgres 限频表。
- 建立 `moderation_reports`。
- 建立 `moderation_actions`。
- 建立 `moderation_queue`。
- 实现举报。
- 实现管理员审核后台。
- 建立 `audit_events`。
- 实现只读模式、暂停发帖、暂停上传开关。

退出标准：

- 未激活用户不能发帖。
- 新用户发帖有限额。
- 用户可以举报帖子。
- 管理员可以隐藏/恢复/锁定内容。
- 所有管理操作有审计。
- 垃圾攻击时能一键暂停发帖。

## Phase 4：会员和支付

目标：完成最小收费闭环。

前置判断：

- 如果 Stripe 可开通：走 Stripe。
- 如果 Stripe 不可开通：评估 Paddle 或 Lemon Squeezy。
- 如果支付通道仍不确定：先走 Manual Provider。

任务：

- 建立 `billing` 模块。
- 定义 `BillingProvider` interface。
- 建立 `billing_customers`。
- 建立 `subscriptions`。
- 建立 `user_entitlements`。
- 建立 `billing_provider_events`。
- 建立 `billing_ledger`。
- 实现会员页。
- 实现付费板块权限。
- 实现 Checkout。
- 实现 Customer Portal 或对应 MoR 管理入口。
- 实现 Webhook 验签、持久化、幂等处理。
- 实现后台手工调整会员权益。

退出标准：

- sandbox 可以完成一次升级。
- Webhook 重放不会重复开通权益。
- 用户刷新页面后能看到正确会员状态。
- 取消/付款失败有明确状态。
- 管理员能查事件和账本。
- Manual Provider 能手动开通会员。

## Phase 5：运营增长和沉淀

目标：进入真实反馈循环。

任务：

- 邀请第一批 10-20 个种子用户。
- 每周发布精选/周报。
- 建立反馈入口。
- 开始记录内容和社区指标。
- 接入 Web Analytics 和 Speed Insights。
- 建立邮件摘要。
- 测试 Founder/Member 付费意愿。
- 根据真实问题优化板块和规则。
- 把重复代码沉淀成 packages。
- 当模式稳定后创建项目 Skill。

退出标准：

- 有 20-30 个高质量主题。
- 至少 10 个真实用户完成登录。
- 至少 3-5 个用户完成发帖或回复。
- 至少 1 个用户表达明确付费意愿或完成付费。
- 能回答用户为什么来、为什么不来、为什么愿意付费。

## 推荐时间表

如果范围清晰，可以按 3-4 周推进：

| 时间 | 目标 |
| --- | --- |
| 第 1-2 天 | Phase 0，定位、规则、种子内容 |
| 第 3-5 天 | Phase 1，Vercel 基础骨架 |
| 第 6-10 天 | Phase 2，论坛核心读写 |
| 第 11-14 天 | Phase 3，邀请和审核 |
| 第 15-18 天 | Phase 4，sandbox/manual 付费 |
| 第 19-28 天 | 种子用户、内容运营、修正方向 |

不要等所有功能完整才第一次给用户看。论坛越早接触真实用户越好。

## 成本边界

早期固定成本：

```text
Vercel Pro：商业化时按 Pro 规划
Neon：Free 或最低付费档
Upstash：Free 或低量付费
Blob：按量
邮件服务：低量免费/低价
支付服务：sandbox 到真实收费前基本无平台成本
```

高风险变动成本：

- 大量图片和附件。
- 热门公开图片流量。
- 爬虫访问。
- 邮件通知过多。
- 队列重试风暴。
- 搜索查询过重。
- 长时间 Functions。

控制手段：

- 邀请制默认开启。
- 新用户低限额。
- 上传大小和数量限制。
- 邮件默认摘要而不是全量即时。
- Blob 临时文件清理。
- 队列最大重试次数。
- 管理后台成本可见。

## 升级触发条件

| 触发条件 | 升级动作 |
| --- | --- |
| 公开页面流量明显增长 | 加强缓存、ISR、搜索引擎优化、CDN 策略 |
| Postgres FTS 不够用 | 抽象搜索模块切到 Upstash Search/Meilisearch/Algolia |
| 通知和邮件任务增多 | 从简单 after/waitUntil 升级到 Vercel Queues/Upstash QStash |
| 付费用户稳定 | 完善账本、发票、退款、税务、对账后台 |
| 第二个论坛/产品复用计费 | 抽离 billing 为独立服务 |
| 垃圾内容增多 | 引入更强 WAF/Bot/AI 审核 |
| 需要实时在线互动 | 接入 Ably/Pusher/Liveblocks，不在 Vercel 自建 WebSocket |
| 团队超过 2-3 人 | 强化 RBAC、审计、操作流程和 staging |

## 关键开放问题

这些问题不阻塞开始，但会影响细节：

- 论坛的垂直主题是什么？
- 目标用户主要在国内还是海外？
- 是否需要中文支付方式？
- 你是否有 Stripe 支持地区的主体、税号和银行账户？
- 是否要公开阅读，还是全站邀请制？
- 是否有付费板块，还是先做支持者会员？
- 是否允许图片和附件？
- 是否需要匿名发帖？
- 是否需要审核所有首帖？
- 是否涉及敏感话题或支付平台限制类目？

建议先不用等所有答案齐全。只要 Phase 0 能明确第一版用户、内容和付费假设，就可以开工。

## 最小成功标准

第一版不是功能多，而是具备社区和商业闭环：

```text
用户能理解论坛定位
游客能读到有价值内容
用户能登录
你能控制谁能发言
用户能发主题和回复
用户能收到通知并回访
你能审核和处理垃圾内容
你能看到关键审计和指标
用户能成为会员或表达付费意愿
出错时你能暂停写入、定位和回滚
```

这比一开始拥有完整的论坛平台更重要。

