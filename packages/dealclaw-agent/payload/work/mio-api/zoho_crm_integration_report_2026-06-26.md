# 米奥 Zoho CRM 只读接入报告（2026-06-26）

安全说明：refresh token、access token、client secret 不写入文件、不打印。

## 结论

Zoho CRM 只读链路已联调通过：可用 refresh token 换取 access token，并读取核心模块。

当前已封装只读 client：

- `work/mio-api/zoho_crm_client.py`

稳定运行建议把以下变量写入 env：

- `ZOHO_CRM_REFRESH_TOKEN` 或 `ZOHO_REFRESH_TOKEN`
- `ZOHO_CRM_CLIENT_ID`
- `ZOHO_CRM_CLIENT_SECRET`
- `ZOHO_ACCOUNTS_URL=https://accounts.zoho.com.cn`

## 已验证模块

- Accounts 样例客户：HTTP 200 / data_count=1
- Accounts 公司名精准搜索：HTTP 200 / data_count=1
- Contacts 样例联系人：HTTP 200 / data_count=1
- Deals 商机列表：HTTP 200 / data_count=5 / more_records=true
- Sales_Orders 合同列表：HTTP 200 / data_count=5 / more_records=true
- Events 会议/拜访记录列表：HTTP 200 / data_count=5 / more_records=true

## 已确认口径

- CRM「会议」模块 API 名称为 `Events`。
- 会议模块里的记录就是拜访记录。
- 后续“高质量拜访判断”以 Events 为主，关联 Accounts / Contacts / Deals / Sales_Orders。

## 下一步

1. 将 client id / secret / accounts url 正式写入 env，避免依赖群消息里的临时值。
2. 读取 CRM 成交/合同客户样本，提炼画像。
3. 与数据圈选平台字段映射：行业、产品、目标市场、参展、贸易、销售阶段、合同金额、拜访记录。
4. 做分布校验和样本对账后，再进入销售分级分配。
