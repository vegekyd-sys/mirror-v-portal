# Mirror V Portal 开发入口

用中文协作。本仓库是 `vegekyd-sys/mirror-v-portal`，部署分支为 GitHub `dev`。
本文件约束仓库开发；`packages/agent-templates/*/payload/AGENTS.md` 是租户 Agent 的运行内容，二者不可混用。

## 范围与入口

| 工作 | 真相源 |
| --- | --- |
| 首页 HTML/CSS、模板选择、H5 弹层、视频 | `packages/central-gateway/src/services/onboard-page.ts` |
| 公开模板、扫码、账号与渠道入口、头像资源合同 | `packages/central-gateway/src/app.ts` |
| 首页静态资源 | `packages/central-gateway/public/onboard/` |
| 实例生命周期、渠道媒体、快照与运行时 | `packages/runtime-manager/` |
| 管理后台 / Credits | `packages/admin-web/` / `packages/credits-ledger/` |
| 可分发的 Agent 工作区 | `packages/agent-templates/` |
| 部署和兼容路由 | `deploy/mirror-v/README.md`、该目录的 Nginx 配置 |

`public/onboard/index.html` 是 Gateway build 生成的文件，不直接维护；不要只改生成物而漏掉源码。
Makaron 的项目 facade、模型、渲染、计费、Agent Kit 源码属于 `ai-image-editor`，Portal 负责模板部署、独立实例、账号绑定与渠道交付。边界和历史工作树见 [两库交接](docs/makaron-portal-handoff-20261015.md)。

## 开发与验证

- 先检查当前分支、工作树、GitHub `dev` 和现场版本，复用适合的隔离 worktree；保留其他任务的修改。
- 网页视觉与交互优先在 Codex 内置浏览器展示并验证；检查普通 MacBook 的实际可用高度和手机宽度，不能只看大屏截图。
- 首页验证要等真实内容加载：头像、完整二维码、选中项、H5 弹层、账号表单、渠道切换；视频检查低清首播、高清替换与失败后继续播放。
- 新 UI 文案覆盖 `zh`、`zh-Hant`、`ja`、`en`；二维码保留不透明白底与原始对比度，不用玻璃滤镜处理二维码。
- 按改动运行构建与检查。Gateway：`pnpm --filter @dealclaw/central-gateway build`、`pnpm --filter @dealclaw/central-gateway test`。其他包按涉及范围验证，完整 CI 见 `.github/workflows/dev-ci.yml`；纯文档修改检查链接、事实与 diff，不新增镜像实现的测试。

## 发布边界

- 区分源码提交、CI、控制面 release、payload version、snapshot 和实际用户验收。发布记录写明日期、版本、验证与回滚依据；当前版本须读现场，不以历史文档代替。
- GitHub `github` remote 是本产品源；旧 GitLab `origin` 是历史来源，不因名字相似推送到错误仓库。
- 纯首页发布按部署文档的 Homepage-only updates：确认运行代码、私有配置和模板 pin 不变后，原子切换 release 并平滑 reload Nginx。不要为了静态 UI 重启保存 pending 扫码会话的 Gateway/Manager；默认 `activate` 属于完整控制面发布，不是静态发布快捷命令。
- `media-src` 必须支持本地高清视频使用的 `blob:`；保留 Feishu 原生 JSON、Makaron 账号页例外及既有渠道路由。修改静态 Nginx 时核对 Gateway 的对应安全头。
- 默认显示名、`listed` 与内部 id、payload、snapshot 是不同合同。隐藏旧入口或改显示名不自动迁移既有租户。账号 Key、私有配置、租户数据、备份和模型凭据不得入 Git、URL、日志或共享文档。
- Makaron 图像、视频、音乐与设计的最终验收看真实可查看/播放的原生交付。健康、二维码 pending、下载回执和自动检查不能代替真人扫码授权或手机播放。
- 新 Agent 上架先保持 `listed:false`：头像按 `agent-<id>-portrait-<sha256前12位>.png` 放入公开静态目录，读取 `--catalog https://mirror-v-portal.vercel.app/onboard/templates?template=<id>` 执行 `packages/central-gateway/dist/check-template-avatars.js`，并在飞书原生创建页验证头像 Canvas 转换及截图，再开放 listed。正常 activate 已强制对所有公开模板执行同一门禁，失败回滚。跨域规则和缓存版本统一由 `services/avatar-policy.ts` 管理，不为每个机器人增加名字白名单，也不手动散落缓存参数。

## 本轮交接

- [UI 更新与发布记录](docs/portal-ui-release-20261015.md)：用户已认可的外观、MacBook/H5 规则、PR 与上线版本。
- [Makaron / Portal 交接](docs/makaron-portal-handoff-20261015.md)：代码归属、保留的分支/worktree、后续接手位置及未完成范围。
- [沙盒运行环境](docs/portal-sandbox-execution.md)：当前能力与持久化事实，运行时工作先读此文和当前代码，不照搬历史 7.1 starter 的假设。
