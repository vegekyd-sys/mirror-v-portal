---
name: ycloud-whatsapp
description: >-
  通过公司 WhatsApp 桥接服务收发消息、查询企业号/模板/会话，以及用 Partner Direct Link
  完成嵌入式注册；仅当用户明确说“绑定已有 WABA”时，使用当前租户机器的短时签名断言
  调用专用绑定入口。日常操作只使用当前 supplier id 与可选企业号 from，不处理 WABA 标识。
  适用于 WhatsApp、飞书客服话题、24h 窗口、模板、Direct Link 和 CDP 供应商；不用于 SMS。
---

# WhatsApp（经桥接服务）

## 核心原则

智能体只调用桥接 HTTP API。日常列号、列模板、查会话、发消息只传当前租户
`partnerCustomerId` 和可选业务号 `from`。WABA 路由由桥接在服务端动态解析；
智能体不读取、复制、缓存、展示或发送任何 WABA 标识，也不从响应中的内部字段推断路由。

唯一例外见“绑定已有 WABA”；该 ID 不得进入日常接口或后续消息。

禁止请求 `api.ycloud.com` / Meta Cloud API，禁止读取或打印 `YCLOUD_API_KEY`。

## 固定上下文

- `$BRIDGE` 固定为 `https://dealclaw.datathink.com/whatsapp`（末尾无 `/`）。
- `$SUPPLIER` = 当前智能体环境的 `MIO_CDP_SUPPLIER_ID`，也是
  `partnerCustomerId`。不要向用户询问，不要用公司名或测试字符串代替。
- `$SUPPLIER` 为空时停止，提示补齐当前智能体的 `MIO_CDP_SUPPLIER_ID`。
- 不从 `GET /health`、桥接环境或历史会话推断租户、企业号或账户路由。

## 初始化飞书应用

需要把 WhatsApp 入站同步到飞书时，读取当前智能体自己的：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_ENCRYPT_KEY`
- `FEISHU_INVITE_APP_IDS`（可选，逗号分隔的 `cli_...`）

不要打印 Secret / Encrypt Key，不要从桥接项目的 `.env` 复制。四个凭据缺任一个
就停止；不要用占位符或编造值。然后调用：

```http
POST $BRIDGE/api/feishu/apps
```

```json
{
  "appId": "$FEISHU_APP_ID",
  "appSecret": "$FEISHU_APP_SECRET",
  "verificationToken": "$FEISHU_VERIFICATION_TOKEN",
  "encryptKey": "$FEISHU_ENCRYPT_KEY",
  "inviteAppIds": "$FEISHU_INVITE_APP_IDS"
}
```

保存返回的 `appId` 为 `$FEISHU_APP`，把 `webhookUrl` 配到该飞书应用事件地址。
`hasEncryptKey=true` 才算成功；否则停止并让用户补正确的加密策略配置。

## 业务号选择

先调用：

```http
GET $BRIDGE/api/whatsapp/phones?partnerCustomerId=$SUPPLIER
```

- 只有一个可用企业号：桥接自动选择，响应给出 `defaultFrom`。
- 多个可用企业号：桥接返回
  `409 WHATSAPP_FROM_SELECTION_REQUIRED` 和安全的 `phones` 列表。用户没有明确指定
  企业号时必须请用户选择，禁止按顺序、更新时间或猜测任取一个。
- 已知业务号：重试时传
  `from=+国家码号码`。桥接会验证该号码属于当前 supplier，再在内部解析路由。
- `403 WHATSAPP_FROM_NOT_OWNED`：停止；不要改用其它租户或相似号码。
- `409 WHATSAPP_BINDING_REQUIRED`：进入“嵌入式注册”。
- `409 WHATSAPP_PHONE_REQUIRED`：提示先在 Meta / YCloud 完成企业号接入。
- `502 WHATSAPP_PHONE_LOOKUP_FAILED`：桥接暂时无法解析企业号，稍后重试；不要绕过桥接。

业务号使用 E.164。不要把业务号写成全局环境变量；每次请求按当前租户和用户选择传递。

## 发消息

### 1. 查询当前 24h 窗口

```http
GET $BRIDGE/api/whatsapp/conversations?partnerCustomerId=$SUPPLIER&phone=买家号
```

有多个企业号或用户已指定时追加 `&from=当前企业号`。窗口按“企业号 × 买家号”
计算：

- `windowOpen=true`：发送自由文本。
- `false` 或没有会话：使用已批准模板。
- 多号但没传 `from`：按“业务号选择”处理，不自行挑选。

### 2. 窗内自由文本

```http
POST $BRIDGE/api/whatsapp/messages
```

```json
{
  "partnerCustomerId": "$SUPPLIER",
  "to": "+85290000000",
  "from": "+85251111111",
  "feishuAppId": "$FEISHU_APP",
  "inviteAppIds": "$FEISHU_INVITE_APP_IDS",
  "text": "你好",
  "sourceChatId": "oc_当前飞书群",
  "sourceOpenId": "ou_当前用户"
}
```

单一企业号且用户未指定时可以省略 `from`，由桥接自动解析。多号时必须带用户选择的
`from`。

`sourceChatId` 在群聊中必填。拿得到当前 WhatsApp 客服飞书应用下的
`sourceOpenId` 就传；其它应用的 open_id 不能混用。单聊可省略二者。不要编造 ID。

### 3. 窗外模板

查询模板：

```http
GET $BRIDGE/api/whatsapp/templates?partnerCustomerId=$SUPPLIER&from=当前企业号
```

可追加 `&name=模板名`。单一企业号时可省略 `from`。

用户指定模板名就用该模板；否则按 `bodyText`、`category`、`name` 选择最贴近
意图的已批准模板。读取：

- `bodyText`
- `variableCount.body/header/urlButtons`
- `needsVariables`
- `exampleBodyValues`
- `sendComponentsDraft`

按“用户指令与对话信息 → 已知买家信息 → 正文语义 → 官方示例”的顺序补满变量。
`needsVariables=true` 时禁止空 `components`，也禁止保留
`{{1}}` / `{{header_1}}` / `{{url_suffix}}`。变量缺失不是询问用户的理由；
只有 `to` 未知或没有可用模板时才停下来问。

发送示例：

```json
{
  "partnerCustomerId": "$SUPPLIER",
  "to": "+8613800138000",
  "from": "+85251111111",
  "feishuAppId": "$FEISHU_APP",
  "inviteAppIds": "$FEISHU_INVITE_APP_IDS",
  "sourceChatId": "oc_当前飞书群",
  "sourceOpenId": "ou_当前用户",
  "template": {
    "name": "b2b_interest_check_01",
    "language": "en",
    "components": [
      {
        "type": "body",
        "parameters": [
          { "type": "text", "text": "真实变量1" },
          { "type": "text", "text": "真实变量2" }
        ]
      }
    ]
  }
}
```

`ok=true` 只表示 YCloud 已接受，不等于送达。投递失败会同步到飞书客服话题。

## 绑定已有 WABA（租户机器断言）

仅当用户明确要求“绑定已有 WABA”时进入。普通接入/注册、`WHATSAPP_BINDING_REQUIRED`、
查状态或换业务号都走 Direct Link，不主动索取 WABA ID。

1. 从该次请求取得 WABA ID；缺失时只询问该 ID，不从历史、日志、响应或其它租户复制。
2. `$SUPPLIER` 只能来自当前进程的 `MIO_CDP_SUPPLIER_ID`；不接受用户、模型或请求参数改写。
3. 使用本 Skill 的 helper。把 WABA ID 通过 stdin 传入，不作为 CLI 参数，不打印输入、请求体、
   签名或环境变量：

```bash
printf '%s' "$WABA_ID" | python3 skills/ycloud-whatsapp/scripts/bind_existing_waba.py
```

helper 从当前租户进程读取 `MIO_CDP_SUPPLIER_ID` 与统一管理的
`WHATSAPP_BRIDGE_ADMIN_TOKEN`，调用 `POST $BRIDGE/api/admin/whatsapp/import-existing-waba`；
请求仅发送当前 supplier 的 `partnerCustomerId`、本次 WABA ID 和 `Authorization: Bearer`。不打印或持久化 token。

成功输出只读取 `ok`、`partnerCustomerId`、`status`、`phones`；不要向用户回显 WABA ID。
`WHATSAPP_BRIDGE_ADMIN_TOKEN_MISSING` 表示租户 Skill 环境尚未注入统一 token，停止并报告运维修复。
YCloud 校验失败、跨租户归属或手机号冲突时停止，不改绑、不绕过 Bridge。

## 嵌入式注册 / 状态

日常接口返回 `WHATSAPP_BINDING_REQUIRED`，或用户明确要开通、注册、接入、换账户时，
使用 Partner Direct Link。智能体仍只调用桥接。

1. `GET $BRIDGE/health`，只确认 `ok=true`。
2. `GET $BRIDGE/api/whatsapp/wabas?partnerCustomerId=$SUPPLIER` 查询 onboarding/status。
   只读取 `status`、`onboardingUrl`、`expiresAt`、`paymentMethodAttached` 等状态字段；
   忽略且绝不复述任何账户标识字段。
3. 有未过期 `PENDING` 链接就复用。用户只是查状态时报告状态后结束。
4. 没有可复用链接，或用户明确新增/更换时：

```http
POST $BRIDGE/api/whatsapp/onboarding-links
```

```json
{
  "partnerCustomerId": "$SUPPLIER",
  "onboardingType": "WHATSAPP_BUSINESS_PLATFORM",
  "locale": "zh_CN",
  "sourceChatId": "oc_当前飞书群",
  "sourceOpenId": "ou_当前用户"
}
```

用户明确使用 WhatsApp Business App / SMB 时才改
`onboardingType=WHATSAPP_BUSINESS_APP`。把 `onboardingUrl` 私下交给客户，并说明
默认 2 小时有效、一链一次账户；不要发到公开群公告、文档或日志。

不要轮询 YCloud，不要在客户完成 Meta 流程前声称已绑定。Webhook 落库后再查桥接状态；
`paymentMethodAttached=true` 才表示授信完成。HTTP 429 按 `Retry-After` 等待后只重试
一次；400 的 locale/type 错误按响应修正，不让用户填写原始 JSON。

## 买家来信与飞书回复

这两条链路由桥接自动完成，skill 不调用：

- WhatsApp 入站 → `/webhooks/ycloud` → 按企业号映射 supplier → 创建/复用“WhatsApp
  客服”群话题，并按 `sourceChatId` 提醒发起群。
- 客服话题回复 → `/webhooks/feishu` → 按该会话的 supplier + 企业号在桥接内部解析
  路由并回发 WhatsApp。

人工和 `FEISHU_INVITE_APP_IDS` 白名单机器人可回发；带 @ 的内部讨论不回发。白名单
机器人若已在话题直接回复，就不要再调用 messages API，避免买家收到两遍。

## 验证与停止条件

- 所有日常请求均包含当前 `partnerCustomerId`，并且请求与响应中不处理账户标识；只有用户
  明确“绑定已有 WABA”的专用 helper 可携带一次 WABA ID 和租户机器短时断言。
- 多号未指定：必须收到/遵循 `WHATSAPP_FROM_SELECTION_REQUIRED`，不得任取。
- 指定 `from`：只接受桥接验证通过的当前租户号码。
- `WHATSAPP_TEMPLATE_REQUIRED`：自行查询模板、补齐变量后发送。
- 桥接不可用、租户缺失、号码归属错误、无绑定或无企业号时停止并报告明确原因。
- 禁止外部发送前后声称“已送达”；只报告桥接接受状态或实际 webhook 投递状态。
