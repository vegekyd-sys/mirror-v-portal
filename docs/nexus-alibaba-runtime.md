# Nexus 阿里云国际站后端

## 状态（2026-09-16）

阿里云账号的暂停/恢复权限已开通，完整生命周期验收通过。`alibaba.enabled` 仍保持关闭，现有 Vercel 服务未切换；尚未完成真实 OpenClaw 聊天与飞书端试用。

新加坡 `ap-southeast-1` 实测（`pnpm exec tsx scripts/verify-alibaba-lifecycle.ts`，报告在私有 dataDir `alibaba-lifecycle.json`）：

| 步骤 | 实测 |
|---|---|
| 创建沙箱 | 1.621 s |
| 命令执行 | 通过 |
| `pause({keepMemory:false})` | 2.544 s |
| `Sandbox.connect` 恢复 | 1.349 s |
| 恢复后文件标记 | 与暂停前一致 |
| 第二实例隔离 | 通过，看不到对方标记 |
| 超时自动暂停 | 通过（真实等待后轮询确认 `paused`，非依赖接口返回值） |
| 测试实例清理 | 通过 |

这取代 2026-09-14 记录的 `pauseSession is not enabled for this function`。工单 `006547184EN` 涉及的暂停/恢复白名单已生效。

### 自动暂停有 600 秒下限，主动暂停没有

`enableAutoPause` 要求 `sessionIdleTimeoutInSeconds >= 600`，传 60 会被拒。这不影响计费模型：Nexus 的空闲释放主线是自己的 collector 主动调用 `provider.stop()`（`src/manager.ts` 的 `collect`，按每租户 `idle_seconds` 判定，取值域 15–1800 秒，默认 60 秒），主动 `pause` 不受 600 秒限制。平台 autoPause 只作为 manager 失联时的兜底网，验收脚本据此把兜底超时设为 600 秒。

### 自定义镜像不在关键路径上

FC 自定义镜像模板要求同账号、同地域并绑定 VPC 的 ACR **企业版**（经济版不支持），是订阅制固定月费。实测表明内置 `base` 模板可以在唤醒时引导出可用运行时，因此 ACR EE 不是跑通的前置条件。

`pnpm exec tsx scripts/probe-alibaba-base-bootstrap.ts` 在新加坡实测（报告在私有 dataDir `alibaba-base-bootstrap.json`）：

| 步骤 | 实测 | 说明 |
|---|---|---|
| 创建 base 沙箱 | 2.548 s | |
| 重建 `/vercel` 布局 | 1.007 s | base 以 uid 1000 `user` 运行且无 `/vercel`，`sudo -n` 可用 |
| 安装 node v24.21.0 | 2.273 s | base 自带 v20.20.2，不满足 openclaw engines |
| 安装 openclaw@2026.7.1 | 17.760 s | |
| **首次引导合计** | **21.040 s** | 仅每个 Agent 首次创建时发生 |
| `--version` 验证 | `OpenClaw 2026.7.1 (2d2ddc4)` | |
| 引导后体积 | 602 M | |
| pause / resume | 11.485 s / 1.147 s | |
| 恢复后 `--version` | 与引导时一致 | 引导结果随文件系统完整保留 |

两处约束是实测得到、必须保留在实现里的：`openclaw@2026.7.1` 的 engines 是 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`，base 的 v20 不满足；`/vercel` 需要 `sudo` 创建后 `chown` 给 `user`，否则 `mkdir` 被拒。e2b 在非零退出时抛出 message 为空的 `CommandExitError`，脚本必须读 `exitCode`/`stderr`，否则失败原因会被吞掉。

### 引导已接入 AlibabaProvider

`AlibabaProvider.create` 在未配置 `templateId` 时用 `base` 创建并调用 `bootstrap`，`checkConfiguration` 改为要求本地存在 payload 归档（由 `scripts/build-alibaba-template.ts` 用 `git archive` 产出，不含客户数据）。引导以 revision 标记幂等，标记覆盖 node 版本、openclaw 版本和 payload 字节，最后写入——半成品引导不会在下次唤醒时被当作完成。

`pnpm exec tsx scripts/verify-alibaba-bootstrap.ts` 实测（报告在私有 dataDir `alibaba-bootstrap.json`）：

| 项 | 实测 |
|---|---|
| 首次创建（含引导） | 87.044 s |
| 默认 `node` | v24.21.0 |
| OpenClaw | `OpenClaw 2026.7.1 (2d2ddc4)` |
| payload | 663 个文件 |
| 同实例二次引导 | 0.249 s，`bootstrapped:false` |
| pause / resume | 12.044 s / 1.359 s |
| 休眠恢复后再引导 | 1.101 s，仍为 no-op，运行时完好 |

两点必须记住：`ensure()` 用无路径的 `node` 运行 `boot.mjs`，因此引导用 `sudo ln -sf` 让 `/usr/local/bin/node` 指向新装的 v24，实测非登录 shell 同样生效；单次文件写入 32 MiB 会被拒（`InvalidArgumentError`），16 MiB 可用，payload 因此分块上传后在沙箱内合并。

87 秒明显高于分步测量之和（约 44 秒），差值来自 `AlibabaSandbox.runCommand` 的后台执行加轮询开销，不是阿里侧耗时。首次创建仍在可接受范围，如需压缩可优先优化这里，其次才是回到自定义镜像。

镜像路线未被否定，仅从关键路径移出：若之后要削掉这 21 秒首次成本或固定依赖版本，仍可购买 ACR EE 走 `scripts/build-alibaba-template.ts`。本地 `linux/amd64` 镜像 `nexus-dealclaw-alibaba:2026-09-14` 仍在，OpenClaw 本地启动约 5.209 秒。

凭据仅保存在 gitignored 的本地私有配置，不进入文档、镜像或前端。

### 端到端真实对话已通过（2026-09-16）

本地 manager 接 `ap-southeast-1`，`alibaba.enabled=true` 且 `templateId` 为空（base 引导模式），用 `alibaba-trial` 租户走完整链路：

| 阶段 | 实测 | 说明 |
|---|---|---|
| 首次唤醒 | 96.453 s | 含完整引导（procps、node、openclaw、payload） |
| 模型响应 | 971 ms | deepseek-flash，HTTP 200 |
| 生成完成 | 3.837 s | |
| 每轮状态备份 | 12.768 s | 明显偏慢，是后续优化的首要目标 |
| 空闲释放 | 约 60 s 后进入 `sleeping` | 由 Nexus collector 主动 `pause`，计算资源释放 |
| 二次唤醒 | 16.872 s | 跳过引导；其中 resume 约 1.3 s，其余是 OpenClaw 进程重启 |
| 跨休眠记忆 | 通过 | 实例彻底休眠后重新唤醒，准确复述休眠前的回答 |

第一轮回复为 payload 中的 DealClaw 人格（“出海精灵小元”），说明 payload 正确播种、OpenClaw 正常运行、模型链路通畅。第二轮复述验证了会话状态经备份/恢复后保持连续。

`keepMemory:false` 决定了休眠保留文件系统而不保留进程，因此二次唤醒必然包含一次 OpenClaw 冷启。16.9 s 中真正的 resume 只占 1.3 s，其余是进程启动，这是压缩唤醒延迟的着力点。

### 尚未验证

过程流式与首字延迟、定时唤醒（cron/heartbeat）、飞书端真实试用、多 Agent 并发下的配额表现，以及连续多轮休眠后的稳定性，均未在阿里侧测过。OpenClaw 已发布 v2026.9.4，本文所有数据基于钉住的 v2026.7.1。

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

1. ~~开通新加坡模板的暂停、恢复和自动暂停功能~~ — 2026-09-16 实测通过。
2. ~~完成完整镜像的私有发布及 FC 模板构建~~ — 改为 base 模板唤醒时引导，已实测通过；ACR EE 路线保留为可选优化。
3. ~~`scripts/verify-alibaba-lifecycle.ts`~~ — 2026-09-16 全项通过。
4. ~~把 base 引导流程接入 `AlibabaProvider`，并使引导具备幂等性~~ — 2026-09-16 实测通过，含休眠恢复后的幂等验证。
5. 真实 OpenClaw 聊天、每轮备份、闲置后恢复记忆 — 2026-09-16 通过（见上）。过程流式与定时唤醒仍待测。
6. 验收通过后设 `alibaba.enabled=true`，在没有活动执行时滚动更新本地 manager。浏览器试用列表将新增 `DealClaw 阿里云试用`，现有租户仍为 Vercel。

创建新飞书租户的 `POST /v1/tenants` 增加可选 `runtimeProvider:"alibaba"`，未启用返回 503。原扫码不传该字段，继续默认 Vercel；本次尚未提供阿里专用二维码入口，不将其误称为已经完成飞书端试用。

## 官方参考

- [FC SDK 接入](https://www.alibabacloud.com/help/en/functioncompute/using-the-cloud-sandbox-via-the-sdk)
- [兼容性边界与暂停白名单](https://www.alibabacloud.com/help/en/functioncompute/e2b-sdk-compatible-api-list)
- [模板构建限制](https://www.alibabacloud.com/help/en/functioncompute/template-construction)
- [自定义镜像与仓库要求](https://www.alibabacloud.com/help/en/functioncompute/build-a-custom-image-template)
