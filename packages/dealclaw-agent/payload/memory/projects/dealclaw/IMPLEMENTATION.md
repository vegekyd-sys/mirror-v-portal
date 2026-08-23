# IMPLEMENTATION.md — 外贸顾问 V · 技术实现

> 版本: v1.2 | 更新: 2026-07-07 | Owner: Tianyi + 格格
>
> 本文件定义 V 的底层技术方案——评分算法、API 集成、性能指标、数据结构。
> 人格定义 → PERSONA.md | 能力定义 → CAPABILITIES.md

---

## 一、买家匹配模型

> 当前版本: v0.1。数据库接入前用标签碰撞，接入后补充数据驱动权重。

### 匹配优先级

```
1. 标签碰撞（市场+行业+产品+买家类型）→ 精确匹配
2. V 内部六维判断 → 解释"为什么先追这家"
3. 用户反馈 → 偏好强化或排除降权
```

### V 内部判断维度（非暴露给用户）

| # | 维度 | 考察内容 | 数据来源 |
|---|------|---------|---------|
| 1 | 行业匹配 | 买家主营产品与我方产品线重合度 | 当前:公网搜索 |
| 2 | 采购可能 | 有无从中国进口同类产品历史 | 当前:推断 待接入:海关进口记录 |
| 3 | 渠道价值 | 分销能力和市场覆盖 | 当前:官网分析 |
| 4 | 客单价 | 采购量级预估 | 当前:公司规模推断 待接入:海关进口金额 |
| 5 | 准入难度 | 认证/法规门槛是否已覆盖 | 当前:CBIE 认证比对 |
| 6 | 触达难度 | 能否找到决策人联系方式 | 当前:公网搜索 待接入:米奥/LinkedIn |

### 输出格式

```
推荐理由（一句自然语言，不暴露分数）:
"PVR 是意大利中型真空泵制造商，泵体铸件直接需求，规模与光华士产能匹配。建议首攻。"
```

---

## 二、外部 API 集成

### 邮件发送

| 项目 | 值 |
|------|-----|
| 服务 | Resend API |
| 状态 | ✅ 已接入 |
| 脚本 | `scripts/resend/send.mjs` |
| 发件人 | `v@mail.dogarm.top` |
| 发送策略 | 所有邮件需用户预览确认后才发送 |

### 多语言内容生成

| 状态 | 语言 | 说明 |
|------|------|------|
| ✅ 可用 | 英语 | 直接生成 |
| ✅ 可用 | 德语 | 直接生成，建议人工抽检 |
| ⚠️ 可用但需审校 | 印尼语、俄语、西班牙语、葡萄牙语 | LLM 可生成，外贸术语可能不准确 |
| 🔜 计划中 | 阿拉伯语、法语、日语 | — |

---

## 三、CBIE（企业画像引擎）

### 输入
- 公司官网 URL
- 公司名称（模糊搜索）
- PDF/名片（展会场景）

### 输出 Schema

```json
{
 "company": {
   "name": "string",
   "founded": "number",
   "country": "string",
   "city": "string",
   "employees": "string",
   "revenue": "string",
   "website": "url"
 },
 "profile": {
   "industry": "string",
   "main_products": ["string"],
   "business_model": "OEM|Brand|Distributor|Trading",
   "customization_capability": "boolean",
   "company_type": "Factory|Trading|Factory+Trading",
   "certifications": ["string"],
   "active_channels": ["Alibaba|Trade Show|Independent Site|Amazon"],
   "procurement_cycle": "Quarterly|Monthly|Irregular"
 },
 "buyer_persona": {
   "buyer_category": "string",
   "target_markets": ["string"],
   "procurement_products": ["string"],
   "procurement_scale": "string|pending",
   "contact_title": "string",
   "key_requirements": ["string"]
 },
 "recommendation": {
   "score": "1-5",
   "reason": "string"
 }
}
```

### 数据约束
- `procurement_scale` 必须量化（如"月采购 10K-50K 件"），无法获取时填 `pending`
- `target_markets` 不推测，中国企业默认海外
- 字段缺失时标记 `pending`，不编造

---

## 四、性能参考

| 操作 | 参考时间 | 备注 |
|------|---------|------|
| 收到 URL → 确认消息 | <2 秒 | 秒回确认，不等分析 |
| URL → 画像初稿 | ~15-30 秒 | CBIE 全流程 |
| 画像修改（单字段） | <5 秒 | 增量更新 |
| 买家搜索 | ~30-60 秒 | 取决于搜索轮次 |
| 开发信生成 | <15 秒 | LLM 生成 + 本地化 |

---

## 五、数据存储约束

| 数据类型 | 存储规则 | 删除规则 |
|---------|---------|---------|
| 买家画像 | 用户确认后持久化 | 用户可随时请求删除 |
| 联系人信息 | 用户明确确认后才存储 | 用户可随时请求删除 |
| 用户偏好 | 自动存储，用户可见可编辑 | 用户可随时清除 |
| 排除名单（黑名单） | 永久存储，除非用户手动移除 | 用户可手动恢复 |
| 对话历史 | 用于上下文记忆 | 遵循平台数据保留策略 |

### 合规要求
- GDPR: 存储任何欧盟公民的联系信息前需用户明确同意
- 数据最小化: 只存储画像生成和买家匹配所需的最小字段集
- 用途限制: 数据仅用于 DealClaw 的外贸顾问功能

---

## 六、错误处理矩阵

| 错误场景 | 用户看到 | 后台行为 |
|---------|---------|---------|
| 外部数据源返回空 | "未找到该公司的 {数据类型}。可能原因：1) 近期无进口 2) 通过代理商采购 3) 公司名拼写偏差。换个名字试试？" | 标记数据源状态，记录失败原因 |
| 画像信息不足（>3 字段 missing） | 列出缺失字段，引导用户补充 | 不生成低质量画像，等待用户补充 |
| 线索匹配 <3 条 | "匹配到的买家不多。放宽某个条件试试？比如不限制国家" | 自动建议放宽的维度 |
| 文件无法解析 | "从文件里提取到了 {已提取字段}，但 {缺失字段} 没识别出来。能手动提供吗？" | 标记文件类型和失败原因 |
| API 超时 | "查得有点慢，还在跑。要不我先给你看已找到的？" | 返回部分结果 + 后台继续 |

---

## 引擎清单（2026-07-29 从 AGENTS.md 搬运）

| 引擎 | 文件 | 职责 |
|------|------|------|
| LS | dc_ls_store.py | 线索去重+标注+偏好回传 |
| HT | dc_customer_import.py | 历史客户导入+标签提取+相似度重排序 |
| IQ | dc_iq_engine.py | 意图识别→CBIE动态读取→状态迁移→KB查缺→断点 |
| KB | dc_kb_engine.py | 物料存储+CBIE播种+IQ联通查缺 |
| Copy | dc_copy_engine.py | CBIE画像自动填充+渠道适配+多轮序列+GS直出 |
| SL | dc_send_log.py | GS/FD/WA发送日志+投递/打开/点击/回复追踪 |
| DB | dc_dashboard.py | 日报+漏斗+4Tab看板数据聚合 |
| WA | dc_wa.py | YCloud WhatsApp发送+Webhook接收+IQ联通 |
| Leads | dc_buyer_leads_api.py | TradeChina 买家线索广场 |

## 数据面板

📊 飞书多维表格：https://hit5b11g3sf.feishu.cn/base/IHANbRPmCaHcBEs2soycoPNQnxc

## 展会数据源（2026-07-25 龚华确认）

- 飞书电子表格 `2026线下展`: https://hit5b11g3sf.feishu.cn/wiki/IvP5wNrbDiD7Eokal2QcIZVYnMg?sheet=Cn0ikz
- spreadsheeToken: `FkCpszMcuhN8LDtXRlkclxYjnEg`, sheetId: `Cn0ikz`
