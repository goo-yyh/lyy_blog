---
title: 一人公司 的粗略想法（七）
date: 2026-04-26
description: 一人公司 的粗略想法（七）
category: 胡说八道
---
# 工程组织、AI 协作与运维

版本：2026-04-26

## 核心原则

这个论坛项目的协作方式：

```text
人负责判断、边界和规格
AI 负责实现、迁移和重复劳动
类型系统、测试、审计、预览环境负责兜底
```

一个人做论坛，最大的风险不是代码写不完，而是边界想不清、审核缺位、支付事故不可追溯。AI 能加速实现，但不能替你承担产品判断和责任。

## 规格驱动开发

每个较大功能先写规格，不直接让 AI 开写。

规格模板：

```text
docs/specs/0001_thread-posting.md

1. 背景
2. 非目标
3. 用户流程
4. 数据模型
5. API / Server Actions
6. 权限要求
7. 状态机
8. 错误码
9. 审计事件
10. 幂等性和并发
11. 测试计划
12. 上线和回滚
```

AI 最适合把清晰规格转成代码，不适合替你猜社区规则和商业边界。

## AI 友好的代码组织

结构要显式、集中、一致：

```text
packages/forum/
  types.ts
  errors.ts
  repository.ts
  service.ts
  permissions.ts
  routes.ts
  __tests__/
```

每个 bounded context 都遵循类似结构：

- `types.ts`：领域类型。
- `errors.ts`：错误码。
- `repository.ts`：数据库读写。
- `service.ts`：业务逻辑和事务。
- `permissions.ts`：权限判断。
- `routes.ts`：HTTP/Server Action 适配。
- `__tests__`：状态机、权限、repository 测试。

这样当你让 AI “给 moderation 增加锁帖功能” 时，它能自然找到要改的位置。

## 分支和部署流程

默认流程：

```text
feature branch
  -> Vercel Preview Deployment
  -> preview database branch
  -> smoke test
  -> PR review
  -> main
  -> production deployment
  -> post-deploy smoke
```

主分支保护：

- typecheck 必须通过。
- lint 必须通过。
- unit tests 必须通过。
- 数据库迁移必须进入 PR。
- 支付、权限、审核相关变更必须人工 review。

不要让 AI 直接操作 production 数据库或 production 环境变量。

## 命令约定

```json
{
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "typecheck": "turbo typecheck",
    "lint": "turbo lint",
    "test": "turbo test",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio",
    "check:env": "tsx scripts/check-env.ts",
    "check:db": "tsx scripts/check-db.ts",
    "seed:dev": "tsx scripts/seed-dev.ts",
    "smoke:prod": "tsx scripts/smoke-prod.ts"
  }
}
```

AI 修改后至少跑：

```text
pnpm typecheck
pnpm lint
pnpm test
```

涉及数据库：

```text
pnpm db:generate
pnpm db:migrate
```

涉及支付：

```text
先用 sandbox/test provider fixture
再用 Vercel preview/staging 验证 webhook
最后生产小流量验证
```

## 测试策略

必须测：

- 发帖权限。
- 私密/付费板块权限。
- 新用户限频。
- 邀请码兑换的一次性和并发安全。
- 举报和审核状态机。
- Webhook 幂等性。
- 用户封禁后核心 API 拒绝。
- 数据库迁移。

建议测试类型：

```text
unit tests
  - 权限函数、状态机、slug、风险评分

integration tests
  - repository + test database
  - 发帖事务和计数器更新
  - webhook parser fixture

e2e smoke
  - 登录
  - 激活
  - 发主题
  - 回复
  - 举报
  - 管理员隐藏内容
  - billing 页面可打开
```

支付 Webhook fixture：

```text
packages/billing/__fixtures__/stripe/
  checkout.session.completed.json
  invoice.paid.json
  customer.subscription.updated.json
  customer.subscription.deleted.json
  invoice.payment_failed.json
```

AI 修改 parser 时，fixture 是兜底。

## 人工 Review 边界

以下代码不允许只靠 AI 自测：

- OAuth callback。
- Webhook 签名验证。
- API key 生成、哈希、验证。
- 权限 guard。
- 付费板块访问控制。
- 用户封禁和删除。
- 审核状态机。
- 数据库 destructive migration。
- 生产环境变量。
- 用户数据导出/删除。

AI 可以写初稿，但你必须审查。

## Rust 使用策略

你熟悉 Rust，但这个项目不要为了 Rust 而 Rust。

适合 Rust 的模块：

- Markdown/HTML 安全处理，如果 TS 方案不满足性能或安全要求。
- 图片压缩、EXIF 清理、附件处理。
- 搜索分词或相似度计算。
- 大规模导入导出。
- 后续独立 worker。

不适合第一阶段用 Rust 的模块：

- 普通 CRUD。
- Auth.js/Better Auth 集成。
- 支付 Webhook。
- 管理后台。
- 简单搜索。

判断标准：

```text
Rust 是否带来明确性能、可靠性或类型收益？
是否会显著增加 Vercel 部署和调试成本？
TS 是否已经足够？
```

只有收益明显时引入 Rust。

## 文档资产

保留这些文档：

```text
docs/design/                  # 顶层设计
docs/specs/                   # 每个功能的实施规格
docs/ops/deploy.md            # 部署流程
docs/ops/rollback.md          # 回滚流程
docs/ops/secrets.md           # 密钥轮换
docs/ops/billing-incident.md  # 支付事故处理
docs/ops/moderation.md        # 审核流程
docs/ops/data-export.md       # 用户数据导出
docs/ops/abuse-spike.md       # 垃圾攻击处理
```

这些不是形式主义，而是未来你和 AI 继续工作的上下文。

## 项目 Skill 的时机

不要第一天就写 Skill。等模式稳定后再固化。

触发条件：

- 项目已有稳定目录结构。
- 已经沉淀 3 个以上重复模式。
- AI 经常问同样上下文。
- 第二个产品或第二个论坛开始复用这些模式。

届时可以创建：

```text
skills/forum/SKILL.md
  - 项目结构
  - 常用命令
  - 数据库模式
  - forum 模块约定
  - moderation 模块约定
  - billing 集成方式
  - 测试要求
  - 禁止事项
```

先有模式，再固化模式。

## 运维基线

上线前必须有：

- `check-env.ts`：校验环境变量。
- `smoke-prod.ts`：生产冒烟测试。
- 数据库 migration 回滚策略。
- 管理员账号 bootstrap。
- 只读模式开关。
- 暂停发帖开关。
- 关闭上传开关。
- 关闭付费板块开关。
- Stripe/MoR webhook 重放工具。
- 审核队列可用。

只读模式很重要。事故发生时，先保住读，再逐步恢复写。

## 备份和恢复

数据库：

- Neon production 使用可恢复能力或定期备份。
- 关键表支持导出。
- 大迁移前做快照或备份。

Blob：

- 文件元数据在 Postgres。
- 清理任务延迟删除，避免误删无法恢复。
- 重要导出物设置过期策略。

代码：

- 所有基础结构和配置变更进 Git。
- Vercel Instant Rollback 只能回滚部署，不能自动回滚数据库。
- 数据库 migration 要能向前修复，而不是指望部署回滚解决全部问题。

## 成本纪律

每个变动成本功能都要有：

- 使用记录。
- 限额。
- 管理员开关。
- 后台可见。

重点关注：

- Blob 存储和流量。
- 图片上传和优化。
- 邮件发送。
- 搜索。
- 长时间 Functions。
- 队列重试风暴。
- 机器人爬取公开页面。

控制手段：

```text
邀请制默认开启
新用户低限额
上传大小限制
付费板块不允许无限附件
Cron 清理临时文件
队列最大重试次数
异常 IP 限频
每日成本和用量汇总
```

省钱不是最终目的，但失控成本会直接杀死一人项目。

## 上线前检查清单

- [ ] Vercel 账户 2FA 已开启。
- [ ] Production 数据库不是 preview 数据库。
- [ ] Production OAuth callback URL 正确。
- [ ] Webhook endpoint 使用 live secret。
- [ ] Sandbox/test key 没有进入 production。
- [ ] `check:env` 通过。
- [ ] 数据库迁移已跑。
- [ ] 管理员账号已配置。
- [ ] 邀请制或发帖限制默认开启。
- [ ] 新用户不能无限发帖/上传。
- [ ] 举报和审核后台可用。
- [ ] 付费板块权限测试通过。
- [ ] Webhook fixture 测试通过。
- [ ] 生产 smoke test 通过。
- [ ] 回滚和只读模式明确。
