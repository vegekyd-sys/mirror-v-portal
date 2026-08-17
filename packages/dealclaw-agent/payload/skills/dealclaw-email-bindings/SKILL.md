---
name: "dealclaw-email-bindings"
description: "DealClaw 邮箱通知绑定管理：管理代理邮箱→飞书群绑定关系，含 upsert/list/delete/test 全操作 + 凭据安全 + 故障排查"
author: ""
---

# DC-Email Notify Bindings — 邮箱通知绑定管理

> 管理 DealClaw email-webhook 的代理邮箱→飞书群绑定。
> 通道：自定义机器人 webhook，mention_open_id 自动取 V。
>
> 服务地址：`https://webhook.dealclaw.io`

---

## 触发条件

- "绑邮箱" / "绑定邮箱" / "邮件通知绑定"
- 用户同时说「绑定」+「邮件通知」（两词同现即触发）
- "查绑定" / "有哪些绑定"
- "删绑定" / "取消绑定"
- "测试绑定" / "通知能通吗"

---

## 绑定需要什么

用户提供两样必填、一样可选；认证凭据由脚本自动读取：

| 谁来 | 需要什么 | 说明 |
|------|---------|------|
| 用户 | 代理邮箱 | 我方发送身份，如 `thia@mail.dealclaw.io` |
| 用户 | Webhook URL | 飞书群 → 群设置 → 添加自定义机器人 → 复制地址 |
| 用户 | 验签码（可选） | 机器人开了签名校验才需要，没开就留空 |

不填的不需要：通道固定自定义机器人，不用选。

认证凭据（`X-Admin-Token` + `X-Supplier-Id`）由脚本自动从 `work/mio-api/.env` 读取（`WEBHOOK_ADMIN_TOKEN` / `MIO_CDP_SUPPLIER_ID`），多租户隔离，无需人工提供。

### mention_open_id 确定方法
mention_open_id = 处理此绑定请求的应用机器人 open_id，不是用户的 open_id。
取值规则：
1. 先 list 全部绑定，取已有绑定的 mention_open_id → 保持一致，直接抄
2. 无已有绑定时，查当前应用机器人的 open_id
禁止：
- 用用户的 open_id
- 在 SKILL.md 或脚本里硬编码某个值
- 自己编一个

## Agent 交互流程

收到绑邮箱请求后，按以下顺序收集信息：

1. **代理邮箱** → 先问，用户不知道格式给示例 `用户名@mail.dealclaw.io`
2. **Webhook URL + 签名校验** → 用户给了邮箱后，同一轮就要问两样：webhook 地址 + "你的机器人开签名校验了吗？开了给我验签码"。不要分成两轮，也不要在收到 webhook 后再回头问。

全部信息收集齐后再调用绑定接口。

---

## 脚本工具

```bash
# 列出全部绑定（token + supplier id 自动从 .env 读，无需手动传）
bash scripts/dc-bindings.sh list

# 新增绑定（mention_open_id 传当前应用机器人的 open_id）
bash scripts/dc-bindings.sh upsert \
  thia@mail.dealclaw.io \
  "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  "ou_xxxxxxxxxxxxxxxx" \
  "备注"

# 删除
bash scripts/dc-bindings.sh delete thia@mail.dealclaw.io

# 测试（会真的往群里发一张卡片）
bash scripts/dc-bindings.sh test thia@mail.dealclaw.io
```

upsert 参数：`<agent_email> <webhook_url> <mention_open_id> [note]`

---

## 接口速查

### 列出全部绑定

```bash
curl -s -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" https://webhook.dealclaw.io/bindings | python3 -m json.tool
```

### 新增/覆盖绑定

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $TOKEN" \
  -H "X-Supplier-Id: $SUPPLIER_ID" \
  -d '{
    "agent_email": "thia@mail.dealclaw.io",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "webhook_secret": "",
    "prefer": "custom",
    "mention_open_id": "<机器人open_id>",
    "note": "备注"
  }' \
  https://webhook.dealclaw.io/bindings
```

规则：
- `agent_email` + `webhook_url` + `mention_open_id` 必填
- `webhook_secret` 可选，没开签名校验就留空
- `mention_open_id` 按上方 mention_open_id 确定方法取值
- `prefer` 固定 `custom`

### 删除 / 测试

```bash
curl -s -X DELETE -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" https://webhook.dealclaw.io/bindings/thia@mail.dealclaw.io
curl -s -X POST -H "Content-Type: application/json" -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" \
  -d '{"agent_email":"thia@mail.dealclaw.io"}' https://webhook.dealclaw.io/bindings/thia@mail.dealclaw.io/test
```

---

## 故障排查

- `bound: false` → `agent_email` 可能填成了买家邮箱
- `via: "none"` → webhook URL 不对或签名校验不匹配
- `400` → 缺少必填字段（特别是 `mention_open_id`，或漏传 `X-Supplier-Id`）
- `401` → ADMIN_TOKEN 不对或过期

---

## 限流

10次/分钟 burst 5，超出返回 `429`。

---

## 边界

- 通道固定自定义机器人，mention_open_id 必须为当前应用机器人的 open_id，取值规则见上文
- 认证双头：`X-Admin-Token`（`WEBHOOK_ADMIN_TOKEN`）+ `X-Supplier-Id`（`MIO_CDP_SUPPLIER_ID`），脚本自动从 `work/mio-api/.env` 读取，多租户隔离
- 不暴露密钥明文
