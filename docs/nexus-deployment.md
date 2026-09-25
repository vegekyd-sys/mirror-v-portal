# Nexus 线上部署

## 拓扑（2026-09-17）

```
飞书 / 浏览器
      │  HTTPS
      ▼
Vercel (nexus 项目, 仅反向代理)
      │  HTTP
      ▼
vlab 129.226.223.132:8098   central-gateway   扫码入驻，公网可达
      │  127.0.0.1:8097
      ▼
              runtime-manager   控制面，仅监听回环
      │
      ├─ PostgreSQL 16 (本机 nexus_elastic)
      └─ Vercel Sandbox (nexus 项目, 按消息热启动)
```

控制面不能放在 Vercel：runtime-manager 持有飞书长连接和空闲回收定时器，两者都活不过一次 serverless 调用。它以 systemd 常驻在 vlab 上，且只绑 `127.0.0.1`，公网只经由 central-gateway 进入。

Vercel 这一层只做 HTTPS 边缘和一个可用域名，自身不提供任何内容；等域名备案完成、由服务器直接终止 TLS 后，这一层可以整个删掉。

## 主机

`vlab`（`VM-0-4-ubuntu`，腾讯云，公网 129.226.223.132，4 核 / 15 GiB）。选它而非 `v` 是用户的决定；`v` 上跑着旧版 DealClaw 全套服务，不混部更安全。

系统自带 node 是 v18，低于 openclaw 要求，因此在 `/opt/nexus/node` 单独装了 node v24.21.0，不动系统 node，以免影响该机上正在运行的 OpenClaw lab 服务。

## 目录与凭据

| 路径 | 内容 |
|---|---|
| `/opt/nexus/app` | 代码（`git archive` 产出，不含 `.elastic`） |
| `/opt/nexus/node` | 专用 node + pnpm |
| `/opt/nexus/data/config.json` | 运行配置，0600 |
| `/var/log/nexus-*.log` | 两个服务的日志 |

`config.json` 的 `adminToken` 与 `encryptionKey` 是这台机器独立生成的，与本机开发环境不同；模型 key、Vercel token 与 snapshotId 复用同一套。凭据只存在于这个 0600 文件里，不进仓库、不进 systemd 单元（`PROVISIONING_API_TOKEN` 例外，写在 0600 的单元文件中）。

## 服务

```sh
systemctl status nexus-runtime-manager nexus-central-gateway
journalctl -u nexus-runtime-manager -f      # 或 tail -f /var/log/nexus-runtime-manager.log
```

`central-gateway` 通过 `PROVISIONING_SERVICE_URL=http://127.0.0.1:8097` 加 `PROVISIONING_API_TOKEN` 调用 runtime-manager 的 `/v1/tenants`，即入驻完成后由控制面建租户。

## 公网暴露

8098 需要在腾讯云安全组放行；该机防火墙本身是全通的（ufw inactive、iptables ACCEPT），不通只会是安全组。另一条备选是 Tailscale Funnel，需先在 tailnet 启用。

## 尚未完成

- 域名与备案：没有备案域名，微信渠道无法打开外链，飞书正式回调也应换成自有域名。
- `snapshotId` 有 30 天有效期，过期前需重跑 `pnpm snapshot` 并更新 `config.json`。
- 数据库是本机 PostgreSQL，无备份、无高可用；控制面磁盘丢失即丢租户状态。
- 代码用 `git archive` 推送，没有 CI/CD；更新需重跑同样的推送与 `pnpm build`。

## 多 Agent 模板

入驻页从控制面 `/v1/templates` 获取已配置的模板目录。扫码会话固定模板 ID 和版本；创建租户时持久化模板 ID、版本与快照 ID。已有租户默认保留 DealClaw，后续更新模板快照不会改变已创建实例的起始快照。

`dealclaw` 使用 `config.json` 的 `snapshotId`。`mirror-v` 使用 `templates.mirror-v = { "version": "mirror-v.v1", "snapshotId": "..." }`。只有快照配置完成，模板才会出现在入驻页。Mirror V 源码位于 `packages/agent-templates/mirror-v/payload`，只包含公开通用的启动文件，不使用私人 V 的记忆归档。

构建 Mirror V 快照：在 VLab 的 `/opt/nexus/app/packages/runtime-manager` 执行 `pnpm snapshot --template mirror-v`，然后重启 `nexus-runtime-manager` 以加载更新后的配置。快照脚本只更新 `templates.mirror-v`，不会覆盖 DealClaw 的 `snapshotId`。扫码后每个飞书应用对应一个独立租户和沙箱；首次发消息时启动 OpenClaw 并使用该模板工作区。
