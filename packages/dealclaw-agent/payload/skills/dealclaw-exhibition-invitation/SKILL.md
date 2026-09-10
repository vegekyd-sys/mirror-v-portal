---
name: "dealclaw-exhibition-invitation"
description: "展前邀约：米奥展会走内部数据→客户确认→模板邀约→邮件发送。来源：田耕郡@格格"
author: ""
---

# 展前邀约

## 触发

用户说要参加展会 / 做邀约 → 确认展会名称、日期、展位号。

### 任务驱动触发（展自动营销）

当展自动营销有**待发草稿**时，也走本 skill 生成内容并发送（与「用户主动发起邀约」同一套内容口径）：

```bash
# 拉待发清单
python3 work/mio-api/dc_marketing_automation_send.py --list --company-id <supplier_id>
```

- 只处理 `content_route == "dealclaw-exhibition-invitation"` 的（跟进类归 dealclaw-email-growth-send）。
- 每条含 `draft_id` / 买家 / 公司 / 展会 / `requires_approval`。
- 按本 skill 的「统一模板填充」口径生成 subject + 正文（展会名/日期/展位号/产品线等按占位字段填），再回传发送：

```python
from dc_marketing_automation_send import send_one
send_one(company_id, draft_id, generator=<按本 skill 口径生成正文的函数>)
```

- `requires_approval=True` 的草稿**不自动发**，保持 `pending_confirmation` 等用户确认。
- 发送成功后 automation 自动关闭（`execution_ref=resend_id`），并回写展会邀约名单（见下）。
- 既有前置不跳过：发送前仍检查邮箱绑定 + 时区窗口（`send_window.py`）。

## 动作

确认参数 → 搜买家（米奥展会优先内部数据）→ 出名单客户确认 → **选邀请函模板（必做，从资产库给用户选）** → 访谈补变量 → 统一模板填充 → 气泡预览 → 检查邮箱绑定（未绑先引导）→ 用户确认后发送 → **发送成功回写展会邀约名单**。

### 邀请函模板选择（必做，不可跳过）

邀请买家来展位，必须**附上邀请函模板供用户选择**，不手写一封了事。

- 模板资产库：`assets/templates/`，索引见 `assets/templates/index.md`。
- 选择逻辑（按「行业 + 目标国家/展会 + 语言」）：
  - 巴西 → 葡语，用「巴西工业_homelife.pdf」或行业专业展内的巴西/homelife 类模板；
  - 墨西哥/拉美 → 西语，用对应行业专业展模板；
  - 迪拜/中东 → 英语。
- 无完全匹配行业 → 用最接近行业模板，或「泛家居」兜底（当前无则用 DEFU 软装 / Homelife 类）。
- 生成时替换占位字段：展会名 / 日期 / 地点 / 国家 / 展商名 / 展位号 / 产品线 / 报名入口 / 参展商名录。
- 把可选择的模板（含文件名 + 适用行业/语言）列给用户挑，选中后再填充字段生成。

## 发送成功回写展会邀约名单（必做收尾）

发出去的邀约买家要单独记进「展会邀约名单」，作为回传 tradechina + 现场 check-in 比对的唯一基准。

- 时机：发送成功（拿到 message id）那一刻，对每个实际发出邀约的买家写一条。名单确认阶段不算，只有真发出去才记。
- 脚本：`python3 work/mio-api/dc_exhibition_invitation.py record ...`（幂等，按 companyCdpId 合并；无 CDP ID 用公司名+国家兜底）。
- 字段来源：公司名/官网/国家/买家类型/匹配产品/展会ID/展会名/模板/发送渠道/发送时间/messageId 从本次发送上下文取；联系人从线索池「联系人」字段取（已解锁才有，未解锁留空）。
- 名单落盘：`data/memory/<supplier_id>/exhibition-invitations.json`，与线索池解耦，不污染线索池口径。
- 与线索池「阶段=已触达」回写并存不冲突：名单记「邀约事实」，阶段记「触达状态」。

```bash
python3 work/mio-api/dc_exhibition_invitation.py record \
  --company-cdp-id <CDPID> --company-name <公司名> --website <官网> \
  --country <国家> --buyer-type <买家类型> --product <匹配产品> \
  --contact-name <姓名> --job-title <职位> --email <邮箱> --phone <电话> --whatsapp <WA> \
  --exhibition-id <展会ID> --exhibition-name <展会名> --template <模板名> \
  --send-channel email --message-id <发送返回ID>
```

## 边界

- 米奥展会优先走内部数据，绝不暴露数据来源
- 出名单前先验证买家行业是否匹配，不把不相关的推给客户
- 只接受 Apollo 找的个人联系邮箱，公共收件箱（vendas@/info@/gmail）不用于发送
- Apollo 无联系人时诚实告知。网页公开邮箱仅作最后兜底，需标注「公开邮箱，送达不确定」
- 不拿网页公开邮箱凑数装成有联系人
- 必须先出名单等客户确认，不跳过
- 不替客户决定邀约目标
- 邀约用统一模板，不逐条手写
- 邀约不生成飞书文档，气泡预览后走邮件
- 发送前检查邮箱绑定状态，未绑先引导绑定
- 发送前检查买家时区：`python3 work/mio-api/send_window.py --country <ISO> [--city <city>]`。非工作日或不在 8:00-18:00 则阻断，向用户说明买家当地时间和预计延迟发送时间
- 不询问「走 FD 还是 GS」，直接问「用哪个邮箱发」

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成本技能操作并交付结果后，必须异步记录一条计费事件：

```bash
# 计费埋点（正式链路）：tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow 记录）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-exhibition-invitation 1 &
```

- 后台异步，不阻塞回复；失败静默
