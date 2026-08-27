# DealClaw 邮件 Webhook 接收服务

接收 Resend webhook → 验签 → 记录事件 → 更新线索状态 → 推送飞书。

TypeScript + Fastify + Node 22（pnpm 管依赖，与 dealclaw-nexus 一致）。

- 线上地址：`https://webhook.dealclaw.io`（Cloudflare 代理）
- Resend Webhook 填：`https://webhook.dealclaw.io/inbound`

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 返回 `{"status":"ok",...}`，附带各依赖的连接状态 |
| POST | `/inbound` | 接收 Resend 事件 |
| GET | `/v1/events` | 认证增量读取事件，供本地 poller 拉取（Bearer `ADMIN_TOKEN`） |
| GET | `/bindings`、`/suppliers` | 管理接口，见 [docs/BINDINGS_API.md](docs/BINDINGS_API.md) |
| GET | `/docs` | OpenAPI 文档 |

### 路由前缀

`ROUTE_PREFIX` 决定上表所有路径的前缀：

| 场景 | `ROUTE_PREFIX` | 实际路径 |
|---|---|---|
| 本地开发 / 独占域名 | 空（默认） | `/inbound`、`/bindings`… |
| k8s（与其他服务共用 ALB） | `/webhook` | `/webhook/inbound`、`/webhook/bindings`… |

应用自身就监听带前缀的路径，**网关不需要 StripPrefix / rewrite**。
唯一的例外是 `/health`：它无条件同时挂在根路径上，因为 k8s 探针直连 Pod、
拿不到 Ingress 的前缀。

`/inbound` 的响应会说明每个环节的结果，便于排查：

```json
{
  "status": "accepted",
  "message_id": "msg_xxx",
  "event_type": "email.clicked",
  "lead_status": "CLICKED",
  "persisted_to": "/var/lib/email-webhook/events/2026-07-28.jsonl",
  "lead":   {"backend": "redis", "matched": true, "updated": true,
             "previous_status": "OPENED", "new_status": "CLICKED"},
  "notify": {"sent": true, "reason": ""}
}
```

## 本地开发

```bash
pnpm install
```

需要一个 PostgreSQL。本地起个一次性的就行：

```bash
docker run -d --name ewh-pg -e POSTGRES_PASSWORD=devpass -e POSTGRES_DB=email_webhook_test -p 15432:5432 postgres:16-alpine
```

```bash
DATABASE_URL=postgresql://postgres:devpass@localhost:15432/email_webhook_test ALLOW_UNSIGNED=true ADMIN_TOKEN=dev pnpm dev
```

建表不需要额外步骤 —— 三个 store 各自在首次访问时 `CREATE TABLE IF NOT EXISTS`，
对着空库直接能起。所以没有独立的 migration 文件。

| 命令 | 作用 |
|---|---|
| `pnpm dev` | tsx watch，改完即重启 |
| `pnpm build` | `tsc` 输出到 `dist/` |
| `pnpm start` | 跑编译产物（生产用这个） |
| `pnpm test` | vitest。存储层测试直连上面那个 Postgres（`TEST_DATABASE_URL` 可覆盖） |
| `pnpm typecheck` | 只做类型检查 |

`tests/smoke_test.py` 是**黑盒**验收脚本（只依赖 Python 标准库，自己构造合法/非法
Svix 签名），对着跑起来的服务打，和服务用什么语言写无关 —— TS 重写就是靠它验证
行为没漂移的，所以保留。

## 处理流程

```
验签 → 解析 → 幂等去重 → 落盘 → 落库 → 更新线索 → 获取邮件正文 → 飞书通知
```

落盘之前失败返回非 2xx（让 Resend 重试）；落盘之后失败仍返回 200，
因为事件已持久化，重推没有意义，失败细节写在响应和日志里。

## 线索状态映射

| Resend 事件 | 线索状态 | rank | 推飞书 |
|---|---|---|---|
| `email.sent` | `SENT` | 10 | 否 |
| `email.delivery_delayed` | `DELAYED` | 15 | 否 |
| `email.delivered` | `DELIVERED` | 20 | 否 |
| `email.opened` | `OPENED` | 30 | **是** |
| `email.clicked` | `CLICKED` | 40 | **是** |
| `email.bounced` | `BOUNCED` | 90 | **是** |
| `email.complained` | `COMPLAINED` | 100 | **是** |
| `email.received`（买家回信） | `REPLIED` | 200 | **是** |

**状态只前进不后退**：webhook 到达顺序不保证，rank 更低的事件不会覆盖已有状态
（迟到的 `delivered` 不会把已 `clicked` 的线索打回去）。`bounced`/`complained`
是负向终态，rank 很高。`REPLIED` rank 最高——买家亲自回信是最强意向信号，
不该被任何后续投递事件盖掉。

> 若业务上认为「投诉」必须压过「已回复」（例如据此停止发信），
> 把 `COMPLAINED` 的 rank 调到 200 以上即可，其余逻辑不用动。

### 线索方向（容易搞反的地方）

出站事件里买家是**收件人**，收信事件里买家是**发件人** —— 我们自己的代理邮箱
才是收件人。所以线索匹配统一走 `event.lead_email`：

| 事件方向 | 线索取自 | 例 |
|---|---|---|
| 出站（sent/delivered/opened/clicked/bounced/complained） | `data.to[0]` | `tiangengjun@meorient.com` |
| 收信（received） | `data.from` | `tiangengjun@meorient.com` |

地址会去掉显示名并转小写（`Buyer <B@X.com>` → `b@x.com`），否则同一个人会因为
显示名不同被当成两条线索。

### 飞书卡片中的邮件正文

Resend webhook payload **不含邮件正文**。配置 `RESEND_API_KEY` 后，服务会在发送
飞书通知前按 `email_id` 查询完整邮件：收信事件走 Receiving API，出站事件走
Sent Email API。优先展示纯文本；只有 HTML 时会安全转换为纯文本。

正文默认最多展示 1200 个字符，可用 `EMAIL_CONTENT_PREVIEW_CHARS` 调整（有效范围
200–4000）。正文只进入飞书卡片，不会写入 webhook 响应，也不入库 —— `email_events.raw`
存的仍然只是 Resend 推来的原始报文。
Resend API 超时、权限不足或查询失败时会降级为原来的元数据卡片，不影响事件落盘、
线索状态或通知发送。

自定义机器人绑定必须在对应邮箱上配置 `mention_open_id`，这样不同代理邮箱可以
分别 @ 不同负责人：

```json
{
  "agent_email": "thia@mail.dealclaw.io",
  "mention_open_id": "ou_xxx"
}
```

全局环境变量仍作为兼容性回退，供历史绑定、仅应用机器人绑定或未命中绑定的全局
机器人使用：

```bash
FEISHU_MENTION_OPEN_ID=ou_xxx
FEISHU_MENTION_EVENTS=email.received
```

绑定值和全局回退值都只接受 `ou_` 开头的 Open ID。绑定测试接口构造的也是
`email.received` 卡片，因此可用于验证该绑定的 @ 是否生效。

已有服务器的 env 文件不会被 `bootstrap.sh` 覆盖，首次启用时需手动加入：

```bash
RESEND_API_KEY=<从 Resend 控制台获取>
RESEND_TIMEOUT_SECONDS=5
EMAIL_CONTENT_PREVIEW_CHARS=1200
```

## 验签

Resend 走 Svix。签名内容为 `{svix-id}.{svix-timestamp}.{原始body}` 的
HMAC-SHA256，**必须用未经解析的原始字节**——任何重新序列化都会导致签名对不上。
`svix-*` 和标准的 `webhook-*` 两套头都支持。

时间戳超出容忍窗口（默认 300 秒）直接拒绝，防重放。
未配置 `RESEND_SIGNING_SECRET` 且未开 `ALLOW_UNSIGNED` 时**拒绝所有请求**（fail closed）。

## 幂等

`email_events.message_id` 上有唯一约束，写入走 `INSERT ... ON CONFLICT (message_id) DO NOTHING`。
插不进去就是重复投递，返回 `{"status":"duplicate"}`。

这个保证来自数据库本身，**不依赖 Redis**。早期版本用 Redis `SET NX` 做去重，
Redis 不可用时是 fail open 静默放行的 —— 后果是 Resend 重推时运营会收到重复的
飞书卡片，而且没有任何报错。现在这条路没有了。

## 存储

全部在 PostgreSQL，没有本地文件状态（所以服务是无状态的，可以多副本、正常滚动更新）。

| 表 | 存什么 |
|---|---|
| `email_events` | 原始事件。`raw` 是 Resend 完整报文（JSONB），其余是可查的正经列 |
| `email_bindings` | 代理邮箱 → 飞书通知渠道的绑定 |
| `email_suppliers` | 供应商（租户）元信息 |

只有 `raw` / `detail` 两列是 JSONB —— 它们存的是对方定义的报文结构，必须原样留存。

建表语句内联在各自的 store 里，首次访问时执行一次（`CREATE TABLE IF NOT EXISTS`），
没有独立的 migration 文件。

## 线索后端

`LEAD_BACKEND` 三选一：

- `noop` — 只记日志，不写任何库
- `redis` — 状态写 Redis Hash `emailhook:lead:{email}`（**当前线上用这个**）
- `postgres` — 直接 UPDATE 业务表，需配 `LEAD_TABLE` / `LEAD_EMAIL_COLUMN` / `LEAD_STATUS_COLUMN`

拿到 DealClaw 线索表 schema 后，正常情况下只要改环境变量，不需要动代码。

## 配置

全部通过环境变量注入。**加粗的是凭据**，只能进 Secret，不要写进 ConfigMap 或提交仓库。

| 变量 | 默认值 | 说明 |
|---|---|---|
| **`DATABASE_URL`** | 空 | **必需**。绑定表/供应商表/事件都在这里。缺了服务启动即失败 |
| `HOST` | `127.0.0.1` | 监听地址。**容器里必须设成 `0.0.0.0`**，否则探针和 Service 连不进来（镜像里已设） |
| `PORT` | `8000` | 监听端口 |
| `LOG_LEVEL` | `info` | `silent`/`error`/`warn`/`info`/`debug`/`trace` |
| `ROUTE_PREFIX` | 空 | 业务路由前缀。k8s 里是 `/webhook`，见上面「路由前缀」一节 |
| **`RESEND_SIGNING_SECRET`** | 空 | Resend 控制台的 Signing Secret（`whsec_` 开头）。**留空且未开 `ALLOW_UNSIGNED` 时拒绝所有请求** |
| `ALLOW_UNSIGNED` | `false` | 跳过验签。仅本地联调用，生产必须 false |
| `SIGNATURE_TOLERANCE_SECONDS` | `300` | 时间戳容忍窗口，防重放 |
| **`RESEND_API_KEY`** | 空 | 查询邮件正文用。留空则飞书卡片只有元信息 |
| `RESEND_API_BASE_URL` | `https://api.resend.com` | 一般不用改 |
| `RESEND_TIMEOUT_SECONDS` | `5` | 正文查询超时 |
| `EMAIL_CONTENT_PREVIEW_CHARS` | `1200` | 卡片正文长度，代码限制在 200–4000 |
| **`ADMIN_TOKEN`** | 空 | `/bindings`、`/suppliers`、`/v1/events` 的凭据。**留空则这些接口整体 503**（fail closed） |
| `DEFAULT_SUPPLIER_ID` | `151897148668` | 存量绑定和未指定归属时落到哪家 |
| **`REDIS_ADDR`** | 空 | `host:port` 或完整 `redis://` URL。只在 `LEAD_BACKEND=redis` 时需要 |
| **`REDIS_PASSWORD`** | 空 | |
| `REDIS_DB` | `0` | |
| `REDIS_KEY_PREFIX` | `emailhook` | 键前缀 |
| **`FEISHU_WEBHOOK_URL`** | 空 | 全局自定义机器人。按邮箱的绑定在 `bindings.json` 里，优先级更高 |
| **`FEISHU_SECRET`** | 空 | 机器人开了「签名校验」才需要 |
| `NOTIFY_EVENTS` | 见下 | 逗号分隔。默认 `email.received,email.opened,email.clicked,email.bounced,email.complained` |
| `FEISHU_TIMEOUT_SECONDS` | `5` | |
| `FEISHU_MENTION_OPEN_ID` | 空 | 全局 @ 的负责人 Open ID（`ou_` 开头），绑定里没配时的回退 |
| `FEISHU_MENTION_EVENTS` | `email.received` | 哪些事件要 @ 人 |
| `LEAD_BACKEND` | `noop` | `noop` / `redis` / `postgres` |
| `LEAD_TABLE` | 空 | `LEAD_BACKEND=postgres` 时必填 |
| `LEAD_EMAIL_COLUMN` | `email` | |
| `LEAD_STATUS_COLUMN` | `email_status` | |
| `LEAD_UPDATED_COLUMN` | 空 | 填了会顺带更新这个时间列 |

## 部署

和 monorepo 其他服务一致：包根一个 `Dockerfile`，k8s 清单在根 `k8s/base/email-webhook/`。

### 镜像

```bash
docker build -t dealclaw-acr-registry.cn-hangzhou.aliyuncs.com/dealclaw-nexus/email-webhook:$(git rev-parse --short HEAD) packages/email-webhook
```

`node:22-alpine` 两段式构建、`USER node`(uid 1000)、只读根文件系统、不写盘。
集群是 amd64，Apple Silicon 上加 `--platform linux/amd64`。

推送走 ACR 企业版实例 `dealclaw-acr` 的公网端点，集群拉取走 VPC 端点
（`dealclaw-acr-registry-vpc.cn-hangzhou.cr.aliyuncs.com`，清单里用的是这个）。
`dealclaw-nexus` 命名空间开了「推送自动建仓」，仓库不用提前创建。

### K8s

```bash
kubectl apply -k k8s/base/email-webhook
```

凭据不在清单里，单独建（**`ADMIN_TOKEN` 要沿用现有值**，否则 openclaw 和 poller 都得跟着改）：

```bash
kubectl -n <namespace> create secret generic email-webhook-secret --from-env-file=/path/to/email-webhook.env
```

几个和别的服务不一样的地方：

- **无状态，可多副本**。状态全在 PostgreSQL，幂等靠数据库唯一约束，
  两个副本同时收到同一条重推也只会落一条。base 里 `replicas: 1`，按需在 overlay 里加。
- **ALB 健康检查必须指到 `/health`**。默认打 `/` 且用 HEAD，而本服务 `/` 是 404，
  用默认值会把后端判成全不健康、整条链路 503。`/health` 无论 `ROUTE_PREFIX`
  设成什么都挂在根路径上，就是为这个留的。
- **同 host 多条 Ingress 靠 `order` 排优先级**（数值越小越优先）。管理接口那两条是 1/2，
  兜底的 `/webhook` 是 20；反了的话限流会被绕过。

### ⚠️ 回源方式：一个踩过的坑

最初的架构是「Cloudflare 直接回源到源站的非标端口 TLS」，跑了不到一天就断，表现为
**525 SSL handshake failed**。抓包定位到根因：TCP 建连成功、TLS ClientHello 送达、
源站 ACK 之后 **0.08ms** 就收到 6 个 RST——而 CF 到源站真实 RTT 约 207ms，
物理上不可能来自 Cloudflare，是路径上的设备注入。触发点精确落在 ClientHello
（内含明文 SNI）。换端口、换证书、改 nginx 都无效。

结论：**跨境入站 TLS 握手会被打断**。当时的解法是 Cloudflare Tunnel，把握手方向
反过来（源站主动出站）。

搬到 ALB 之后这个风险**依然存在**——机器换了，链路特征没变。如果打算让 Resend
经 Cloudflare 直连 ALB，先小流量验证；更稳的做法是把 cloudflared 也跑进集群，
指向 `email-webhook` 这个 ClusterIP Service。

## 运维

```bash
kubectl -n <namespace> logs -f deploy/email-webhook
```

```bash
kubectl -n <namespace> rollout restart deploy/email-webhook
```

改了 ConfigMap/Secret 必须 `rollout restart`，`envFrom` 不会自动触发滚动。

Pod 内直连探活（不经 Ingress，走根路径）：

```bash
kubectl -n <namespace> exec deploy/email-webhook -- node -e "fetch('http://127.0.0.1:8000/health').then(r=>r.text()).then(console.log)"
```


## 验收测试

走完整公网链路（推荐，顺带验证 Cloudflare 没有篡改请求体）：

```bash
python3 tests/smoke_test.py https://webhook.dealclaw.io/webhook "$RESEND_SIGNING_SECRET"
```

只测本机、跳过 Cloudflare（排查时用来区分是源站问题还是 CF 问题）：

```bash
kubectl -n <namespace> port-forward deploy/email-webhook 8000:8000 &
python3 tests/smoke_test.py http://127.0.0.1:8000/webhook "$RESEND_SIGNING_SECRET"
```

脚本只依赖标准库，自己构造合法/非法 Svix 签名，逐条覆盖需求表的最小验收标准。
当前结果 **21/21 通过**（TS 版重写后对着容器复验过）。

> 验签是基于原始字节的 HMAC，任何中间环节改动 body 都会导致全线失败。
> 公网链路能全部跑通，就证明 Cloudflare 这一层是字节透传的。
