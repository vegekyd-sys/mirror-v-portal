# WhatsApp ↔ 飞书桥接服务

Node 服务：YCloud WhatsApp 与飞书客服群话题双向同步。买家 WhatsApp 消息写入固定客服群里的一条话题；客服在该话题回复后回发 WhatsApp。也支持 Partner Direct Link 嵌入式注册，为客户开通 WABA。

## 能力（第一版）

- 文本双向同步
- 每个「买家 × 企业号」会话对应一条飞书话题
- YCloud / 飞书 webhook 验签与事件幂等
- 24h 窗口外禁止自由文本，并在话题里提示需要模板
- 忽略机器人自己发的飞书消息，避免回环
- Partner Direct Link：服务端创建一次性 Onboarding Link，Webhook 落库 WABA 绑定
- 管理员恢复入口：把 YCloud 中已存在、无法重新走 Direct Link 的 WABA 导入单一租户

## 启动

完整步骤（环境变量、数据库、飞书/YCloud Webhook、生产进程守护）见 **[docs/部署.md](docs/部署.md)**。

本地最快路径：

本包已并入 `dealclaw` monorepo，依赖在仓库根统一安装（pnpm workspace）：

```bash
cd ../.. && pnpm install
```

```bash
cp .env.example .env.development   # 填入 YCloud / 飞书 / 数据库配置
pnpm --filter @dealclaw/whatsapp-bridge build
pnpm --filter @dealclaw/whatsapp-bridge dev
```

建表 + 迁移一步到位（幂等，可重复执行）：

```bash
pnpm --filter @dealclaw/whatsapp-bridge db:setup
```

健康检查：`GET /health`。生产不要用 `prisma migrate dev`（RDS 通常没有 shadow DB），`db:setup` 内部走的是 `migrate deploy`。

## Webhook

| 通道 | 路径 |
|------|------|
| YCloud | `POST /webhooks/ycloud` |
飞书事件：每个应用使用智能体注册后返回的 `POST /webhooks/feishu/<appId>`。兼容旧配置 `POST /webhooks/feishu`（仅当桥接 env 里仍有 `FEISHU_*` 时）。

公网调试可用 ngrok / Cloudflare Tunnel，把上述 URL 配进 YCloud Webhook 与飞书事件订阅。飞书需订阅 `im.message.receive_v1`。买家来信时：没有客服群会自动创建「WhatsApp 客服」群再拉话题；已有该群则只创建话题。`FEISHU_CHAT_ID` 可空。

智能体**只调桥接 HTTP**（不要直连 YCloud）：

| 用途 | 方法 |
|------|------|
| 探活 | `GET /health` |
| 注册飞书应用（智能体初始化） | `POST /api/feishu/apps` |
| 发文本/模板 | `POST /api/whatsapp/messages`（body 带 `partnerCustomerId`，可选 `from`） |
| 列企业号 | `GET /api/whatsapp/phones?partnerCustomerId=`（可选 `&from=`） |
| 列已批准模板 | `GET /api/whatsapp/templates?partnerCustomerId=`（可选 `&from=` / `&name=`） |
| 查会话窗口 | `GET /api/whatsapp/conversations?partnerCustomerId=&phone=`（可选 `&from=`） |
| 嵌入式注册（创建 Onboarding Link） | `POST /api/whatsapp/onboarding-links` |
| 查询 WABA 绑定状态 | `GET /api/whatsapp/wabas?partnerCustomerId=` |
| 绑定已有 WABA（Skill 明确意图 + 管理员 token） | `POST /api/admin/whatsapp/import-existing-waba` |

现有 WABA 导入是独立的运维接口 `POST /api/admin/whatsapp/import-existing-waba`，不属于
智能体 API，也不得把管理员凭据或 WABA 标识交给租户智能体。它只接受服务端
`Authorization: Bearer …` 鉴权，body 仅含 `partnerCustomerId` 与 `wabaId`。服务先通过
YCloud 列号接口核实账户及号码，再在 SERIALIZABLE 事务中写入 `CONNECTED`
`WabaOnboarding` 和 `WabaPhone`。响应只返回 tenant、状态和号码，不返回 WABA 标识。

Skill 在明确“绑定已有 WABA”时读取统一管理的 `WHATSAPP_BRIDGE_ADMIN_TOKEN`，以 Bearer
认证调用 `POST /api/admin/whatsapp/import-existing-waba`。请求仅含当前租户的
`partnerCustomerId` 与本次 `wabaId`；token 不进入日志或响应。Provisioning 的 runtime-config
全局配置会热更新到租户 Skill 环境，确保所有租户使用同一个 Bridge 管理 token。

**归属不变量：一个手机号只能属于一个 tenant；一个 WABA 可以被多个 tenant 共享。**
归属落在 `WabaPhone`（`phoneNumber` 全局唯一），不在 WABA 上。导入必须显式指定
`phoneNumbers`：号被别家占用返回 409 `PHONE_OWNED_BY_OTHER_TENANT`、号不在该 WABA 上返回
404 `PHONE_NOT_ON_WABA`，两种情况都不写入。并发导入、解绑与 `PARTNER_ADDED` Webhook
共用同一组 advisory lock（顺序固定为 phone 升序 → waba 升序）。

嵌入式注册（`PARTNER_ADDED`）会自动认领该 WABA 上的**无主号**，因为它的 payload 里没有
任何号码字段（Partner Direct Link 指南 §6），无法定位「本次接入对应哪个号」。
但**该 WABA 上已有其他 tenant `CONNECTED` 时一个号都不认领** —— 那是运营手工拆分的共享
场景，需要按号 `import-existing-waba`，不能让自助注册抢走未分配的号。

`PARTNER_ADDED` 是唯一触发认领的事件且没有重试，所以入站反查 / 出站取号发现
「`CONNECTED` 但零归属」时会补认领一次（闸门是纯 DB 的，正常状态下不产生 YCloud 调用）。

YCloud Webhook 需订阅 `whatsapp.inbound_message.received`、`whatsapp.message.updated`，以及嵌入式注册用的 `whatsapp.business_account.updated`。绑定成功后桥接会落库，并可通知发起飞书群 / 客服群。

所有租户请求都必须显式携带 `partnerCustomerId`（也接受别名 `supplierId`）。列号、列模板、查会话和发消息不接受也不返回 WABA 路由信息：桥接按 supplier 动态查询 CONNECTED 绑定及 `WabaPhone`，再在内部解析目标 WABA。只有一个可用企业号时自动选择；多个企业号且未传 `from` 时返回 `409 WHATSAPP_FROM_SELECTION_REQUIRED` 和不含 WABA 标识的号码列表，绝不按顺序任取。传入 `from` 时桥接必须证明它属于当前 supplier，否则返回 `403 WHATSAPP_FROM_NOT_OWNED`。无绑定返回 `409 WHATSAPP_BINDING_REQUIRED`；窗外自由文本返回 `409 WHATSAPP_TEMPLATE_REQUIRED`。Onboarding/status 与 webhook 内部仍保留 WABA 数据。

上述显式绑定入口是唯一允许 Skill 输入 WABA ID 的业务路由；phones/templates/
conversations/messages 继续忽略 WABA 参数且不能据此选路。

## 环境变量

见 [`.env.example`](.env.example) 与 [部署文档](docs/部署.md)。本地无密钥时可设 `YCLOUD_SKIP_SIGNATURE=1` 与 `FEISHU_SKIP_SIGNATURE=1`，仅用于联调，生产必须关闭。

## 路由前缀

`ROUTE_PREFIX` 决定所有业务路由的前缀：本地默认为空，集群里是 `/whatsapp`
（与 email-webhook 共用一个 ALB host，按路径分流）。所以线上要填给外部平台的是：

```
https://dealclaw.datathink.com/whatsapp/webhooks/ycloud            ← YCloud
https://dealclaw.datathink.com/whatsapp/webhooks/feishu            ← 飞书（单应用）
https://dealclaw.datathink.com/whatsapp/webhooks/feishu/{appId}    ← 飞书（多应用，见 POST /api/feishu/apps 返回的 webhookUrl）
```

`/health` 是唯一例外，它**无论前缀怎么设都额外挂在根路径上** —— k8s 探针直连 Pod，
拿不到网关前缀。

`POST /api/feishu/apps` 返回的 `webhookUrl` 由 `WHATSAPP_BRIDGE_BASE_URL` 拼成，
**该配置必须自带前缀**（集群 ConfigMap 里是 `https://dealclaw.datathink.com/whatsapp`）；
没配时会从请求头推导并自动补上 `ROUTE_PREFIX`。

## 部署（k8s）

和 monorepo 其他服务一致：包根一个 `Dockerfile`，清单在根 `k8s/base/whatsapp-bridge/`。

```bash
docker build -t dealclaw-acr-registry.cn-hangzhou.aliyuncs.com/dealclaw-nexus/whatsapp-bridge:$(git rev-parse --short HEAD) .
```

```bash
kubectl apply -k k8s/base/whatsapp-bridge
```

几个和别的服务不同的点：

- **initContainer 跑 `node dist/scripts/dbSetup.js`**（建 schema + `prisma migrate deploy`）。
  不能直接在 initContainer 里调 prisma CLI —— 表要落进 `DATABASE_SCHEMA` 指定的
  schema，而这个路由靠 `DATABASE_URL` 上的 `?schema=` 参数，那是应用侧
  `loadEnvFiles()` 拼进去的，CLI 不走那段代码，结果会落进 `public`。
- **独立 schema `whatsapp_platform_bridge`**，与 email-webhook 的表同库不同 schema。
- **`APP_ENV=production` 必须显式给**。`loadEnv.ts` 靠 `npm_lifecycle_event` 推断环境，
  容器里跑的是 `node dist/index.js`，没有那个变量，不给就会当成 development。
- 容器里没有任何 `.env` 文件，配置全部来自 ConfigMap / Secret。

需要的凭据（`whatsapp-bridge-secret`）：

| 键 | 必需性 |
|---|---|
| `YCLOUD_API_KEY` | **必需**，所有出站 YCloud 调用都读它 |
| `YCLOUD_WEBHOOK_SECRET` | **必需**（生产），校验 YCloud 回调签名 |
| `WHATSAPP_BRIDGE_ADMIN_TOKEN` | **必需**，仅服务端运维持有；缺失时进程拒绝启动 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 可选，见下 |
| `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` | 可选，见下 |

**飞书那 4 个是「单应用模式」的兜底。** 现在的主路径是多应用：智能体调
`POST /api/feishu/apps` 把凭据注册进 `FeishuApp` 表，拿回一个专属的
`webhookUrl`（`/whatsapp/webhooks/feishu/{appId}`）配到飞书后台。
`resolveFeishuAppCreds()` 先查库，查不到才回落到这 4 个环境变量。
所以如果全部走 API 注册，这 4 个可以不配。

`DATABASE_URL` 复用集群里已有的 `dealclaw-db` Secret。
