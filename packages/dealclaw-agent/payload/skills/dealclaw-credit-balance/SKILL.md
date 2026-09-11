---
name: "dealclaw-credit-balance"
description: "查客户 Credit 余额与用量（触发词：还剩多少 credit / 余额多少 / 查余额 / 查额度 / 用了多少 / 扣了多少）。只调 getCreditBalance.json（biz-id=DEALCLAW_TENANT_ID）查真实 Credit 余额，按账户状态决定动作：报余额、引导工作台看明细、余额低于 1000 或耗尽引导充值、未绑定/无账户引导去工作台开通、异常转客服。绝对不说人民币金额、模型成本、API 费用等机密数据。"
author: ""
---

# DealClaw Credit Balance — 余额 / 用量 / 充值引导

## 核心原则（商业化红线）

1. **按「用户意图 + 账户状态」决定动作**，不用一个笼统的「余额不足」覆盖所有场景。
2. **用词精确**：余额不足买 Credit 叫「充值」；套餐到期 / 合同到期叫「续约 / 续签」；两者不混用，避免商务承诺。
3. **只有「有账户且余额耗尽」或「余额低于阈值」才给充值链接**；「无账户 / 账户异常 / 合同制」不引导充值，转商务 / 客服。
4. **余额预警**：余额 ≤ 阈值（默认 1000）即提示客户余额不足、建议及时充值，避免影响后续任务正常执行。
5. **数据隔离红线**：绝对不允许返回、列出、汇总任何其他客户/租户的 credit 余额或消耗数据；只返回当前租户自己的余额。
6. **不输出任务级明细**：绝对不输出、不编造任何任务级消耗明细（任务类型 / 次数 / 单价 / “哪些任务最费钱”）。客户问明细时，统一兜底：「具体消耗明细请到企业工作台查看（手机号登录）」，然后给 `console_url`。
7. **充值只用租户链接**：不做固定档位、不生成支付宝订单/二维码；只给 `recharge?bizId=<租户ID>` 链接（优先用 getCreditBalance 返回的 `rechargeUrl`）。

## 触发条件

命中任一即触发：

- 查余额：「还有多少 credit / 余额多少 / 剩多少」
- 查用量：「用了多少 / 扣了多少钱 / 消耗了多少 / 账单」
- 消耗明细（**不查明细，只兜底**）：「哪些任务最费钱 / 消耗明细 / 任务明细 / 明细」→ 「具体消耗明细请到企业工作台查看（手机号登录）：`console_url`」
- 质疑扣费：「为什么扣这么多 / 从哪扣的 / 怎么扣的 / 扣费明细」
- 余额告急：「credit 不够了 / 用完了 / 没了 / 要充值」

## 执行流程

1. 调 `scripts/get_credit_balance.py`（biz-id 从 per-tenant pod 环境变量 `DEALCLAW_TENANT_ID` 自动读；阈值默认 1000，可用 `--threshold` 调整）。

1.5. 若脚本返回 `ok:false`（missing biz-id，即当前未绑定计费租户）：
     「您当前还未绑定计费账户，请先到企业工作台开通套餐：`console_url`（手机号登录），开通后即可查询余额。」
     —— 明说未绑定，不编造余额，不列出任何数据。

2. 按 `account_state` 分支回复：

   - `active`（余额 > 阈值）：
     「当前余额 X Credit，共充值 Y，已消耗 Z。详细消耗明细可去企业工作台查看（手机号登录）：`console_url`」

   - `low`（0 < 余额 ≤ 阈值，余额不足预警）：
     「您的 Credit 余额仅剩 X（已低于 1000 预警线），建议及时充值，以免影响后续使用。可点击这里充值：`recharge_url`」

   - `insufficient`（余额耗尽，balance ≤ 0）：
     「您的 Credit 已用完（余额 0）。可点击这里充值：`recharge_url`，充值后即可继续使用。」
     —— 说「充值」，不说「续费」；不承诺套餐 / 合同。

   - `no_account`（无账户 / 未开通）：
     「您当前还没有开通 Credit 账户，可以直接去企业工作台注册并充值：`console_url`（手机号登录），充值完成后会有客服联系您。」
     —— 不给充值链接（未注册账户 recharge 链接无效），引导去工作台注册充值。

   - `abnormal`（账户异常）：
     「您的账户状态异常，暂时无法查询或充值。请稍后重试，或联系客服核实账户状态。」
     —— **不给充值链接**。

3. **质疑扣费的情绪引导**（客户问「为什么扣这么多 / 从哪扣的」）：
   - 先安抚 + 解释口径：「您的消耗都是按任务结算的，每次任务的扣费都有明细记录，不是隐性扣费。」
   - 再给动作：「您可以到企业工作台查看每一笔消耗明细：`console_url`（手机号登录），按任务 / 时间逐条查看。」
   - 若余额已耗尽或低于阈值，同时给充值链接 `recharge_url`。

4. **账户类型 / 到期说明**（当前均为充值制，到期时间统一为今年 12 月 31 日，后续销售策略调整后再区分）：
   - 客户若主动提「续约 / 合同到期」，一句话兜底：「当前为充值制账户，续约请联系您的商务处理」，不引导充值。

## 强制调用方式

```bash
python3 scripts/get_credit_balance.py [--threshold 1000]
```

输出 JSON：

```json
{
  "ok": true,
  "hasAccount": true,
  "account_state": "low",
  "balance": 800,
  "totalGranted": 500000,
  "totalConsumed": 499200,
  "status": 1,
  "low_balance_threshold": 1000,
  "console_url": "https://xyconsole.tradechina.com/",
  "recharge_url": "https://xyconsole.tradechina.com/recharge?bizId=<租户ID>"
}
```

- `account_state` 取值：`active` / `low` / `insufficient` / `no_account` / `abnormal`
- `recharge_url` 在 `low` / `insufficient` 时非空；`active` / `no_account` / `abnormal` 为 `null`

## 安全边界

- **数据隔离红线（最高优先级）**：只返回当前租户自己的余额，绝对不允许列出、汇总、提及任何其他客户/租户的 credit 余额、消耗或账户信息。查询余额只能用 `get_credit_balance.py`（biz-id 从 `DEALCLAW_TENANT_ID` 读）；禁止调用 `billing.mjs all-balances`、`dealclaw-balance-check.sh` 或任何列出多租户余额的命令。
- **机密数据红线**：绝对不说人民币金额（¥）、模型成本、模型 API 费用、内部计费成本、单次调用价格等机密数据。只报产品 Credit 余额（balance / totalGranted / totalConsumed），不折算人民币、不透露成本结构。
- **不混用「充值 / 续费 / 续约 / 续签」**：余额不足只说「充值」；合同 / 套餐到期才说「续约 / 续签」。
- **只有「有账户且余额耗尽或低于阈值」才引导充值**；无账户、账户异常、合同制不引导，避免给错误入口或商务承诺。
- biz-id 从环境变量 `DEALCLAW_TENANT_ID` 读，不落日志；充值链接里的 bizId 是客户自己的租户ID，可展示。
- 余额数字如实报，接口失败（`ok:false`）明说查不到，不编造。
- 不主动替客户充值 / 续约，只给链接或转商务，支付与签约动作由客户完成。
