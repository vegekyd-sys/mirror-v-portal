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
| 「展后跟进」 | 展后邮件 |

## 数据源分工（关键）

- **ASR / 翻译 / 会议纪要** 由 tradechina 侧的慧译、慧记完成，DealClaw **不自己做 ASR**，只调 `text`。
- **买家信息获取** 两条路（可并行）：
  1. 扫码 `badge-buyer`（展证二维码/展证号）→ 买家信息 + `customer-id`/`cdp-id`
  2. 名片 OCR → 用视觉模型（`view_image`，系统 `imageModel`）结构化提取公司/姓名/职位/邮箱/网址/电话
- **匹配** 是 DealClaw 自己做：拿 text 关联买家信息，做意图分析。

## 展中处理

1. GDPR 隐私门：已获同意才存储，未获同意仅临时处理
2. **买家信息获取**：
   - 扫码：`badge-buyer`（`--scan-url` 展证二维码链接，或 `--badge-no` + `--exhibition-id` 成对）→ 买家信息 + `customer-id`/`cdp-id`
   - 名片：`view_image` 看图 → 结构化提取（见「名片 OCR」小节）
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

### 名片 OCR（视觉模型）

> 实现契约见 `references/card-ocr.md`（内部，不对外、不对租户暴露）。
> 视觉模型由平台「模型供应商」全局库配置一次，自动推所有租户，租户无需任何配置；
> Key 由后台加密存储，绝不写入 skill / 仓库 / 对话。

名片照片用视觉模型（`view_image`，系统 `imageModel`）做结构化提取，输出字段：

- 公司名 / 姓名 / 职位 / 邮箱 / 网址 / 电话 / 地址 / 国家（输出 JSON 键与规则见 `references/card-ocr.md`）

规则：

- 反光 / 模糊 / 字段缺失 → 对应字段标 `⚠️ 待补充`，不脑补
- 形近字（擎/挚、舜/舸、染/梁等）拿不准 → 标 `⚠️` 请用户确认，不硬猜
- 多语言名片 → 保留原文，必要时附中文转写
- 结果先展示给用户确认，确认后才进入匹配 / 意图分析（沿用五步确认门）
- GDPR 门不变：含邮箱/电话等联系人信息，获得同意后才存储/落库

前提：系统视觉模型已配置（管理后台「模型供应商」→ 系统视觉模型）。未配置时 `view_image` 不可用 → 降级为「仅人工录入名片信息」，标 `⚠️ 数据不全`，不阻塞后续（若同时有扫码 ID 仍可走 ID 直连）。

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

## 展后跟进

> 端到端完整链路（OCR→隐私门→匹配→意图→回写→跟进）与验证状态见 `references/end-to-end-checklist.md`。

按意图分类生成跟进邮件，走 Growth Send 发送。
跟进完成后，查 `work/mio-api/exhibition_plan_*.csv.txt` 检查该国是否还有其他 upcoming 米奥展会，有则附加短钩子（如「沙特12月也有HOMELIFE，要不要提前搜买家？」）。

## 失败与降级

- 慧译/慧记 text 空（无翻译/无纪要）→ 跳过意图判断，降级为纯买家信息落库，不阻塞
- 扫码失败 / ID 查不到 → 走名片 OCR（`view_image` 视觉模型）或文本匹配兜底，标 ⚠️ 数据不全
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
