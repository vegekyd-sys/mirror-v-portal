# WhatsApp 首次触达风控笔记

> 创建: 2026-07-03 | 来源: 格格+VGap分析
> 状态: 待验证/补全

## 核心原则

**第一条消息不是营销，是建立联系。目的是让对方回复你。**

---

## 风控机制

### 新号冷启动期

- 前 50–100 条消息如果没有互动（对方回复/存联系人），发营销内容大概率被标记。
- 新号信誉分从 0 开始，每收到一条回复加分，被举报/被屏蔽扣分。低于阈值进入 spam pool。

### 举报与限流

- 被举报率 > 2–3% 直接限流或封号。
- 被多人屏蔽 → 封号风险。

### 内容检测触发

| 触发行为 | 后果 |
|----------|------|
| 首条消息带链接 | 直接限流 |
| 未回复连续群发 | 信誉快速下降 |
| 同一文案批量发送 | 模板检测，限流 |
| 首条就提价格/折扣/优惠 | 营销标记 |
| 新号一天发 50+ 条首触达 | 大概率封号 |

---

## 安全首次触达策略

### 三步走

1. **首触达**：自我介绍 + 轻量提问。不带链接、不推销、不报价。
2. **对方回复后**：再发送简版公司介绍或资料。
3. **第三次对话**：再推进邀约/邮件/样品。

### 首条消息要点

- ❌ 不带链接
- ❌ 不报价、不提折扣/优惠
- ❌ 不推销产品
- ✅ 自我介绍（谁、做什么）
- ✅ 用问句结尾（`Darf ich...` / `Hätten Sie Interesse...`），回复率远高于陈述句
- ✅ 让对方只需要回一句 "Ja, gerne" 就能建立互动

### 示例（德语安全版·第一条）

```
Hallo, ist das [Firmenname]?

Mein Name ist [Name], ich bin bei NTC Technology in Shanghai.
Wir sind auf Feingussteile für industrielle Pumpen spezialisiert.

Darf ich Ihnen kurz unser Leistungsspektrum vorstellen?
```

---

## 渠道特性：德国

- WhatsApp 在德国商务场景中不如 LinkedIn 常用，但越来越普及。
- 首次触达用 LinkedIn 可能比 WhatsApp 更安全、更正式。
- 如用 WhatsApp，短消息风格应偏正式（`Hallo` 而非 `Hi`），用 `Sie` 而非 `du`。
- 德语区商务沟通忌讳 `günstig` / `billig` / `best price`，会被当低端供应商。

---

## 待补全

- [ ] 其他主要市场 WhatsApp 风控差异（印尼、俄罗斯、中东、拉美）
- [ ] LinkedIn 首次触达风控规则
- [ ] 不同国家 WhatsApp Business API vs 个人号规则差异
- [ ] 群发工具的合规边界
- [ ] 真实测试：新号冷启动期被标记后的恢复流程
