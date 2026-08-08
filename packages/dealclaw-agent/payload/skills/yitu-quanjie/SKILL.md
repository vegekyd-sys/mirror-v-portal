---
name: "yitu-quanjie"
description: "一图全解：展会推广海报批量生成。触发词\"一图全解\"，收集国家+产品+PPT模版，自动替换内容并生成PPTX。"
---

# 一图全解（Yitu Quanjie）— 展会推广海报批量生成工作流

## 硬触发规则

触发词：一图全解

执行步骤：
1. Step 1：逐项收集 国家 → 产品 → PPT模版（每项确认✅后继续）
2. Step 2：用 python-pptx 递归拆解模版（含 Group 嵌套，shape_type==6）
3. Step 3：web_search 查 2026 真实市场数据（5 维度：市场规模/进口依赖/中X贸易/产业政策/相关展会）
4. Step 4：按原文长度约束替换 6 个区域（封面/介绍/产品范围表格/市场优势4点/买家采购），文本长度 ≤ 原文
5. Step 5：验证无溢出、无残留原文、格式完整、Group无遗漏

核心铁律：
- 文本长度 ≤ 原文（防溢出串联坍塌）
- Group 必须递归遍历（防遗漏）
- 表格行高使用明确的最小高度并按内容计算
- 市场数据必须来自公开报告（IMARC/Mordor Intelligence/Grand View Research等），不编造

## 脚本位置

`/tmp/ppt-template-batch-skill/yitu-quanjie/scripts/yitu_quanjie_replace.py`
