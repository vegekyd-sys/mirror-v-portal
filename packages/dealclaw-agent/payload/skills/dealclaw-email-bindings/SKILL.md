---
name: "dealclaw-email-bindings"
description: "DealClaw 邮箱通知绑定管理：管理代理邮箱→飞书群绑定关系，含 upsert/list/delete/test 全操作 + 凭据安全 + 故障排查"
---

# DC-Email Notify Bindings — 邮箱通知绑定管理

> 管理 DealClaw email-webhook 的代理邮箱→飞书群绑定。
> 通道：自定义机器人 webhook，mention_open_id 自动取 V。
>
> 服务地址：`https://webhook.dealclaw.io`

---

## 触发条件

- "绑邮箱" / "绑定邮箱" / "邮件通知绑定"
- "查绑定" / "有哪些绑定"
- "删绑定" / "取消绑定"
- "测试绑定" / "通知能通吗"

---

## 绑定需要什么

用户提供两样必填、一样可选，管理员提供一样：

| 谁来 | 需要什么 | 说明 |
|------|---------|------|
| 用户 | 代理邮箱 | 我方发送身份，如 `thia@mail.dealclaw.io` |
| 用户 | Webhook URL | 飞书群 → 群设置 → 添加自定义机器人 → 复制地址 |
| 用户 | 验签码（可选） | 机器人开了签名校验才需要，没开就留空 |
| 管理员 | ADMIN_TOKEN | `WEBHOOK_DEALCLAW_ADMIN_TOKEN` 环境变量，调接口的凭证。**找管理员拿，不要自己找。** |

不填的不需要：mention_open_id 自动取 V，通道固定自定义机器人，不用选。

---

## 脚本工具

```bash
# 列出全部绑定
WEBHOOK_DEALCLAW_ADMIN_TOKEN=*** bash scripts/dc-bindings.sh list

# 新增绑定（验签码没有就留空）
WEBHOOK_DEALCLAW_ADMIN_TOKEN=*** bash scripts/dc-bindings.sh upsert \
  thia@mail.dealclaw.io \
  "https://open.feishu.cn/open-apis/bot/v2/hook/xxx" \
  "" \
  "备注"

# 删除
WEBHOOK_DEALCLAW_ADMIN_TOKEN=*** bash scripts/dc-bindings.sh delete thia@mail.dealclaw.io

# 测试（会真的往群里发一张卡片）
WEBHOOK_DEALCLAW_ADMIN_TOKEN=*** bash scripts/dc-bindings.sh test thia@mail.dealclaw.io
```

upsert 参数：`<agent_email> <webhook_url> [webhook_secret] [note]`

---

## 接口速查

### 列出全部绑定

```bash
curl -s -H "X-Admin-Token: $TOKEN" https://webhook.dealclaw.io/bindings | python3 -m json.tool
```

### 新增/覆盖绑定

```bash
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $TOKEN" \
  -d '{
    "agent_email": "thia@mail.dealclaw.io",
    "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "webhook_secret": "",
    "prefer": "custom",
    "mention_open_id": "ou_15273b08310b914c5f97b27af680c149",
    "note": "备注"
  }' \
  https://webhook.dealclaw.io/bindings
```

规则：
- `agent_email` + `webhook_url` + `mention_open_id` 必填
- `webhook_secret` 可选，没开签名校验就留空
- `mention_open_id` 固定 V
- `prefer` 固定 `custom`

### 删除 / 测试

```bash
curl -s -X DELETE -H "X-Admin-Token: $TOKEN" https://webhook.dealclaw.io/bindings/thia@mail.dealclaw.io
curl -s -X POST -H "Content-Type: application/json" -H "X-Admin-Token: $TOKEN" \
  -d '{"agent_email":"thia@mail.dealclaw.io"}' https://webhook.dealclaw.io/bindings/thia@mail.dealclaw.io/test
```

---

## 故障排查

- `bound: false` → `agent_email` 可能填成了买家邮箱
- `via: "none"` → webhook URL 不对或签名校验不匹配
- `400` → 缺少必填字段（特别是 `mention_open_id`）
- `401` → ADMIN_TOKEN 不对或过期

---

## 限流

10次/分钟 burst 5，超出返回 `429`。

---

## 边界

- 通道固定自定义机器人，mention_open_id 固定 V
- 依赖 `WEBHOOK_DEALCLAW_ADMIN_TOKEN` 环境变量 — **ADMIN_TOKEN 找管理员拿，不要自己找**
- 不暴露密钥明文
