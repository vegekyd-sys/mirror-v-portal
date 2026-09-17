---
name: "dealclaw-smart-reply"
description: "询盘处理引擎。企业画像动态读取→资料充足才自动回复；资料不足/会议/拒绝/低置信度→飞书断点通知。来源：田耕郡@格格"
author: ""
version: 2.1.0
date: "2026-07-19"
---
> 作者/发起人: 蔡天懿 | 实现: 田耕郡@格格

# DC-IQ: 询盘处理引擎

> DealClaw Skill | 入站询盘处理
> 版本: v2.1 | 数据源: Resend 入站 webhook / WABA/YCloud webhook
> 触发: 买家回复邮件/WA → 接管 → 企业画像动态读取 → 状态迁移 → 回复/断点通知

## 写作口吻与 CTA（用户明确要求 2026-09-15）

- **口吻**：以**专业外贸顾问**身份判断与回复——先给判断（这封信想干什么、值不值得投入、风险在哪），再给动作；用数字和事实说话，不吹、不空承诺。
- **CTA 铁律**：**每一封跟进邮件必须有且只有一个明确 CTA**，具体、轻量、容易回答；禁止「有需要随时联系」「期待回复」这类空 CTA。
- CTA 按意图选：询价 → 确认**数量 + 目的港**；索样 → **寄样地址 + 收件人 + 电话**；约会议 → **两个具体时段**（按时区换算）；无明显意向 → 低压力钩子或明确收尾。
- **不编造 / 不空承诺（用户长期要求，最高优先）**：
  - 不编造任何事实数据（价格 / MOQ / 交期 / 认证 / 产能 / 案例）；没有任何一项可以“猜一个先发过去”。
  - **不替用户对外承诺**：需要这些参数时**主动向用户索取**（如“请确认 MOQ 与 FOB 价”“交期按哪个口径报”），拿到之后再起草。
  - **不承诺答复时间**：不写「24 小时内回」「明天给你」这类时间承诺，只承诺**动作本身**（如“确认数量与目的港后即出正式报价”）。
- 中英文各按母语习惯写，不做逐句直译。
- **外发确认（2026-09-15 修订，按来源分流）**：
  - **默认**：任何邮件发出前必须用户确认，本 skill 只出草稿。
  - **展会期间 · 邀约到展位的买家**：用户很忙、无法逐条确认 → **用户信息不缺失、资料齐备时可自动回复**，不必逐条等确认。
    - 该场景发送时同样用 `python3 work/mio-api/send_window.py --country <ISO> --mode exhibition`（非窗口不阻断）。
  - **其他来源（慧译慧记 / 名片 OCR / 扫码）**：**即使在展会期间，也必须用户确认后**再回。
  - 豁免不满足即回落：出现「缺字段 / 缺资料 / 需报价 / 预约会议 / 意图不明」→ 立即回到「断点 + 等确认」。
  - 来源判据取**线索来源字段**，不凭印象；来源不明 → 按「需确认」处理。
  - “资料齐备”以 `check_materials` / `get_material_links` 的**实际命中**为准（含资质证书、产品手册），**不得凭印象判断**。

## 用户偏好（模板 / 改稿意见）——记住并复用（2026-09-15 用户明确）

同一租户反复纠正同一个点、或反复给同一套模板，**不能每次从默认打法重来**。

- **记住**：用户给出模板、或对草稿提改进意见 → **记成该租户的偏好（写进记忆）**，并在同一轮就按它改。
  **不搞脚本、不搞配置文件**——用记忆和判断，夜间反思时把它沉淀成稳定偏好。
- **复用**：写任何草稿前先想一遍该租户的偏好：结构 / 口吻 / CTA / 署名 / 忌讳。
  **同一租户重复提同一个点 = 偏好没生效**，先查是不是没记住，而不是再解释一遍“下次注意”。
- **适度**：偏好是“照他的想法来”，但**不得越过**安全与真实性规则（不编造 / 不空承诺 / 外发需确认）；冲突时以规则为准，并向用户说明。

## 一、职责

DC-IQ 处理所有 outbound 营销产生的买家回复：FD 邮件回复、GS 邮件回复、WA 消息回复。

目标：自动识别意图 → 自动推进状态 → AI 动态回复 → 推到 Stage4 预约会议时交还用户。

## 二、买家状态机

```text
Stage0  未建联 — 系统已发信，买家尚未回复
Stage1  已回复 — 买家有回应但未表达采购兴趣
Stage2  已表达兴趣 — 买家有「我需要/我在找/感兴趣」等信号
Stage3  已索要资料 — 买家明确要 catalog/price/cert/spec
Stage4  已预约会议 — 买家提出或同意 call/meeting
Stage5  销售跟进 — 人工接管，DC-IQ 退出
```

## 三、入口

| 渠道 | 来源 | 格式 |
|---|---|---|
| FD 邮件回复 | Resend 入站 MX / IMAP → webhook/poller | 纯文本 |
| GS 邮件回复 | Resend 入站 MX → receiving webhook | 纯文本 |
| WA 回复 | WABA/YCloud webhook | 文本 |

## 四、意图识别与通知过滤

拿到买家回复后，先过滤再通知：

**静默丢弃（不通知用户）：**
| 类型 | 特征 | 处理 |
|------|------|------|
| 🤖 自动回复 | out of office / vacation / OOO | 静默丢弃，不通知 |
| 📧 退信 | mailbox full / address not found | 静默记录发送失败 |

**通知用户：**
| 意图 | 特征 | 动作 |
|------|------|------|
| 🙋 一般回复 | thanks / got it / will check | 通知 + Stage0→Stage1 |
| 🎯 表达兴趣 | interesting / looking for / need | 通知 + Stage1→Stage2 |
| 📂 索要资料 | catalog / price / spec / send me | 通知 + Stage2→Stage3 |
| 📅 预约会议 | call / meeting / schedule / visit | 通知 + Stage3→Stage4 |
| ❌ 退订/拒绝 | not interested / stop / unsubscribe | 通知 + 记录退订事件 + 线索标「停止触达」 |

## 四之二、买家附件（回复带附件时必读）

买家回信里的报价单、规格书、logo、产品图**已经自动落盘**，不要当它不存在——
不读附件就判断意图，等于只看了半封信。

**怎么知道有附件**：案卷（`dc_thread_dossier.py`）里每封信下面会列「**附件**」段；
事实层记录的 `attachments[]` 字段同样带着。飞书提醒卡片也会列出文件名和大小。

**怎么拿到路径**：

```bash
# 按邮件 message_id 查（最常用：卡片刚提醒的那封）
python3 work/mio-api/dc_resend_attachments.py --find --company-id <sid> --message-id "<xxx>"
# 或按文件名子串
python3 work/mio-api/dc_resend_attachments.py --find --company-id <sid> --name quote
# 案卷里直接带路径（仅自用，交付给客户的案卷不要开这个开关）
python3 work/mio-api/dc_thread_dossier.py --company-id <sid> --buyer <email> --with-paths
```

**现拉前必须先分清是哪条链路**（代理邮箱走 Resend API，个人邮箱走 IMAP，**混用必失败**）：

| 链路 | 怎么认 | 附件在哪 / 怎么取 |
|------|--------|------------------|
| **resend 代理邮箱** | 域名是 `dealclaw.io` 及其子域（`mail.` / `bde.` / `send.` …），账号 `provider=resend` / `mailbox_kind=dealclaw_proxy` | 现拉：`--pull --message-id "<邮件id>"`，或用 `--pull --latest` |
| **个人邮箱** | 163 / QQ / 腾讯企业邮 / gmail / 企业自建域名等，账号 `mailbox_kind=personal` | **收信时 imap_sync 已落盘** → `--find` 查；没有就重收该账号再查 |

拿不准先探一下（不联网）：

```bash
python3 work/mio-api/dc_resend_attachments.py --route --message-id "<邮件id>"
```

**现拉 / 取附件**：

```bash
# 代理邮箱：最近一封带附件的入站（用户说「附件发我」时最常用）
python3 work/mio-api/dc_resend_attachments.py --pull --latest
# 代理邮箱：知道邮件 id 就拉那一封
python3 work/mio-api/dc_resend_attachments.py --pull --message-id "<邮件id>"
# 个人邮箱：先查已落盘
python3 work/mio-api/dc_resend_attachments.py --find --message-id "<邮件id>"
# 个人邮箱：查不到就重收该账号（IMAP），再 --find
cd work/mio-api && python3 -m email_gateway.cli sync --account-id <账号id>
```

`--pull` 只下载 + 落盘 + 写索引，**不外发**；用户要文件时，用当前会话把 `path` 那个文件发出去。
对个人邮箱用 `--pull` 是错的（Resend 里没有这封）——命令会直接告诉你改走 `sync`，别反复重试。

**怎么读**：拿到 `path` 后直接喂一等工具——PDF/规格书用 `pdf`，图片/logo/产品照用 `image`，
Excel 用 `python3` + openpyxl。读到的内容并入意图判断（例如对方发来的是询价单，
意图就不是「一般回复」而是「表达兴趣」甚至「索要资料」的下一步）。

**读不了的时候照实说**：
- `image` 工具不存在 → 该租户没配视觉模型，**只报文件名，不猜图里是什么**
- 行里 `stored: false` → 附件没存下来（超限/下载失败），说明原因，别假装看过
- docx 目前镜像里没有解析库，同样只报文件名

不编、不猜——REDLINES 一「不假装看过」在附件上同样适用。

## 四之三、回信带附件（买家索要资料时）

上一节是**读**买家发来的附件，这节是**回**过去带附件 —— 买家说「catalog 发我一份」
「把规格书发来」（意图表里的 📂 索要资料）时最常用。

**怎么带**：草稿字典里塞 `attachments`（本地文件路径的列表），`confirm_and_send` 会自动透传给发信层：

```python
from dc_email_controller.dc_reply_draft import record_draft, confirm_and_send

record_draft({
    "draft_id": "...", "company_id": "<sid>", "buyer_email": "buyer@x.com",
    "subject": "Re: catalog request", "text": "...",
    "attachments": ["/本地路径/catalog-2026.pdf"],   # ← 就这一个键
})
confirm_and_send(draft_id, confirmed_by="ou_<用户open_id>")
```

**从哪拿路径**：资料库里的物料走 `dc_material_ingest` / 知识库资料层；
买家先前发来、要原样转回去的，用上一节的 `--find` 拿 `path`。

**规矩**：

- 只认**本地文件路径**，不认 IM 的 file_key；拿不到本地路径就如实说做不了，别编一个路径塞进去
- 总大小 15MB（原始字节）；超限 / 文件不存在 / 空文件 → **整封不发**，草稿标 `failed` 并带上原因，
  **绝不会出现「说发了其实没带附件」**
- 附件一样要用户确认 —— 发资料给外部买家是对外动作，「只出草稿」那条默认规则同样适用
- 发出去的附件会进统一附件库并记进出站事实，案卷里能看到「我方发了什么」

## 五、退订追踪

退订/拒绝发生时：
1. 记录退订事件（时间/买家/渠道/原文摘要）
2. 线索池阶段列更新为「停止触达」
3. 退订数计入当日统计，早晚报中展示：「🚫 退订：X 家」

## 五、自动回复原则

> **出草稿前先读 `memory/projects/dealclaw/email-playbook.md`** —— 买家回复后的两步闭环（代回买家+抄送负责人 → 内部说明邮件）、CTA 口径、排版规范以它为准。

**不写死模板。回复必须从企业画像动态读取外部线英文原文。**

必读字段：

- `enterprise_external`：外部线英文公司名
- `product`：外部线英文产品名/产品线
- `usp`：外部线英文价值主张/资质/规模/代理背书
- `materials`：DC-KB/资料库中的 catalog、price、spec、certificate、sample 等可发送材料

生成要求：

- 呼应买家原文中的具体产品、问题或语气。
- 简洁、自然、外贸真人口吻，不套模板腔；默认 2 行、≤120 词。
- 目标是推进状态，而不是完成一次漂亮回复。
- 不直接报价；买家索要价格时必须检查是否已有价格资料/报价规则，否则断点。
- 禁止用中文内部线字段拼外贸邮件；英文外部线不足时断点补资料。
- Stage4 预约会议、企业画像字段缺失、资料缺失、意图不确定、拒绝/投诉都必须暂停并飞书气泡通知。

| 当前状态 → 目标 | 回复方向 |
|---|---|
| Stage0 → Stage1 | 简短确认收到，问一句引导他补充需求。 |
| Stage1 → Stage2 | 顺着兴趣点展开，确认应用场景/产品范围。 |
| Stage2 → Stage3 | 先检查 DC-KB/materials 是否有买家要的 catalog/price/spec/cert/sample；有才发送，缺就断点。 |
| Stage3 → Stage4 | 不自动发会议确认；生成草稿并交给用户确认。 |

回复渠道：邮件走 Resend/SMTP，WA 走 WABA/YCloud API。

## 六、人工断点 → 飞书气泡

`dc_iq_engine.py` 默认只返回 `feishu_notice` payload；生产环境设置 `DC_IQ_SEND_FEISHU=1` 后才真实发送飞书通知，避免测试误打扰用户。

| 断点 | 气泡示例 |
|---|---|
| 企业画像字段缺失 | 📌 企业画像不足，IQ暂停自动回复：缺 enterprise_external/product/usp，请补充英文外部线。 |
| KB/资料缺失 | 📂 买家索要 catalog/price/spec/cert/sample，但资料不足，补上我继续帮你跟。 |
| 预约会议 | 📅 Osculati 想约会议：「Would next Tuesday work for you?」帮你草拟了回复 → 请确认发送/修改。 |
| 意图不确定 | 💬 Osculati 回了，我没太看懂 → 展示原文 + 让用户选择含义。 |
| 拒绝/投诉 | ❌ Osculati 说没兴趣，已暂停该买家所有自动营销。 |

## 七、状态写入

每次状态迁移写入买家状态模块。买家状态模块负责「谁在什么阶段」，漏斗看板直接读取。

线索池阶段/冷热列更新前，调 `get_lead_pool` 获取 bitable 信息：

```bash
cd work/mio-api
python3 dc_company_registry.py show "<company_id>"
# 返回 {"app_token": "...", "table_id": "tbl...", "field_map": {...}}
```

然后按 `field_map` 定位「阶段」「冷热」列的 field_id，调飞书 Bitable API `PATCH /records/{record_id}` 更新字段值。

```json
{
  "buyer": "Osculati",
  "stage": 2,
  "last_contact": "2026-07-17",
  "channel": "GS",
  "round": 1,
  "intent": "表达兴趣",
  "next_action": "wait_reply",
  "history": [
    {"stage": 0, "at": "2026-07-10", "event": "首封发出"},
    {"stage": 1, "at": "2026-07-17", "event": "买家回复"}
  ]
}
```

## 八、Stage5 退出

Stage5 销售跟进时，DC-IQ 完全退出。后续回复由用户自己处理；仅在用户明确说「你帮我回一下」时重新介入。

## 九、版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| v2.1 | 2026-07-19 | 回复改为 CBIE 动态读取；英文外部线/资料不足时飞书断点通知；资料充足才自动发送。来源：田耕郡@格格 |
| v2.0 | 2026-07-19 | 脱proposal，dc_iq_engine.py实现。意图识别+状态迁移+自动回复+dc_ls_store持久化。来源：田耕郡@格格 |
| v1.0 | 2026-07-17 | 初始proposal。蔡天懿 |

## 邮件计费上报（按发送次数，小元 credit）

> 2026-09-15 新增：每封邮件**成功发出后**，按**实际发出条数**上报一次。

```bash
xiaoyuan report-usage \
  --api-code "dealclaw-smart-reply" \
  --api-name "回信处理（自动回复）" \
  --quantity <本次成功发出的邮件条数>
```

- `--quantity` = 本次**真实成功发出**的条数；失败 / 被闸门拦截 / 被时区窗口阻断的**不计**
- 不传 `--credit` → 走平台定价表；**未配置则按 0 计**（所以 code 必须与定价表一致）
- 余额不足：服务端置 0、**不拒绝发送**（计费不阻断业务）
- 上报失败静默，不阻塞主流程；但**结果里要能看出是否已上报**（可观测）
- 与既有 `dealclaw-billing-record.sh`（shadow 记录）**并存**：shadow 继续记，本条是正式扣点

- 定价：**每条自动回复 200 credit**（用户 2026-09-15 指定；⚠️ `credits-ledger/skill_pricing_full.tsv` 目前**没有这一行**，需定价侧补录，否则服务端会按 0 计）
