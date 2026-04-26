---
title: 一人公司 的粗略想法（四）
date: 2026-04-26
description: 一人公司 的粗略想法（四）
category: 胡说八道
---
# 数据模型与权限治理

版本：2026-04-26

## 设计目标

论坛的数据模型必须服务四类需求：

- 内容读写：板块、主题、回复、标签、附件。
- 社区治理：举报、审核、封禁、编辑历史、审计。
- 用户关系：关注、收藏、通知、信任等级。
- 商业化：会员、付费板块、权益、支付事件。

第一阶段使用 Postgres。论坛关系复杂、查询形态多，用户、板块、主题、回复、通知、举报、会员权益都适合用关系表和索引表达。

## 用户与认证

不要把 Google/GitHub 的 provider id 当系统主键。

```text
users
  id uuid/ulid primary key
  email text unique
  name text
  avatar_url text
  status text              registered | active | suspended | banned | deleted
  trust_level int          0-4
  site_role text           user | moderator | admin | owner
  created_at timestamptz
  updated_at timestamptz

auth_accounts
  id
  user_id references users(id)
  provider text            google | github | email
  provider_account_id text
  created_at

sessions
  id
  user_id
  expires_at
  created_at
```

`users.id` 是系统内部唯一身份。未来增加邮箱登录、GitHub 登录、企业 SSO，都只是在 `auth_accounts` 增加记录。

## 板块

```text
boards
  id
  slug unique
  name
  description
  visibility              public | members | paid | staff
  required_entitlement    nullable
  posting_policy          open | trusted | moderators
  sort_order
  thread_count
  post_count
  last_thread_id
  last_post_at
  created_at
  updated_at
```

第一版板块不要太多。`visibility` 和 `required_entitlement` 从第一天存在，哪怕暂时只有 public。

## 主题和回复

```text
threads
  id
  board_id references boards(id)
  author_id references users(id)
  type                    discussion | question | showcase | guide | announcement
  title
  slug
  status                  draft | published | locked | hidden | deleted | archived
  pinned boolean
  accepted_post_id nullable
  reply_count int
  reaction_count int
  view_count int
  score numeric
  last_post_id nullable
  last_post_at
  created_at
  updated_at

posts
  id
  thread_id references threads(id)
  author_id references users(id)
  parent_post_id nullable
  floor int
  body_markdown text
  body_html text
  status                  pending | published | hidden | deleted | rejected
  reaction_count int
  report_count int
  edited_at nullable
  created_at
  updated_at
```

关键约束：

- `(thread_id, floor)` 唯一。
- 主题首帖也在 `posts` 中，通常 floor = 1。
- `threads.last_post_at`、`reply_count` 等是反规范化计数器，为列表性能服务。
- 删除默认软删除，避免破坏讨论上下文。

## 标签

```text
tags
  id
  slug unique
  name
  description
  thread_count

thread_tags
  thread_id
  tag_id
  primary key(thread_id, tag_id)
```

不要一开始允许用户随意创建标签。第一版由管理员创建或审核新标签，避免标签污染。

## 编辑历史

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

每次编辑保存一条 revision。管理员查看争议、用户投诉、审核误伤时需要回溯。

## 互动关系

```text
post_reactions
  user_id
  post_id
  type                    like | thanks
  created_at
  primary key(user_id, post_id, type)

thread_bookmarks
  user_id
  thread_id
  created_at
  primary key(user_id, thread_id)

thread_follows
  user_id
  thread_id
  level                   watching | mentions | muted
  created_at
  updated_at
  primary key(user_id, thread_id)
```

反应、收藏、关注都需要唯一约束，避免重复写。

## 通知

```text
notifications
  id
  user_id
  type                    reply | mention | accepted_answer | moderation | billing
  actor_user_id nullable
  thread_id nullable
  post_id nullable
  payload jsonb
  read_at nullable
  created_at
```

通知生成可以异步，但通知写入要幂等。建议为每类通知设计 `dedupe_key`：

```text
reply:{postId}:to:{userId}
mention:{postId}:to:{userId}
```

## 举报与审核

```text
moderation_reports
  id
  reporter_user_id
  target_type             thread | post | user
  target_id
  reason                  spam | abuse | off_topic | illegal | other
  detail
  status                  open | reviewing | resolved | dismissed
  created_at
  resolved_at

moderation_actions
  id
  moderator_user_id
  target_type
  target_id
  action                  approve | hide | delete | lock | suspend | ban | restore
  reason
  metadata jsonb
  created_at
```

任何影响内容可见性或用户状态的操作都要写 `moderation_actions`。

## 邀请与访问状态

早期论坛建议开启邀请制或候补名单，控制用户质量和垃圾内容。

```text
invite_codes
  id
  code_hash unique
  display_hint
  status                  available | assigned | redeemed | revoked
  assigned_email nullable
  redeemed_by_user_id nullable
  redeemed_at nullable
  expires_at nullable
  batch_id
  created_by_user_id
  created_at

invite_batches
  id
  name
  format
  count
  created_by_user_id
  created_at

waitlist_entries
  id
  email
  user_id nullable
  reason text
  status                  pending | invited | rejected
  created_at
  updated_at
```

邀请码格式使用无歧义字符集：

```text
3479ACDEFGHJKMNPQRTUVWXY
```

默认格式：

```text
XXXX-XXXX
```

邀请码明文不落库，只存 hash。明文只在生成时展示一次。`display_hint` 最多存后四位，便于后台识别。

## 会员与权益

具体支付设计见 `0005_支付会员与商业化.md`。在数据模型层，权限判断不要直接散落读取 Stripe/Paddle 状态，而要读取本地权益快照。

```text
user_entitlements
  user_id
  key                     member | paid_board:{boardId} | founder | no_ads
  value jsonb
  source                  manual | stripe | paddle | lemonsqueezy
  starts_at
  expires_at nullable
  created_at
  updated_at
```

这样支付服务换了，论坛权限判断不变。

## 权限模型

论坛权限来自三层：

```text
site_role       站点级角色
trust_level     信任等级
entitlements    会员/付费权益
```

站点角色：

```text
user -> moderator -> admin -> owner
```

信任等级：

```text
0 new        新用户，严格限制发帖、链接、图片
1 basic      已激活，能正常发帖
2 regular    稳定用户，较高限额
3 trusted    可信用户，可协助标记垃圾内容
4 staff      内部人员或核心协作者
```

权益：

```text
member
paid_board:{boardId}
founder
higher_upload_limit
no_ads
```

服务层 guard：

```ts
requireUser()
requireActiveUser()
requireBoardReadable(user, board)
requireBoardWritable(user, board)
requireModerator(user, board?)
requireEntitlement(user, key)
requireTrustLevel(user, minLevel)
```

权限检查必须在服务层执行，不只靠前端隐藏按钮。

## 状态变更审计

```text
audit_events
  id
  actor_user_id nullable
  action
  entity_type
  entity_id
  ip
  user_agent
  metadata jsonb
  created_at
```

必须审计：

- 用户激活、封禁、解封。
- 版主/管理员操作。
- 邀请码生成、分配、撤销、兑换。
- 付费状态变更。
- 会员权益手工调整。
- 公开/私密/付费可见性变更。
- 大规模删除或迁移。

审计表不要为了省事省掉。一个人维护时，审计就是你事后定位问题的黑匣子。

## 计数器与一致性

论坛有很多计数器：

- 主题回复数。
- 帖子点赞数。
- 板块主题数。
- 用户发帖数。
- 未读通知数。
- 热门分数。

策略：

- 写操作事务内更新必要计数器。
- 允许非关键计数短暂不一致。
- 每日 Cron 重算核心计数并修正。
- 复杂榜单用异步任务或汇总表。

不要每次渲染列表都实时 count 大表。

## 索引建议

```text
boards(slug)
threads(board_id, status, pinned desc, last_post_at desc)
threads(author_id, created_at desc)
threads(score desc, last_post_at desc)
posts(thread_id, floor asc)
posts(author_id, created_at desc)
post_reactions(post_id)
thread_bookmarks(user_id, created_at desc)
notifications(user_id, read_at, created_at desc)
moderation_reports(status, created_at desc)
invite_codes(code_hash)
user_entitlements(user_id, key, expires_at)
audit_events(entity_type, entity_id, created_at desc)
```

上线后根据真实慢查询调整，不要凭空建几十个索引。

## 用户删除与隐私

第一版至少支持：

- 用户可修改昵称和头像。
- 用户可请求删除账户。
- 删除账户时保留帖子但匿名化作者，或按社区规则软删个人资料。
- 管理员能导出某个用户的基础数据。

论坛内容有公共讨论属性，不能简单“一删了之”。需要在用户协议和产品规则里说明。
