# Portal UI 更新与发布记录

本记录整理 2026-10-14 至 2026-10-15 的 Portal 外观、入口与响应式更新。用户在最后一轮反馈“挺好的，先这样”，当前外观可作为下一次修改的对比基线。

## 版本边界

- 产品仓库：[vegekyd-sys/mirror-v-portal](https://github.com/vegekyd-sys/mirror-v-portal)，正式分支 `dev`。
- 正式页面：[Mirror V Portal](https://mirror-v-portal.vercel.app/onboard?lang=zh)。
- 本轮 UI 最后上线版本：`322f3ed1a68f5eea8dd37c8083113816a2674235`，当时 release 为 `/opt/nexus/releases/322f3ed1a68f`。
- 2026-10-15 收尾现场复核：GitHub `dev` 和 `/opt/nexus/current` 已是其他任务的 `88cc038a66100caf4cd1e7b09193f1844f8ea69f`（运行时环境上下文调整，PR #15）。该版本包含上述 UI 基线；不要为了恢复 UI 把整个控制面回退到 `322f3ed1`。
- 本次文档整理不改变生产 release、payload 或 snapshot。文档之后的 `dev` 提交也不自动代表已上线。

## 一系列变更

| 阶段 | 内容 | 合并与上线基线 |
| --- | --- | --- |
| 首次首页整理 | 品牌、标题、桌面 Agent 选择与扫码区、手机布局；构建静态首页，兼容原渠道 API | [PR #9](https://github.com/vegekyd-sys/mirror-v-portal/pull/9)、[PR #10](https://github.com/vegekyd-sys/mirror-v-portal/pull/10)，`6fd735b771e5` |
| 全屏视频与玻璃 | 使用原循环视频作为全屏背景；透明玻璃、四类角色头像、favicon、高清视频渐进加载、H5 弹层；默认新版 Mirror V | [PR #11](https://github.com/vegekyd-sys/mirror-v-portal/pull/11)，`4dc15d8955e0` |
| MacBook 自适应 | 按浏览器可用高度调整布局，右侧二维码跨两行，左侧标题与 Agent 列表；较矮窗口压缩留白 | [PR #12](https://github.com/vegekyd-sys/mirror-v-portal/pull/12)，`e8219df6a721` |
| 最后位置微调 | 两个玻璃面板同步略微下移，减少底部空白，保留矮窗口保护 | [PR #13](https://github.com/vegekyd-sys/mirror-v-portal/pull/13)，`322f3ed1a68f` |

### 视觉与角色

- 左上角只显示统一字号的 `Mirror V Portal`，不再加独立 V 标志。
- 原液态金属环视频铺满背景，文字保留阴影与对比度；两个深色玻璃面板以低透明度填充、轻度模糊、细反光边框呈现，避免再次变成不透明白卡。
- DealClaw 使用用户指定的戴眼镜男生近景；星擎使用已认可的机器人形象；Makaron 使用灵动的 Pixel Wizard 近景；Mirror V 使用 V 的近景形象。
- favicon 为银紫色圆环与深色背景的 SVG：`mirror-aperture-v3.svg`。
- 公开头像元数据用于新用户注册；更新 Portal 展示头像不会自动修改已存在飞书账号的头像。

### 默认入口和版本

收尾复核的公开目录有四项。桌面顺序为 DealClaw、Mirror V、星擎 Agent、Makaron。

| 显示名 | 内部模板 id | 复核的 payload version |
| --- | --- | --- |
| DealClaw | `dealclaw` | `dealclaw-starter.v1` |
| Mirror V | `mirror-v-full` | `mirror-v-full.v5` |
| 星擎 Agent | `xingqing` | `xingqing-starter.v1` |
| Makaron | `makaron` | `makaron.v2.1.2` |

旧 `mirror-v` 从公开目录下架，配置保留供既有实例使用。“Mirror V 全功能”只改显示名为 Mirror V，并设为默认选择。旧 `?template=mirror-v` 链接兼容指向 `mirror-v-full`；不重命名或迁移既有实例。

### 视频加载

- 先播 `nexus-world-preview-480p-v6.mp4`（854×480，约 607 KB）；完整下载 `nexus-world-hd-1080p-v6.mp4`（1920×1080，约 9.8 MB）后自动接替。
- 1080p 由原视频经 Makaron 超分得到，保持同一段画面、24fps、约 15.04 秒；没有重新生成场景或插帧。它是无声背景视频。
- 完整下载的高清视频使用 Blob URL；切到另一播放器对齐时间后渐变，循环也通过两个播放器交接。Nginx 和 Gateway CSP 均保留 `media-src 'self' blob:`。
- 暂停、页面不可见、reduced-motion/Save-Data 和高清失败有降级路径。高清加载失败时继续播放低清，不让页面空白。

### 桌面与手机布局

- 桌面可用高度 ≤1100px 时，网格为左侧标题与列表、右侧扫码区；≤760px 高度进一步收紧标题、列表和面板的垂直留白。
- 两个面板的额外上边距为 `clamp(0px, calc((100svh - 650px) * .3), 36px)`。750px 高时均下移 30px，650px 或更矮时不额外位移。
- 宽度 ≤760px 时继续使用 H5 布局，不受上述桌面位移影响。隐藏单独的 Agent 列表框，点击整个头像、标题与描述区打开四项底部弹层，支持关闭与焦点返回。
- 二维码保持原尺寸、不透明白底和原始对比度；长表单、错误与验证码状态仍可自然撑开页面滚动，不用固定高度裁切。
- 新增 UI 文案覆盖简体、繁体、日语、英语；生成正文语言不由这些界面标签推断。

## 验证与实际交付

- Gateway 构建和 70 项测试通过；UI 最终提交 `322f3ed1` 的 `dev` CI [38599907909](https://github.com/vegekyd-sys/mirror-v-portal/actions/runs/38599907909) 成功。
- 内置浏览器验证 1280×650、1000×650、1440×780、1440×1000 与 375×812；正式站最后 1440×750 两框 margin-top 均为 30px，文档高度等于视口高度，完整二维码在首屏。
- 真实页面验证默认选择、四个头像、H5 选择、Makaron 账号表单、背景暂停/继续与 1080p 实际播放；低清等待、高清下载成功和失败降级另有本地受控夹具证据。
- 公开 HTTP 回归覆盖头像 hash/CORP、视频 Range、favicon、CSP、账号校验、二维码、pending 轮询和取消。接口测试会话取消，未借测试创建新租户。
- #11 的目录/元数据发布范围内重启 Gateway 和 Manager；首次未等目录就绪触发自动回滚，改为校验实际目录后成功激活。原 22 个实例版本与快照保留。
- #12/#13 只更新静态页面、原子切换 release、平滑 reload Nginx；Gateway、Manager、Ledger、HTTPS 隧道和 Nginx 主进程 PID、配置与目录保持原值。
- 用户已认可外观；自动检查没有替用户完成手机授权，也不能证明新用户后续四类媒体聊天或创意效果优于其他 Harness。

## 接手时保持的合同

修改源码 `packages/central-gateway/src/services/onboard-page.ts`，通过 Gateway build 生成静态 HTML。发布前区分首页、控制面和 payload 的改动；只因页面更新，不重启保存扫码会话的进程，不改租户 pin。

本轮没有改变公开 Makaron CLI 的命令、模型、参数或 bundled Skill，未新增 npm 发包。原生 Agent 内容、项目 facade 与 Portal UI 是不同发布面，后续按 [两库交接](makaron-portal-handoff-20261015.md) 分开推进。

截图及安全摘要保存在本次聊天产物目录的 `portal-production-20261015/`、`portal-laptop-20261015/`、`portal-spacing-20261015/`。私有原始扫码材料、生产配置和备份留在原安全位置，不复制进本仓库。
