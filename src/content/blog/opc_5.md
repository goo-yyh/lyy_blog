---
title: 一人公司 的粗略想法（五）
date: 2026-04-26
description: 一人公司 的粗略想法（五）
category: 胡说八道
---
# 支付会员与商业化

版本：2026-04-26

## 结论先行

支付方案必须按不确定性设计。

如果你能合法、稳定地开通 Stripe，第一选择是：

```text
Stripe + Vercel Stripe Integration + Stripe Checkout + Customer Portal + Webhook
```

如果你不能直接开通 Stripe，尤其是主要经营主体在中国大陆且没有 Stripe 支持国家/地区的实体、税号、地址和银行账户，不要把第一版绑定死在 Stripe。优先评估 Paddle、Lemon Squeezy 这类 Merchant of Record，或者先使用 Manual Provider 验证付费意愿。

论坛第一版的商业化不要做复杂“内容交易市场”。推荐从会员制开始：

```text
免费公开内容
  -> 会员身份
  -> 会员板块
  -> 更高发帖/上传/通知配额
  -> 支持者徽章
```

## Stripe 开通判断

截至 2026-04-26，Stripe 支持的商户开户地区包含美国、香港、日本、新加坡、英国、欧盟多个国家/地区等，但不包含中国大陆。

如果你想在非主要经营国家/地区开 Stripe，通常需要当地法律实体、税号、地址、电话、身份证明、业务网站和当地实体银行账户等材料。具体要求以 Stripe 后台 KYC/KYB 为准。

判断建议：

- 你有美国个人税务身份、美国银行账户，且产品和业务信息符合 Stripe 要求：可以评估美国 Stripe。
- 你有香港公司和香港银行账户：可以评估香港 Stripe。
- 你只有中国大陆个人身份和大陆银行账户：短期不假设 Stripe 可用。
- Stripe Atlas 可以帮助注册美国公司，但会带来公司维护、税务、银行和合规成本。论坛 MVP 阶段不要轻率上。

这不是法律、税务或支付合规建议。正式收费前要按你的主体、所在地、客户所在地和产品类型确认。

## MoR 备选路径

Paddle 和 Lemon Squeezy 这类 Merchant of Record 的价值是：它们在支付流程中作为记录商户，通常会承担更多税务、VAT/GST、合规、退款和争议处理职责。代价是费率更高、审核更强、平台规则更多，用户账单上也可能出现 MoR 平台而不是你的主体。

适合：

- 你暂时无法直接开通 Stripe。
- 你卖的是数字产品、会员、订阅或软件服务。
- 你希望尽快验证海外信用卡付费。
- 你不想第一版就处理全球税务。

不适合：

- 产品类目可能被 MoR 禁止。
- 你需要完全控制支付体验和商户名。
- 你要做用户之间的分账或 marketplace。
- 你需要国内微信/支付宝为主的本地支付。

所以 MoR 是 Stripe 不确定时的务实备选，不是“无脑更好”。

## 为什么论坛不要先做复杂计费

论坛第一版的边际成本主要是：

- Vercel 平台。
- 数据库。
- Blob 存储和流量。
- 邮件通知。
- 搜索/队列。
- 可能的审核或 AI 辅助成本。

这些成本不需要一开始做复杂“额度扣减”。论坛更自然的付费方式是会员和访问权。

所以第一阶段做 `billing` bounded context，而不是独立计费服务：

```text
packages/billing/
  provider/
    stripe.ts
    paddle.ts
    lemonsqueezy.ts
    manual.ts
  services/
    checkout.ts
    subscription.ts
    entitlement.ts
    webhook.ts
  repositories/
    billing-repo.ts
    entitlement-repo.ts
    event-repo.ts
```

等第二个产品或多个论坛复用计费时，再抽成独立服务。

## BillingProvider 抽象

业务代码不要直接依赖 Stripe。

```ts
interface BillingProvider {
  createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutSession>
  createCustomerPortal(input: CustomerPortalInput): Promise<CustomerPortalSession>
  parseWebhook(req: Request): Promise<BillingWebhookEvent>
  providerName(): "stripe" | "paddle" | "lemonsqueezy" | "manual"
}
```

统一事件：

```ts
type BillingWebhookEvent =
  | { type: "subscription.created"; customerId: string; plan: string; metadata: Metadata }
  | { type: "subscription.updated"; customerId: string; plan: string; status: string; metadata: Metadata }
  | { type: "subscription.cancelled"; customerId: string; metadata: Metadata }
  | { type: "invoice.paid"; customerId: string; periodStart: Date; periodEnd: Date; metadata: Metadata }
  | { type: "payment.failed"; customerId: string; metadata: Metadata }
  | { type: "one_time_payment.succeeded"; customerId: string; product: string; metadata: Metadata }
```

Stripe、Paddle、Lemon Squeezy 的事件不同，但进入系统后必须归一成自己的领域事件。

## 论坛定价模型

第一版建议三层：

| 层级 | 价格假设 | 权益 |
| --- | --- | --- |
| Free | $0 | 阅读公开内容、有限发帖、基础通知 |
| Member | $5-9/月 | 会员板块、支持者徽章、更高发帖和上传限额、无广告占坑 |
| Founder | $29-99/年或一次性 | 创始会员徽章、早期私密板块、反馈优先级、长期折扣 |

这只是定价假设。早期更重要的是验证：

- 用户是否愿意为社区质量付费。
- 用户更在意会员身份、私密内容、工具权益还是支持项目本身。
- 付费是否会伤害公开内容增长。

## 不同商业化路径

### 会员制

最推荐的第一路径。

优点：

- 技术实现简单。
- 权限模型稳定。
- 不涉及创作者分成。
- 用户理解成本低。

### 付费板块

适合高质量小圈子：

- 深度讨论。
- 项目复盘。
- 私密问答。
- 高价值资料索引。

注意：付费板块不能只是“把所有好内容藏起来”。公开内容负责增长，付费内容负责转化。

### 一次性支持

适合支付不确定阶段：

- Founder badge。
- 手动开通会员。
- 通过 Manual Provider 记录。

### 广告和赞助

后置。广告需要流量，赞助需要垂直人群信任。第一版不要先做广告系统。

### 创作者分成

不建议第一阶段做。原因：

- 涉及付款给用户，可能需要 Stripe Connect 或 MoR 的 marketplace 能力。
- KYC、税务、退款、纠纷复杂度上升。
- 容易吸引低质量套利内容。

## 数据模型

```text
billing_customers
  id
  user_id
  provider
  external_customer_id
  created_at

subscriptions
  id
  user_id
  provider
  external_subscription_id
  tier                    free | member | founder | admin_granted
  status                  trialing | active | past_due | cancelled | unpaid
  current_period_start
  current_period_end
  cancel_at_period_end
  created_at
  updated_at

user_entitlements
  user_id
  key                     member | founder | paid_board:{boardId} | no_ads
  value jsonb
  source                  manual | stripe | paddle | lemonsqueezy
  starts_at
  expires_at
  created_at
  updated_at

billing_provider_events
  id
  provider
  external_event_id
  event_type
  status                  received | processing | processed | failed | ignored
  raw_payload jsonb
  error text
  received_at
  processed_at

billing_ledger
  id
  user_id
  provider
  type                    subscription | one_time | refund | admin_adjustment
  amount_cents
  currency
  external_payment_id
  description
  metadata jsonb
  created_at
```

关键约束：

- `billing_provider_events(provider, external_event_id)` 唯一。
- `billing_ledger` 只追加，不修改历史。
- 权限判断只读 `user_entitlements`，不要每次请求查询支付平台。
- 手工调整权益必须写 reason 和 audit event。

## Stripe 流程

### Checkout

```text
1. 用户点击升级
2. 服务端创建 Checkout Session
3. metadata 写入 userId、tier、returnPath
4. 用户跳转 Stripe 托管页面
5. Stripe Webhook 回调
6. 系统持久化 provider event
7. 更新 subscription 和 entitlements
8. 用户回到 /settings/billing，前端刷新状态
```

使用托管 Checkout，不自己处理银行卡信息，降低安全和 PCI 压力。

### Customer Portal

订阅管理、取消、更新支付方式优先使用 Stripe Customer Portal。不要第一版自建复杂账单中心。

### Vercel Stripe Integration

Vercel 的 Stripe Integration 可以创建 sandbox 或连接已有 Stripe 账号，并把 API keys provision 到环境变量。这样能减少手动复制密钥的风险。

## Webhook 设计

Webhook 不是普通 API，是支付系统的核心。

推荐流程：

```text
1. 读取 raw request body
2. 使用 provider secret 验签
3. 解析 provider event id
4. 插入 billing_provider_events，唯一约束防重复
5. 快速返回 2xx
6. 后续同步处理小状态变更，或入队处理复杂逻辑
7. 失败时标记 failed，由后台重试或人工处理
```

Stripe Webhook 验签依赖 raw body。不要让框架提前改写 body。Webhook endpoint 应快速返回 2xx，再处理复杂逻辑。

第一版至少处理：

```text
checkout.session.completed
invoice.paid
customer.subscription.updated
customer.subscription.deleted
invoice.payment_failed
```

状态策略：

- `active`：开放会员权益。
- `past_due`：给宽限期，提示用户更新支付方式。
- `cancelled` / `unpaid`：到期后撤销会员权益，但保留用户内容。
- Webhook 重放不能重复发放权益。

## Manual Provider

支付通道未确定时，Manual Provider 很有用。

功能：

- 管理员手工把用户升为 Member/Foundation。
- 记录来源：转账、测试、赠送、早鸟、合作。
- 设置过期时间。
- 写 `billing_ledger` 和 `audit_events`。

这不是长期方案，但能验证“是否有人愿意付费”。不要因为 Stripe 未定就停止产品开发。

## 会员权益判断

服务层统一判断：

```ts
requireEntitlement(userId, "member")
requireEntitlement(userId, `paid_board:${boardId}`)
requireTier(userId, "member")
```

前端可以根据 session claims 快速显示 UI，但关键写操作必须服务端查最新权益。

## 支付事故处理

必须有后台能力：

- 查看 provider event。
- 查看用户 subscription。
- 查看 entitlement。
- 手工重放 failed event。
- 手工调整会员权益。
- 导出 ledger。
- 查看某个用户完整支付事件链路。

一个人运营时，支付事故最怕“用户付了钱但你不知道系统发生了什么”。账本和事件表是底线。
