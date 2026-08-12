# Group message template

## Card format

Use `message.send` with `presentation` format, `tone:"info"`. The card must include:

### Title

```
【AI猎客 - 来自{买家国家}买家的采购机会】
```

Fill `{买家国家}` with the sanitized `买家国家` value. Do not translate, append `国`, or normalize. When empty, do not include in push.

Group records by `买家国家`. If multiple countries in one batch, send a separate card per country, max 5 records total per day.

### Body

Each lead as a text block:

```
🥇 **{买家公司名称}**  ⭐{AI评分}

需求意向：{需求意向}

关注产品：{关注产品}

买家特征：{买家特征}

💡 {AI匹配理由}
```

Separate leads with `<divider>` blocks. Only show non-empty fields.

### Card footer

Always end with these two blocks:

```
{"type":"divider"}
{"type":"text","text":"📊 完整线索池：{Base URL}\n\n💬 请在线索池中标记每条线索的匹配结果（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。"}
```

### Buttons

```
{"buttons":[{"label":"📊 打开线索池","url":"{Base URL}","style":"primary"}]}
```

**CRITICAL**: Always use `tone:"info"`. `tone:"warning"` and other tones strip buttons in Feishu client. `select` blocks do not render — do not use them.

## Examples

Title: `【AI猎客 - 来自巴西买家的采购机会】`

Footer text:
```
📊 完整线索池：https://versa-ai.feishu.cn/base/ADFabV5sqauBA5sCQOOc9Wx6nqe

💬 请在线索池中标记每条线索的匹配结果（待确认/✅匹配/❌不匹配），系统将根据你的反馈优化后续推送。
```
