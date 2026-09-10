# 单租户部署下的 Push 改造设计

> 状态：设计稿（2026-08-19）
> 目标：把 agent push / leads push 从「运行时 chat_id 绑定」改为「provisioning 租户配置注入」，适配单租户部署。

## 一、背景与问题

当前 DealClaw 是「多租户挤一个部署」：多个企业共享同一套运行环境，所以必须靠 `chat_id`（飞书群）把群和企业绑起来，才能路由消息、隔离数据、确定推送目标。

现状两个 push 都依赖这个绑定：
- **agent push**（campaign 倒计时 + 早晚报）：推送到绑定的群
- **leads push**（buyer-leads-push）：binding 存 chat_id → 企业+知识库+Base+supplier

**问题**：真实服务器部署时，每个企业是独立租户（独立 pod/namespace），租户边界就是部署本身，不再需要「chat_id 绑定」这个运行时动作。保留绑定流程是多余且脆弱的。

## 二、核心思路

把「租户边界」从 `chat_id` 改成「部署单元（tenant/pod）本身」：

- 租户身份、推送目标、supplier id、知识库、Base 全部在 **provisioning 时注入**（企业扫码开通那一刻就确定）
- 运行时不再有「绑定」动作，只剩「读租户配置 + 执行推送」两件事

## 三、映射表

| 现在的机制 | 单租户部署后 |
|---|---|
| 租户键 = chat_id（群） | 租户键 = tenant_id（pod 本身） |
| binding：chat_id → 企业+知识库+Base+supplier | tenant config：provisioning 注入 supplier id + KB token + Base token + 推送 channel |
| 群历史建草稿 → 企业确认 → 正式绑定 | 初始化（supplier → getBasicInfo）自动建画像 |
| 每轮查 state，按 chat_id 隔离 | 每轮读 tenant config + tenant state，按 tenant_id 隔离 |
| 推送到绑定的群 chat_id | 推送到 tenant config 里的 channel |
| chat_id 精确匹配 + chat-isolation-v3 权限校验 | pod/namespace 隔离，guard 从 chat_id 校验退化成 tenant_id 校验 |

## 四、两个 push 的具体调整

### 1. agent push（campaign / 早晚报）
- campaign 已 key 在 company_id，基本不动
- 早晚报推送目标从 chat_id 换成 tenant channel
- 倒计时/phase 逻辑不变

### 2. leads push（buyer-leads-push）
- binding 换成 tenant config（supplier id + KB token + Base token + channel 注入）
- **砍掉群历史建草稿**（企业由 supplier id 已知，不用从群消息反推）
- **砍掉「草稿→正式知识库」的绑定确认双文档流程**（一个企业一个租户，不存在绑错企业）
- TradeChina 查询和推送都走 tenant 里的 supplier id + channel
- 画像确认保留，但性质变了：从「确认绑哪家企业」变成「确认画像的产品/市场」

## 五、保留 / 删除

**保留（和租户无关，原样搬）：**
- 打分、60 阈值、卡片渲染、去重、轮询逻辑
- 画像确认（性质从「确认企业」变「确认画像的产品/市场」）
- supplier id → getBasicInfo 的初始化数据落位（init-data-mapping 已定义）

**删除（单租户下多余）：**
- 群历史建草稿
- 草稿→正式知识库的「绑定确认」双文档流程
- chat_id 隔离的 guard 精确匹配（tenant_run_guard / resource_permission_guard 里的 chat_id 校验），退化成 tenant_id 校验或直接靠 pod 隔离

## 六、例外与注意点

1. **channel 仍需注入**：单租户下企业仍用飞书、机器人仍往某群/会话推，所以 channel 这个值还在——只是从「运行时绑定」变成「provisioning 时注入」，企业扫码那一刻就知道，不用再让用户给群 ID。
2. **supplier id 是租户级凭据**：进凭据管理服务，随实例注入（见 credential 清单），非全局单值。

## 七、落地顺序（建议）

1. provisioning 注入 tenant config（supplier id / KB / Base / channel / 展会国 / 画像产品）
2. 初始化流程改成「读 tenant config → getBasicInfo 建画像」，替代群历史建草稿
3. 两个 push 的运行时把 chat_id 键替换为 tenant_id
4. 砍掉绑定确认流程和 chat_id 隔离 guard 的精确匹配
