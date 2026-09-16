# 企业微信扫码绑定（管理控制台）实现说明

## 目标
在管理控制台的「企业微信绑定」区块新增**扫码获取凭据**能力：客户用企业微信 App 扫码，一键创建智能机器人并自动回填 Bot ID / Secret，免去手动复制。与既有「凭证填入式」绑定共存，交互对齐飞书已有的扫码流程。

## 实现原理
企业微信官方为 OpenClaw 生态提供「扫码一键创建智能机器人」能力，底层是纯 HTTP 接口（官方 CLI `@wecom/wecom-openclaw-cli@1.1.1` 同款，已核对源码 `dist/utils/qrcode.js`）：

| 步骤 | 接口 | 说明 |
|------|------|------|
| 1. 发起 | `GET https://work.weixin.qq.com/ai/qc/generate?source=wecom-cli&plat=<数字>` | 返回 `data.scode` + `data.auth_url`（二维码内容） |
| 2. 轮询 | `GET https://work.weixin.qq.com/ai/qc/query_result?scode=…` | `data.status==='success'` 时返回 `data.bot_info.botid/secret` |

`plat` 平台码映射：darwin=1 / win32=2 / linux=3 / 其他=0。`source` 默认 `wecom-cli`（官方 CLI 同款，env `WECOM_SCAN_SOURCE` 可覆盖；`plat` 用 `WECOM_SCAN_PLAT` 可覆盖）。

## 交互流程
1. 管理员在「企业微信绑定（机器人）」区块点「扫码获取凭据」
2. 前端弹窗调 `POST /v1/admin/wecom-app/scan/start` → 后端调企微 generate → 渲染二维码（data URI）
3. 客户用企业微信扫码并确认「一键创建智能机器人」
4. 前端每 3s 轮询 `GET /v1/admin/wecom-app/scan/status/:scode`（后端同步调 query_result）
5. 成功 → 自动回填 botId/secret 到绑定表单 → 管理员确认点「绑定」→ 走原有 wecom-binding 链路（secret 只入 K8s Secret，不落库）

## 改动文件
### 后端 provisioning-service
- `src/services/wecom-app-scan.ts`（新增）：`WeComAppScanStore` 会话管理 + generate/query_result 调用 + qrcode 渲染。会话存内存，前端驱动轮询，5 分钟 TTL，最多 50 个并发会话。
- `src/routes/wecom-app-scan.ts`（新增）：`start` / `status/:scode` / `cancel` 三个端点。
- `src/config.ts`：新增 `wecomScanSource` / `wecomScanPlat`（env 可配置）。
- `src/app.ts`：挂载 `createWeComAppScanRoutes(config, authAndAudit)`。
- `src/__tests__/wecom-app-scan.test.ts`（新增）：15 个单测覆盖 store + 路由。

### 前端 admin-web
- `src/components/WeComAppScanModal.tsx`（新增）：扫码弹窗（仿 FeishuAppScanModal），含倒计时、授权链接备选、失败重试。
- `src/pages/AgentDetailPage.tsx`：企业微信绑定区块加「扫码获取凭据」按钮 + 回填逻辑。

## 验证结果
- 后端单测：**15/15 通过**
- 后端 `tsc --noEmit`：本次改动**零类型错误**
- 前端 `tsc` + `vite build`：**通过**（78 modules）

## 环境注意事项（与本次改动无关，预先存在）
1. **`serve-static` 类型定义缺失**：pnpm hoisting 问题，`@types/serve-static` 未提升到 `node_modules/@types/serve-static` 的 index.d.ts，导致 tsc 报 `TS2688`。本次临时复制 `.pnpm` 内的 index.d.ts 验证后已通过；正式修复建议在 `.npmrc` 加 `public-hoist-pattern[]=@types/*` 或显式安装 `@types/serve-static`。
2. **`src/index.ts` 的 `http.Server` vs `node:http.Server` 类型不匹配**（TS2345）：@types/node 版本差异导致，本次改动未触及。
3. **本地构建需 `NODE_OPTIONS=''`**：WorkBuddy 环境注入的 fs shim 会拦截项目目录的依赖安装，清空后 `pnpm install` / build 正常。

## 风险提示
- 企微 `work.weixin.qq.com/ai/qc/*` 为官方 CLI 使用的接口（非公开文档化 API），存在随企微升级变动的可能；已按官方 CLI 源码严格对齐。
- 扫码授权需 provisioning-service 具备到 `work.weixin.qq.com` 的出网（与飞书 `open.feishu.cn` 同要求，集群已具备）。
