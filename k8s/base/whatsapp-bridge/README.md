# whatsapp-bridge — K8s 部署说明

本目录是 `whatsapp-bridge` 的 K8s base 清单，由 `k8s/overlays/production` 通过 kustomize 引用。

## 资源

| 文件 | 作用 |
|---|---|
| `configmap.yaml` | 非敏感配置（端口、路由前缀、DB schema、桥接基址等） |
| `deployment.yaml` | Deployment + Service；引用了 `whatsapp-bridge-secret` 和 `dealclaw-db` 两个 Secret |
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

`POST /api/admin/whatsapp/import-existing-waba` 仅供授权运维恢复 YCloud 已有 WABA，必须
使用 `WHATSAPP_BRIDGE_ADMIN_TOKEN` 的 Bearer 鉴权。一个 WABA 只能属于一个 tenant；
已有其他 `CONNECTED` owner 或号码映射冲突时事务整体拒绝。该接口及凭据不得进入日常
agent skill，响应也不返回 WABA 标识。

## 部署

```bash
kubectl apply -k k8s/overlays/production
```

改 ConfigMap / Secret 后需 `kubectl -n dealclaw-prod rollout restart deployment/whatsapp-bridge`（`envFrom` 不会自动触发滚动）。
