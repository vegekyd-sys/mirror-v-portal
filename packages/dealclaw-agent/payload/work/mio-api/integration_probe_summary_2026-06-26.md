# 米奥数据圈选 API 接入探测摘要（2026-06-26）

安全说明：token 不写入本文档。测试时发现运行环境 token 与李梦蛟上传 demo 文件中的 token 不一致；demo token 可调通核心接口。

## 已调通

测试企业：江苏海狮汽车部件有限公司
统一社会信用代码：91321181663286492K

- 展商高级搜索 `/ds/authApi/dcZohoSupplierBusinessSearch`：HTTP 200 / errCode=0 / total=1
- 工商详情-工商信息 `/ds/authApi/dcDimBussinessInfo`：HTTP 200 / errCode=0 / total=1
- 贸易数据-贸易记录 `/ds/authApi/dcTradeRecord`：HTTP 200 / errCode=0 / total=3375
- 工商详情-基本信息 `/ds/authApi/dcDimZohoSupplierBusinessInfo`：HTTP 200 / errCode=0 / total=1
- 贸易数据-出口趋势 `/ds/authApi/dcExportTrend`：HTTP 200 / errCode=0 / total=10
- 参展信息 `/ds/authApi/dcHisExhibition`：HTTP 200 / errCode=0 / 国内 total=1，国际 total=13
- 产品标签 `/ds/authApi/dcProductTagList`：HTTP 200 / errCode=0 / total=7
- 高级搜索-会刊列表 `/ds/authApi/dcExhibitionSearch`：HTTP 200 / errCode=0 / total=5202

## 已请求/需确认

- 运行环境变量里的 token 当前与 demo token 不一致，env token 调核心展商搜索返回 errCode=90000 / 获取token失败。
- 文档中的 `dcJournalHisExhibition`、`dcTradeMap` 当前 HTTP 404；需确认是否路径变更、未发布、或权限未开。
- `dcHisExhibition` 必须传 `exhibition_type`：0 国际会刊，1 国内会刊。

## 下一步

1. 更新运行环境 token 为 demo 中可用 token，或让数据中心确认正确 token。
2. 把已通接口封装成只读 client。
3. 整理字段映射：搜索字段、企业基础字段、贸易字段、参展字段、产品标签字段。
4. 基于企业画像输出商机卡和二访方案模板。

## 2026-06-26 17:15 数据中心确认

- `dcJournalHisExhibition` 改为 `dcExhibitionSearch`。
- `dcTradeMap` 已下线，后续接入不再依赖贸易图谱接口。
