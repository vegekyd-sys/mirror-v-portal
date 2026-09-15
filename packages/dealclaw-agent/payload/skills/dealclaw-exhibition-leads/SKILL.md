---
name: "dealclaw-exhibition-leads"
description: "展会线索处理。展中扫码/OCR/慧译慧记text/匹配→展后跟进。来源：田耕郡@格格"
author: ""
---

# 展会线索处理

> 展中线索（扫码/名片 + 慧译慧记 text）和展后跟进。展前邀约走 DC-Exhibition-Invitation。

## 触发

| 用户说 | 阶段 |
|------|------|
| 扫码 / 上传名片 / 录音 | 展中线索采集 |
| 「我扫了哪些买家」/「看下扫码记录」/ 想查看扫码买家 | 展中·扫码记录查询 |
| 「展后跟进」 | 展后邮件 |

## 数据源分工（关键）

- **ASR / 翻译 / 会议纪要** 由 tradechina 侧的慧译、慧记完成，DealClaw **不自己做 ASR**，只调 `text`。
- **买家信息获取** 两条路（可并行）：
  1. 扫码 `badge-buyer`（展证二维码/展证号）→ 买家信息 + `customer-id`/`cdp-id`
  2. 名片 OCR → 结构化提取（**待方案，暂空**）
- **匹配** 是 DealClaw 自己做：拿 text 关联买家信息，做意图分析。

## 展中处理

1. GDPR 隐私门：已获同意才存储，未获同意仅临时处理
2. **买家信息获取**：
   - 扫码：`badge-buyer`（`--scan-url` 展证二维码链接，或 `--badge-no` + `--exhibition-id` 成对）→ 买家信息 + `customer-id`/`cdp-id`
   - 名片：OCR（待方案）
3. **调慧译慧记 text**（按 ID 直连）：
   - 慧译 `translate-summary-list --customer-id <id>` → 翻译 text（`--type`：1 实时翻译 / 2 同声传译 / 4 离线翻译）
   - 慧记 `note-records --customer-id <id>`（或 `--cdp-id <id>`）→ 会议纪要 text
4. **匹配**：
   - 主链路：扫码拿到 `customer-id`/`cdp-id` → ID 直连查该买家的慧译慧记 text
   - 兜底：仅名片无 ID 时，从 text 提取公司名/人名 → 文本匹配线索池买家
5. **意图判断**：从 text 读懂买家想要什么、意向高低，并给出下一步跟进方式 + 何时需要用户补充材料（产品资料/报价/样品等）——只做语义判断，不做打分表
   - text 为空 → 跳过意图判断，降级为纯买家信息落库，不阻塞
6. 五步完成 → 一条总结气泡
7. 写入线索池：调 `ensure_company_lead_pool` 获取企业线索池 → 写 record，来源「展会线索」；有意图时写冷热/阶段
8. 若线索中涉及展会名称、国家，查 `work/mio-api/exhibition_plan_*.csv.txt` 校验展会信息（时间/行业/规模），辅助上下文判断。

### Step 7 写入线索池

GDPR 已获同意模式下，完成后写入企业线索池：

```bash
cd work/mio-api
python3 dc_company_registry.py ensure "<company_id>" "<company_name>"
# 返回 field_map → 按映射写 bitable record
```

字段映射：
- 公司名 ← 扫码/OCR company_name
- 官网 ← 扫码/OCR website
- 国家 ← 扫码/OCR/text 推断
- 联系人 ← `contact_name|title|email`（多人换行）
- 来源 ← 展会线索
- 冷热 ← 有意图：高意向→🔥热，中低意向→❄️冷；无意图 → ❄️冷
- 阶段 ← 待触达

GDPR 未获同意 → 跳过此步骤，不写入。

## 展商查看扫码买家（scan-badge-list）

> 触发：展商**明确说想查看/查询扫码买家**——「我扫了哪些买家」「看下扫码记录」「展会期间扫的买家」等。
> 这是**查询（读）**动作，与上面「展中线索采集」（现场采集一条新线索）不同：先拉记录，再与慧译慧记匹配，最后提供线索池记录。

```bash
xiaoyuan company scan-badge-list \
  [--exhibition-id <展会ID>] [--company-name <公司名模糊>] \
  [--start "yyyy-MM-dd"] [--end "yyyy-MM-dd"] \
  [--page-num 1] [--page-size 10]        # page-size 上限 100
```

- 身份：`--open-id` 与 `--supplier-id` **必须成对**（全局参数，写在子命令**前面**），或 env `MEO_OPEN_ID` / `MEO_SUPPLIER_ID`。缺一直接报错「飞书身份须同时提供 --open-id 与 --supplier-id」。
- 数据是**展商联系人维度**（命令即「当前联系人」）：必须用**发起人本人**的身份查，不代查他人扫码记录。
- 时间参数只给日期时，`--end` 含当天 23:59:59。

**存档（扫码记录单独记，不混进线索池结构）**

```
data/exhibition/scan-badge/<supplier_id>/records.jsonl   # 归一化记录（按 record_id 幂等追加）
data/exhibition/scan-badge/<supplier_id>/index.json      # 汇总（最近抓取时间 / 条数 / 展会分布）
data/exhibition/scan-badge/<supplier_id>/raw/<ts>.json   # 原始响应留档
```

调用（工作目录 = `work/mio-api`，脚本 `dc_scan_badge.py`）：

```bash
python3 dc_scan_badge.py fetch --supplier-id <id> --open-id <id> \
    [--exhibition-id <id>] [--start 2026-09-01] [--end 2026-09-30] [--page-size 100]
python3 dc_scan_badge.py list  --supplier-id <id> --limit 10
python3 dc_scan_badge.py match --supplier-id <id> --limit 5      # 慧译 / 慧记 匹配
python3 dc_scan_badge.py fetch --supplier-id <id> --mock          # 联调用（不调接口）
```

- 先 `fetch` 归档，展示与匹配都读本地存档（不重复请求接口）；需要最新时再 fetch。
- 字段归一化已做容错映射（公司名/官网/国家/联系人/职位/邮箱/电话/展证号/扫码时间/展会/customer-id/cdp-id），原始记录完整保留在 `raw` 字段——真实字段名与接口不一致时不影响使用。
- SQL 化/多租户隔离：目录以 `<supplier_id>` 分级，不同展商互不可见。

**流程**

1. 解析展商身份（open-id + supplier-id 成对）；缺就问用户要，**不猜、不用默认值**。
2. 拉取扫码记录（默认最近一页；用户指定展会/时间段/公司名就带上对应参数）。
3. 归一为线索字段：公司名 / 官网 / 国家 / 联系人（`姓名|职位|邮箱`，多人换行）/ 扫码时间 / 展会。
4. **慧译慧记匹配**（按记录里的 `customer-id` / `cdp-id` 直连，恒不上模糊强挂）：
   - 慧译 `translate-summary-list --customer-id <id>`（`--type`：1 实时翻译 / 2 同声传译 / 4 离线翻译）→ 翻译 text
   - 慧记 `note-records --customer-id <id>`（或 `--cdp-id <id>`）→ 会议纪要 text
   - 用途：用 text 补全/校验公司名与人名、判断买家想要什么；无 ID → 不做文本强匹配，标 ⚠️ 数据不全。
5. **与邀约记录交叉比对**（判断“既邀约又扫码”）：
   - 拉邀约记录：`xiaoyuan company invitation-list [--exhibition-id <id>] [--is-check-in 0|1] [--is-meeting 0|1] [--page-num/--page-size]`（分页获取邀约记录；`--is-check-in` 是否到展、`--is-meeting` 是否商洽）
   - 按 **公司名（+ 官网/邮箱）** 与扫码记录交叉比对；域名/邮箱命中优先于公司名模糊命中，**不确认不硬挂**
   - 命中 → 标「**邀约+扫码**」；未命中 → 标「纯扫码」
6. **写入线索池**：走 Step 7 的 `ensure_company_lead_pool` + 字段映射，**来源固定填「展会扫码」**（独立标记，**不并入「展会线索」**）；冷热/阶段按下面优先级判定。幂等：公司名 + 官网去重，已存在则更新不重建。
7. **交付**：**按优先级排序**（见下）后**分批逐条**展示：每批 ≤10 条气泡（公司名 — 官网 / 关键信号 / 推荐理由），批次依次全部发出、明细不省略，末尾附线索池链接；总量 >30 条时先发一条汇总气泡（总数 / 方向 / Top 亮点）+ 线索池链接，**随后仍要把全部明细分批补齐**。气泡不内嵌表格。**禁止「>N 条只给汇总 + 链接」的折叠交付**（2026-09-15 现场实测 49 条被折叠、明细丢失，故改此口径）。

**优先级（用户明确口径）**

| 优先级 | 情形 | 冷热 / 动作 |
|---|---|---|
| **1（最高）** | **既邀约过、又扫码过**（交叉命中） | 采购意图高 → **🔥热 · 优先跟进 + 优先推荐** |
| 2 | 只扫码（未邀约） | 用户更关注扫码买家 → 按慧译慧记意图定冷热；无 text → ❄️冷，仍在扫码组 |
| 3 | 只邀约、未到展/未扫码 | **其次**，排在扫码组之后 |

- 命不命中要**能指出命中了哪条邀约记录**（公司名/域名），凭交叉比对结果、不凭印象。
- 「邀约未到场」在本 skill 里**只做排序参考**，其独立跟进链路不在本段。

**失败与降级**

- 身份不成对 → **明确告知缺哪个并请用户提供**，不得降级为「查不到」
- 该身份下 `total=0` → 如实说「这个身份下没有扫码记录」，并提示可能原因（不是本人扫的 / 时间或展会筛得过窄）；**不编造记录**
- 慧译慧记 text 空 → 跳过匹配与意向判断，按纯买家信息落库，不阻塞
- 记录超过一页 → 先交付第一页，并告知还有多少条（`page-size` 上限 100）

**边界**

- 扫码记录属于展商联系人的个人数据：**只给发起人自己的**，不跨联系人查
- 不把内部数据源名（慧译/慧记/adapter 等）暴露给用户
- GDPR 隐私门同样适用：未获同意不落库

## 展后跟进

按意图分类生成跟进邮件，走 Growth Send 发送。
跟进完成后，查 `work/mio-api/exhibition_plan_*.csv.txt` 检查该国是否还有其他 upcoming 米奥展会，有则附加短钩子（如「沙特12月也有HOMELIFE，要不要提前搜买家？」）。

## 失败与降级

- 慧译/慧记 text 空（无翻译/无纪要）→ 跳过意图判断，降级为纯买家信息落库，不阻塞
- 扫码失败 / ID 查不到 → 走名片 OCR（待方案）或文本匹配兜底，标 ⚠️ 数据不全
- text 匹配不到任何买家 → 仍写线索池，来源标「展会线索-未关联」，留待人工补

## 边界

- GDPR 隐私门不可跳过
- 数据来源不对用户暴露
- 模糊字段标注 ⚠️，不自行脑补
- 展后邮件走 Growth Send，不单独发
- ASR 由慧译慧记完成，DealClaw 只调 text，不自建 ASR

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成展会买家对接并交付结果后，必须异步记录一条计费事件：

```bash
# 计费埋点（正式链路）：tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow 记录）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-exhibition-leads 1 &
```

- 必须在后台异步执行（加 `&`），不阻塞用户回复
- 失败静默，不影响主流程
