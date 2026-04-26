---
title: 一人公司 的粗略想法（三）
date: 2026-04-26
description: 一人公司 的粗略想法（三）
category: 胡说八道
---
# 论坛产品与内容模型

版本：2026-04-26

## 产品定位先于功能

论坛最怕做成“什么都能聊，但没人想聊”。第一版必须先回答：

```text
这个论坛服务谁？
他们为什么不在微信群、Discord、Reddit、V2EX、即刻、知乎里聊？
哪些内容值得沉淀成可搜索、可引用、可长期阅读的帖子？
用户为什么愿意注册、发言、回访，甚至付费？
```

建议第一版选择一个窄主题，而不是泛社区。例如：

- 一人公司实践论坛。
- AI 辅助开发经验论坛。
- Vercel/Next.js 独立产品社区。
- 某个具体技术栈或职业人群的深度问答社区。

越窄，越容易冷启动，越容易形成内容标准。

## MVP 范围

第一版应该有：

- 公开首页。
- 板块列表。
- 主题列表。
- 主题详情。
- 发主题。
- 回复。
- Markdown 编辑和预览。
- 用户资料页。
- 收藏/关注主题。
- 回复和提及通知。
- 举报。
- 管理员审核后台。
- 邀请制或候补名单。
- 会员/付费板块占坑。

第一版不做：

- 私信。
- 群聊。
- WebSocket 实时在线。
- 复杂声望系统。
- 用户自建子论坛。
- 创作者分成。
- 完整广告系统。
- 移动 App。
- 过度复杂的富文本编辑器。

这些不是永远不做，而是不要让它们拖慢第一版上线。

## 内容层级

推荐内容结构：

```text
Forum
  -> Board              板块
      -> Thread         主题
          -> Post       回复/楼层
              -> Revision
              -> Reaction
              -> Report
```

板块用于划分讨论上下文，不要第一版开太多。建议 3-5 个：

- 公告和规则。
- 经验分享。
- 问答求助。
- 项目展示。
- 会员/私密板块。

板块太多会稀释内容密度。冷启动阶段，内容密度比分类精细更重要。

## 主题类型

第一版支持少量主题类型：

```text
discussion   普通讨论
question     问答
showcase     项目展示
guide        长文教程
announcement 公告
```

不同类型可以有轻微差异：

- `question` 可以有 accepted answer。
- `guide` 可以进入精选/文档索引。
- `announcement` 只能管理员发。
- `showcase` 可要求项目链接。

不要一开始做复杂自定义字段。先让主题类型影响列表样式、筛选和权限。

## 帖子与回复

建议每个主题的首帖也是一条 `posts` 记录：

```text
threads
  id
  board_id
  author_id
  type
  title
  slug
  status
  pinned
  locked
  reply_count
  reaction_count
  last_post_id
  last_post_at
  created_at

posts
  id
  thread_id
  author_id
  parent_post_id nullable
  body_markdown
  body_html
  status
  floor
  edited_at
  created_at
```

好处：

- 主题页渲染统一。
- 编辑历史统一。
- 审核和举报统一。
- 将来支持楼中楼或引用回复时更自然。

第一版可以不做无限嵌套回复。用引用和 `parent_post_id` 即可。

## Markdown 与安全

论坛内容建议用 Markdown，而不是一开始做复杂富文本。

要求：

- 服务端渲染并消毒 HTML。
- 允许代码块、链接、图片、引用、列表。
- 第一版禁止或限制 iframe、script、style、任意 HTML。
- 新用户发链接、图片、附件要受信任等级限制。
- 保存 `body_markdown` 和消毒后的 `body_html`。

如果未来 Markdown 处理成为性能瓶颈或安全敏感模块，可以考虑 Rust/Wasm。但第一版 TypeScript 生态足够。

## 内容状态机

主题状态：

```text
draft -> published -> locked
                   -> hidden
                   -> deleted
                   -> archived
```

回复状态：

```text
pending -> published -> hidden -> deleted
                    -> rejected
```

含义：

- `pending`：需要审核，外部不可见。
- `published`：正常可见。
- `hidden`：被审核隐藏，作者和管理员可见。
- `deleted`：软删除，占位或完全隐藏由策略决定。
- `locked`：主题可读不可回复。
- `archived`：旧主题只读。

状态变化必须写 `moderation_events` 和 `audit_events`。

## 编辑历史

帖子编辑不要直接覆盖历史。

```text
post_revisions
  id
  post_id
  editor_user_id
  body_markdown
  body_html
  reason
  created_at
```

第一版可以只让作者在一定时间内编辑，例如 30 分钟。超过时间需要 moderator 或留下公开编辑标记。

这个设计对论坛很重要：争议内容、审核纠纷、用户投诉都需要回溯。

## 反应、收藏、关注

第一版建议只做轻量互动：

- reaction：点赞或感谢。
- bookmark：用户收藏主题。
- follow：用户关注主题，收到新回复通知。

不要一开始做十几种表情反应。论坛内容质量比互动花样更重要。

数据结构：

```text
post_reactions(user_id, post_id, type)
thread_bookmarks(user_id, thread_id)
thread_follows(user_id, thread_id, level)
```

`level` 可取：

```text
watching     所有回复通知
mentions     只通知提及
muted        不通知
```

## 排序与发现

第一版提供三个列表即可：

- 最新：按 `last_post_at desc`。
- 热门：按近 7 天回复、反应、浏览加权。
- 精选：管理员手动标记。

热门分数可以简单：

```text
score = replies_7d * 3 + reactions_7d * 2 + views_7d * 0.2
```

每天或每小时 Cron 重算即可。不要一开始做复杂推荐系统。

## 搜索

第一版搜索目标：

- 能搜标题。
- 能搜正文。
- 能按板块和标签过滤。
- 管理员能搜隐藏/举报内容。

实现：

- Postgres full-text search。
- 标题权重大于正文。
- 标签单独过滤。
- 搜索结果只返回用户有权限看的内容。

后续再升级外部搜索。搜索服务要通过 `packages/search` 抽象，避免业务代码绑定实现。

## SEO

论坛的长期增长很依赖搜索引擎。公开内容页要从第一版做好：

- 主题页 SSR/缓存。
- 稳定 slug：`/t/{threadId}/{slug}`。
- canonical URL。
- sitemap。
- robots.txt。
- 公开板块可索引，私密/付费板块 noindex。
- 被隐藏、删除、审核中的内容不进入 sitemap。
- 标题、摘要、Open Graph 完整。

不要把论坛做成登录后单页应用。公开内容必须能被搜索引擎和未登录用户读到。

## 私密与付费内容

论坛可以有三类可见性：

```text
public        未登录可读
members       登录且 active 可读
paid          拥有对应 entitlement 可读
staff         管理员/版主可读
```

第一版付费内容建议只做“付费板块”，不要做单帖付费、创作者分账、内容市场。

原因：

- 权限模型简单。
- 支付集成简单。
- 运营上更容易解释。
- 避免一开始涉及平台分成和复杂税务/合规。

## 用户路径

游客：

```text
访问首页 -> 浏览公开主题 -> 看到高质量内容 -> 点击注册/申请邀请码
```

新用户：

```text
OAuth 登录 -> 创建 profile -> 注册为 registered -> 输入邀请码或加入 waitlist -> active
```

活跃用户：

```text
发主题 -> 收到回复通知 -> 回访 -> 收藏/关注 -> 逐渐提升 trust level
```

付费用户：

```text
看到会员权益 -> 进入 Checkout/Manual 申请 -> 获得 member entitlement -> 访问付费板块
```

管理员：

```text
查看待审核 -> 处理举报 -> 生成邀请码 -> 查看用户/支付/审计 -> 调整规则
```

## 首页原则

首页应该是论坛本身，不是营销页。

第一屏建议展示：

- 论坛名称和一句定位。
- 当前精选/热门主题。
- 板块入口。
- 登录/加入入口。
- 若为邀请制，明确显示“申请加入”。

不要用大幅 hero 和空泛标语替代实际内容。论坛用户要先看到这里有东西可读，才会注册。

