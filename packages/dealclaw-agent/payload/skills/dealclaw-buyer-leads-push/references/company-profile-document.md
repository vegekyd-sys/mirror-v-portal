# Generated Feishu company-profile document

This structure is distilled from the supplied reference document. Use proper Feishu heading blocks, compact two-column/four-column tables, and 11 pt-equivalent body text. Do not add images or unsupported marketing copy.

- Draft title: `企业名称｜企业画像草稿｜vN`.
- Formal title: `企业名称｜企业知识库`.
- Create the formal document as a new Docx from the confirmed snapshot. Never rename or reuse the draft token.

## Document order

1. **Title** — `企业名称 | 企业知识库`
2. **Update line** — `更新：YYYY-MM-DD | AI猎客根据当前群历史消息整理`
3. **Status notice** — every draft: `草稿｜尚未经过企业确认，不可用于AI猎客推送` plus missing/conflicted fields. Formal document: `企业确认版本：vN | 确认人：显示名 | 确认时间：...`.
4. **一、企业快照**
5. **二、AI 的判断**
6. **三、生产配置**
7. **四、市场分布**
8. **五、目标买家画像**
9. **六、物料清单**
10. **七、信息来源与待确认项**

## 一、企业快照

Create a `项目 | 内容` table in this order:

1. 公司全称
2. 成立年份
3. 企业类型
4. 办公地址
5. 工厂地址
6. 工厂规模
7. 年出口额
8. 主营产品
9. 产品类别
10. 业务模式
11. 起订量
12. 认证资质
13. 数据来源
14. 店铺/官网链接

Use `待确认` for optional slots without confirmed evidence. Include a URL only when it was explicitly shared in this group and is suitable for group-visible use. Never include personal contact data.

## 二、AI 的判断

Write three short subsections: `已确认优势`, `已确认短板`, and `建议补充`. Every sentence must map to evidence. Do not introduce comparative claims such as “行业领先” or regulatory requirements unless they were explicitly stated in the group evidence. If no supported claim exists, write `暂无可确认信息`.

## 三、生产配置

Create a `工序 | 设备/规模` table. Add only evidenced rows. If none exist, write `暂无可确认信息` instead of fabricating a default production process.

## 四、市场分布

Use three subsections:

- `现有市场` — confirmed current/past selling markets.
- `新目标市场` — only explicit development markets; this is the source of matcher `target_countries`.
- `参展计划` — event name, country/city, and date only when explicit.

Do not promote an exhibition country, customer example, or market-news country to `新目标市场` without explicit target/development intent.

## 五、目标买家画像

Create one subsection and one `字段 | 内容` table for each confirmed target country. Use these rows:

1. 买家身份
2. 目标市场
3. 采购产品
4. 采购规模
5. 决策人
6. 关键要求
7. 买家标签
8. 需求意向关键词

The matcher reads only explicit confirmed product names/categories, target countries, buyer types, MOQ, desired buyer tags, buyer-profile keywords, and intent keywords. `待确认` display values never enter matcher input.

## 六、物料清单

Create a `类型 | 文件名称 | 状态 | 用途` table. Allowed status labels are `已具备`, `待补充`, `待申请`, and `待确认`. A missing file is not the same as a confirmed missing file; use `待确认` unless the group explicitly says it is absent or needs action.

## 七、信息来源与待确认项

State the source `chat_id` fingerprint, history time range, number of messages processed, whether the range was complete, and the stop reason. Do not print the full `chat_id` or document/Base token in a normal group document.

Create a `画像字段 | 状态 | 群消息证据 | 时间` table. Each confirmed fact shows a short excerpt and timestamp. Each missing/conflicted slot shows the reason. Do not expose full message IDs; persist only the canonical evidence-manifest hash and history cursor in state.

End with:

`本画像仅依据当前飞书群内可访问的历史消息、置顶项和群内附件生成；未进行全局文档搜索或外部信息补全。`

For the formal document, append: `本正式知识库由企业授权确认人对上述草稿版本确认后生成。` Do not claim confirmation in a draft.
