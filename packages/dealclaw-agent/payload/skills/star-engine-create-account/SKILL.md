---
name: "star-engine-create-account"
description: "输入客户公司名→浏览器自动登入星擎后台创建企业账号"
---

# 星擎工单后台 — 自动创建企业账号 Skill

## 触发条件

用户提供客户公司名称，要求「创建企业账号」「开个后台账号」「在星擎后台创建账号」。

## Background task execution policy

This skill performs browser automation and external account creation. It is background-worthy for the execution branch, and it is also externally mutating, so user confirmation is required before creation.

When invoked from an IM/group/chat surface:

1. **Parent session is control-plane only before execution**: validate company name/account proposal, request or confirm authorization, submit a background task after confirmation, and reply quickly.
2. **Do not run the full browser account-creation workflow in the parent session.**
3. **Use OpenClaw official background task primitives**: spawn a `sessions_spawn` subagent with `mode="run"`. The run is tracked by the official background task ledger (`openclaw tasks`) and can be inspected/cancelled/audited there.
4. Default to isolated child context; fork only when the child genuinely needs current transcript context.
5. Parent session must not poll-loop waiting for browser automation. Rely on OpenClaw task completion / heartbeat wake to notify the parent session, then the parent sends the final user-visible result.
6. Child worker must write durable artifacts: proposed account, browser steps summary, screenshot/evidence path, final created/not-created status, and blockers.
7. Child worker should not message the chat directly; it returns structured results/artifact paths for the parent session to deliver.
8. Explaining the naming rule or preparing a proposed account can run synchronously; clicking save/create in the external system must be confirmed and backgrounded.

Recommended parent submission shape:

```ts
sessions_spawn({
  taskName: "star-engine-create-account-<company>-<yyyymmdd-hhmm>",
  mode: "run",
  cleanup: "keep",
  task: `
You are a Xingqing staffmis account-creation background worker.
Objective: create customer account only after explicit confirmation.
Inputs: company=<...>, account=<...>, role=<customer>, confirmed=<yes/no>
Safety: do not print admin credentials/tokens; do not modify existing accounts unless explicitly authorized.
Output contract:
- final status: completed/failed/blocked/not-created
- created account details safe for the requesting group
- screenshot/evidence path
- clear blocker and next step if failed
- do not send user-visible chat messages directly; return results for the parent session to deliver
`
})
```

## 后台信息（固定）

- URL：`https://staffmis.ultronx.tech/admin`
- 管理员账号：`admin`
- 管理员密码：`7#kR9$mQ2@vLp`

## 固定配置

- **登录密码**：所有客户统一使用 `K9#pL$2m`
- **用户角色**：所有客户统一选择「客户」

## 输入

用户提供：**客户公司全称**（如「广东振丰科教玩具有限公司」）

可选提供：登录账号（拼音缩写，如未提供则根据公司名自动生成拼音）

## 执行流程

### Step 1：打开浏览器并登录
1. `browser open` → `https://staffmis.ultronx.tech/admin`
2. 页面重定向到登录页
3. 用户名填入 `admin`，密码填入 `7#kR9$mQ2@vLp`，点击「登 录」

### Step 2：进入企业管理 → 新建
1. 点击导航栏「企业管理」
2. 点击「+ 新建企业」

### Step 3：填写表单（4字段）

| 字段 | 值 |
|------|-----|
| 登录账号 | 公司名拼音缩写（规则见下） |
| 登录密码 | **固定 `K9#pL$2m`** |
| 用户昵称 | 公司全称原文 |
| 用户角色 | **固定「客户」** |

### Step 4：保存 → 截图

点击「保存企业」，截图确认创建成功。

## 登录账号拼音生成规则

- 公司名去除非汉字字符
- 取前 4-6 个汉字转拼音首字母，全部小写
- 示例：广东振丰科教玩具 → `zhenfeng`，杭州仟源科技 → `hangzhouqianyuan`，帝拉玛工业科技 → `dilama`

## 输出

回复包含：
- 用户昵称
- 登录账号
- 登录密码：`K9#pL$2m`
- 登录地址：`https://staffmis.ultronx.tech`
- 截图确认
