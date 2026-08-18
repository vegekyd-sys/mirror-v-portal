---
name: "dealclaw-lead-import"
description: "Excel/CSV通用线索导入。解析→列映射→去重→写入企业线索池。来源标记「用户导入」。来源：田耕郡@格格"
---

# DC-Lead-Import：Excel/CSV 线索导入

> 通用线索导入能力。不绑定任何业务场景（非展会专属）。

## 触发

| 用户说 | 行为 |
|------|------|
| 上传 `.csv` / `.xlsx` 文件 | 触发导入流程 |
| 「导入线索」「导入买家」「批量导入」 | 引导用户上传文件 |

## 执行流程

```
用户上传文件
    ↓
1. 解析文件（dc_customer_import.py 或直接解析）
    ↓
2. 列映射确认 — 展示识别到的列映射给用户确认
    ↓
3. 去重 — 域名完全相同 → 以导入数据覆盖，联系人合并
    ↓
4. 确保线索池 — ensure_company_lead_pool(company_id, company_name)
    ↓
5. 写入 bitable — 按 field_map 逐条写 record，来源「用户导入」
    ↓
6. 气泡确认 — 「导入了 X 家买家，已写入线索池」+ bitable 链接
```

## 列映射

自动识别表头并映射到线索池字段：

| 用户可能使用的列名 | 映射到 |
|------|------|
| 公司名/公司名称/企业名称/客户名称/company/name | 公司名 |
| 域名/网站/网址/官网/website/domain/url | 官网 |
| 国家/国家/地区/country | 国家 |
| 买家类型/客户类型/类型/type | 买家类型 |
| 产品/成交产品/品类/product | 匹配产品 |
| 备注/说明/推荐理由/note | 推荐理由 |
| 联系人/姓名/contact | 联系人 |
| 邮箱/email | 联系人（合并到 `姓名\|职位\|邮箱`） |
| 职位/职位/title | 联系人（合并） |
| 电话/手机/phone | 联系人（合并） |

列映射展示给用户确认后再写入，允许用户修正映射。

## 去重规则

以「域名」为去重键：

- **域名完全相同** → 以用户导入数据覆盖：公司名/官网/国家/买家类型/匹配产品 用导入值替换
- **联系人合并**：导入有新联系人 → 追加到已有联系人后面（换行分隔）；导入无联系人 → 保留原有联系人
- **推荐理由**：导入有值则覆盖，无值则保留原有
- **域名不存在** → 直接新建

去重前使用 `dc_ls_store.is_duplicate()` 做跨源验证。

## 写入线索池

```bash
# 1. 确保企业线索池存在
cd work/mio-api
python3 dc_company_registry.py ensure "<company_id>" "<company_name>"
# → {"app_token": "...", "table_id": "tbl...", "field_map": {...}}

# 2. 按 field_map 写 record
# 来源列填「用户导入」
# 阶段列默认「待触达」
# 冷热列默认「❄️冷」
```

## 边界

- 缺少必填列（公司名/域名/国家）→ 提示用户补充，不编造
- 文件为空或无法解析 → 提示错误，不执行
- 弹列映射确认，不等用户确认不写入
- 导入完成后发 bitable 链接

## 计费记录（Shadow Mode — 测试期仅记录不扣费）

每次完成本技能操作并交付结果后，必须异步记录一条计费事件：

```bash
# 计费：dealclaw-billing 插件自动 detect 此命令并 estimate→settle（租户映射在 scripts/billing-config.json）
bash scripts/dealclaw-billing-record.sh --group <chat_id> dealclaw-lead-import 1 &
```

- 后台异步，不阻塞回复；失败静默
