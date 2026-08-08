# 07 — Payment Service 系分

> 优先级: P4 | 部署: 中央独立 Pod | 语言: Python
> 前置依赖: Credits Ledger (P0), 支付宝商户号 (王建提供)
> 参考: alipay.trade.wap.pay（手机网站支付 2.0）

## 1. 职责边界

Payment Service 是支付与 DealClaw Agent 的解耦层。**Agent 对话中不出现支付二维码**——Agent 只返回支付链接，客户点击后跳转第三方网页收银台。

```
DealClaw Agent ──▶ POST /v1/orders             (创建订单，返回支付链接)
                 ◀── { payUrl, orderId }

客户浏览器 ──▶ 支付宝/嘉联 网页收银台           (完成支付)
支付宝服务器 ──▶ POST /v1/callback/alipay        (异步通知)
Payment Service ──▶ Credits Ledger              (更新余额)
```

## 2. API 契约

### 2.1 创建支付订单

```
POST /v1/orders
Authorization: Bearer <agent-internal-token>
Content-Type: application/json

{
  "tenantId": "cust-001",
  "accountId": "credits-cust-001",
  "productCode": "credits_pack_100k",    // 产品代码
  "amount": 10.00,                       // 金额（元）
  "quantity": 1,
  "description": "DealClaw Credits 追加包 — 10万 Credits",
  "returnUrl": "https://dealclaw.cn/payment/result"
}

Response 200:
{
  "ok": true,
  "orderId": "order_po_20260726_001",
  "payUrl": "https://openapi.alipay.com/gateway.do?...",  // 支付宝 H5 收银台
  "amount": 10.00,
  "expiresAt": "2026-07-26T13:00:00Z"     // 30分钟有效
}

Response 400:
{
  "ok": false,
  "code": "INVALID_PRODUCT",
  "message": "Unknown product code: credits_pack_xxx"
}
```

### 2.2 支付宝异步回调

```
POST /v1/callback/alipay
Content-Type: application/x-www-form-urlencoded

# 支付宝 POST 原始参数（验签用）:
out_trade_no=order_po_20260726_001
trade_no=2026072622001...
total_amount=10.00
trade_status=TRADE_SUCCESS
sign=<支付宝签名>
sign_type=RSA2
...

Response 200:
"success"    # 必须返回纯文本 "success"，否则支付宝最多重试8次
```

### 2.3 查询订单状态

```
GET /v1/orders/{orderId}

Response 200:
{
  "orderId": "order_po_20260726_001",
  "status": "paid",                    // created|paid|expired|refunded
  "amount": 10.00,
  "productCode": "credits_pack_100k",
  "paidAt": "2026-07-26T12:35:00Z",
  "creditsAdded": 100000
}
```

## 3. 产品列表

```python
PRODUCTS = {
    "credits_pack_100k": {
        "name": "10万 Credits",
        "amount_yuan": 10.00,           # ¥10
        "credits": 100_000,
    },
    "credits_pack_500k": {
        "name": "50万 Credits",
        "amount_yuan": 50.00,           # ¥50
        "credits": 500_000,
    },
    "credits_pack_1m": {
        "name": "100万 Credits",
        "amount_yuan": 100.00,          # ¥100
        "credits": 1_000_000,
    },
    "subscription_pro_annual": {
        "name": "Pro 版年费",
        "amount_yuan": 69800.00,        # ¥69,800
        "credits": 0,                   # 订阅费不含 Credits
        "renewal": "annual",
    },
}
```

## 4. 支付宝手机网站支付实现（Python）

```python
from alipay import AliPay
import os

alipay = AliPay(
    appid=os.environ["ALIPAY_APP_ID"],
    app_notify_url=f"{os.environ['PAYMENT_BASE_URL']}/v1/callback/alipay",
    app_private_key_string=os.environ["ALIPAY_PRIVATE_KEY"],
    alipay_public_key_string=os.environ["ALIPAY_PUBLIC_KEY"],
    sign_type="RSA2",
    debug=os.environ.get("ALIPAY_SANDBOX", "false") == "true",
)

def create_order(product_code: str, order_id: str, return_url: str):
    product = PRODUCTS[product_code]

    order_string = alipay.api_alipay_trade_wap_pay(
        out_trade_no=order_id,
        total_amount=str(product["amount_yuan"]),
        subject=f"DealClaw {product['name']}",
        product_code="QUICK_WAP_WAY",
        timeout_express="30m",
        quit_url=return_url,
    )

    # 返回完整支付链接
    pay_url = f"https://openapi.alipay.com/gateway.do?{order_string}"
    return pay_url
```

## 5. 回调验签与入账（时序图）

```
支付宝服务器                Payment Service              Credits Ledger
      │                          │                           │
      │ POST /v1/callback/alipay │                           │
      │ (trade_status=SUCCESS)   │                           │
      │─────────────────────────▶│                           │
      │                          │──① 验签 (RSA2+SHA256)     │
      │                          │   验证 sign 字段           │
      │                          │──② 校验 IP (支付宝官方IP段) │
      │                          │──③ 比对金额                │
      │                          │    notify.total_amount     │
      │                          │    vs 本地订单.amount      │
      │                          │──④ 查询订单状态             │
      │                          │    (幂等：已处理则直接→success)│
      │                          │                           │
      │                          │ POST /v1/accounts/.../credit│
      │                          │──────────────────────────▶│
      │                          │◀── balance updated ────────│
      │                          │                           │
      │                          │──⑤ 标记订单已支付           │
      │                          │                           │
      │◀── "success" ────────────│                           │
```

## 6. 安全设计

| 防护点 | 措施 |
|--------|------|
| 回调签名伪造 | 支付宝公钥 RSA2 验签 |
| IP 伪造 | 校验回调来源 IP 在支付宝官方 IP 段 |
| 金额篡改 | 比对 notify total_amount 与本地订单记录 |
| 重复回调 | out_trade_no 唯一索引，幂等处理 |
| 支付成功但 Credits 未更新 | 定时对账：每小时拉支付台账单 vs credits_ledger |
| 支付链接劫持 | 链接含一次性 token，5 分钟有效，单次使用 |
| 回调超时 | 支付宝最多重试 8 次（间隔 4m/10m/10m/1h/2h/6h/15h），返回 "success" 即停止 |

## 7. 数据库 Schema

```sql
CREATE TABLE payment_orders (
    id              VARCHAR(64) PRIMARY KEY,           -- order_po_20260726_001
    tenant_id       VARCHAR(64) NOT NULL,
    account_id      VARCHAR(64) NOT NULL,
    product_code    VARCHAR(32) NOT NULL,
    amount_yuan     DECIMAL(10, 2) NOT NULL,
    credits_amount  BIGINT NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'created',
                    -- created|paid|expired|refunded
    pay_url         TEXT,
    pay_url_token   VARCHAR(128) UNIQUE,              -- 一次性链接 token
    pay_url_expires TIMESTAMPTZ,                       -- 5分钟过期
    
    -- 支付宝回调信息
    alipay_trade_no VARCHAR(64),
    paid_at         TIMESTAMPTZ,
    callback_raw    JSONB,                             -- 回调原始数据（审计）
    
    credits_updated BOOLEAN DEFAULT FALSE,             -- Credits 是否已入账
    
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payment_orders_tenant ON payment_orders(tenant_id);
CREATE INDEX idx_payment_orders_status ON payment_orders(status);
CREATE UNIQUE INDEX idx_payment_orders_token ON payment_orders(pay_url_token);
CREATE UNIQUE INDEX idx_payment_orders_alipay ON payment_orders(alipay_trade_no);
```

## 8. 外部依赖

| 依赖 | 状态 | 负责人 |
|------|------|--------|
| 支付宝商户号 (APPID + 密钥) | 🔴 待王建提供 | 王建 |
| 支付宝沙箱环境 | 🟡 注册后可配 | V |
| 嘉联支付商户号 (备用) | ⚪ 后续评估 | — |
| Stripe (海外客户) | ⚪ 后续评估 | — |

## 9. 部署规格

```yaml
cpu: 200m
memory: 256Mi
replicas: 1
port: 8084

环境变量:
  ALIPAY_APP_ID: <商户 APPID>
  ALIPAY_PRIVATE_KEY: <商户私钥 (PEM)>
  ALIPAY_PUBLIC_KEY: <支付宝公钥 (PEM)>
  ALIPAY_SANDBOX: "true"     # 沙箱测试阶段
  PAYMENT_BASE_URL: https://pay.dealclaw.cn
  CREDITS_LEDGER_URL: http://credits-ledger:8081
  CREDITS_LEDGER_TOKEN: <internal>
  DATABASE_URL: postgresql://.../dealclaw_payment
```
