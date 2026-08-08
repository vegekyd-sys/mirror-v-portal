---
name: "xingqing-lead-ingestion"
description: "星擎线索摄入：收到线索Excel→自动解析字段→识别企业partnerId→质量过滤→批量入库→汇报结果"
---

# 星擎线索摄入 Skill

> V 内部能力 | 触发：群聊收到线索 Excel | 对应后端：`business/*` API + `clue-agent.js`

## 触发条件

当本群或星擎相关群中收到 Excel/CSV 线索文件，且发送者是运营（李国琳/董力贤）、CSM、或康浩源时自动触发。

## 核心原则

V 收到线索 Excel 后自动完成：解析 → 泛用识别企业 → 字段映射 → 质量过滤 → 入库 → 汇报。每次结果一致。**不硬编码任何企业名称或 partnerId。** 所有企业信息从 `config/clue-user-mapping.json` 动态读取。

## 执行流程

### Step 1 — 解析 Excel

读取所有 sheet，识别数据结构：
- 有「已去重线索」sheet → 用它的表头，按「线索质量」列跳过"低质量/缺联系方式"
- 无此 sheet → 用第一个 sheet，按以下规则判断字段列

字段列识别规则（按优先级匹配，不区分大小写、忽略前后空格）：
```
姓名/contactName   → 姓名/Contact Name/Name/contactName
邮箱/email         → 清洗邮箱/邮箱原始值/Email/email
电话/phone         → 电话数字/手机号/Phone/phone
国家码/dialingCode → 国家码/Dialing Code/dialingCode
职位/position      → 工作岗位/职位/Title/position
```

### Step 2 — 泛用识别目标企业

从文件名提取关键词 → 动态查 `config/clue-user-mapping.json` 的 `partners` 表做 contains 匹配。

**匹配规则（按优先级）**：
1. 从文件名提取中文关键词（去掉"线索""B线索""整理""日期"等噪音词）
2. 遍历 `partners` 表的 `company` 字段，contains 匹配关键词
3. 命中 1 个 → 取该条 partnerId 和 companyName
4. 命中多个 → 取最长匹配（最精确的那个）
5. 未命中 → 尝试从 Excel sheet 名称提取关键词再匹配
6. 仍未命中 → 在群里反问"这是哪个企业的线索？"，等待确认后手动配入 mapping

**禁止**：不在 skill 中硬编码任何 `if 天易成 → partnerId=6` 或 `if 骏业 → partnerId=2` 的映射。

### Step 3 — 字段映射与质量过滤

入库需填充的字段及默认值：

| API 字段 | Excel 来源 | 缺省处理 |
|----------|-----------|---------|
| contactName | 姓名列 | 无则跳过该行 |
| email | 清洗邮箱/邮箱原始值 | 无则跳过该行 |
| phone | 电话数字 | 保留原始值 |
| dialingCode | 国家码 | 保留原始值 |
| companyName | Step 2 动态获取的企业全称 | — |
| position | 工作岗位 | 保留原始值 |
| country | 国家码→国家名动态映射 | 见下方说明 |
| interestArea | 采购意向（如有） | 空字符串 |
| requirementDesc | 来源说明 | "来自{发送者名}Excel: {文件名}" |
| status | — | 固定 "1"（原始线索） |
| source | — | 固定 "2" |
| partnerId | Step 2 动态获取 | — |
| agreedPrivacy | — | 固定 1 |

国家码→国家名映射（渐进式，运行时扩展）：
```
62→Indonesia, 63→Philippines, 60→Malaysia, 27→South Africa,
213→Algeria, 84→Vietnam, 52→Mexico, 1→USA, 44→UK, 86→China
```
遇到新国家码 → 记录到映射表，不阻塞入库。

跳过规则：
- 无姓名 或 无邮箱 → 跳过并计数
- 姓名/邮箱在库里已有（by email 在入库前用 `selectPage` 查一次已存在列表做去重预检）→ 跳过并计数"重复"

### Step 4 — 调用 API 批量入库

使用 `node scripts/clue-agent.js import <manager_open_id> '<json_array>'`

内部故障处理：
- Token 过期 → 自动 `login` 再重试
- 单条失败 → 记录失败条目，不阻塞其他
- 全部失败 → 报告并建议检查 API 连通性

### Step 5 — 汇报结果

入库完成后在群里回复结构化总结：

```
入库完成 ✅
- 企业: {companyName}
- 总解析: N 条
- 成功入库: X 条
- 跳过(低质量): Y 条
- 跳过(重复): Z 条
- 失败: W 条
国家分布: 印尼 X, 越南 Y, ...
全部为原始线索，客户侧暂不可见。CSM 验证后改状态即可透传。
```

## 边界与拒绝条件

- 文件不含任何可识别的线索数据 → 回复"未识别到线索数据，请确认文件格式"
- 无法识别企业 → 反问确认后再入库
- 不修改已入库的线索（不覆盖）
- 不处理非 Excel/CSV 格式
- 不在客户群中暴露内部信息
- **不硬编码任何企业名或 partnerId**

## 验证门

入库后至少执行一条验证：
```
node scripts/clue-agent.js summary <manager_open_id>
```
确认 total 增长与导入条数一致。

## 关联 Skill / 工具

- `clue-agent.js` — API 封装 + 权限 + 可视性过滤
- `clue-mgmt.js` — 底层 API 封装 + 登录
- `config/clue-user-mapping.json` — 企业 partnerId + 角色映射（**单一真相源**，所有企业信息从此读取）
- `lead-customer-profile` — 线索客户画像（入库后可触发，读取米奥贸易 API）
- Wiki 接口文档 — `CjXuwypHOiBs2ikfo3TcldsWnir`
