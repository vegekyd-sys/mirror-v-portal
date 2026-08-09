---
name: "dealclaw-exhibition-leads"
description: "展会线索处理。展中OCR/ASR/匹配→展后跟进。来源：田耕郡@格格"
---

# 展会线索处理

> 展中线索（名片+录音）和展后跟进。展前邀约走 DC-Exhibition-Invitation。

## 触发

| 用户说 | 阶段 |
|------|------|
| 上传名片 / 录音 | 展中 OCR + ASR |
| 「展后跟进」 | 展后邮件 |

## 展中处理

1. GDPR 隐私门：已获同意才存储，未获同意仅临时处理
2. 名片 → OCR → 结构化提取（气泡通知 + 飞书文档）
3. 录音 → ASR → 说话人分割（气泡通知 + 飞书文档）
4. 匹配 → 关联名片与录音 → 意图分析（高/中/低意向）
5. 五步完成 → 一条总结气泡
6. 写入线索池：调 `ensure_company_lead_pool` 获取企业线索池 → OCR 字段写 record，来源「展会线索」；有 ASR 意图时写冷热/阶段

### Step 6 写入线索池

GDPR 已获同意模式下，OCR 完成后写入企业线索池：

```bash
cd work/mio-api
python3 dc_company_registry.py ensure "<company_id>" "<company_name>"
# 返回 field_map → 按映射写 bitable record
```

字段映射：
- 公司名 ← OCR company_name
- 官网 ← OCR website
- 国家 ← OCR/ASR 推断
- 联系人 ← `contact_name|title|email`（多人换行）
- 来源 ← 展会线索
- 冷热 ← 有 ASR 意图：高意向→🔥热，中低意向→❄️冷；无 ASR → ❄️冷
- 阶段 ← 待触达

GDPR 未获同意 → 跳过此步骤，不写入。

## 展后跟进

按意图分类生成跟进邮件，走 Growth Send 发送。

## 边界

- GDPR 隐私门不可跳过
- 数据来源不对用户暴露
- 模糊字段标注 ⚠️，不自行脑补
- 展后邮件走 Growth Send，不单独发
