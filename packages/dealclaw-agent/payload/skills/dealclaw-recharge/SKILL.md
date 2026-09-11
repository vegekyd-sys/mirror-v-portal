---
name: "dealclaw-recharge"
description: "余额不足充值处理：余额不足（402 insufficient_credit / 客户要充值）时，统一引导去企业工作台充值页（recharge?bizId=<租户ID>），不再生成订单/二维码、不再调旧充值后端。"
author: ""
---

# DealClaw Recharge — 余额不足 → 工作台充值引导

## 目标

余额不足时**统一引导客户去企业工作台充值**；不在对话里生成订单 / 二维码，不依赖任何充值后端。

## 触发条件

命中任一即触发：

- CDP 返回 `402 insufficient_credit` / `error.retry_after_recharge === true`
- 客户主动说「充值 / 我要充值 / 余额不够了」

## 执行流程

1. 取当前租户的 `bizId`：= 该 agent 的 `DEALCLAW_TENANT_ID`；或直接用 `getCreditBalance` 返回的 `rechargeUrl`。
2. 给链接：`https://xyconsole.tradechina.com/recharge?bizId=<bizId>`
3. 话术：「充值请在**企业工作台**完成：<链接>；充值到账后回来继续即可。」
4. 不再轮询、不再生成订单、不再重试（到账结果由工作台/后端回传）。

## 已废弃（不要再调用）

- ❌ `/v1/recharge/order`（旧充值后端，已下线；sq-api 充值服务不再需要）
- ❌ 固定档位（100 / 500 / 1000 元）、支付宝订单 / 二维码生成
- ❌ `scripts/recharge.py`

## 安全边界

- 只给链接，不主动替客户支付。
- 不编造档位 / 订单号 / 二维码。
- biz-id 从环境变量 `DEALCLAW_TENANT_ID` 读，不落日志。
