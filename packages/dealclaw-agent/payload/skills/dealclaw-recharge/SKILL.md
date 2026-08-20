---
name: "dealclaw-recharge"
description: "余额不足充值处理：识别 CDP 返回的 402 insufficient_credit 充值提示，按固定档位生成支付宝充值订单，在对话中展示支付宝二维码和链接，到账后重试原请求。"
author: ""
---

# DealClaw Recharge — 余额不足支付宝充值处理

## 目标

当买家搜索等能力因 Credit 不足被拒（CDP 内部调 sq-api reserve 返回 402 `insufficient_credit` 并透传回来）时，引导用户支付宝充值：解析余额缺口 → 按固定档位生成支付宝充值订单 → 展示支付宝二维码和链接 → 到账后重试原请求。

## 触发条件

CDP 接口返回余额不足提示，以下特征**任一命中即触发**本 skill：

- `error.code === "insufficient_credit"`
- `error.retry_after_recharge === true`
- 响应携带 `error.recharge.recharge_url` 和 `error.recharge.token`

> 注意区分：只有「余额不足」才走充值；其他错误（timeout / upstream_error / permission_denied）不走本 skill。

## 充值档位（固定，不让用户/模型自由填金额）

| 档位 | 金额 | Credit |
|---|---|---|
| 小 | 100 元 | 1 万 |
| 中 | 500 元 | 5 万 |
| 大 | 1000 元 | 10 万 |

**补差额规则**：`缺口 = required - balance`，向上取整到最近档位推荐给用户。
（例：缺口 4.5 万 → 推荐 5 万档；缺口 8000 → 推荐 1 万档。）

## 执行流程

1. **识别 + 解析**：从 402 响应取 `balance`（当前）、`required`（本次需要）、`recharge_url`（充值链接）。
2. **告知缺口**：告诉用户「当前 X Credit，本次需要 Y Credit，差 Z」，附固定档位选项（100/500/1000 元）。
3. **用户选档位**：等用户明确选择档位（如「充 100」），不替用户默认选择。
4. **生成支付宝订单 + 二维码**：调 `scripts/recharge.py` 创建支付宝充值订单并生成二维码。
5. **展示**：在对话中展示支付宝二维码 + 支付宝链接。
6. **到账确认**：用户支付后，查询订单状态（poll 到账），到账后**重试原搜索请求**。

## 强制调用方式

```bash
python3 scripts/recharge.py --api-key <KEY> --amount-yuan 100 [--channel alipay]
```

输出 JSON：`{ order_id, amount_yuan, credits_amount, qr_code, recharge_url, status }`

- `--api-key`：客户 API Key，由 agent 从账户配置读取后传入，**不落日志、不写进对话**。
- `--amount-yuan`：只接受固定档位值（100 / 500 / 1000），不接受任意金额。
- `--channel`：支付渠道，**固定 alipay（支付宝）**。

## 安全边界

- 充值金额**只用固定档位**，不自由填写、不接受模型临时编造的金额。
- 不主动替用户支付；只展示二维码/链接，支付动作由用户完成。
- 充值链接含短期签名 token，**不外泄到日志或群外**。
- 到账前**不重试原搜索**（避免重复 402、重复冻结）。

## 充值接口现状

- ✅ 已实现：`POST /v1/recharge/order`（创建充值订单，`amount_yuan` → `order_id` + `credits_amount`）。
- ⏳ 待对接：支付系统下单生成二维码（接口 A，见 `work/sq-api-两阶段计费-CDP对齐文档-20260820.md`）。
- 当前脚本在二维码未对接时，**回退返回 `recharge_url` 链接**（用户点链接充值），`qr_code` 字段置空。
