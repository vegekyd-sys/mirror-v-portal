# whatsapp-bridge — K8s 部署说明

本目录是 `whatsapp-bridge` 的 K8s base 清单，由 `k8s/overlays/production` 通过 kustomize 引用。

## 资源

| 文件 | 作用 |
|---|---|
| `configmap.yaml` | 非敏感配置（端口、路由前缀、DB schema、桥接基址等） |
| `deployment.yaml` | Deployment + Service；引用 `whatsapp-bridge-secret`、`dealclaw-db` 和 `dealclaw-auth` |
| `ingress.yaml` | ALB 入口，与 email-webhook 共用一个 host |
| `kustomization.yaml` | base 资源聚合 |

## Secret 占位（王建手动配置）

`whatsapp-bridge-secret` 里需要配置以下 key。**值不要提交进 git，由王建在集群里手动 `kubectl create secret` 填真实值。**

通过批准的 Secret 管理流程或主机侧遮罩输入创建 `whatsapp-bridge-secret`；不要把值放进
命令参数、shell 历史或聊天记录。该 Secret 必须包含下表的必填键，可选键按部署模式提供。

| Key | 必填 | 提供方 | 说明 |
|---|---|---|---|
| `YCLOUD_API_KEY` | 是 | 业务（YCloud 控制台） | 调 YCloud 发消息 / 列号 / 列模板 / 建 onboarding link |
| `YCLOUD_WEBHOOK_SECRET` | 生产必填 | 业务（与 YCloud Webhook Secret 同一份） | 校验 `ycloud-signature` 请求头 |
| `WHATSAPP_BRIDGE_ADMIN_TOKEN` | 是 | 运维安全生成 | 管理员现有 WABA 导入接口；仅放服务端 Secret，不分发给租户智能体 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY` | 可空 | 业务 | 「单应用模式」兜底；多应用走 `POST /api/feishu/apps` 登记进 `FeishuApp` 表，这 4 个可不填 |

**数据库连接**不走 `whatsapp-bridge-secret`，而是和 `credits-ledger` / `email-webhook` 共用 `dealclaw-db` Secret 的 `DATABASE_URL` key（见 `deployment.yaml` 里的 `secretKeyRef`）。

## 租户上下文

桥接进程不配置默认租户或全局当前 WABA。调用方显式传 `partnerCustomerId`（或 `supplierId`）；日常号码、模板、会话和消息接口只额外接受可选业务号 `from`，WABA 由服务按租户绑定和 `WabaPhone` 动态解析。多业务号未指定 `from` 时服务拒绝任意选择；onboarding/status 与 webhook 内部才保留 WABA 数据。

`POST /api/admin/whatsapp/import-existing-waba` 仅供授权运维恢复 YCloud 已有 WABA。共享 WABA
模式下，一个 WABA 可被多个 tenant 共享，但手机号只能归一家；号码归属冲突时事务整体拒绝。
该接口及凭据不得进入日常 agent skill，响应也不返回 WABA 标识。

### 测试期一键清库（临时接口）

`POST /api/admin/whatsapp/cleanup` 是**测试阶段的临时接口**，按测试期口径**不做请求侧校验**：
直接 POST 即执行，空 body 也能清全量运行数据。测完请连同代码一起删除。

默认清 `Message` / `PlatformThread` / `Conversation` / `Customer` / `WebhookEvent` /
`WabaPhone` / `WabaOnboarding`（按 FK 顺序：消息/话题映射 → 会话 → 买家）；
**默认保留** `FeishuApp` 与 `AppSetting`（凭据与全局配置）。

可选参数：

| 参数 | 作用 |
|---|---|
| `dryRun: true` | 只返回各表预览数量，不删 |
| `supplierId` | 只清一个测试租户，避免误清其他人的测试 |
| `includeConfig: true` | 连 `FeishuApp`/`AppSetting` 一起清；只允许全局范围 |

应急关闭：ConfigMap 设 `WHATSAPP_DISABLE_DB_CLEANUP: "true"` 再 `rollout restart`，
接口立即返回 403（不需要重新构建镜像）。

⚠️ 该 host 对外可达（YCloud/飞书 webhook 必须能进来），而这个接口**无鉴权且会删数据**——
只应作为测试期短时存在，验完立即删除。

Skill 绑定已有 WABA 使用 provisioning 已为每个租户随机生成、注入
`dealclaw-agent-config-<tenant>` 的 `OPENCLAW_GATEWAY_TOKEN` 签发短时用途隔离 HMAC。
Bridge 通过内部 `PROVISIONING_SERVICE_URL` 和服务端 `PROVISIONING_API_TOKEN` 请求验证；
provisioning 以 supplier 精确解析唯一 live tenant，并直接读取其 K8s Secret 验签，只返回
`valid` 布尔值。Bridge 再用 PostgreSQL nonce 唯一约束防重放。两个服务端 token 都不进入
Skill 请求；`WHATSAPP_BRIDGE_ADMIN_TOKEN` 仍只用于管理员 importer。routine API 不接受 WABA ID。

## 部署

```bash
kubectl apply -k k8s/overlays/production
```

改 ConfigMap / Secret 后需 `kubectl -n dealclaw-prod rollout restart deployment/whatsapp-bridge`（`envFrom` 不会自动触发滚动）。
