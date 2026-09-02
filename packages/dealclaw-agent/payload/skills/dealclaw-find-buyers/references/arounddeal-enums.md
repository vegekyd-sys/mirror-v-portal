# AroundDeal 枚举速查

调 `dc_arounddeal/` 脚本时，枚举字段必须用下面的 ID（不写人话）。这是最容易写错的地方：`job_level` 不是 `CEO` 而是 `CXO`；`function` 不是 `PROCUREMENT` 而是 `PURCHASING`；`industry` 传数字 ID 不传名称；国家用 ISO2，英国是 `GB` 不是 `UK`。

## job_level（职级，11 项）

`PARTNER`=合伙人 · `OWNER`=企业主 · `CXO`=C 级高管 · `VP`=副总裁
`DIRECTOR`=总监 · `MANAGER`=经理 · `SENIOR`=资深员工 · `ENTRY`=初级员工
`ASSISTANT`=助理 · `TRAINEE`=实习/培训生 · `FREELANCER`=自由职业者

> 筛高管要带 `CXO,OWNER,PARTNER` 三个 —— 实测 Chairman and CEO 被标成 `OWNER` 而不是 `CXO`，只筛 `CXO` 会漏掉真 CEO。

## function（职能，29 项）

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

## employee_range（公司规模，9 档）

`A`=自雇 · `B`=2~10 人 · `C`=11~50 人 · `D`=51~200 人 · `E`=201~500 人
`F`=501~1000 人 · `G`=1001~5000 人 · `H`=5001~10000 人 · `I`=10000 人以上

> 字母序与规模同向：`A` 最小、`I` 最大。

## industry（行业，传数字 ID）

传**数字 ID**。19 个父类如下；145 个子类用 `xiaoyuan arounddeal list-enums --field industry --search <英文关键词>` 查。

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

## country_code / company_hq_country_code

ISO 3166-1 alpha-2 两位大写码，共 241 项。常错：英国 `GB`（不是 UK）、韩国 `KR`、阿联酋 `AE`。不确定用 `xiaoyuan arounddeal list-enums --field country_code --search <国名>`。

## company_type（出参字段，非过滤条件）

`C`=上市公司 · `D`=教育机构 · `E`=自雇 · `G`=政府机构
`N`=非营利组织 · `O`=独资经营 · `P`=私营企业 · `S`=合伙企业
