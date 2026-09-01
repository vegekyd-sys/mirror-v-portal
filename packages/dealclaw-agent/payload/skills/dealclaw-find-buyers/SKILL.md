---
name: "dealclaw-find-buyers"
description: "找买家结果自动写入企业唯一线索池；≤5条逐条气泡并附链接，>5条总结并附链接。"
author: ""
---

# DealClaw Find Buyers

## 目标

先找买家公司，再找联系人。最终展示给用户的买家公司必须先自动同步到企业唯一线索池；这是低风险内部动作，不等待二次确认。

联系人搜索、Apollo 邮箱 reveal、邮件发送属于后续动作：联系人搜索需用户确认公司或方向，Apollo reveal 和外部发送需用户确认。

## 必要输入

搜索前需要：产品/品类、目标国家、买家类型。

优先从企业画像、当前搜索画像和对话上下文读取。只有缺失项会实质改变结果时，才问一个简短问题；不要重复询问已经知道的信息。默认展示 Top 5。

## 搜索字段判断

**强制优先级：tag-keyword > profile-keyword > keyword（公司名）**

- 产品词 → **必须先用 `--tag-keyword`**。不得跳过标签直接上 profile-keyword。
- 标签无结果时，才降级为 `--profile-keyword`（公司简介匹配）。
- 公司名/品牌名 → `--keyword`。
- 产品词不能放进公司名字段。
- 采购标签只认英文。
- 一次只传一个搜索概念或完整短语，不堆多个同义词。
- 国家统一为大写 ISO2。

### 展会预注册买家

两条接口组合使用：

**1. 查展会 → `selectAllExhibition.json`**

接口地址：`POST /blade-agent-adapter/agent/buyer/selectAllExhibition.json`

请求体 `EmExhibitionListReq`：

| 参数 | 类型 | 说明 |
|------|------|------|
| `page` | int | 页码 |
| `size` | int | 每页条数 |
| `states` | int[] | 展会状态筛选。0=未发布 1=未开始 2=展前 3=展中 4=展后 5=结束 |

响应体 `SimplePage<EmExhibition>`，`records` 数组中每条的 `EmExhibition` 关键字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | **展会 ID**（传给 preExhibitionIds） |
| `name` | string | 展会英文名称 |
| `nameCn` | string | 展会中文名称 |
| `countryName` | string | 国家名称 |
| `cityId` | string | 城市 ID |
| `industries` | string | 所属行业 |
| `state` | int | 状态（同上 0-5） |
| `inshowStartDate` | string | 展会开始日期（yyyymmdd） |
| `inshowEndDate` | string | 展会结束日期（yyyymmdd） |
| `year` | string | 展会年份 |
| `period` | string | Q1/Q2/Q3 |
| `pavilion` | string | 举办场馆 |
| `organizer` | string | 举办方 |
| `location` | string | 英文地址 |
| `exhibitionType` | int | 1=线下展 2=双线展 |

调用示例：
```bash
curl -s -X POST \
  'https://<host>/blade-agent-adapter/agent/buyer/selectAllExhibition.json' \
  -H 'Content-Type: application/json' \
  -d '{"page":1,"size":20,"states":[2]}'
```

**2. 搜买家 → `preExhibitionIds` 参数**
字符串数组，传入展会 ID 限定只查该展会的预注册买家。
- 传一个或多个展会 ID，只返回这些展会的预注册买家
- 不传则不受展会限制
- 与 `--tag-keyword`、`--countries-json` 等参数可同时使用

**⚠️ 本届报名校验（必须，交付前逐条核对）**：
`preExhibitionIds` 过滤不严格，会混入报名过历届展会的买家。凡声称「本届报名/预注册买家」，交付前必须逐条核对每条返回记录的 `preExhibitionIds` 字段**确实包含目标展会 ID**；不含的剔除。不能只看接口返回的 total 就报「预注册买家 N 家」。

**⚠️ features 必须含 21（搜报名/预注册买家）**：
搜索「报名 / 预注册 / 报名参展」买家时，`--features-json` 参数**必须包含 21**。

features 枚举：
- 5 到展 · 7 提单 · 20 广交会 · **21 报名或预注册（买家有报名参展记录）** · 28 推荐自选

**⚠️ 本届/历届展会识别（用户未明确指定展会时）**：
当用户要求搜「本届 / 历届展会买家」但未明确指定是哪一场展会时：
1. **先**调 `python3 work/mio-api/company_info.py --action basic`（用当前 supplier 的 `X-Supplier-Id`）获取企业基础信息，查看 `orderRecords`（线下展订购记录）。
2. 调 `selectAllExhibition.json` 拉全量展会列表，按 `state` 区分：本届 = `state=2`（展前），历届 = `state=4`（展后）。
3. 若基础信息存在订购记录，用记录中的展会 ID 与展会列表对账，推断用户已订购/可能参与的展会。
4. 列出「本届/历届可能的展会列表」（展会 ID + 名称 + 日期），让用户选择或确认目标展会，再继续搜买家。

**⚠️ 买家结果按 features 排序**：
- `features` 含 **21（报名/预注册）**：结果买家中，属于**本届展会**（state=2）的排最前；无法确定本届时，按「展前状态展会、开展时间最近」排序。
- `features` 同时含 **5（到展）+ 21（报名/预注册）**，且目标均为**历届展会**：结果买家中，包含「历届到展 id」的买家排最前。

搜索结果为 0 时，先检查字段、语言和参数，不直接得出“该市场没有买家”。

## 数据源路由

- 目标国家有 upcoming 米奥展会 → 优先 CDP；结果不足再走 Apollo。
- 无 upcoming 展会记录 → Apollo 公司搜索优先，CDP 可补足。
- Apollo 公司搜索需要从产品推断买家行业、渠道和类型。
- Web 搜索只用于补足、歧义判断和公司验证。
- **AroundDeal 补充 Apollo**（补 Apollo 覆盖不到的公司情报 / 关联判断 / 履历 / 手机验证），脚本在 `mio-api/dc_arounddeal/`，从 `work/mio-api` 目录调用：
  - 公司画像：`python3 dc_arounddeal/enrich_company.py --linkedin-url "<url>"`（优先 linkedin_url，只传域名可能匹配到子品牌，务必核对返回的 `linkedin_identifier`）
  - 找公司采购/供应链决策人：`python3 dc_arounddeal/find_contacts.py --linkedin-url "<url>" --preset sourcing --limit 5`（`--limit` 必填、单次上限 5；`--preset brand` = 高管/品牌）
  - 搜公司 / 搜人：`python3 dc_arounddeal/search_companies.py --keyword "<kw>" --country US --size 10` / `search_people.py --title "<t>" --job-level CXO,DIRECTOR --limit 10`（单页上限 10，翻页是独立调用；超过 3 页先跟用户确认范围）
  - 公司情报：`python3 dc_arounddeal/company_intel.py --type clients|suppliers|events|products|jobs|orgchart --website "<domain>"`
  - 关联判断 / 验证：`python3 dc_arounddeal/check_relationship.py`、`verify_contact.py --email/--phone`
  - 枚举值必须用 ID（不用人话），完整枚举表见下方「AroundDeal 枚举速查」章节；不确定先 `python3 dc_arounddeal/list_enums.py --field <字段> --search <关键词>` 查
  - 需 `.env` 配 `AROUNDDEAL_API_KEY`；联系人发现/邮箱反查是消耗性动作，批量前先跟用户确认
- **Hunter 兜底邮箱**（最后一道：CDP / Apollo / AroundDeal 都没拿到邮箱时走），脚本在 `mio-api/dc_hunter/`，从 `work/mio-api` 目录调用：
  - 域名搜邮箱：`python3 dc_hunter/domain_search.py --domain "<domain>" --limit 10`（某公司全部邮箱 + 职位/部门/决策人标记）
  - 邮箱查找：`python3 dc_hunter/email_finder.py --domain "<domain>" --first-name X --last-name Y`（已知姓名找最可能邮箱，找不到不扣费）
  - 邮箱验证：仅当用户明确要求验证邮箱时，才调用 `python3 dc_hunter/email_verifier.py --email "<email>"`；不得因找到邮箱、准备展示或准备发送而自动验证
  - 需 `.env` 配 `HUNTER_API_KEY`；domain-search 免费，验证/富化按量计费
- 未实际调用的数据源，不要声称已经执行。

## AroundDeal 枚举速查（必须用 ID，不要写人话）

调 `dc_arounddeal/` 脚本时，枚举字段必须用下面的 ID。这是最容易写错的地方：`job_level` 不是 `CEO` 而是 `CXO`；`function` 不是 `PROCUREMENT` 而是 `PURCHASING`；`industry` 传数字 ID 不传名称；国家用 ISO2，英国是 `GB` 不是 `UK`。

### job_level（职级，11 项）

`PARTNER`=合伙人 · `OWNER`=企业主 · `CXO`=C 级高管 · `VP`=副总裁
`DIRECTOR`=总监 · `MANAGER`=经理 · `SENIOR`=资深员工 · `ENTRY`=初级员工
`ASSISTANT`=助理 · `TRAINEE`=实习/培训生 · `FREELANCER`=自由职业者

> 筛高管要带 `CXO,OWNER,PARTNER` 三个 —— 实测 Chairman and CEO 被标成 `OWNER` 而不是 `CXO`，只筛 `CXO` 会漏掉真 CEO。

### function（职能，29 项）

`ACCOUNTING`=会计 · `ADMINISTRATIVE`=行政 · `ARTS_DESIGN`=艺术与设计
`BD`=商务拓展 · `COMMUNITY_SOCIAL`=社区与社会服务 · `CONSULTING`=咨询
`CUSTOM`=自定义 · `EDUCATION`=教育 · `ENGINEERING`=工程技术
`FINANCE`=金融财务 · `HEALTHCARE`=医疗健康服务 · `HUMAN_RESOURCES`=人力资源
`IT`=信息技术 · `LEGAL`=法务 · `LOGISTICS_AND_SUPPLY_CHAIN`=物流与供应链
`MARKETING`=市场营销 · `MEDIA_COMMUNICATION`=媒体与传播 · `MILITARY_PROTECTIVE`=军事与安保
`OPERATIONS`=运营 · `PRODUCT_MANAGEMENT`=产品管理 · `PROGRAM_AND_PROJECT_MANAGEMENT`=项目/项目集管理
`PUBLIC_RELATIONS`=公共关系 · `PURCHASING`=采购 · `QUALITY_ASSURANCE`=质量保证
`RD`=研发 · `REAL_ESTATE`=房地产 · `RESEARCH`=研究
`SALES`=销售 · `SUPPLY_CHAIN`=供应链

> 采购场景建议 `PURCHASING,SUPPLY_CHAIN,LOGISTICS_AND_SUPPLY_CHAIN` 一起带，三者并存且语义有重叠。

### employee_range（公司规模，9 档）

`A`=自雇 · `B`=2~10 人 · `C`=11~50 人 · `D`=51~200 人 · `E`=201~500 人
`F`=501~1000 人 · `G`=1001~5000 人 · `H`=5001~10000 人 · `I`=10000 人以上

> 字母序与规模同向：`A` 最小、`I` 最大。

### industry（行业，传数字 ID）

传**数字 ID**。19 个父类如下；145 个子类用 `list_enums.py --field industry --search <英文关键词>` 查。

`2190`=Accommodation Services · `1912`=Administrative and Support Services
`48`=Construction · `91`=Consumer Services
`1999`=Education · `28`=Entertainment Providers
`201`=Farming, Ranching, Forestry · `43`=Financial Services
`75`=Government Administration · `14`=Hospitals and Health Care
`25`=Manufacturing · `332`=Oil, Gas, and Mining
`1810`=Professional Services · `1757`=Real Estate and Equipment Rental Services
`27`=Retail · `1594`=Technology, Information and Media
`116`=Transportation, Logistics, Supply Chain and Storage · `59`=Utilities
`133`=Wholesale

> ⚠️ 行业必须传数字 ID；行业词先用英文查（steel 不是「金属」），禁止猜。

### country_code / company_hq_country_code

ISO 3166-1 alpha-2 两位大写码，共 241 项。常错：英国 `GB`（不是 UK）、韩国 `KR`、阿联酋 `AE`。不确定用 `list_enums.py --field country_code --search <国名>`。

### company_type（出参字段，非过滤条件）

`C`=上市公司 · `D`=教育机构 · `E`=自雇 · `G`=政府机构
`N`=非营利组织 · `O`=独资经营 · `P`=私营企业 · `S`=合伙企业

## 执行流程

**进度播报（2-3 节点，不逐条刷）。** 搜索中报一次「在搜 X 类买家」、出结果报一次「找到 N 家」、写入线索池报一次「已入池」，中间不推。

0. **先明确目标，再规划路径（动手搜之前必做，缺一不可）**：
   - 先回答两个问题：①目标展会是什么——用户是否明确指定了具体展会（给了展会 ID / 展会名）？②口径是「本届」还是「历届」？
   - 规划路径的硬规则：
     - **用户规定了具体展会**：把本届展会 ID 和标签放进**同一次请求**同时提交——`--pre-exhibition-ids-json '["<event_id>"]'` + `--tag-keyword "<product_tag>"` + `--countries-json '["<ISO2>"]'`（以及 `--features-json '[21]'`），接口在数据源层用「展会范围 + 产品方向」一次过滤出结果，**不拆步**。**禁止**把展会 ID 留空后在结果里翻 `preExhibitionIds` 找本届；也**禁止**分两次请求（先拉展会买家、再按标签筛）——翻页有上限（可能只取到前 2000），一场 2 万买家的展会，剩下的 1.8 万在后一步就选不上了。
     - **用户只说「本届/历届」但没指定展会**：用 `selectAllExhibition.json` 确定目标展会 ID 后，同样把展会 ID 与标签放进同一次请求提交。
     - **纯产品/国家搜买家（不涉及展会）**：跳过展会过滤，直接按产品标签搜。

1. 从用户原话、企业画像和当前校准摘要提取搜索参数。
1a. **搜索前置判断产品类型（成品 vs 中间件/半成品/零部件）**：结合企业画像的 `profile.products` 和产品定位，用语义判断企业卖的是「成品消费品」还是「中间件/半成品/零部件」。这一步只判断一次，为后续同行过滤定方向。
2. 建立候选池。
3. 抽查公司名、简介、主营和采购信号，剔除明显不相关或自产自用型公司。
3a. **同行过滤（靠语义判断，不写死规则）**：结合第 1a 步的产品类型，判断买家身份是否为「制造商」：
   - **成品（消费品）场景**：目标买家是进口商/经销商/品牌商/商超。买家身份为「制造商」（自产自用/自建生产线/与买方自产线重叠）时 = 同行/竞品，不展示、不入池。同步到线索池时传 `exclude_manufacturer=True`。
   - **中间件/半成品/零部件场景**：目标买家常常就是「制造商」（买你的件去组装加工），此时制造商是目标客户，不剔。传 `exclude_manufacturer=False`（或不传）。
   判断依据：公司简介与属性里 fabricante / manufacturer / fábrica / 自有工厂 / 生产线 等信号，叠加「产品与买方自产线重叠」的语义判断；最终由模型判断，不用纯关键词命中硬顶。
4. 按公司名 + 官网域名去重；应用已确认的长期排除规则，不把单次负反馈当永久过滤器。
5. 按产品匹配、买家类型、采购可能性、渠道价值、触达可行性排序；分数只用于内部排序。
6. 将最终展示结果自动同步到企业唯一线索池，取得 `lead_pool.bitable_url`。
7. 按数量交付：
   - ≤5 条：逐条气泡展示；整批末尾附线索池链接。
   - >5 条：气泡总结；附线索池链接。
8. 用户用自然语言评价结果后，交给 `dealclaw-review` 归因并修改下一批搜索画像。
9. 用户确认公司或方向后，再搜索联系人。
10. Apollo 邮箱 reveal 前确认额度；邮件发送前再次确认。

## 强制调用方式

搜索时必须传企业和用户标识，让脚本完成去重和自动入池；尽量传企业名和群 ID：

```bash
cd skills/dealclaw-find-buyers/scripts
python3 search_aiv2.py \
  --tag-keyword "<product_tag>" \
  --countries-json '["<ISO2>"]' \
  --page-size 100

# 展会预注册买家（传展会 ID 列表）：
python3 search_aiv2.py \
  --tag-keyword "<product_tag>" \
  --countries-json '["<ISO2>"]' \
  --pre-exhibition-ids-json '["<event_id>",...]' \
  --page-size 100

# 联系人：
python3 get_cdp_contact.py \
  --company-cdp-ids-json '["<cdp_id>",...]'
```

默认会读取该企业/用户的 `current_search_profile`：国家和可映射买家类型会进入服务端搜索参数，`avoid_current` 会在本地过滤，`prefer` 会重排结果。正常请求不得使用 `--ignore-calibration`；它只用于诊断或用户明确开启了一个全新搜索任务。

脚本必须返回：

```json
{
  "records": [],
  "lead_pool": {
    "created": 0,
    "updated": 0,
    "bitable_url": "https://..."
  }
}
```

`lead_pool.status=error` 时，仍可展示搜索结果，但必须说清线索池同步失败；不能声称已入池。`--no-lead-pool` 仅限诊断，不用于正常用户请求。

发生过纠偏时，返回结果还必须包含 `calibration.plan`。缺少该字段说明画像没有真正进入搜索，先修复参数链路，不要用旧画像重跑。

## 企业线索池字段

统一字段：公司名、官网、国家、买家类型、匹配产品、推荐理由、联系人、来源、冷热、阶段。

来源：引擎搜索、星擎线索、猎采线索、米奥数据库、Apollo数据库、展会线索、用户导入。

新线索默认：冷热=❄️冷，阶段=待触达。已存在记录按公司名/官网幂等更新，不重复创建，不覆盖已有联系人成果和销售阶段。

## 输出格式

### ≤5 条

```text
1. 公司名 — 官网
关键信号：一句话
推荐理由：一句话
```

逐条展示后追加：

```text
已同步到企业线索池：<bitable_url>
```

### >5 条

```text
找到 X 家符合方向的买家，已完成筛选和去重。
企业线索池：<bitable_url>
```

气泡不内嵌表格，不使用按钮完成校准。用户直接用自然语言评价这一批。

## 自然语言反馈衔接（任何买家纠偏 → 交给 review）

只要意图识别到「买家纠偏」，无论哪种类型，都交给 `dealclaw-review`，不要片面判断纠偏类型：

- 搜索结果反馈（“这几家不对”“要品牌商不要分销商”“第2和第4家不错”）
- 产品线/画像结构纠偏（“康复辅具是拐杖不是床”“不走零售走 B2B 经销商”“这属于不同买家类型”）

执行：

- 把整句反馈连同本批结果交给 `dealclaw-review`（由它落知识库 persona + 更新搜索画像）；
- 一次用户回复只算一轮；
- 提取具体 profile patch，而不是只写“买家类型需要调整”；
- 下一轮找买家必须实际使用 review 更新后的搜索画像。

## 联系人和邮箱

**联系人优先级**（解锁时标注，发送时按规则选择）：
1. 采购经理 / Purchasing / Procurement / Sourcing / Buyer
2. 总经理 / CEO / Owner / Director
3. 产品经理 / R&D / Engineering
4. 其他职位

GS 群发全发。FD 只发 1+2（采购+总经理）。

**数据源**：
- CDP 结果有 companyCdpId → 优先用 CDP 联系人接口，不消耗 Apollo reveal 额度。
- Apollo 结果只有域名 → 先搜联系人；reveal 前确认额度。
- **兜底链**：CDP（companyCdpId）→ Apollo → AroundDeal（linkedin 找联系人）→ **Hunter**（域名搜邮箱）。前三者都没拿到邮箱时，用 Hunter `domain_search` 按域名搜邮箱兜底。**不得自动验证邮箱**；只有用户明确要求验证时，才调用 Hunter `email_verifier`。
- 不为用户未确认的公司解锁邮箱。
- 接口失败不等于没有联系人，须如实说明失败。

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次找买家完成并交付结果后，必须异步记录一条计费事件：

```bash
# 计费埋点（正式链路）：tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow 记录）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-find-buyers 1 &
```

- 必须在后台异步执行（加 `&`），不阻塞用户回复
- 失败静默，不影响主流程
- 只在结果已交付用户后才记录

## 边界

- 不编造公司、联系人、邮箱、采购事实或市场数据。
- 不输出内部评分。
- CRM 私有联系人信息不外显；公网公开信息可展示。
- 不使用未授权付费源。
- 外部发送、报价、承诺交期必须确认。
- 搜索结果交付前必须完成最小质检和企业级去重。
