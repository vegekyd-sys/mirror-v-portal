---
name: "dealclaw-email-bindings"
description: "DealClaw 邮箱通知绑定：区分个人邮箱(IMAP)与 resend 代理邮箱(webhook)两类绑定"
author: ""
---

# DC-Email Notify Bindings — 邮箱通知绑定管理

> 管理 DealClaw 的「邮箱 → 飞书群通知」绑定。共两类，**先按邮箱域名路由，再走对应流程**：
>
> - **resend 代理邮箱 webhook 绑定**：`xxx@*.dealclaw.io` 代理邮箱（`mail.` / `bde.` / `send.` … 任意子域），服务端 webhook 直接推送
> - **个人邮箱通知绑定**：真实个人/企业邮箱（163、腾讯企业邮箱、gmail 等），本地 IMAP 轮询

---

## 路由判断（先判类型，再收集信息）

### 代理邮箱判据（唯一定义，先记这一条）

- **代理邮箱 = 域名是 `dealclaw.io` 或其任意子域**：`mail.dealclaw.io`、`bde.dealclaw.io`、`send.dealclaw.io` …（外加旧域 `mail.dealclaw.com`）。等价于 account 的 `provider=resend` / `mailbox_kind=dealclaw_proxy`。
- **个人邮箱 = 其他所有域名**：163 / QQ / 腾讯企业邮箱 / gmail / 企业自建域名等。
- 判据是**域名后缀**，不是子域白名单 —— 不要枚举 `mail.`，不要精确匹配某个子域（只认 `mail.dealclaw.io` 就是 09-14 那次漏判的根因）。
- **禁用 MX 探测区分这两类**：代理收信域（如 `bde.dealclaw.io`）必然有 MX，按「有 MX → SMTP」判会把它错误归到个人邮箱。
- 代码同源判据：`scripts/founder-direct/lib/email-routing.mjs`（`isResendProxyDomain`）；`preflight-email.mjs` / `send-direct.mjs` 与本文规则必须一致。

看到「绑邮箱 / 绑定邮件通知 / 邮件通知绑定」类请求，先看用户给的**邮箱域名**：

| 邮箱形态 | 类型 | 绑定方式 | 通知路径 |
|---------|------|---------|---------|
| `xxx@*.dealclaw.io`（任意子域，如 `mail.` / `bde.` / `send.`） | resend 代理邮箱 | `dealclaw.datathink.com/webhook/bindings`（服务端） | resend webhook → 服务端 → 飞书 |
| `@163.com` / `@qq.com` / `@gmail.com` 等真实邮箱 | 个人邮箱 | `email_gateway.cli`（本地） | cron IMAP 轮询 → 飞书 |

判断规则：
- 邮箱域名是 `dealclaw.io` 或其任意子域（`mail.` / `bde.` / `send.` …）且动词是「创建/建/新增」→ 走 **类型 C（登记代理邮箱）**
- 邮箱域名是 `dealclaw.io` 或其任意子域且动词是「绑定/绑」→ 走 **类型 A（代理 webhook 绑定）**
- 其他真实邮箱（`@163.com` 等）→ 走 **类型 B（个人 IMAP）**

- 用户没给邮箱，或只说「绑邮箱」没说是哪种 → 先问邮箱地址，拿到后按域名路由。
- 用户同时提到「代理邮箱 / dealclaw 邮箱」→ 直接走 A。
- 用户提到「个人邮箱 / 163 / QQ / gmail」→ 直接走 B。

两类**不要混用**：个人邮箱走 `/bindings` 服务端接口是无意义的（服务端只认 `dealclaw.io` 代理域发来的 resend webhook 事件，不认个人邮箱域）；代理邮箱也不需要本地 account/IMAP —— 本地 account 只是发信身份，不参与通知绑定。

---

## 类型 A：resend 代理邮箱 webhook 绑定

> 通道：自定义机器人 webhook，`mention_open_id` 自动取 V。
> 服务地址：`https://dealclaw.datathink.com`（接口前缀 `/webhook`）

### 触发条件

- 用户给的邮箱是 `xxx@*.dealclaw.io`（任意子域）
- 或用户说「代理邮箱绑定」「dealclaw 邮箱通知绑定」

### 绑定需要什么

用户提供两样必填、一样可选；认证凭据由脚本自动读取：

| 谁来 | 需要什么 | 说明 |
|------|---------|------|
| 用户 | 代理邮箱 | 我方发送身份，如 `thia@mail.dealclaw.io` |
| 用户 | Webhook URL | 飞书群 → 群设置 → 添加自定义机器人 → 复制地址 |
| 用户 | 验签码（可选） | 机器人开了签名校验才需要，没开就留空 |

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

### 交互流程

收到代理邮箱绑定请求后，按顺序收集：

1. **代理邮箱** → 先问，用户不知道格式给示例 `用户名@mail.dealclaw.io`（`*.dealclaw.io` 任意子域都算代理邮箱）
2. **Webhook URL + 签名校验** → 用户给了邮箱后，同一轮就问两样：webhook 地址 + "你的机器人开签名校验了吗？开了给我验签码"。不要分成两轮。

全部信息收集齐后再调用绑定接口。

### 脚本工具

```bash
# 列出全部绑定
bash scripts/dc-bindings.sh list

# 新增/覆盖绑定（mention_open_id 传当前应用机器人的 open_id）
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

### 接口速查

```bash
# 列出全部
curl -s -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" https://dealclaw.datathink.com/webhook/bindings

# 新增/覆盖
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Admin-Token: $TOKEN" \
  -H "X-Supplier-Id: $SUPPLIER_ID" \
  -d '{"agent_email":"thia@mail.dealclaw.io","webhook_url":"https://.../hook/xxx","webhook_secret":"","prefer":"custom","mention_open_id":"<机器人open_id>","note":"备注"}' \
  https://dealclaw.datathink.com/webhook/bindings

# 删除 / 测试
curl -s -X DELETE -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" https://dealclaw.datathink.com/webhook/bindings/thia@mail.dealclaw.io
curl -s -X POST -H "Content-Type: application/json" -H "X-Admin-Token: $TOKEN" -H "X-Supplier-Id: $SUPPLIER_ID" \
  -d '{"agent_email":"thia@mail.dealclaw.io"}' https://dealclaw.datathink.com/webhook/bindings/thia@mail.dealclaw.io/test
```

规则：
- `agent_email` + `webhook_url` + `mention_open_id` 必填
- `webhook_secret` 可选，没开签名校验就留空
- `mention_open_id` 按上文方法取值
- `prefer` 固定 `custom`

---

## 类型 B：个人邮箱通知绑定（本地 IMAP）

> 通道：本地 `email_gateway`，`cron_notify --all` 每 5 分钟 IMAP 轮询 → 飞书卡片。
> 适用：真实个人/企业邮箱，163 / 腾讯企业邮箱 / gmail。

### 触发条件

- 用户给的邮箱是真实邮箱（`@163.com` / `@qq.com` / `@exmail.qq.com` / `@gmail.com` 等）
- 或用户说「个人邮箱通知绑定」「把我的 163 邮箱通知绑到这个群」

### 绑定需要什么

个人邮箱绑定 = 两步：**先建 account，再绑群**。需要收集：

| 谁来 | 需要什么 | 说明 |
|------|---------|------|
| 用户 | 邮箱地址 | 如 `waqa1988@163.com` |
| 用户 | provider | `netease_163` / `tencent_exmail` / `gmail` |
| 用户 | IMAP/SMTP 授权码 | 163/腾讯 = 网页版生成的「客户端授权码」（非登录密码）；gmail = App Password |
| 用户 | 飞书群 chat_id | `oc_` 开头（通常就是当前群） |
| 用户 | Webhook URL | 飞书群自定义机器人地址（发卡片通道） |
| 系统 | enterprise + owner_open_id | enterprise = supplier id（`.env` 的 `MIO_CDP_SUPPLIER_ID`，自动读）；owner = 当前用户 open_id |

### 交互流程

分两段收集，不要一次塞一堆：

1. **邮箱 + provider + 授权码** → 先问这三样（163/腾讯要提示「网页版设置里开启 IMAP/SMTP 并生成客户端授权码，不是登录密码」）。
2. **chat_id + webhook URL** → 第二段问（群 chat_id 通常就是当前群）。enterprise 自动用 supplier id，owner 默认当前用户，无需用户提供。

收集齐后按下面命令执行，并**验证**（见「验证」）。

### 命令

```bash
cd work/mio-api
export DC_DATA_DIR="$(pwd)/data"
SUPPLIER_ID="$(grep '^MIO_CDP_SUPPLIER_ID=' .env | cut -d= -f2-)"

# 1) 建 account（授权码默认裸明文直接传，不碰 chmod；例：授权码=Abc123xyz）
python3 -m email_gateway.cli account-add \
  --enterprise "$SUPPLIER_ID" \
  --owner-open-id ou_xxx \
  --email waqa1988@163.com \
  --provider netease_163 \
  --secret-ref "Abc123xyz" \
  --display-name "王强163"

# 2) 绑群
python3 -m email_gateway.cli bind-group \
  --account-id ema_xxx \
  --chat-id oc_xxx \
  --webhook "https://open.feishu.cn/open-apis/bot/v2/hook/xxx"
```

`account-add` 关键参数：`--enterprise`（= supplier id，`.env` 的 `MIO_CDP_SUPPLIER_ID`）`--owner-open-id`（= 当前用户 open_id）`--email` `--provider` `--secret-ref`（必填），`--mailbox-kind`（默认 personal）、`--display-name`、`--default`、`--daily-send-limit` 可选。

`bind-group` 关键参数：`--account-id` `--chat-id`（必填），`--filter`（默认 `dealclaw_replies`）、`--webhook`、`--webhook-secret` 可选。

### secret-ref 三种形式（授权码存储，选一种，别混）

- **裸明文**（默认，最简单）—— 授权码直接作为 `--secret-ref` 的值传。**不涉及任何 chmod**。仅当用户明确要求不落明文时才换下面的。
- `env:NAME` —— 环境变量（需先 `export NAME=授权码`；cron 环境 `.env` 不自动加载，需确保 cron 注入了该变量，否则解析失败）。**不涉及 chmod**。
- `file:/绝对路径` —— 0600 权限文件。**只有用户明确要求用文件形式时才走这条**，步骤写死在下面（顺序不能乱：先写文件 → 再 chmod → 最后 account-add）：

```bash
printf '%s' '授权码' > /data/workspace/work/mio-api/.secret-<邮箱别名>
chmod 600 /data/workspace/work/mio-api/.secret-<邮箱别名>
python3 -m email_gateway.cli account-add ... --secret-ref "file:/data/workspace/work/mio-api/.secret-<邮箱别名>"
```

> **绑定成功的唯一标志 = `account-check` 认证通过（见「验证」），不是 chmod 成功。**
> 授权码用裸明文 / env 时根本不会走到 chmod，别画蛇添足去 chmod 一个不存在的文件；chmod 失败不阻塞绑定，也不要在回复里外发「Exec failed」这类内部报错。
> 如果授权码解析失败（`SecretResolutionError`），先确认 cron 进程环境里读得到该 secret（env 需注入、file 需存在且 600、明文无需外部依赖）。

### 验证（最小验证门）

1. `account-check`：`python3 -m email_gateway.cli account-check --account-id ema_xxx` → 确认 IMAP/SMTP 认证通过
2. `sync`：`python3 -m email_gateway.cli sync --account-id ema_xxx` → 确认 IMAP 登录成功（`fetched` 正常，无 `SecretResolutionError`）
3. 让收件人回一封，等 `cron_notify --all` 跑一轮，群里应出卡片 + @ 数字人

---

## 类型 C：创建 resend 代理邮箱（`xxx@*.dealclaw.io`）

> 触发：用户说「创建代理邮箱 xxx@bde.dealclaw.io」「帮我建 resend 代理邮箱」。
> 前提：该代理域已在 Resend 验证（sending+receiving）且配了通配收信，
> 无需逐个别名创建，也无需再建域名。

### 判断规则
- 邮箱域名是 `dealclaw.io` 或其任意子域（`mail.` / `bde.` / `send.` …）且动词是「创建/建/新增」→ 类型 C（登记代理邮箱）
- 动词是「绑定/绑」→ 类型 A（webhook 绑定）

### 一条命令
```bash
cd work/mio-api
SUP=$(grep '^MIO_CDP_SUPPLIER_ID=' .env | cut -d= -f2-)
python3 -m email_gateway.cli account-add \
 --enterprise "$SUP" \
 --owner-open-id <当前用户open_id> \
 --email <用户名>@mail.dealclaw.io \
 --provider resend \
 --mailbox-kind dealclaw_proxy \
 --secret-ref env:RESEND_API_KEY \
 --display-name "<中文名>"
```

### 参数口径
- `--enterprise` = `MIO_CDP_SUPPLIER_ID`（.env 自动读，不手填）
- `--owner-open-id` = 当前用户 open_id（不是机器人 open_id，不是 mention_open_id）
- `--provider` 固定 `resend`；`--mailbox-kind` 固定 `dealclaw_proxy`
- `--secret-ref env:RESEND_API_KEY`（代理发信走 Resend API key，无 IMAP 授权码）
- 创建后**主动说明**：发信身份已可用；回信自动通知还需另走类型 A 绑群（同轮问 webhook）

---

## 故障排查

### 类型 A（代理邮箱）

- `bound: false` → `agent_email` 可能填成了买家邮箱
- `via: "none"` → webhook URL 不对或签名校验不匹配
- `400` → 缺少必填字段（`mention_open_id` 或漏传 `X-Supplier-Id`）
- `401` → ADMIN_TOKEN 不对或过期
- 代理邮箱被当个人邮箱处理（走了本地 `bind-group`/IMAP）→ 域名判据缺口（旧版只认 `mail.dealclaw.io`）：按「代理邮箱判据」重判，`xxx@任意子域.dealclaw.io` 一律走类型 A
- 历史错误记录（`email-registry.json` 里代理域被写成 `smtp`）→ `node scripts/founder-direct/migrate-proxy-protocol.mjs`（先看报告，加 `--apply` 才写入，幂等）

### 类型 B（个人邮箱）

- `SecretResolutionError` → 授权码在 cron 环境读不到（见 secret-ref 三种形式）
- `Unsafe Login` / IMAP 登录失败 → 163 需要客户端授权码（非登录密码），且已开启 IMAP/SMTP
- 收不到通知 → 确认 binding 的 `--webhook` 填了、`notify_enabled` 为真、cron `dealclaw-email-sync-all` 在跑
- 重复发信被 `duplicate idempotency key` 拦截 → 同一收件人默认幂等，需传 `content_version`/`campaign_id` 区分（换附件重发不受影响，附件指纹已算进幂等键）
- 问「这个邮箱能不能发附件」→ 能，个人邮箱与代理邮箱都支持。**但发信不归本 skill 管**：怎么发见 `dealclaw-email-founder-direct` 的「带附件」一节（含绕过刹车/日志的补救清单），机制与上限见 `work/mio-api/email_gateway/README.md`

---

## 脚本路径锚点（避免执行失败）

- 本 skill 的绑定走 `work/mio-api` 下的 `email_gateway.cli` 和 `scripts/dc-bindings.sh`（相对工作区根），不要拼 `/data/workspace` 绝对路径。
- 路由判据实现在 `scripts/founder-direct/lib/email-routing.mjs`；单个邮箱判定可自查：`node scripts/founder-direct/preflight-email.mjs --email <邮箱>`（退出码 0=READY）。
- 不要 `ls`/list `scripts/founder-direct/`、`scripts/resend/` 目录来「确认发信脚本存在」——发信脚本归属 email-founder-direct / email-growth-send，且其 `accounts/`、`.env` 等运行时文件不在镜像里，列目录必失败。

## 限流

- 类型 A `/bindings` 接口：10 次/分钟 burst 5，超出返回 `429`。

---

## 边界

- 类型 A：通道固定自定义机器人，`mention_open_id` 必须为当前应用机器人的 open_id
- 类型 B：`--confirmed-by`（发信）必须匹配邮箱 owner；首次 sync 不导入历史邮件（除非 `--bootstrap-days`）
- 认证双头（类型 A）：`X-Admin-Token`（`WEBHOOK_ADMIN_TOKEN`）+ `X-Supplier-Id`（`MIO_CDP_SUPPLIER_ID`），脚本自动从 `work/mio-api/.env` 读取
- 类型 B 的 `enterprise` = supplier id（`.env` 的 `MIO_CDP_SUPPLIER_ID`），与类型 A 的 `X-Supplier-Id` 同源，保持多租户一致
- 两类不要混用（见「路由判断」）
- 不暴露密钥明文；授权码/验签码只在必要的命令里传，不写进聊天记录或日志
