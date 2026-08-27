# 绑定接口对接说明

给外部系统（openclaw 等）对接「代理邮箱 → 飞书通知渠道」绑定关系用。

```
Base URL:  https://webhook.dealclaw.io          （systemd 部署，无前缀）
           https://webhook.dealclaw.io/webhook  （k8s 部署，ROUTE_PREFIX=/webhook）
认证头:    X-Admin-Token:  <向平台管理员索取>
范围头:    X-Supplier-Id:  151897148668
```

> 下文所有路径都相对 Base URL。切到 k8s 后路径统一多一层 `/webhook`
> （`/bindings` → `/webhook/bindings`），请求体、响应和两个头都不变。
> `X-Admin-Token` 迁移时会沿用原值，不需要改。

> **`X-Admin-Token` 的真值不写进本文件。** 它是生产凭据，而这些接口暴露在公网，
> 拿到它就能读出所有租户的飞书 `app_secret`。取值方式：
>
> - k8s：`kubectl -n <namespace> get secret email-webhook-secret -o jsonpath='{.data.ADMIN_TOKEN}' | base64 -d`
> - 早期 systemd 部署：`grep ^ADMIN_TOKEN= /etc/email-webhook/email-webhook.env`
>
> 该值最初由部署脚本用 `head -c 24 /dev/urandom | base64 | tr -d '/+=\n'` 生成，
> 生成后不会自动轮换。`X-Supplier-Id` 不是凭据，可以照常出现在文档和工单里。

## 两个头是配合使用的

| 头 | 作用 | 说明 |
|---|---|---|
| `X-Admin-Token` | **认证** | 证明调用方可信。全局一把，openclaw 持有 |
| `X-Supplier-Id` | **范围** | 这次操作哪一家租户的数据 |

`supplier_id` **不是凭据**，它只是范围标识——终端用户的身份由 openclaw 自己
判断，openclaw 决定把哪个 `supplier_id` 传进来。所以它可以是可读的业务 ID，
放日志、报错、工单里都没问题。

`X-Admin-Token` 固定值，重复部署 / 重启服务 / 服务器重启都不会变，可以配死。
**轮换它不影响任何已有绑定**，只影响调用本接口的人。

两个头都必须传，缺任何一个都会被拒：

| 情况 | 返回 |
|---|---|
| 两个都有 | 正常处理 |
| 只有 `X-Admin-Token` | `400` missing X-Supplier-Id |
| 只有 `X-Supplier-Id` | `401` invalid admin token |
| 都没有 | `401` |

故意不给 `X-Supplier-Id` 设默认值——漏传时静默操作到默认租户是很难查的 bug。

## 概念：agent_email 是哪个邮箱

绑定的 key 是**我方代理邮箱**（发送身份），不是买家邮箱。

| 事件类型 | agent_email 取自 | 例 |
|---|---|---|
| `email.received`（买家回信） | `data.received_for[0]` | `thia@mail.dealclaw.io` |
| 其余出站事件 | `data.from` | `thia@mail.dealclaw.io` |

地址大小写不敏感，带显示名的写法（`Thia <thia@mail.dealclaw.io>`）会自动
提取裸地址。

**一个代理邮箱只归一家租户。** 因为 Resend 推来的事件里没有任何租户信息，
只能靠邮箱地址反查绑定；同一个邮箱若归属两家，就无法判断该发给谁。别家想
占用已被绑定的邮箱会返回 `409`。

## 接口

### `GET /bindings` — 列出本租户的绑定

```json
{
  "count": 18,
  "supplier_id": "151897148668",
  "bindings": [
    {
      "agent_email": "thia@mail.dealclaw.io",
      "supplier_id": "151897148668",
      "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/…",
      "app_id": "",
      "chat_id": "",
      "prefer": "custom",
      "mention_open_id": "ou_15273b08310b914c5f97b27af680c149",
      "note": "…",
      "updated_at": "2026-08-14T05:53:49.824091+00:00",
      "webhook_secret_hint": "ctFG…4PUg",
      "app_secret_hint": "",
      "channel": "custom"
    }
  ]
}
```

**密钥不回显完整值**，只给 `*_hint` 掩码，webhook URL 也只留前缀。绑定表只写
不读——要改凭据就整条覆盖，不要指望能读回来。

`channel` 是计算出来的实际生效通道：`custom` / `app` / `none`。

运维排查可加 `?all_suppliers=true` 跨租户列全部（此时不需要 `X-Supplier-Id`）。

### `POST /bindings` — 新增或覆盖

按 `agent_email` upsert，同一个邮箱重复提交即覆盖。归属自动取
`X-Supplier-Id`，请求体里不用（也不能）指定。

```json
{
  "agent_email": "thia@mail.dealclaw.io",

  "webhook_url": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
  "webhook_secret": "验签码，机器人没开签名校验就留空",
  "mention_open_id": "ou_xxx",

  "app_id": "cli_xxx",
  "app_secret": "xxx",
  "chat_id": "oc_xxx",

  "prefer": "custom",
  "note": "备注"
}
```

只有 `agent_email` 必填，但**两组通道至少要配齐一组**：

- 自定义机器人：`webhook_url` + `mention_open_id`（`webhook_secret` 可选）
- 应用机器人：`app_id` + `app_secret` + `chat_id`

两组都配时由 `prefer` 决定走哪个（默认 `custom`）；首选那组不齐会自动回落到
另一组。

成功返回 `{"status": "saved", "operation": "created|updated", "binding": {...}}`。

### `DELETE /bindings/{agent_email}`

```json
{"status": "deleted", "agent_email": "…", "supplier_id": "151897148668"}
```

**只能删本租户的**。不属于自己的绑定一律返回 `404`（而不是 `403`）——否则可以
靠状态码差异探测别家绑了哪些邮箱。

### `POST /bindings/{agent_email}/test`

用一条假的 `email.received` 事件走完整发送链路，**会真的往群里发一张卡片**。
用来验证凭据对不对。

```json
{
  "agent_email": "…",
  "channel": "custom",
  "chat_id": null,
  "result": {"sent": true, "via": "custom_bot", "reason": "", "bound": true}
}
```

`sent: false` 时 `reason` 里有飞书返回的原始错误。常见的两个：

| 飞书码 | 含义 | 怎么修 |
|---|---|---|
| `19024` | 机器人开了「自定义关键词」，卡片不含该词被拒 | 改成签名校验，或把关键词加进卡片标题 |
| `19021` | 签名校验失败 | `webhook_secret` 配错了，重新复制 |

## 租户管理（只需 `X-Admin-Token`）

`GET /suppliers` — 列出全部租户及各自绑定数
`POST /suppliers` — 登记/更新（字段：`supplier_id` / `name` / `note`）
`DELETE /suppliers/{id}` — 删除；名下还有绑定时返回 `409`，加 `?force=true` 连带删除

租户被停用后，用它的 `X-Supplier-Id` 调任何绑定接口都返回 `403`。

## 参数速查

### 请求头

| 头 | 适用接口 | 必填 | 说明 |
|---|---|---|---|
| `X-Admin-Token` | 全部管理接口 | ✅ | 认证。缺失或错误 → `401` |
| `X-Supplier-Id` | 四个 `/bindings*` 接口 | ✅ | 租户范围。缺失 → `400`。用 `?all_suppliers=true` 时不需要 |

> ⚠️ 这两个头在 `/openapi.json` 和 `/docs` 里显示为 **optional**（代码里带了默认值），
> 但运行时是强制的。**用代码生成器从 OpenAPI 生成客户端时要手动改成必填**，
> 否则漏传会在运行时才报错。

### `POST /bindings` 请求体

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `agent_email` | string | ✅ | — | 我方代理邮箱，不是买家邮箱 |
| `webhook_url` | string | 条件 | `""` | 自定义机器人 webhook 地址 |
| `webhook_secret` | string | 可选 | `""` | 验签码；机器人没开签名校验就留空 |
| `mention_open_id` | string | **条件必填** | `""` | 卡片里 @ 的负责人；**配了 `webhook_url` 就必填**，`ou_` 开头 |
| `app_id` | string | 条件 | `""` | 应用机器人 App ID，`cli_` 开头 |
| `app_secret` | string | 条件 | `""` | 应用机器人密钥 |
| `chat_id` | string | 条件 | `""` | 目标群 ID，`oc_` 开头 |
| `prefer` | string | 可选 | `custom` | 两组都配时优先哪个：`custom` / `app` |
| `note` | string | 可选 | `""` | 备注 |

**「条件」的含义**：两组通道至少配齐一组，否则 `400`：

- 自定义机器人：`webhook_url` + `mention_open_id`
- 应用机器人：`app_id` + `app_secret` + `chat_id`

### `POST /suppliers` 请求体

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `supplier_id` | string | ✅ | 字母数字 / 下划线 / 短横，≤64 位 |
| `name` | string | 可选 | 租户名称 |
| `note` | string | 可选 | 备注 |

### 路径与查询参数

| 接口 | 参数 | 位置 | 默认 | 说明 |
|---|---|---|---|---|
| `DELETE /bindings/{agent_email}` | `agent_email` | 路径 | — | |
| `POST /bindings/{agent_email}/test` | `agent_email` | 路径 | — | |
| `GET /bindings` | `all_suppliers` | 查询 | `false` | `true` 时跨租户读全量，且不需要 `X-Supplier-Id` |
| `DELETE /suppliers/{supplier_id}` | `force` | 查询 | `false` | `true` 时连带删除该租户名下所有绑定 |

## 错误码

| 码 | 含义 |
|---|---|
| `400` | 缺 `X-Supplier-Id`、`supplier_id` 非法、`agent_email` 不是邮箱、或两组通道都没配齐 |
| `401` | `X-Admin-Token` 缺失或不匹配 |
| `403` | 该租户已停用 |
| `404` | 绑定不存在，**或不属于当前租户** |
| `409` | 该邮箱已归属其他租户 / 删租户时名下还有绑定 |
| `429` | 触发限流，**退避后重试** |
| `503` | 服务端未配置 `ADMIN_TOKEN`，管理接口整体关闭 |

## 限流

`10 次/分钟`，burst 5，超出返回 `429`。批量导入必须**串行 + 退避**，不要并发打。

限流按调用方真实 IP 计（取 `CF-Connecting-IP`），不同来源互不影响。

## 客户端示例

```python
import time
import httpx

BASE = "https://webhook.dealclaw.io"
ADMIN_TOKEN = "..."


class BindingClient:
    """一个实例对应一家租户。换租户就换 supplier_id 再建一个。"""

    def __init__(self, supplier_id, base_url=BASE, token=ADMIN_TOKEN, timeout=15.0):
        self.supplier_id = supplier_id
        self._client = httpx.Client(
            base_url=base_url,
            headers={"X-Admin-Token": token, "X-Supplier-Id": supplier_id},
            timeout=timeout,
        )

    def _request(self, method, path, **kwargs):
        """429 是限流，退避重试；其余错误直接抛。"""
        for attempt in range(4):
            response = self._client.request(method, path, **kwargs)
            if response.status_code != 429:
                response.raise_for_status()
                return response.json()
            time.sleep(2 ** attempt)
        raise RuntimeError(f"{method} {path} 持续被限流")

    def list(self):
        return self._request("GET", "/bindings")["bindings"]

    def upsert(self, agent_email, *, webhook_url="", webhook_secret="",
               mention_open_id="", app_id="", app_secret="", chat_id="",
               prefer="custom", note=""):
        return self._request("POST", "/bindings", json={
            "agent_email": agent_email,
            "webhook_url": webhook_url,
            "webhook_secret": webhook_secret,
            "mention_open_id": mention_open_id,
            "app_id": app_id,
            "app_secret": app_secret,
            "chat_id": chat_id,
            "prefer": prefer,
            "note": note,
        })["binding"]

    def delete(self, agent_email):
        return self._request("DELETE", f"/bindings/{agent_email}")

    def test(self, agent_email):
        """会真的往群里发一张测试卡片。"""
        return self._request("POST", f"/bindings/{agent_email}/test")["result"]
```

用法：

```python
client = BindingClient("151897148668")

client.upsert(
    "alex@mail.dealclaw.io",
    webhook_url="https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    webhook_secret="xxx",
    mention_open_id="ou_xxx",
    note="Alex 的线索群",
)

assert client.test("alex@mail.dealclaw.io")["sent"] is True
```

## 对接时容易踩的点

1. **两个头都要传**，漏 `X-Supplier-Id` 会 400，不会静默落到默认租户。
2. **不要试图读回完整密钥**。`GET` 返回的是掩码，要改就整条覆盖。
3. **`agent_email` 是我方邮箱，不是买家邮箱**。填错了绑定不会报错，但事件
   永远匹配不上，通知会静默回落到全局机器人。
4. **`mention_open_id` 在配 `webhook_url` 时必填**，否则 400。
5. **`test` 会真发消息**。做健康检查用 `GET /health`（不需要任何头）。
6. **限流 10 次/分钟**，批量导入串行 + 退避。
7. **一个邮箱只归一家**，抢占别家的返回 409，要处理这个提示。

## 生效验证

绑定生效后，`POST /inbound` 的响应里会带路由信息：

```json
{
  "notify": {
    "sent": true,
    "via": "custom_bot",
    "bound": true,
    "agent_email": "thia@mail.dealclaw.io"
  }
}
```

- `bound: true` — 命中了绑定
- `bound: false` — 没命中，回落到了全局兜底机器人
- `via` — `custom_bot` / `app_bot` / `none`

排查「为什么没进指定的群」时先看这两个字段。

> 注意：`sent: true` 只代表**飞书接受了这条消息**，消息进的是那个 webhook 所属
> 的群。如果业务员不在那个群里，现象仍然是「没收到通知」。

## 轮换 ADMIN_TOKEN

怀疑外泄、或人员变动时执行。**不影响任何已有绑定**——绑定表里没有这个 token，
通知链路（Resend → 本服务 → 飞书）完全不读它。轮换后只有调用本接口的人需要
更新，那 N 个已绑定的邮箱完全无感。

```bash
ssh -t root@114.55.150.21 'f=/etc/email-webhook/email-webhook.env; T=$(head -c 24 /dev/urandom | base64 | tr -d "/+=\n"); T="$T" awk "/^ADMIN_TOKEN=/{print \"ADMIN_TOKEN=\" ENVIRON[\"T\"]; next}{print}" "$f" > "$f.t" && mv "$f.t" "$f" && chown root:emailhook "$f" && chmod 640 "$f" && systemctl restart email-webhook && grep "^ADMIN_TOKEN=" "$f"'
```

命令会打印新令牌。改完记得更新本文件和各调用方的配置。
