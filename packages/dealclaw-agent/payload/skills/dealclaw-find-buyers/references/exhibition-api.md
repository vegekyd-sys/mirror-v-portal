# 展会接口参考

展会预注册买家搜索用两条接口组合。判断规则（何时搜、如何确认目标展会）见 SKILL.md 阶段 A，本文件只放字段与调用细节。

## 1. 查展会 → `selectAllExhibition.json`

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
| `id` | string | 展会 ID（传给 preExhibitionIds） |
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
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" buyer exhibitions --page 1 --size 20
```

## 2. 搜买家 → `--pre-exhibition-ids` 参数

传入展会 ID 限定只查该展会的预注册买家（逗号分隔）。

- 传一个或多个展会 ID，只返回这些展会的预注册买家
- 不传则不受展会限制
- 与 `--tag-keyword`、`--countries` 等参数可同时使用

## 3. features 枚举

搜索「报名 / 预注册 / 报名参展」买家时，`--features` 参数必须包含 `21`。

- 5 到展 · 7 提单 · 20 广交会 · **21 报名或预注册（买家有报名参展记录）** · 28 推荐自选

```bash
xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" buyer search \
  --tag-keyword "<product_tag>" --countries MX --features 21 \
  --pre-exhibition-ids 152996309420 --page-size 100
```

## 4. 本届/历届展会识别流程（用户未明确指定展会时）

所有命令走 `xiaoyuan` CLI，鉴权必须显式传 `--open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID"`（CLI 认 `MEO_*`，工程注入 `MIO_*`，无映射 shim，不显式传会报「缺少身份」）。

1. 先调企业基础信息，查看 `orderRecords`（线下展订购记录）：
   ```bash
   xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" company info
   ```
2. 调展会列表拉全量展会，按 `state` 区分：本届 = `state=2`（展前），历届 = `state=4`（展后）：
   ```bash
   xiaoyuan --open-id "$MIO_V_OPEN_ID" --supplier-id "$MIO_CDP_SUPPLIER_ID" buyer exhibitions --page 1 --size 50
   ```
   > ⚠️ `buyer exhibitions` 当前仅支持 `--page` / `--size`，无 `states` 筛选参数；需在返回的 `records` 里自行按 `state` 字段区分本届/历届。
3. 若基础信息存在订购记录，用记录中的展会 ID 与展会列表对账，推断用户已订购/可能参与的展会。
4. 列出「本届/历届可能的展会列表」（展会 ID + 名称 + 日期），让用户选择或确认目标展会，再继续搜买家。

## 5. 买家结果排序规则

- `features` 含 21（报名/预注册）：属于本届展会（state=2）的排最前；无法确定本届时，按「展前状态展会、开展时间最近」排序。
- `features` 同时含 5（到展）+ 21（报名/预注册），且目标均为历届展会：包含「历届到展 id」的买家排最前。

## 6. 本届报名校验（交付前必做）

`preExhibitionIds` 过滤不严格，会混入报名过历届展会的买家。凡声称「本届报名/预注册买家」，交付前必须逐条核对每条返回记录的 `preExhibitionIds` 字段确实包含目标展会 ID；不含的剔除。不能只看接口返回的 total 就报「预注册买家 N 家」。
