# Nexus 阿里云国际站后端

## 状态（2026-09-14）

新增 Alibaba FC Agent Sandbox provider，与 Vercel 并存。代码已通过本地构建和 29 项测试，但阿里完整聊天与休眠恢复尚未验收，`alibaba.enabled` 保持关闭，现有 Vercel 服务未切换。

阿里云国际站新加坡 `ap-southeast-1` 已创建 `nexus-comparison` Team（Std）及专用、永不过期 API Key。凭据仅保存在 gitignored 的本地私有配置，不进入文档、镜像或前端。

真实基础设施验证：内置模板创建约 2.218 秒、1.866 秒，命令执行及文件写入通过。这是基础沙箱创建时间，不是 OpenClaw 首字时间。暂停请求返回 `pauseSession is not enabled for this function`；启用超时自动暂停创建返回 `enableAutoPause requires snapshot feature to be enabled for this function`。失败的测试实例已清理。原始测试报告在私有 dataDir 下 `alibaba-lifecycle.json`。

当前控制台已经填写新加坡暂停/恢复/自动暂停开通申请，因账号“联系方式未设置”无法提交，尚无工单号。需补充联系信息并确认实际提交结果。不能把公开产品文档的休眠能力视为此账号已开通。

本地 `linux/amd64` 镜像已构建：`nexus-dealclaw-alibaba:2026-09-14`。通过非 root 用户 `node` 的完整 boot 检查，OpenClaw 启动约 5.209 秒，再次 boot 成功复用进程；这是本地 Docker 验证，不是阿里启动性能，也未调用模型。执行 `pnpm exec tsx scripts/verify-alibaba-image.ts` 可复现，脚本使用占位凭据并在结束时清理测试容器。

## 隔离与运行合同

- `elastic_tenants.runtime_provider` 固定每个 Agent 的供应商，旧记录默认 `vercel`。路由覆盖 ensure、execute、stop，因此消息、Cron、heartbeat 使用同一条供应商路由。
- 同一 Agent 的 sandbox ID 存储在 `sandbox_name`，阿里记录物理实例 ID；不同 Agent 创建不同实例。未知供应商报错，不回退到 Vercel。
- 阿里通过 E2B 2.31.0，显式传入 API Key、地域 endpoint 和 domain，不修改全局 E2B 环境。
- 与 Vercel 复用 OpenClaw 2026.7.1、DealClaw payload、boot/invoke、逐帧事件消费、过程流式、nexus_schedule RPC 和每轮状态备份。
- 镜像内 `/vercel/sandbox` 是既有文件布局，阿里运行时使用此目录不代表运行在 Vercel。
- Std 使用 `pause({ keepMemory: false })` 保留文件系统，恢复后由 boot 启动 OpenClaw；自动超时也必须暂停而非销毁。此能力仍待账号开通后实测。
- 已有实例恢复失败时明确报错，绝不静默新建空实例。每轮状态备份在 Nexus 本地私有 dataDir，暂未接入 OSS/NAS；本地控制面磁盘丢失仍是风险。
- 保留当前配置权限边界：本次不声称解决 Agent 经 exec 修改自身配置的问题。

## 镜像与模板

FC 实测拒绝 E2B 内联 `.runCmd()` / `.copy()` 构建步骤。因此需要外部 Docker 构建，再由 FC 从完整 OCI 镜像创建模板。

在 `packages/runtime-manager` 执行：

```sh
pnpm exec tsx scripts/build-alibaba-template.ts
```

该命令通过 `git archive HEAD packages/dealclaw-agent/payload` 产生无客户数据的构建上下文，并复制 `runtime/Dockerfile.alibaba`。从仓库根目录构建：

```sh
docker build --platform linux/amd64 --provenance=false --sbom=false -t nexus-dealclaw-alibaba:2026-09-14 .elastic/alibaba-build
```

把镜像推到 FC 可访问的私有镜像仓库后，指定 `NEXUS_ALIBABA_IMAGE` 为其唯一版本地址，重新运行构建脚本。脚本成功后才写入 templateId。镜像转换可能需要同账号、同地域 ACR EE/VPC 或官方支持的其他私有仓库路径；当前尚未配置或购买 ACR EE，不把镜像公开发布作为绕过方式。

## 启用前验收

1. 开通新加坡模板的暂停、恢复和自动暂停功能。
2. 完成完整镜像的私有发布及 FC 模板构建。
3. `pnpm exec tsx scripts/verify-alibaba-lifecycle.ts`：创建、命令、写标记、暂停、恢复并验证标记、第二实例隔离、超时自动暂停，以及清理测试实例。
4. 使用 AlibabaProvider 完成真实 OpenClaw 聊天、过程流式、每轮备份、闲置后恢复记忆以及定时唤醒测试。
5. 验收通过后设 `alibaba.enabled=true`，在没有活动执行时滚动更新本地 manager。浏览器试用列表将新增 `DealClaw 阿里云试用`，现有租户仍为 Vercel。

创建新飞书租户的 `POST /v1/tenants` 增加可选 `runtimeProvider:"alibaba"`，未启用返回 503。原扫码不传该字段，继续默认 Vercel；本次尚未提供阿里专用二维码入口，不将其误称为已经完成飞书端试用。

## 官方参考

- [FC SDK 接入](https://www.alibabacloud.com/help/en/functioncompute/using-the-cloud-sandbox-via-the-sdk)
- [兼容性边界与暂停白名单](https://www.alibabacloud.com/help/en/functioncompute/e2b-sdk-compatible-api-list)
- [模板构建限制](https://www.alibabacloud.com/help/en/functioncompute/template-construction)
- [自定义镜像与仓库要求](https://www.alibabacloud.com/help/en/functioncompute/build-a-custom-image-template)
