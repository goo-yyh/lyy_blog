---
title: 一人公司 的粗略想法（二）
date: 2026-04-26
description: 一人公司 的粗略想法（二）
category: 胡说八道
---
# Vercel 技术架构

版本：2026-04-26

## 架构目标

论坛项目的技术架构要满足四件事：

- 公开内容页面快，利于 SEO。
- 登录后的发帖、回复、通知可靠。
- 审核、反垃圾、权限、付费状态可追溯。
- 低运维，适合一个人长期维护。

因此第一阶段不要拆成“前端 + API 服务 + worker 服务 + 搜索服务 + 计费服务”的多项目结构。推荐单个 Vercel 项目内的模块化单体。

## 推荐仓库结构

```text
forum/
  apps/
    web/
      app/
        (public)/                 # 首页、板块页、主题页、价格页
        (app)/                    # 登录后通知、个人设置、发帖
        admin/                    # 管理后台
        api/                      # Route Handlers
      components/
      lib/
      middleware.ts
      next.config.ts
      vercel.json

  packages/
    db/                           # Drizzle schema、migration、查询封装
    core/                         # 通用类型、错误码、ID、时间、Result
    auth/                         # 登录、Session、用户身份映射
    forum/                        # 板块、主题、回复、反应、收藏
    moderation/                   # 举报、审核队列、封禁、内容状态机
    notification/                 # 提及、回复、订阅、邮件摘要
    billing/                      # 会员、付费板块、支付 Provider 抽象
    audit/                        # 审计事件写入和查询
    search/                       # Postgres FTS，后续可换外部搜索
    rate-limit/                   # Upstash Redis 或 Postgres 计数
    ui/                           # 共享 UI 组件
    rust/                         # 可选 Wasm/Rust 能力

  docs/
    design/
    specs/
    ops/

  scripts/
    check-env.ts
    check-db.ts
    seed-dev.ts
    smoke-prod.ts

  package.json
  pnpm-workspace.yaml
  turbo.json
```

这个结构以 TypeScript monorepo 为主。原因很直接：Vercel + Next.js + TS 是最低摩擦路径。

## Runtime 策略

默认使用 Next.js App Router：

- 公开页面使用 Server Components 和缓存策略，让板块页、主题页尽可能快。
- 写操作使用 Route Handlers 或 Server Actions。支付 Webhook、队列回调、上传签名优先使用 Route Handlers。
- `middleware.ts` 只做轻逻辑：登录态粗检查、重定向、feature flag、IP/路径级拦截。不要在 Middleware 里读数据库。
- Vercel Functions 用 Node.js/TypeScript。普通论坛请求不需要 Rust。
- 长任务进入队列，不在用户请求里同步等待。

Rust 的边界：

- 可用于 Markdown/HTML 安全处理、图片压缩、复杂文本分词、导入导出转换等明确收益模块。
- 第一阶段不用于 OAuth、支付 Webhook、普通 CRUD、后台管理。
- 如果使用 Rust，优先编译成 Wasm 包给 Node 调用，除非确实需要独立 Rust Function。

## 数据库

推荐 Neon Postgres via Vercel Marketplace。

原因：

- 论坛天然是关系模型：用户、板块、主题、回复、权限、通知、举报、会员关系都需要 join。
- 支付和审计更适合事务与关系型数据。
- Neon 与 Vercel 集成能注入环境变量，降低密钥管理成本。
- Neon 的分支能力适合 Preview Deployment。

环境策略：

```text
local       -> 本地 Postgres 或 Neon dev branch
preview     -> Neon preview branch
staging     -> 固定 staging database/branch
production  -> 独立 production database
```

开始收费后，建议一定有 staging。支付 Webhook、数据库迁移、管理员后台都先在 staging 验证。

## 数据访问策略

使用 Drizzle：

- schema 在 `packages/db/schema.ts` 集中定义。
- migration 文件进入 Git。
- repository 函数封装常用查询。
- 写操作尽量在 service 层事务化。
- 所有 destructive migration 必须人工 review。

论坛高频查询要从第一版设计索引：

```text
threads(board_id, last_post_at desc)
threads(board_id, status, pinned desc, last_post_at desc)
posts(thread_id, created_at asc)
posts(author_id, created_at desc)
notifications(user_id, read_at, created_at desc)
moderation_reports(status, created_at desc)
```

不要让页面组件散落手写 SQL。公开查询、权限查询、管理查询分别封装。

## 缓存与页面性能

论坛页面有明显冷热分层：

- 首页、板块列表、热门主题：可短缓存。
- 主题详情：可缓存公开内容，发帖后按 tag/path revalidate。
- 登录态通知、草稿、我的收藏：不缓存或用户级缓存。
- 管理后台：不缓存。

建议策略：

```text
公开板块页：ISR / revalidateTag("board:{id}")
公开主题页：revalidateTag("thread:{id}")
主题回复后：更新 counters，然后 revalidate thread 和 board
个人通知：数据库实时读或短缓存
```

不要一开始做复杂 feed 系统。先用 `last_post_at`、`reply_count`、`score` 这些字段支撑最新、热门、精华列表。

## Edge Config

Edge Config 适合高频读取、低频更新的全局配置：

- `forum_readonly`: 是否全站只读。
- `invite_only`: 是否开启邀请码注册。
- `posting_disabled`: 是否暂停发帖。
- `paid_boards_enabled`: 是否开放付费板块。
- `blocked_terms_version`: 敏感词规则版本。
- `kill_switches`: 高成本或高风险功能开关。

不要把用户状态、计数器、帖子内容放进 Edge Config。Edge Config 写入传播有延迟，不适合频繁更新或要求写后立刻读的数据。

## 文件和附件

使用 Vercel Blob。

存储路径：

```text
users/{userId}/avatar/{fileId}
threads/{threadId}/attachments/{fileId}
posts/{postId}/images/{fileId}
tmp/{yyyy-mm-dd}/{uploadId}
exports/{userId}/{exportId}
```

原则：

- Blob 只存文件内容，元数据存在 Postgres。
- 用户上传走 client upload，减少服务器流量成本。
- 第一版限制上传大小、类型和每日数量。
- 图片默认公开但不可枚举；付费/私密板块附件必须走受控下载。
- 删除帖子时不要立刻硬删文件，先软删并进入延迟清理队列。

## 异步任务

论坛需要异步任务，但第一版不应过度复杂。

适合队列的任务：

- 回复、提及、关注的通知分发。
- 邮件摘要。
- 搜索索引更新。
- 审核扫描。
- 图片处理。
- Webhook 后处理。
- 计数器回填。

优先级：

1. 简单低风险任务：Next.js `after()` 或 Vercel `waitUntil`。
2. 可靠后台任务：Vercel Queues。
3. 如果不想承担 Beta 风险：Upstash QStash。
4. 多步骤长流程：Vercel Workflow，后置。

Vercel Queues 当前是 Beta，并且是 at-least-once delivery。消费者必须幂等。它也不提供严格 FIFO 保证，不要把业务正确性建立在消息顺序上。

## Cron Jobs

Vercel Cron 适合这些任务：

```text
每日 02:00 UTC：发送摘要邮件
每日 03:00 UTC：重算热门榜和用户统计
每日 04:00 UTC：清理 tmp Blob 和过期 session
每小时：重试失败通知或失败 webhook 事件
```

Cron endpoint 必须校验 `CRON_SECRET`。不要因为路径不可见就假设安全。

## 实时能力

第一版不做 WebSocket。Vercel Functions 不支持作为 WebSocket server。论坛也不需要实时聊天式体验。

建议：

- 通知铃铛用轮询，30-60 秒一次即可。
- 主题页可以用“有新回复，点击刷新”的轻提示。
- 如果未来需要实时，接入 Ably、Pusher、Liveblocks、Supabase Realtime 或 Convex，而不是自己在 Vercel 上维护 WebSocket。

## 搜索

第一阶段：

- 使用 Postgres full-text search。
- `threads` 和 `posts` 建 `search_vector`。
- 支持标题、正文、作者、标签的基础搜索。
- 管理后台可以搜索被举报/隐藏内容。

升级触发：

- 搜索成为主要入口。
- 数据超过 Postgres FTS 舒适区。
- 需要拼音、同义词、复杂排序、推荐。

升级选项：

- Upstash Search。
- Meilisearch/Typesense 托管版。
- Algolia。

保留 `packages/search` 抽象，不让页面直接依赖具体搜索实现。

## 可观测性

平台层：

- Vercel Observability：函数耗时、错误、调用量。
- Runtime Logs：短期排障。
- Web Analytics：访问趋势。
- Speed Insights：真实用户性能。

应用层：

```text
audit_events         管理员操作、权限变更、支付状态变更
moderation_events    审核动作、举报、自动拦截
billing_events       支付 Webhook、订阅变化
notification_events  通知发送状态
usage_events         上传、搜索、邮件、AI 调用等成本相关事件
```

平台日志会过期，应用审计要自己掌控。这就是 Vercel 版本的“黑匣子”。

## 安全基线

第一版必须实现：

- Vercel 账户开启 2FA。
- GitHub 主分支保护。
- Production 只从主分支部署。
- Preview 使用测试支付密钥和 preview/staging 数据库。
- Webhook 验签。
- 管理后台独立 admin guard。
- 管理操作写审计。
- 上传文件做类型、大小和频率限制。
- 发帖、回复、登录、邀请码兑换做 rate limit。
- 用户可见错误不泄漏内部异常。

后续增强：

- Vercel Firewall/WAF/Bot Management。
- Log Drains 到长期存储。
- 独立 staging 项目。
- 安全事件告警。
