# 米奥数据圈选 API 正式 env 接入报告（2026-06-26）

安全说明：token 仅从 env 读取，不写入文件、不打印。

## 结论

正式 env 已接通。已封装只读 client：

- `work/mio-api/miao_data_selection_client.py`

可运行：

```bash
python3 work/mio-api/miao_data_selection_client.py probe --company '江苏海狮汽车部件有限公司'
python3 work/mio-api/miao_data_selection_client.py card --company '江苏海狮汽车部件有限公司'
```

## 验证样例

测试企业：江苏海狮汽车部件有限公司  
统一社会信用代码：91321181663286492K

正式 env 验证结果：

- 展商高级搜索 `dcZohoSupplierBusinessSearch`：HTTP 200 / errCode=0 / total=1
- 工商详情 `dcDimBussinessInfo`：HTTP 200 / errCode=0 / total=1
- 贸易记录 `dcTradeRecord`：HTTP 200 / errCode=0 / total=3375
- 工商基本信息 `dcDimZohoSupplierBusinessInfo`：HTTP 200 / errCode=0 / total=1
- 出口趋势 `dcExportTrend`：HTTP 200 / errCode=0 / total=10
- 参展信息 `dcHisExhibition`：HTTP 200 / errCode=0 / total=13（国内会刊）
- 产品标签 `dcProductTagList`：HTTP 200 / errCode=0 / total=7
- 会刊/展会搜索 `dcExhibitionSearch`：HTTP 200 / errCode=0 / total=5202

## 已生成样例输出

- 正式探测摘要：`work/mio-api/formal_probe_2026-06-26.json`
- 样例商机卡：`work/mio-api/sample_opportunity_card_2026-06-26.json`

样例商机卡核心字段：

- 公司：江苏海狮汽车部件有限公司
- 省市：江苏省 / 镇江市
- 行业：工业机械
- 最近展会：2026年第139届中国进出口商品交易会
- 参展次数：38
- 官网：https://www.jiangsuhaishi.com
- 可继续拉取：工商详情、贸易记录、出口趋势、参展信息、产品标签

## 接口口径修正

- `dcJournalHisExhibition` 改走 `dcExhibitionSearch`
- `dcTradeMap` 已下线，不再依赖贸易图谱接口

## 下一步

1. 字段映射：把 API 字段映射为「客户画像 / 商机评分 / 拜访策略」字段。
2. 商机卡模板：输出 A/B/C 级评分、核心痛点、销售切入点、推荐素材/视频方向。
3. 二访方案：根据调研表 + API 数据生成二次拜访提纲。
