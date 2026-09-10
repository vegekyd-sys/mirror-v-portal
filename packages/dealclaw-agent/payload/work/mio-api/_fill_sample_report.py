#!/usr/bin/env python3
"""Agent 生成深析内容并填充骨架 → 渲染 → 校验。一次性样例生成演示。"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import dc_after_exhibition_report as r

SID = "sample-exhibition-review"
EXPO = "demo-expo-2026"

# 1. 出骨架（机械层：漏斗/分层/evidence_refs/需求聚合）
report = r.build_skeleton(SID, EXPO, "close_out")

# 2. Agent 生成深析（按 SKILL.md 第 5 步：为什么理想 + 互动证据 + 已确认/待确认需求 + 阶段 + 下一步）
deep_dives = {
    "cdp_a001": (
        "阿联酋电信运营商（Etisalat）企业服务，手机周边在 UAE 的高势能渠道。"
        "证据：6/12 现场会谈主动提「手机壳 ODM 定制 200 套」并要求报价（quote_request），"
        "6/13 邮件确认「自营品牌渠道」+「11 月前交付」。"
        "已确认：产品（手机壳 ODM）、数量（200 套）、用途（自营品牌）、交期（11 月前）；待确认：单价、logo 工艺。"
        "下一步：6/14 前发 ODM 报价单（200 套阶梯价 + 打样周期），销售负责；完成标准 = 买家回传单价与交期确认。"
    ),
    "cdp_a002": (
        "到展并多次对接，明确要求蓝牙耳机样品——「要样品」是实质采购动作，不是泛泛咨询。"
        "证据：6/12 现场对接要求本周寄样（sample_request），6/13 邮件确认 TWS 入耳式规格。"
        "已确认：产品（蓝牙耳机）、规格（TWS 入耳式）；待确认：数量、预算、采购周期。"
        "下一步：本周寄 TWS 入耳式样品，样品组负责；完成标准 = 买家确认收到并反馈测试结果。"
    ),
    "cdp_a003": (
        "有决策人到场，要求移动电源 1000 台批量报价——带量询价，是明确的采购规模信号。"
        "证据：6/12 决策人会谈要求 1000 台批量报价（quote_request），6/13 邮件确认数量 1000 台、预算「待报价后确认」。"
        "已确认：产品（移动电源）、数量（1000 台）；待确认：预算、交期。"
        "下一步：发 1000 台批量报价单（含阶梯价），销售负责；完成标准 = 买家回传预算区间或还价。"
    ),
    "cdp_a004": (
        "到展留下采购总监联系方式，明确「季度采购」节奏——渠道型买家，价值在持续复购而非单笔。"
        "证据：6/12 采购总监会谈（product_need 手机配件 + usage 季度采购），6/13 邮件确认季度采购周期。"
        "已确认：产品（手机配件）、采购节奏（季度）；待确认：单次数量、具体 SKU。"
        "下一步：发配件目录 + 季度框架协议，销售负责；完成标准 = 锁定季度下单节奏。"
    ),
    "cdp_a005": (
        "扫码对接，现场确认手机壳/套订单意向并主动约二次会议——意向明确且愿意推进谈判。"
        "证据：6/12 扫码确认订单意向（quote_request），6/13 邮件要求二次会议确认交期（next_negotiation）。"
        "已确认：产品（手机壳/套）、意向（有）；待确认：数量、交期、预算。"
        "下一步：48 小时内定二次会议时间，销售负责；完成标准 = 会议确认交期与数量。"
    ),
}

for b in report["buyer_actions"]["connected_followups"]:
    b["deep_dive"] = deep_dives.get(b["customer_id"], "")

# 3. Agent 生成诊断（解释 + 建议 + 验证指标）
if report["diagnoses"]:
    d = report["diagnoses"][0]
    d["interpretation"] = (
        "有效商洽 10 家，仅 5 家推进到报价/样品/二次会议，掉链子环节在「现场商洽 → 明确商务动作」。"
        "需区分：是买家需求尚未明确（没到要报价的阶段），还是已明确但展后跟进没及时跟上。"
    )
    d["recommended_action"] = (
        "对 10 家有效商洽买家在 72 小时内逐一回访：已明确需求的直接推进报价/样品/二次会议，"
        "需求未明确的补齐数量/交期/预算信息，再判断是否升级为商务推进。"
    )
    d["success_metric"] = "有效商洽 → 商务推进 转化率提升（当前 50%）。"

# 4. Agent 生成本届收获（wins）
report["executive_summary"]["wins"] = [
    "本届共触达 20 家目标买家，其中 5 家已进入报价/样品/二次会议阶段，是本届现场形成的重点机会。",
    "5 家优先跟进买家需求各不相同且证据充分：手机壳 ODM 定制、蓝牙耳机样品、移动电源批量报价、手机配件季度采购、手机壳二次会议，是差异化商机而非泛泛咨询。",
    "需求聚焦手机配件与移动电源，与产品线契合；5 家优先跟进均含决策人或多次现场对接，可作下届展重点邀约对象。",
]

# 5. Agent 生成跟进与复购建议（action_plan）
report["executive_summary"]["priority_action"] = "72 小时内一对一跟进 5 家优先跟进买家，发报价/寄样/定二次会议。"
report["action_plan"] = [
    {
        "horizon": "72h",
        "action": "一对一跟进 5 家优先跟进买家",
        "target_customer_ids": [b["customer_id"] for b in report["buyer_actions"]["connected_followups"]],
        "owner": "销售",
        "due": "2026-06-15",
        "reason": "5 家均已在报价/样品/二次会议阶段，2 天内推进可把现场意向转成书面动作。",
        "evidence_refs": ["demo:2", "demo:5", "demo:8", "demo:11", "demo:14"],
        "success_metric": "5 家均完成报价/寄样/会议邀约并记录回复",
        "status": "pending",
    },
    {
        "horizon": "7d",
        "action": "培育 15 家 B/C 级买家",
        "target_customer_ids": [b["customer_id"] for b in report["buyer_actions"]["nurture"]],
        "owner": "销售",
        "due": "2026-06-22",
        "reason": "B 级意向中等、C 级需先核验，纳入月度跟进节奏，发目录/白皮书逐步升温。",
        "evidence_refs": [],
        "success_metric": "15 家均纳入跟进节奏并记录下一步",
        "status": "pending",
    },
    {
        "horizon": "next_exhibition",
        "action": "沉淀 20 家匹配买家为下届邀约名单",
        "target_customer_ids": [],
        "owner": "销售",
        "due": "下届展会",
        "reason": "本届 20 家匹配买家作为下届（阿联酋）展邀约基础，提前备样品册与报价。",
        "evidence_refs": [],
        "success_metric": "下届邀约名单已沉淀并导出",
        "status": "pending",
    },
]

# 6. 写回 + 渲染 + 校验
out_dir = HERE.parents[1] / "data" / "after-exhibition-report" / SID / EXPO
out_dir.mkdir(parents=True, exist_ok=True)
json_path = out_dir / "report-data.json"
json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

html = r.render_html(report)
html_path = out_dir / "report.html"
html_path.write_text(html, encoding="utf-8")
pdf_ok = r.html_to_pdf(str(html_path), str(out_dir / "report.pdf"))

val = r.validate_report(str(json_path))

print(json.dumps({
    "json_path": str(json_path),
    "html_path": str(html_path),
    "pdf_path": str(out_dir / "report.pdf"),
    "pdf_ok": pdf_ok,
    "validate": val,
}, ensure_ascii=False, indent=2))
