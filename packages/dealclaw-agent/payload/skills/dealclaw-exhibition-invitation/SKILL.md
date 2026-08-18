---
name: "dealclaw-exhibition-invitation"
description: "展前邀约：米奥展会走内部数据→客户确认→模板邀约→邮件发送。来源：田耕郡@格格"
---

# 展前邀约

## 触发

用户说要参加展会 / 做邀约 → 确认展会名称、日期、展位号。

## 动作

确认参数 → 搜买家（米奥展会优先内部数据）→ 出名单客户确认 → 访谈补变量 → 询问附件 → 统一模板填充 → 气泡预览 → 检查邮箱绑定（未绑先引导）→ 用户确认后发送。

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
- 不询问「走 FD 还是 GS」，直接问「用哪个邮箱发」

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成本技能操作并交付结果后，必须异步记录一条计费事件：

```bash
# 计费：dealclaw-billing 插件自动 detect 此命令并 estimate→settle（租户映射在 scripts/billing-config.json）
bash scripts/dealclaw-billing-record.sh --group <chat_id> dealclaw-exhibition-invitation 1 &
```

- 后台异步，不阻塞回复；失败静默
