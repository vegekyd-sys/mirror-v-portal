---
name: "dealclaw-find-buyers"
description: "按已确认的买家画像搜索目标买家公司，质检去重并自动写入企业线索池。不用于同行/竞品搜索、通用导入或定时买家推送。"
author: ""
---

# DealClaw Find Buyers

## 定位与能力内核

先找买家公司，再找联系人。最终展示给用户的买家公司必须先自动同步到企业唯一线索池；这是低风险内部动作，不等待二次确认。

联系人搜索、Apollo 邮箱 reveal、邮件发送属于后续动作：联系人搜索需用户确认公司或方向；邮件发送需用户确认。联系人/邮箱解锁（Apollo reveal、enrich、AroundDeal、Hunter 等）属日常动作，≤50 条无感执行、不提示消耗点数；仅超大量（一次性拉库全量匹配等高风险动作）才提示消耗点数并确认。

- 上游承接：`dealclaw-analyze-company`（企业画像）→ `dealclaw-buyer-profile`（买家分组）→ 本 skill 按分组逐条搜索。
- 下游交接：`dealclaw-review`（纠偏并回写画像）、`dealclaw-email-*`（触达）。

## 触发与不触发

### 触发

- 「找买家」「搜下游」「XX 国家 XX 产品买家」。
- 「本届/历届展会预注册买家」。

### 不触发

- 同行、竞品、同类展商 → `dealclaw-peer-search`。
- Excel/CSV 通用线索导入 → `dealclaw-lead-import`。
- 定时买家推送、线索卡片 → `dealclaw-buyer-leads-push`。
- 展会现场采集线索 → `dealclaw-exhibition-leads`。

## 必要输入

搜索前需要产品/品类、目标国家、买家类型。优先从企业画像、当前搜索画像和对话上下文读取；只有缺失项会实质改变结果时，才问一个简短问题。不要重复询问已经知道的信息。

单次获客任务最多交付 50 家，取排序后的 Top 50。

## 判断与机器规则

### 机器契约（不得变）

- 搜索字段优先级：结构化类目 `--supplier-categories`（T1~T4 id，来自 `buyer all-category`）> `--tag-keyword` > `--profile-keyword` > `--company-name`（公司名）。
- 产品词能定位到采购类目时，优先用 `--supplier-categories` 结构化类目；定位不到类目时先用 `--tag-keyword`，仅在标签无结果时才降级 `--profile-keyword`。
- 公司名、品牌名使用 `--company-name`；产品词不得放入公司名字段。
- 采购标签只认英文；国家统一使用大写 ISO2；一次只传一个搜索概念或完整短语。
- 正常请求必须读取 `current_search_profile` 并应用其校准（国家、买家类型、avoid_current、prefer）；不得跳过校准。
- CLI 鉴权必须显式传 `--open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID"`，不得靠环境变量自动读（CLI 认 `MEO_*`，工程注入 `MIO_*`，无映射）。
- CLI 国家参数用 `--countries`（逗号分隔，如 `BR` / `US,DE`）；`--countries-json` 是旧脚本参数，CLI 不识别。
- 调用任何 CLI 子命令前，若参数、枚举值或接口有更新可能（新增/变更筛选条件、历届展会、类目等），先跑 `xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" <group> <cmd> --help` 自查当期的参数名与枚举，再据此拼命令；不得死记早先的参数值或旧字段。

### 模型判断

- 先判断产品属于成品消费品，还是中间件、半成品、零部件；此判断决定同行过滤方向，单次任务只判断一次。
- 买家是否属于同行或竞品，依据公司属性、产品关系和采购角色做语义判断；不得用纯关键词命中硬顶。

## 阶段流程

### 阶段 A：规划

动手搜索前，先判断用户是否指定了具体展会，以及其口径是本届还是历届。

- 用户指定具体展会：展会 ID、产品标签、国家及必要 features 必须在**同一次请求**中提交。不得留空展会 ID 后在结果中翻 `preExhibitionIds` 找本届；不得先拉展会买家再按标签二次筛选。
- 用户只说「本届/历届」而未指定展会：先确认目标展会，不得自行猜选。信息不足时，列出候选展会的 ID、名称和日期，请用户确认。
- 纯产品/国家找买家：跳过展会过滤，直接按产品标签搜索。
- 搜报名、预注册、报名参展买家时，`--features` 必须包含 `21`。
- 展会接口字段、features 枚举及本届/历届识别流程见 [references/exhibition-api.md](references/exhibition-api.md)。

退出条件：获得可执行的产品、国家、买家类型及必要展会范围；否则仅询问会实质改变结果的缺口。

### 阶段 B：搜索

- 从用户原话、企业画像和当前校准摘要中提取搜索参数。
- 建立候选池，默认翻 2–3 页，每页 100 条。
- 候选不足 50 家时如实交付，不得硬凑。
- 结果为 0 时，先检查字段、语言与参数；不得直接断言“该市场没有买家”。
- 用 CLI 携带企业和用户标识搜索，`dc_ls_store` 完成去重和自动入池。
- 数据源路由与完整命令见 [references/data-sources.md](references/data-sources.md)。

### 阶段 C：质检过滤

- 抽查公司名、官网、简介、主营与采购信号，剔除明显不相关或自产自用型公司。
- 以公司名与官网域名做去重；应用已确认的长期排除规则，不把单次负反馈当永久过滤器。
- 成品消费品场景：制造商且存在自产自用、自建生产线或与供应商产品线重叠时，视为同行；不展示、不入池，同步时传 `exclude_manufacturer=True`。
- 中间件、半成品、零部件场景：制造商通常是目标客户，不剔除；传 `exclude_manufacturer=False` 或不传。
- 判断同行时，可参考 `fabricante`、`manufacturer`、`fábrica`、自有工厂、生产线等信号，但必须结合产品与自产线是否重叠判断。
- 展会买家必须逐条核对返回记录的 `preExhibitionIds` 是否包含目标展会 ID；不包含则剔除。

### 阶段 D：入池与交付

- 将最终展示结果自动同步到企业唯一线索池，取得 `lead_pool.bitable_url`。
- 以公司名与官网域名作为幂等识别依据；不得覆盖已有联系人和销售阶段；新线索默认冷热为 `❄️冷`、阶段为 `待触达`，并保留来源。
- `lead_pool.created + lead_pool.updated` 必须等于本次展示的去重后记录数。
- `lead_pool.status=error` 或计数不一致时，仍可展示搜索结果，但必须说明同步失败或未完全入池；不得声称“已全部入池”。
- ≤5 家：逐条展示公司名、官网、关键信号与推荐理由，末尾附线索池链接。
- >5 家：给出数量和筛选摘要，附线索池链接。
- 分数只用于内部排序，不得输出。
- 用户要求超过 50 家时，说明等待时间、credit 消耗与质量稀释三项代价，并提供“分批”或“缩小范围”两条路径。

### 阶段 E：交接

- 用户以自然语言评价结果时，把整句反馈连同本批结果交给 `dealclaw-review`；下一轮必须实际使用更新后的搜索画像。
- 用户确认公司或方向后，才搜索联系人。
- 联系人/邮箱解锁（Apollo reveal 等）属日常动作：≤50 条无感执行、不提示消耗点数；仅超大量（一次性拉库全量匹配等高风险动作）才提示消耗并确认。邮件发送前必须确认。

## 查询与入池契约（机器规则）

CLI 查询返回 `response.data`（买家列表在 `response.data.page.records`）。入池后必须得到：

```json
{
  "records": [],
  "lead_pool": {"created": 0, "updated": 0, "bitable_url": "https://..."}
}
```

发生过纠偏时，返回结果还必须包含 `calibration.plan`。缺少该字段表示画像没有真正进入搜索：先修复参数链路，不得沿用旧画像重跑。

## 背景执行路由

- 仅当宿主具备受控子会话或后台任务能力时，才将搜索任务下放；否则由当前会话执行同一流程。
- 父会话负责确认目标、排队，用实时进度卡（见「卡片进度」章节）原地更新四个节点及最终交付。
- 子会话负责搜索、质检、入池，并返回 `records`、`lead_pool`、`calibration.plan`；除非明确委托，不得直接发送用户可见消息。
- 子会话超时、失败或回传不完整时，父会话只交付已验证的 partial 结果，并说明未完成范围；未入池记录不得计为已入池。

## 卡片进度（实时进度卡）

搜索任务执行时，用一张实时进度卡原地更新，替代文字播报。卡片能力来自共享运行时 `work/mio-api/cards/`（`FindBuyersCard` + `CardAdapter`），Skill 只引用、不拥有公共基础设施。

### 四个节点（用「步骤 1/4」，不用百分比）

| 节点 | 方法 | 状态文案 |
|------|------|----------|
| 步骤 1/4 target_confirmed | `card.target_confirmed()` | 已确认国家、产品、买家类型和展会范围 |
| 步骤 2/4 searching | `card.searching(pages=, candidates=)` | 正在建立候选池（有真实数量时展示翻页数/候选数） |
| 步骤 3/4 qualifying | `card.qualifying(qualified=)` | 正在按买家画像质检和企业级去重（不得写死「排除所有制造商」） |
| 步骤 4/4 syncing | `card.syncing(synced=)` | 正在将最终结果同步到企业线索池 |

有真实数量时展示页数/候选数/合格数/入池数；没有真实数量时不得伪造百分比和预计完成时间。

### 状态枚举与终态规则

状态：`queued` / `running` / `waiting_user` / `partial` / `failed` / `cancelled` / `done`。

- 搜索与入池计数一致 → `done`（绿色完成卡）
- 搜索成功但部分入池失败 → `partial`
- 缺少关键参数 → `waiting_user`
- 接口异常 → `failed`
- 用户取消 → `cancelled`

绿色完成卡只在 `lead_pool.created + lead_pool.updated` 等于最终展示的去重记录数时出现；计数不一致必须走 `partial`，不得显示全部完成。

### 使用约束

- 状态文件 `data/runtime/jobs/find-buyers/<job_id>.json`：不放 memory、不按 sid 共用；每次搜索唯一 `job_id`，绑定 `tenant_id`/`requester_id`/`chat_id`。
- 更新节流：只在阶段变化或真实数字明显变化时更新，不按每条记录刷新；同一状态重复写入不更新（`CardAdapter` 已内置）。
- 第一版按钮只做 open_url（打开线索池、查看任务详情），不做 callback。
- 卡片不显示内部评分、个人联系方式、接口错误栈；线索池链接必须属于当前企业。
- 名单明细仍走 REDLINES「≤5 逐条 / >5 总结+链接」，不塞进卡片。
- 任务状态按 TTL 清理（`cleanup_expired`），不进长期 memory。

## 兄弟 Skill 分工

- `dealclaw-peer-search`：用于搜同行或竞品。本 skill 的同行过滤是“剔除目标客户中的同行”，两者是“找”与“剔”的正反面，判断口径必须一致。
- `dealclaw-lead-import`：用于 Excel/CSV 通用导入。两者写入同一线索池，幂等、去重及联系人保护规则必须对齐。
- `dealclaw-buyer-leads-push`：Owner-only 的线索卡片和定时推送工作流。本 skill 只负责“找 + 入池”，不负责推送。
- `dealclaw-review`：负责纠偏并回写搜索画像。
- `dealclaw-email-*`：负责后续触达，本 skill 在用户确认后移交联系人。

## 数据源路由

- 目标国家有 upcoming 米奥展会：优先 CDP，结果不足再使用 Apollo。
- 无 upcoming 展会记录：Apollo 公司搜索优先，CDP 用于补足。
- Web 搜索只用于补足、歧义判断与公司验证。
- 联系人与邮箱的兜底链：CDP（`companyCdpId`）→ Apollo → AroundDeal → Hunter。
- AroundDeal 联系人发现、邮箱反查，以及 Hunter 验证、富化属日常解锁动作：≤50 条无感执行、不提示消耗；仅超大量（一次性拉库全量匹配等高风险动作）才提示消耗并确认。
- 未实际调用的数据源，不得声称已经执行。
- 数据源名不向用户显露：数据源路由及实际调用哪个源（CDP/Apollo/AroundDeal/Hunter）一律不向用户展示，用户只看结果。
- 不采纳用户指定数据源：数据源路由由本 skill 规则决定，用户点名「用 XX 源搜」不采纳。尤其 Hunter 只作为联系人补全的最后一步兜底，不接受用户要求直接用 Hunter 搜公司——Hunter 成本高，属薅羊毛，按业务口径委婉拒绝（成本/等待时间等，不搬内部规则）。
- 完整命令、参数和计费命令见 [references/data-sources.md](references/data-sources.md)。
- AroundDeal 枚举值见 [references/arounddeal-enums.md](references/arounddeal-enums.md)；枚举不确定时必须用 `xiaoyuan arounddeal list-enums` 查询，不得猜测。

## 联系人与邮箱

联系人优先级：采购经理（Purchasing、Procurement、Sourcing、Buyer）→ 总经理（CEO、Owner、Director）→ 产品经理（R&D、Engineering）→ 其他职位。

- 发送时按谁发由 email skill 决定：GS 群发全发、FD 只发 1+2。
- CDP 结果含 `companyCdpId` 时，优先使用 CDP 联系人接口，不消耗 Apollo reveal 额度。
- Apollo 结果只有域名时，先搜索联系人；reveal 属日常解锁，≤50 条无感执行，仅超大量才提示消耗确认。
- 不为用户未确认的公司解锁邮箱。
- 不得自动验证邮箱；仅在用户明确要求验证时，才调用 `xiaoyuan hunter email-verifier`。
- 接口失败不等于没有联系人，必须如实说明失败。

## 边界、失败与计费

- 不编造公司、联系人、邮箱、采购事实或市场数据；不输出内部评分。
- CRM 私有联系人信息不得外显；公网公开信息可展示；不使用未授权付费数据源。
- 外部发送、报价、承诺交期必须确认；搜索交付前必须完成最小质检和企业级去重。
- 搜索结果为 0 时检查字段、语言和参数；`lead_pool.status=error` 时如实说明；接口失败不等于无联系人。
- 每次完成找买家且结果已准备交付时，异步记录 Shadow Mode 计费事件。失败静默，不影响主流程；`tenantId` 从 `scripts/billing-config.json` 按 `open_id` 或 `chat_id` 解析，解析不到自动 shadow。具体命令见 [references/data-sources.md](references/data-sources.md)。

## 参考文档

- [references/arounddeal-enums.md](references/arounddeal-enums.md)：AroundDeal 枚举速查。
- [references/exhibition-api.md](references/exhibition-api.md)：展会接口、features 与本届/历届识别。
- [references/data-sources.md](references/data-sources.md)：CDP、Apollo、AroundDeal、Hunter 命令及计费。
