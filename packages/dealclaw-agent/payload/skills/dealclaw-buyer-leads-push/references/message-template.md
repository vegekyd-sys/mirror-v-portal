# Group message template

**Format: Use a Feishu card (`presentation` with `tone:"info"`) instead of plain text.** **IMPORTANT: Only `tone:"info"` renders buttons correctly. `tone:"warning"`, `tone:"success"`, and `tone:"danger"` may strip or hide buttons in the Feishu client.** The card should include:
- Title: `【AI猎客 - 来自{买家国家}买家的采购机会】`
- Body: One block per lead, separated by dividers, showing only non-empty approved fields
- **Last text block**: Always end the card body with "📊 完整线索池：{Base URL}\n\n💬 请在线索池中标记每条线索的匹配结果（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。"
- Buttons: Primary button "📊 打开线索池" linking to the Base URL

## Title

Use exactly:

```text
【AI猎客 - 来自{买家国家}买家的采购机会】
```

Fill `{买家国家}` only with the sanitized `买家国家` value copied from interface field `buyerCountry`.

Examples:

```text
【AI猎客 - 来自巴西买家的采购机会】
【AI猎客 - 来自Mexico买家的采购机会】
```

Do not translate the country, append an extra `国`, normalize its spelling, or infer it from `countryId`. When `买家国家` is empty, retain the record in the lead pool when otherwise eligible but do not include it in a group push.

Group records by identical `买家国家`. When one daily batch contains several countries, send a separate message for each country while keeping the overall daily maximum at 5 records.

## Body

Show only non-empty approved interface fields:

- 买家公司名称
- 买家国家
- 需求意向
- 关注产品
- 产品类别 （T1 - T2）
- 买家特征
- 报名参展展会
- 需求时间

Keep AI conclusions visibly separate under `AI匹配`:

- AI匹配分
- AI匹配理由
- AI风险提示, only when based on explicit profile or approved buyer fields

Do not show email, phone, WhatsApp, WeChat, direct contact data, raw interface records, `数据来源`, or `原始详情`.
