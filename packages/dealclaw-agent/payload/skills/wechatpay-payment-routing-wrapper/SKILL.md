---
name: "wechatpay-payment-routing-wrapper"
description: "Route Alipay payment flows vs WeChat Pay merchant integration safely."
---

# wechatpay-payment-routing-wrapper

## Purpose

Route payment-related user requests between installed payment skills without confusing two different tracks:

- `alipay-payment-skill`: consumer-side payment execution for valid Alipay cashier links, Alipay order strings, or HTTP 402 Payment-Needed responses.
- `wechatpay-payment-integration`: merchant/developer-side WeChat Pay integration guidance, product selection, official code examples, quality review, and API troubleshooting.

This wrapper must not present `wechatpay-payment-integration` as a consumer WeChat Pay payment executor. The official WeChat Pay skill has no wallet authorization, cashier-link handling, consumer QR payment, HTTP 402 handling, or personal payment status polling.

## Trigger

Use this wrapper before loading any payment skill when a request mentions payment, checkout, cashier, order payment, Alipay, WeChat Pay, 微信支付, 支付宝, 收银台, 付款码, 扫码支付, HTTP 402, Payment-Needed, cashier links, order strings, local-life ordering, food delivery payment, or payment integration.

## Required Pre-Classification

Classify the request by role and payment object before loading a downstream skill.

### Consumer Alipay Payment

Route to `alipay-payment-skill` only when at least one of these is true:

- the current user request or tool output contains a valid Alipay cashier URL, Alipay order string, or Alipay order identifier that the skill supports;
- an HTTP response returned status `402 Payment Required` or a `Payment-Needed` header;
- the user explicitly chooses Alipay for a real consumer payment and a real payment object already exists in current runtime context.

Before invoking `alipay-payment-skill`, preserve the project-level confirmation gates:

- a real payment object must exist; never fabricate or reconstruct a link, QR payload, order string, or 402 object;
- present a sanitized pre-payment summary when the surrounding workflow has not already done so;
- require explicit approval for the exact amount, payee, order/service summary, and payment method;
- keep cashier links, order strings, Payment-Needed bodies, QR payloads, credentials, cookies, and screenshots session-only.

When invoking `alipay-payment-skill`, follow its own rules exactly, including `check-wallet`, `--session-id`, `--intent-summary`, current-command output handling, and status polling behavior.

### WeChat Pay Merchant/Developer Integration

Route to `wechatpay-payment-integration` only when the user is clearly asking as a merchant, service provider, developer, or integration reviewer. Allow examples:

- product selection for a merchant/business payment scenario;
- WeChat Pay APIv2/APIv3 docs, official fields, callbacks, signatures, certificates, OpenID, request IDs, or error codes;
- JSAPI, APP, H5, Native, Mini Program, service-provider, sub_mchid, settlement, refund, split, transfer, contract deduction, or coupon integration work;
- integration quality review before launch;
- merchant-side API troubleshooting using `mchid`, `sub_mchid`, official API paths, callback payloads, signatures, certificates, or request IDs.

Before using `wechatpay-payment-integration`, verify the request is not a consumer payment. If the role is unclear, ask one clarification question: `这是商户/开发者接入问题，还是你自己的订单/付款问题？`

### Consumer WeChat Pay / Local-Life Payment

Do not route to `wechatpay-payment-integration` for consumer-side personal payment requests, even if they mention WeChat Pay terms.

Deny or redirect these cases:

- `帮我付款`, `替我付`, `代付`, `我要付款`, `用微信付`, `微信扫码付款`, `付款码`, `收款码`, `个人支付`, `线上付款`;
- food/local-life orders: `外卖`, `点餐`, `美团`, `饿了么`, `小美`, `跑腿`, `买菜`, `奶茶`, `下单`, `结账`, `订单帮我付`;
- personal QR codes, app checkout screens, mini-program checkout pages, wallet/payment-code screens, or order payment pages.

For these requests:

- if an Alipay cashier link/order string/HTTP 402 object exists and the user chooses Alipay, route to `alipay-payment-skill`;
- if the user wants WeChat Pay for a personal order, state that the current WeChat Pay skill is merchant/developer-only and cannot execute personal WeChat payments;
- if the workflow is still browsing, drafting, carting, or deciding, return to the local-life transaction state machine;
- if the payment method or payment object is unknown, ask for clarification instead of loading a downstream payment skill.

## Routing Algorithm

Use negative consumer guards before broad WeChat Pay keywords.

```python
ALIPAY_OBJECT_TERMS = [
    "cashier", "excashier", "alipay.com", "支付宝订单", "支付宝订单串",
    "402", "payment-needed", "payment required",
]

ALIPAY_METHOD_TERMS = ["支付宝", "alipay", "AI支付", "收银台"]

CONSUMER_PAYMENT_TERMS = [
    "帮我付款", "替我付", "代付", "我要付款", "个人支付", "线上付款",
    "扫码付款", "付款码", "收款码", "微信扫码", "用微信付", "付这个订单",
    "买单", "结账",
]

LOCAL_LIFE_TERMS = [
    "外卖", "点餐", "美团", "饿了么", "小美", "跑腿", "买菜", "奶茶", "下单",
]

WECHATPAY_DEV_TERMS = [
    "接入", "集成", "开发", "接口", "api", "apiv2", "apiv3", "jsapi",
    "native", "h5支付", "app支付", "小程序支付", "回调", "签名", "证书",
    "错误码", "mchid", "sub_mchid", "服务商", "特约商户", "代码",
    "上线前", "质量审查", "验签", "查单", "退款接口",
]

WECHATPAY_BROAD_TERMS = ["微信支付", "wechat pay", "微信收款", "扫码支付"]


def route_payment_request(text: str, context: dict) -> str:
    q = text.lower()

    has_alipay_object = context.get("has_alipay_payment_object", False) or any(t.lower() in q for t in ALIPAY_OBJECT_TERMS)
    mentions_alipay = any(t.lower() in q for t in ALIPAY_METHOD_TERMS)
    consumer = any(t.lower() in q for t in CONSUMER_PAYMENT_TERMS)
    local_life = any(t.lower() in q for t in LOCAL_LIFE_TERMS)
    wechat_dev = any(t.lower() in q for t in WECHATPAY_DEV_TERMS)
    wechat_broad = any(t.lower() in q for t in WECHATPAY_BROAD_TERMS)

    if has_alipay_object:
        return "route_alipay_payment_skill"

    if mentions_alipay and context.get("current_real_payment_object_exists", False):
        return "route_alipay_payment_skill"

    if (consumer or local_life) and wechat_broad and not wechat_dev:
        return "deny_wechat_consumer_payment_return_life_service"

    if wechat_broad and wechat_dev:
        return "route_wechatpay_payment_integration"

    if wechat_broad:
        return "clarify_merchant_dev_vs_personal_payment"

    if mentions_alipay and not context.get("current_real_payment_object_exists", False):
        return "clarify_or_wait_for_payment_object"

    if consumer or local_life:
        return "life_service_state_machine_or_clarify_payment_method"

    return "no_payment_skill_match"
```

## Regression Matrix

| Request | Expected route |
| --- | --- |
| `帮我付一下外卖` | local-life workflow or clarify; no WeChat Pay developer skill |
| `这个美团订单帮我用微信付` | deny WeChat consumer execution; no WeChat Pay developer skill |
| `微信扫码付款可以帮我扫吗` | deny WeChat consumer execution |
| `我要点奶茶，最后用支付宝支付` with no payment object | local-life workflow until a real payment object exists |
| Alipay cashier URL appears after checkout | `alipay-payment-skill` |
| HTTP 402 Payment-Needed returned by service | `alipay-payment-skill` |
| `我做外卖小程序，JSAPI 微信支付怎么接` | `wechatpay-payment-integration` |
| `Native 支付回调验签失败，提示 SIGN_ERROR` | `wechatpay-payment-integration` |
| `服务商模式 sub_mchid 怎么传` | `wechatpay-payment-integration` |
| `帮我审一下微信支付接入代码` | `wechatpay-payment-integration` |
| `微信支付订单查一下` | ask whether this is merchant API troubleshooting or personal payment/order issue |
| `用支付宝付这个订单` but no payment object exists | ask for/obtain real payment object; do not execute payment |

## Downstream Skill Loading Rules

1. Load at most one downstream payment skill after classification.
2. If routing to `wechatpay-payment-integration`, apply its install-time guard first: the skill description and first section must exclude consumer personal payment, QR-code payment, and food/local-life order payment.
3. If routing to `alipay-payment-skill`, follow its official payment command rules exactly and do not summarize or modify current CLI output.
4. Do not route consumer WeChat Pay requests to any payment executor until a dedicated, reviewed consumer WeChat Pay capability exists.
5. When routing is ambiguous, ask one concise clarification question and stop.

## Sensitive Data Rules

The wrapper must not write or persist:

- payment URLs, cashier links, QR payloads, order strings, HTTP 402 Payment-Needed bodies, payment codes, wallet identifiers, card/bank data, credentials, tokens, cookies, OTPs, raw screenshots, or payment page dumps;
- phone numbers, full addresses, recipient identity, address-book contents, or raw order receipts.

Durable project notes may record only sanitized metadata such as route decision, platform/provider, generic payment method, merchant/payee name if safe, amount/currency, and whether a payment object existed.

## Validation Before Approval

Before applying this proposal as a live skill, validate manually with the regression matrix above and confirm:

- consumer WeChat Pay terms do not trigger `wechatpay-payment-integration`;
- merchant/developer WeChat Pay requests still route to `wechatpay-payment-integration`;
- Alipay cashier/402 objects still route to `alipay-payment-skill`;
- ambiguous WeChat Pay order/status wording asks the merchant-vs-personal clarification question;
- no test writes payment objects or personal data into memory or project files.
