---
name: "dealclaw-email-founder-direct"
description: "Founder Direct 一对一邮件：SMTP发送、个性化内容、日量控制。来源：田耕郡@格格"
version: 2.0.0
---

# DC-Email Founder Direct: 一对一触达

> DealClaw Skill | 高价值买家、老板对老板、展后跟进

## 何时用

- 用户看中某个高价值买家，想一对一发邮件
- GS 自动序列中买家回复了，转人工深度跟进
- 展会见面后跟进

## 执行流程

```
1. 生成邮件内容 → V 根据买家背景+企业优势自主撰写
2. 发送前确认 → 展示收件人、内容、检查项给用户
3. 用户确认 → SMTP 发送
4. 记录发送状态
```

## 邮件内容原则

V 自主生成，核心约束：

- 纯文本，80-100 词
- 一句话破冰（引用具体证据：产品/展会/新闻）
- 一个观察 + 一个问题
- 只签名字，不挂公司全称
- 无追踪像素、无退订链接、无附件
- 首封不直接约会（不问 "let's schedule a call"）

## 日量控制

- 硬上限：15 封/天
- 超限 → 提示明天继续

## 回复处理

买家回复 → V 通知用户 → 展示摘要 → 问是否要回复

## 发送脚本

```bash
node scripts/founder-direct/send-direct.mjs \
  --from user@company.com \
  --to buyer@example.com \
  --subject 'Quick question — [主题]' \
  --text '...'
```

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v2.0 | 2026-07-29 | 吸收 dc-copy 内容生成，删 DC-OS/DC-Copy 死链。邮箱绑定引导移出 skill（V 被问到自然会引导）。来源：田耕郡@格格 |
| v1.0 | 2026-07-14 | 初始 |
