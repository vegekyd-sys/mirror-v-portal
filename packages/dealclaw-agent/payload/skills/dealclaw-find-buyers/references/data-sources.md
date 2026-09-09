# 数据源命令清单（CLI 版）

路由决策与消耗性动作的确认规则见 SKILL.md，本文件只放命令与参数。

所有接口通过 `xiaoyuan` CLI 调用。鉴权用飞书身份，**全局选项必须放在子命令前面**：

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" <group> <cmd> [选项]
```

> ⚠️ **机器铁律（鉴权必须显式传，禁止靠环境变量自动读）**
> `xiaoyuan` CLI 只认 `MEO_OPEN_ID` / `MEO_SUPPLIER_ID` 环境变量，而本工程注入的是 `MIO_V_OPEN_ID` / `MIO_CDP_SUPPLIER_ID`，两者**无映射 shim**。不显式传参时 CLI 会报「缺少身份」。因此每次调用必须写成：
> `xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" <group> <cmd> [选项]`
> 不得省略 `--open-id` / `--supplier-id`，也不得改成 `--api-key` 兜底（本工程无 `MEO_API_KEY`，用了只会缺 key）。

- `--open-id` / `--supplier-id` 读自 `.env` 的 `MIO_V_OPEN_ID` / `MIO_CDP_SUPPLIER_ID`（entrypoint 已 source 进进程环境）。
- 国家参数用 `--countries`（逗号分隔，如 `US,DE`）；`--countries-json` 是旧脚本参数，CLI 不识别。
- 数组参数用**逗号分隔**（不是 JSON 数组）。
- 返回结构：`response.data`，买家列表在 `response.data.page.records`，翻页 token 在 `response.data.backendParam`。

## Apollo（采购决策人 + 邮箱解锁）

走 blade-agent-adapter 服务端（`/agent/apollo/...`），key 由服务端配置，本地无需 .env 配 key。

```bash
# 搜采购/供应链决策人（快捷入口，免费返回脱敏数据）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo search-sourcing-contacts --domain "<domain>"

# 按域名搜联系人（People Search，需 Basic+）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo search-people --domain "<domain>" --titles buyer,sourcing --seniorities director,manager

# 搜高管/品牌负责人（快捷入口）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo search-brand-contacts --domain "<domain>"

# 搜公司（关键词标签 + 国家）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo search-companies-by-keyword --keyword "<kw>" --country "<国家>"

# 解锁邮箱/电话（日常解锁 ≤50 条无感执行，不提示消耗；仅超大量拉库全量匹配才提示确认）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo enrich-person --first-name X --last-name Y --domain "<domain>" --organization-name "<org>"
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  apollo reveal-emails --contacts "first:last:domain[:org],..."
```

> 搜索返回 `hasEmail:true` 但 email 为空（脱敏）；真实邮箱需 `enrich-person`/`reveal-emails` 解锁（消耗积分），解锁后 `emailStatus=verified`。Apollo 对欧美大客户覆盖好，巴西等中小公司覆盖弱，留给 CDP/arounddeal 补。

## 核心搜索（buyer）

```bash
# 采购类目树（先定位产品所属 T1~T4 类目 id，再填进 search 的 --supplier-categories）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer all-category

# 常规产品/国家搜索（关键词）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer search --tag-keyword "<product_tag>" --countries US,DE --page-size 100

# 结构化类目搜索（比关键词精准；id 来自 all-category 树路径）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer search --supplier-categories '[{"t1TagId":"105","t2TagId":"105038"}]' --countries US,DE --page-size 100

# 展会预注册买家（展会 ID + features 21）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer search --tag-keyword "<product_tag>" --countries US \
  --pre-exhibition-ids <event_id> --features 21 --page-size 100

# 按公司名搜
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer search-by-name --company-name "<name>"

# 买家详情
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer detail --company-cdp-id <cdp_id>

# 买家联系人
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  buyer contacts --company-cdp-ids <cdp_id>

# 展会列表
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" buyer exhibitions

# 到展买家
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" buyer onsite ...
```

- 翻页扩池：`--page-num` / `--backend-param`，`--page-size 100`；`--backend-param` 传上一轮 `response.data.backendParam`。
- 搜报名/预注册买家时 `--features` 必须含 `21`。
- 类目定位优先用结构化 `--supplier-categories`（JSON 数组，`t1TagId`~`t4TagId`，id 来自 `buyer all-category` 树路径），比 `--tag-keyword` 更精准；定位不到类目时用关键词兜底。

## AroundDeal（补充 Apollo）

走 blade-agent-adapter 服务端（`/agent/arounddeal/...`），key 由服务端配置，本地无需 .env 配 key。枚举值必须用 ID，见 `references/arounddeal-enums.md`；不确定先 `list-enums` 查，不得猜。

```bash
# 公司画像（优先 linkedin-url；只传域名可能匹配到子品牌）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal enrich-company --linkedin-url "<url>"

# 找采购/供应链决策人（--preset sourcing；--limit 单次上限 5；--preset brand = 高管/品牌）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal find-contacts --linkedin-url "<url>" --preset sourcing --limit 5

# 搜公司 / 搜人（单页上限 10；超过 3 页先跟用户确认范围）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal search-companies --keyword "<kw>" --country US --size 10
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal search-people --title "<t>" --job-level CXO,DIRECTOR --limit 10

# 公司情报
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal company-intel --type clients --website "<domain>"

# 关联判断 / 验证
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" arounddeal check-relationship ...
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" arounddeal verify-contact --email <email>

# 枚举查询（不确定字段值先查）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  arounddeal list-enums --field <字段> --search <关键词>
```

> 联系人发现/邮箱反查属日常解锁动作，≤50 条无感执行、不提示消耗；仅超大量（一次性拉库全量匹配）才提示消耗并确认。

## Hunter（最后一道邮箱兜底）

走 blade-agent-adapter 服务端（`/agent/hunter/...`），key 由服务端配置，本地无需 .env 配 key。

```bash
# 域名搜邮箱（免费）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  hunter domain-search --domain "<domain>" --limit 10

# 已知姓名找最可能邮箱（找不到不扣费）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  hunter email-finder --domain "<domain>" --first-name X --last-name Y

# 邮箱验证（仅当用户明确要求验证时；不得自动验证）
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" \
  hunter email-verifier --email "<email>"
```

> domain-search 免费；验证/富化按量计费。

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次找买家交付结果后，后台异步记录一条计费事件：

```bash
# tenantId = 当前租户（按 open_id/群 chat_id 从 scripts/billing-config.json 解析；解析不到自动 shadow）
bash scripts/dealclaw-billing-record.sh <tenantId> dealclaw-find-buyers 1 &
```

- 后台异步执行（加 `&`），不阻塞用户回复。
- 失败静默，不影响主流程。
- 只在结果已交付用户后才记录。
