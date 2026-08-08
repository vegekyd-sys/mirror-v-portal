# 米奥数据圈选平台：字段映射 / 商机评分 / 拜访策略 Playbook

生成时间：2026-06-26 18:30（Asia/Shanghai）
安全边界：只读查询；token 只从 env 读取；输出不展示 token、不展示敏感联系方式明细。

## 1. 数据源到业务结构

### A. 客户画像 customer_profile

- 企业身份：`company_name`、`tax_number`、`company_english_name`、`province`、`city`、`district`、`reg_location`
- 工商稳定性：`foundtime`、`reg_capital`、`actualcapital`、`reg_status`、`company_org_type`、`staff_size`、`industry`
- 官网/外贸基础：`offficial_website`、`is_exportenterprise`、`annual_export_turnover`、`export_amount`
- 行业与产品：`indus_name_t0`、`company_products`、`exhibition_product`、`trade_product`、`product_introduction`、产品标签接口返回的 `tag / indus_name_t1/t2/t3 / tag_source / is_main_product`
- 参展行为：`exhibition_cnt`、`last_exhibition_name`、参展记录的 `exhibition_name / exhibition_date / exhibition_country / exhibition_area`
- 贸易行为：贸易记录 `total`、`prod_desc`、`hscode`、`importer_country`、`by_date`、`trade_vl`；出口趋势 `month / trade_cnt / buyer_cnt`
- 触达/归属信号：`recent_touch_time`、`recent_receitve_time`、`owner_name`、`data_source`、`data_type`（只作为内部判断，不在群里展开客户联系方式）

### B. 商机评分 opportunity_score

建议 100 分制，同时输出 A/B/C 档：

- 产品/行业匹配度 25 分
  - 产品标签、主营产品、贸易产品能映射到星擎可做的素材/获客场景：+15～25
  - 只有宽泛行业，没有明确产品：+5～14
- 外贸/市场活跃度 25 分
  - 贸易记录总量、出口趋势、买家数、目的国丰富度高：+15～25
  - 仅有少量或历史贸易记录：+5～14
- 参展与近期动作 20 分
  - 参展次数高、最近仍参展、会刊/展会信息完整：+12～20
  - 参展弱或无近期展会：+0～11
- 企业可靠性 15 分
  - 工商状态正常、成立年限/注册资本/官网可验证：+8～15
  - 工商异常、老赖、信息缺失：扣分
- 销售可推进性 15 分
  - 有 CRM 阶段、已触达/已拜访、明确痛点或负责人：+8～15
  - 数据圈选单独无法判断 CRM 温度时，默认保守给 3～8，等待 CRM 合并校准

档位：A=80+ 优先推进；B=60–79 可进入运营池/二访培育；C<60 暂缓或只做低成本触达。

### C. 拜访策略 visit_strategy

- 一访前：用 `产品标签 + 参展历史 + 贸易目的国` 生成 3 个问题，确认目标市场、主推产品、现有获客方式。
- 一访中：不要直接卖工具；先用数据指出“参展后线索转化/海外买家分层/产品素材本地化”的缺口。
- 二访前：结合 CRM/调研表补齐预算、组织角色、历史投放、当前内容产能。
- 二访输出：1 页诊断 + 3 个增长假设 + 1 个可落地试点（例如 10 个产品短视频 / 50 个买家分组触达脚本 / 广交会后续邮件素材）。

## 2. 标准商机卡结构

```json
{
  "company": {
    "name": "企业名称",
    "tax_number": "统一社会信用代码",
    "location": "省/市/区",
    "industry": "行业",
    "products": ["产品/标签"],
    "website": "官网"
  },
  "profile": {
    "business_status": "工商状态",
    "established": "成立时间",
    "capital": "注册资本",
    "export_signals": "出口/贸易/买家数摘要",
    "exhibition_signals": "参展次数/最近展会",
    "product_signals": "产品标签/主推品类"
  },
  "opportunity_score": {
    "grade": "A/B/C",
    "score": 0,
    "reasons": [],
    "risks_or_unknowns": []
  },
  "sales_angle": {
    "likely_pain_points": [],
    "xingqing_fit": "适合/待验证/不适合",
    "first_pitch": "一句话切入",
    "recommended_assets": []
  },
  "second_visit_plan": {
    "opening": "复盘上次沟通 + 数据洞察",
    "questions": [],
    "demo_flow": [],
    "proposal_outline": [],
    "next_step": "建议动作"
  }
}
```

## 3. 二访方案模板

1. 客户一句话判断：行业 + 产品 + 市场 + 当前机会等级。
2. 数据证据：参展、贸易、产品标签、出口趋势各 1–2 条。
3. 关键假设：客户最可能卡在「展后线索转化 / 海外买家分层 / 产品内容产能 / 多语种跟进」哪一类。
4. 二访问题：
   - 今年重点市场是哪几个国家/区域？
   - 当前展会线索多久能完成第一轮跟进？
   - 主推产品是否已有英文卖点、视频、案例素材？
   - 线索分层和销售跟进脚本是谁在做？
   - 如果做 2 周试点，最想验证线索质量、内容效率还是询盘转化？
5. Demo 结构：先展示客户自己的产品/市场画像，再展示星擎如何生成分层、素材和跟进话术。
6. 试点建议：选 1 个产品线 + 1–2 个目标市场 + 20–50 条线索/买家样本，跑一轮素材和触达脚本。

## 4. 业务同学可直接使用的问法

- 查一下「江苏海狮汽车部件有限公司」的展商画像。
- 这个客户适合做星擎吗？给一个商机评分，说明加分项和风险。
- 基于这家公司数据生成二次拜访提纲。
- 帮我按「汽车零部件」找 5 个高潜展商样例。
- 帮我找「江苏省」参展次数高的展商，先给 5 个候选。
- 这个客户近年贸易活跃吗？主要产品和可能市场是什么？
- 帮我把这家客户做成一张商机卡，后面等 CRM 数据补齐。
- 查一下某个展会/会刊里的相关展商样例。

## 5. 当前接口口径注意

- 会刊/展会搜索使用 `dcExhibitionSearch`；不要再依赖 `dcJournalHisExhibition`。
- `dcTradeMap` 已下线，不进入商机评分依赖。
- 高级搜索分页上限需保守使用；不拉取全量 50 万数据，只做小样本候选筛选。
- `customer_value` 字段文档与实际返回存在口径差异：搜索结果里像数值分，筛选入参暂不作为稳定自测项，等数据中心确认。
- `trade_cnt_recent` 入参需要按文档的 object-list 结构传：例如 `[{"lower": 1, "upper": 999999}]`；单个 object 会返回非标准错误结构。
- 展会搜索对简称不一定命中，例如“广交会”未命中时应使用“中国进出口商品交易会”。
