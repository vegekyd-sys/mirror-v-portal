---
name: "qcc-company-lookup"
description: "企查查企业查询：通过 qcc CLI 查工商/风险/经营/知产/历史/董监高，支持模糊搜索自动锁定"
---

# QCC 企业查询 / Company Lookup

Use this skill when the user asks to look up a company (查公司 / 企业查询 / 背调 / 工商信息 / 股东 / 风险 / 知识产权 / 招投标), mentions a company name with intent to investigate, or asks "这个公司怎么样/靠不靠谱".

## Prerequisites

- `qcc-agent-cli` must be installed globally: `npm install -g qcc-agent-cli`
- MCP token must be configured: `qcc init --authorization "Bearer <TOKEN>"`
- Token stored in env `QCC_MCP_TOKEN` or `~/.qcc/config.json`
- Run `qcc check` to verify before first use

## Service Modules

| Module | Command | Use When |
|---|---:|---|
| company | `qcc company` | 工商登记、股东、实控人、年报、变更 |
| risk | `qcc risk` | 行政处罚、失信、被执行、破产、经营异常 |
| operation | `qcc operation` | 招投标、行政许可、信用评级、舆情 |
| ipr | `qcc ipr` | 商标、专利、软著、APP、抖音号、ICP备案 |
| history | `qcc history` | 历史沿革、曾用名、历史股东、历史风险 |
| executive | `qcc executive` | 董监高任职、个人风险、对外投资 |

## Workflow

### Step 1: Resolve company name

Never assume the exact name. Always fuzzy-search first:

```bash
qcc company get_company_by_query --json "用户输入的公司名或简称"
```

If returns `"匹配结果": "多候选"`:
- List all candidates to user
- Let user pick before proceeding
- Never auto-select the first match

If single match: proceed with the returned 统一社会信用代码.

### Step 2: Pull core profile

```bash
qcc company get_company_registration_info "企业名称或信用代码"
qcc company get_shareholder_info --searchKey "企业名称或信用代码"
```

### Step 3: Pull additional info based on user intent

| User asks | Run |
|---|---|
| 股东/股权/实控人 | `get_shareholder_info` + `get_actual_controller` |
| 风险/官司/被执行 | `risk get_administrative_penalty` + `get_case_filing_info` + `get_dishonesty_info` + `get_judicial_documents` |
| 知识产权/专利/商标 | `ipr get_trademark_info` + `ipr get_patent_info` + `ipr get_copyright_work_info` |
| 招投标/经营 | `operation get_bidding_info` + `operation get_credit_evaluation` |
| 董监高/老板背景 | `executive get_executive_case_filing` + `get_executive_controlled_companies` |
| 历史沿革/曾用名 | `history get_historical_shareholders` + `get_change_records` |
| 综合背调 | Run company + risk + operation + ipr in parallel |

### Step 4: Report

Format output as clean Markdown. Always include:
- 企业名称、信用代码、法定代表人、成立日期、注册资本（实缴）
- 股东结构
- Any red flags found (失信、被执行、经营异常、大量诉讼)

## Key rules

1. **Fuzzy first**: always run `get_company_by_query` before any other tool
2. **Multi-candidate = ask user**: never auto-pick, show all options
3. **Use --json** for machine-readable output when needed
4. **Parallelize**: pull company/risk/ipr/operation in parallel when doing comprehensive lookup
5. **Be concise**: don't dump raw JSON to user; summarize key findings
6. **Flag red**: highlight risk items (失信、被执行、经营异常、吊销) prominently
7. **Risk tools need date filters**: when user says "近三年", calculate and pass `--date_from`; when no timeframe mentioned, omit date filter for current records
