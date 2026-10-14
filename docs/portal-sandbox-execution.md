# Portal Agent 的沙盒执行能力

Portal 的隔离边界是每个租户自己的云端 VM。Agent 在这个 VM 内可以联网、执行命令、写文件、安装 npm 包和使用免密码 sudo。OpenClaw 的 `host: gateway` 在这里指 VM 内的 Gateway 进程，不指 Portal 控制面服务器。

## 修复原因

旧的每轮附件说明禁止尝试 `lark-cli`。Agent 把“当前聊天由外部网关投递”和“没有预装 CLI”误判为不能安装，还错误声称安装会在休眠后丢失。`turn-instructions.mjs` 现在分别说明沙盒执行能力、CLI 安装、外部账号授权和当前聊天的 `MEDIA:` 投递方式，并纠正旧笔记或历史回复中的限制。

npm 12 还会默认跳过未获允许的安装脚本，可能出现安装成功但 CLI 缺少二进制的情况。专属 VM 的启动环境明确允许生命周期脚本，不需要逐包批准。[npm 配置文档](https://docs.npmjs.com/cli/using-npm/config/)

## 运行合同

- 所有 Portal 模板的 exec 使用 `host: gateway`、`security: full`、`ask: off`，并在登录 Shell 初始化之后把全局 npm 的 bin 加入 PATH。
- 宿主审批策略也设为 `full/off`，包括已有的每个 Agent 覆盖项。通过 OpenClaw 自己的 `approvals get/set` 更新：2026.7 使用 JSON，完整 V 的 patched 2026.9 使用 SQLite，不直接写旧 JSON 文件。
- `NPM_CONFIG_PREFIX=/vercel/sandbox/agent-data/npm`，因此 `npm install -g` 可写且不需要 sudo。`NPM_CONFIG_DANGEROUSLY_ALLOW_ALL_SCRIPTS=true`、`NPM_CONFIG_IGNORE_SCRIPTS=false` 只作用于租户 VM 内的进程。
- 包需要 curl 等系统依赖时，Agent 可以自行安装。缺少 apt 索引时先 `sudo -n apt-get update`，再安装所需系统包。
- 休眠快照保留 VM 文件系统。工作区、本地 node_modules、全局 npm 的包与 bin 符号链接也纳入 agent-data 备份。后台进程需在唤醒后重启。
- Gateway 和 Worker 在轮次边界检测配置及执行环境 hash；发生变化时重启对应 VM 内的进程，避免继续沿用旧 npm prefix 或权限环境。

当前聊天仍由 Nexus 网关负责投递，定时任务仍用 `nexus_schedule`。安装 CLI 不会自动获得用户的外部账号授权。

## 验证

本地测试覆盖实际 invoke HTTP 请求中的环境说明、可写 npm prefix、审批迁移与已有 allowlist/socket 数据保留，以及普通和完整 V 模板的执行配置。

真实验收使用独立的 Makaron 和完整 V Sandbox，通过实际模型与 Agent 原生 exec 工具安装 `is-number`、`@larksuite/cli`，验证 CLI、管道/重定向和 `sudo -n true`；同时独立读文件和执行程序核对结果。随后实际 stop/resume，再验证包与文件保留，并核对备份包含全局 CLI 符号链接和本地包。

安装脚本的额外验收使用带 postinstall 的本地 npm tarball：不增加逐包 `--allow-scripts` 参数，安装后执行 CLI 必须输出安装脚本生成的值。另验证健康进程复用与配置变更时的 VM 内重启。
