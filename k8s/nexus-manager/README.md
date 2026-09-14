# Nexus Manager 部署

此目录是待参数化的部署模板，**不要直接 apply resources.yaml**。不加入客户 production overlay，避免 namespace 被改写。

## 前置条件

1. 确认实际集群、NAS CSI、Ingress 实现及 provisioning-service 的 namespace / ServiceAccount。
2. 确认 ACK CNFS 控制器可创建独立 NAS 通用型性能型文件系统；模板使用 NFS v3，与集群现有高性能 NAS 配置一致。
3. NAS 首发仅用于配置、JSON 会话和工作文件。内存索引默认禁用；在实际版本验证 SQLite/文件锁后再启用依赖本地数据库的功能。
4. 准备独立 UI 域名与通配 TLS 证书；Ingress 已按 ACK ALB 的数字 Service 端口约束配置。

## 构建

```sh
docker build --platform linux/amd64 -t <registry>/nexus-manager:<固定版本> packages/nexus-manager
```

首次发布用构建后 digest 填入 NEXUS_MANAGER_IMAGE。基础镜像与插件兼容性需通过实际镜像启动测试；不会升级其他客户镜像。

当前基础镜像为 OpenClaw 2026.9.4 amd64；目标 ACK 集群节点均为 amd64。kubectl 默认 v1.36.2，与当前 ACK v1.36.2 对齐；集群升级后可通过 `--build-arg KUBECTL_VERSION=<版本>` 调整。Git、Python、pnpm 和同版本飞书插件已包含在镜像中。

## 参数与凭据

设置 render.py 要求的七个非敏感环境变量，然后：

```sh
python3 k8s/nexus-manager/render.py > /tmp/nexus-manager.yaml
kubectl apply --dry-run=server -f /tmp/nexus-manager.yaml
```

在 `dealclaw-system` namespace 通过现有密钥发布流程创建：

- `nexus-manager-gateway`：`OPENCLAW_GATEWAY_TOKEN`，至少 32 字符随机值。
- `registry-secret-vpc`：复用现有 ACR 拉取凭据，并复制到独立 namespace。
- `datathink-tls`：复用现有 `*.datathink.com` TLS Secret，并复制到独立 namespace。

密钥禁止填入 Git 模板。NAS 100Gi 是 PVC 声明，不是实际用量强制上限。

Provisioning Service 新版本需要三个环境变量：

```text
NEXUS_MANAGER_ENABLED=true
NEXUS_MANAGER_NAMESPACE=dealclaw-system
NEXUS_MANAGER_UI_URL=https://<UI 域名>
```

确认 admin 域名上的 `/v1/admin/system-agent` 及子路径路由到 Provisioning Service；现有 ingress 若已将 `/v1/admin/*` 路由给其他服务，需增加更具体的前缀规则。路由仍使用现有 Bearer/JWT 认证。

## 运行与恢复

- 控制台入口 `/nexus-manager`。外层管理栏不依赖 Gateway 启动成功；iframe 使用独立域名和原生认证。
- Gateway 监听容器 loopback:18790；同进程管理的轻量代理在 18789 提供 HTTP/WS，保留原生认证，只对 UI HTML 的 CSP framing 指令进行定向适配。
- 原生 UI 首次输入 Gateway 凭据，通过运维人员执行 `openclaw devices list` / `openclaw devices approve <requestId>` 完成配对。不要把 Gateway token 放入 URL。
- 主供应商初始化为 `nexus`，API Key 引用 `${NEXUS_MODEL_API_KEY}`。首启可不提供该变量，随后由管理控制台创建版本化 Secret 并重启 Pod；其他模型、通道、定时任务在原生 UI 配置。原生插件是否随镜像提供须在部署验证时确认，缺少时固定版本加入镜像。
- 凭据更换保存新版 immutable Secret，乐观锁更新 Deployment 引用，Recreate 重建 Pod；停止状态只保存，下一次启动生效。
- 页面明确显示 Pod 状态；模型 Key 认证与余额必须通过实际对话确认，不声称自动做了模型验证。
- “恢复上一版凭据”切换到保留 Secret，触发重新加载。不自动删除历史 Secret；后续人工清理须排除当前和回退引用。
- 配置与工作区只在首次初始化，原生 UI 的修改跨重启保留。错误配置时通过可信运维入口恢复 NAS 上的备份并重启。
- 当前日志提供限量快照和 previous 容器日志，非长期存档；已知注入凭据做服务端遮盖，仍须避免应用输出其他密钥。
- 默认不挂载项目 K8s 操作令牌；待明确项目操作范围再添加业务 namespace RoleBinding 和短期令牌。控制台管理实例的权限已经在模板中单独配置。
- Pod 中断不保证正在运行的 shell 任务自动恢复；依靠持久化任务记录接续。

生产放行前验证：原生 UI/WS/设备配对、模型对话、实际需要的消息插件、重启持久化、凭据切换/回退、NAS 文件语义与独立 OSS 备份恢复。保持一个写入者，节点失联时不得强制双开。

首次实施状态：代码、镜像入口和 ACK ALB/CNFS 模板已提供；真实 NAS 创建、证书复制、备份任务和项目工具权限需要在上线阶段验证。
