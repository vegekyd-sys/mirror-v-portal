---
name: ycloud-whatsapp
description: >-
  通过公司 WhatsApp 桥接服务收发消息，以及 Partner Direct Link 嵌入式注册开通 WABA。
  禁止直连 YCloud / Meta API，禁止读取 YCLOUD_API_KEY。买家入站由后端同步到飞书客服群话题：
  无群则自动建「WhatsApp 客服」群再拉话题，有群则只建话题。窗外发模板时智能体
  无 YCLOUD_WABA_ID 且尚未绑定 WABA 时先走嵌入式注册，禁止直接发消息。开通 WABA 时 partnerCustomerId 使用
  MIO_CDP_SUPPLIER_ID，经桥接创建 Onboarding Link。不要自己调 YCloud。适用于 WhatsApp、飞书客服、话题、模板、24h 窗口、换号、
  嵌入式注册、Direct Link、Onboarding Link、WABA、CDP 供应商。不用于 SMS。
---

# WhatsApp（经桥接服务）

智能体**只调用桥接 HTTP API**。不要 curl `api.ycloud.com`，不要读或打印 `YCLOUD_API_KEY`。

`partnerCustomerId` **就是环境变量 `MIO_CDP_SUPPLIER_ID`（CDP 供应商 ID）**。嵌入式注册整条链路都用它：不要问用户、不要用对话里的公司名、不要生成 `pc_` / `test_onboard_001`。

**发消息前必须已配置 `YCLOUD_WABA_ID`。** 从环境变量读，或看 `GET /health` 的 `wabaId` / `wabaBound`。`wabaBound=false`（没配 `YCLOUD_WABA_ID`）时，**禁止** `POST /api/whatsapp/messages`，必须先走嵌入式注册。`GET /api/whatsapp/wabas` 里旧的 `CONNECTED` **不算**当前绑定，不要因此跳过开通。不要因为请求里带了 `from`、或以前发成功过，就跳过开通。

## 基址（必读环境变量）

调用前先解析 `$BRIDGE`、`$SUPPLIER`、WABA 是否已绑定，**不要写死** `http://127.0.0.1:3000`，**不要编造** `partnerCustomerId`：

1. 读 **`WHATSAPP_BRIDGE_BASE_URL`**（当前 shell，或桥接项目根目录 `.env` / `.env.development` / `.env.shared`）。
2. 未配置时：可读同文件里的 **`PORT`**，拼成 `http://127.0.0.1:$PORT`（`PORT` 缺省按 `3000`）。
3. 读 **`MIO_CDP_SUPPLIER_ID`**（同一组 env 文件）。也可 `GET $BRIDGE/health`，用返回的 `partnerCustomerId`（以后端进程里的值为准）。
4. `$SUPPLIER` 仍为空则停，提示在桥接项目 `.env.development`（或对应环境文件）补上 `MIO_CDP_SUPPLIER_ID`。
5. `$BRIDGE` 仍不确定则停，提示补上 `WHATSAPP_BRIDGE_BASE_URL`。
6. 看 **`YCLOUD_WABA_ID`** 是否已配置，或 `GET $BRIDGE/health` 的 `wabaBound` / `wabaId`。`wabaBound=false`（未配 `YCLOUD_WABA_ID`）→ 先做嵌入式注册，**不要发消息**。库里有旧 `CONNECTED` 也不算已绑定。

后端自己用 `PORT` 监听；智能体只用 `WHATSAPP_BRIDGE_BASE_URL`（或上面的回退）当 HTTP 基址。  
`$BRIDGE` 去掉末尾 `/`。服务未启动则先停，提示启动后端。

```text
进度：
- [ ] 解析 $BRIDGE（WHATSAPP_BRIDGE_BASE_URL）
- [ ] 解析 $SUPPLIER（MIO_CDP_SUPPLIER_ID / GET /health 的 partnerCustomerId）
- [ ] GET $BRIDGE/health
- [ ] 无 WABA（health.wabaBound=false）→ 嵌入式注册；成功后后端会写入 YCLOUD_WABA_ID / YCLOUD_FROM，再 GET /health
- [ ] GET $BRIDGE/api/whatsapp/phones（只要 current / defaultFrom，from 必须是当前 WABA 企业号）
- [ ] 查窗口：GET $BRIDGE/api/whatsapp/conversations?phone=买家号&from=当前企业号
- [ ] 窗内（windowOpen=true）：POST text，from=当前企业号
- [ ] 窗外（windowOpen=false）：GET templates → 回填 → POST template，from=当前企业号
```

## 发消息（WABA + 企业号 + 24h 窗口）

每次发 WhatsApp **按此顺序**，不要跳过：

1. `GET $BRIDGE/health`。`wabaBound=false` 或 `409 WHATSAPP_WABA_REQUIRED` → 嵌入式注册，**禁止**发消息。
2. 绑定成功后智能体**不要自己改 .env**。后端会在 Webhook `PARTNER_ADDED` 时写入 `YCLOUD_WABA_ID` 和当前 WABA 下的 `YCLOUD_FROM`。再 `GET /health` 确认 `wabaId` / `from`。
3. `GET $BRIDGE/api/whatsapp/phones`（当前 WABA）。`from` **必须**是返回列表里的号码（优先 `defaultFrom` / `current=true`）。禁止用其它 WABA 或过期环境号。`409 WHATSAPP_FROM_NOT_IN_WABA` 时改用列表里的号再发。
4. `GET $BRIDGE/api/whatsapp/conversations?phone=买家号&from=当前企业号`，看这对账号的 `windowOpen`：
   - `true`：发自由文本（`text`），不要无故改模板。
   - `false` / 无会话：走下面「窗外」模板流程。
5. `POST /api/whatsapp/messages` 始终带 `from`（当前 WABA 企业号）和 `to`（买家）。

24h 窗口是 **当前 WABA 企业号 × 买家号** 这一对会话，不是「这个买家曾经给任意企业号来过信」。换号后要重新查窗口。

## 窗外 / 主动触达（必按此流程，否则走不通）

窗口外**禁止**发 `text`。收到 `409 WHATSAPP_TEMPLATE_REQUIRED` 或 `windowOpen=false` 时，智能体**自己做完选模板、回填、发送**，不要停下来问用户「{{1}} 填什么」。

收到 `409 WHATSAPP_WABA_REQUIRED` 或 `health.wabaBound=false`：改走嵌入式注册，**不要继续发消息**。

1. `GET $BRIDGE/api/whatsapp/templates`（或 `?name=某模板`；新绑的 WABA 加 `?wabaId=`）
2. 选模板：用户指定了名字就用那个；否则按意图选最接近的已批准模板（看 `bodyText` / `category` / `name`）。只列模板、等用户挑 = 未完成任务。
3. 读这些字段再回填，**不要猜变量个数**：
   - `bodyText`：正文（含 `{{1}}` `{{2}}`），用来理解每个槽位语义
   - `variableCount.body` / `header` / `urlButtons`
   - `needsVariables`：是否必须带 `components`
   - `exampleBodyValues`：官方示例，作缺省回填
   - `sendComponentsDraft`：骨架；把占位换成真实值后作为 `template.components`
4. **自主回填**（按此优先级，填满所有槽位后立刻发）：
   1. 当前用户指令、对话里已给出的姓名/公司/展会/时间/链接等
   2. 已知买家信息（号码、会话、飞书话题上下文）
   3. `bodyText` 语义推断出的合理业务值
   4. 仍缺则用 `exampleBodyValues` / `sendComponentsDraft` 里的示例值
5. `needsVariables=true` 时**禁止**空 `components: []`，**禁止**把 `{{1}}` / `{{header_1}}` / `{{url_suffix}}` 原样发出。
6. 立刻 `POST $BRIDGE/api/whatsapp/messages` 带完整 template。发完用一句话告诉用户用了哪个模板、填了什么，不要先展示草稿等确认。

无变量模板（`needsVariables=false`）才允许 `components: []` 或不传。

只有收件人 `to` 未知、或列表里没有任何可用模板时，才停下来问。变量缺失不是停下来的理由。

## 嵌入式注册 / 开通 WABA（Partner Direct Link）

**无 WABA 时发消息也会走这里**，不只是用户口头说「开通」。`YCLOUD_WABA_ID` 未配置（`GET /health` 的 `wabaBound=false`）时，智能体**自己创建链接并交给客户**，不要问用户每个字段，也不要先去发 WhatsApp。不要因为 `GET /wabas` 有旧 `CONNECTED` 就当成当前已绑定。

用户要**开通 / 注册 / 接入 / 连接 WhatsApp WABA**、提到 Direct Link / 嵌入式注册 / Onboarding Link 时同样走此流程。

前提（后端已配置，智能体不要读密钥、不要替用户配 Dashboard）：

- YCloud 已开通 Partner Direct Link；Webhook 已订阅 `whatsapp.business_account.updated`
- 创建链接**只能经桥接**。SDK Button 若需要，也是前端调**你们自己的后端/本桥接**拿 `onboardingUrl`，禁止在浏览器调 YCloud

### 流程

1. `GET $BRIDGE/health`（确认 `ok`；若返回 `partnerCustomerId` 则作为 `$SUPPLIER`）
2. `$SUPPLIER` 必须已解析。禁止向用户要 partnerCustomerId，禁止用其它字符串代替。
3. 先 `GET $BRIDGE/api/whatsapp/wabas?partnerCustomerId=$SUPPLIER`（也可省略 query，桥接会默认用 `MIO_CDP_SUPPLIER_ID`）：
   - 已有 `status=PENDING` 且返回了 `onboardingUrl`（未过期）→ **复用**，不要再 POST
   - 已 `CONNECTED` 且用户只是查状态 → 报告 WABA / 授信，结束
   - 已 `CONNECTED` 但用户要**新增或更换 WABA** → 再 POST 新链接
   - 没有可用链接 → POST
4. `POST $BRIDGE/api/whatsapp/onboarding-links`

```json
{
  "partnerCustomerId": "$SUPPLIER",
  "onboardingType": "WHATSAPP_BUSINESS_PLATFORM",
  "locale": "zh_CN",
  "sourceChatId": "oc_当前飞书群",
  "sourceOpenId": "ou_当前用户"
}
```

`partnerCustomerId` 必须是 `$SUPPLIER`。不传时桥接也会用 `MIO_CDP_SUPPLIER_ID` 回填；**已配置时请求里的其它 ID 会被忽略**。

- `onboardingType` 默认 `WHATSAPP_BUSINESS_PLATFORM`（API WABA）。用户明确要 WhatsApp Business App / SMB 时才用 `WHATSAPP_BUSINESS_APP`。
- `locale`：中文对话用 `zh_CN`，否则 `en_US`。只允许 `en_US` `zh_CN` `es_ES` `pt_BR` `id_ID` `ru_RU`（区分大小写）。
- `sourceChatId` / `sourceOpenId`：与发消息相同；绑定成功时飞书提醒用。群聊尽量带上。
5. 立刻把 `onboardingUrl` 交给**该客户**（可点开的链接），并说明：
   - 打开链接 → **Continue with Meta** → 选择或创建业务、WABA、号码
   - 默认 **2 小时**有效；**一链一次 WABA**；完成前可刷新重试，不必新建
   - **不要**发到公开群公告、文档、分析平台
6. 不要轮询 YCloud、不要声称已经绑定成功。告诉用户：完成 Meta 后桥接会收 Webhook；`CONNECTED` 后后端会把 `YCLOUD_WABA_ID` / `YCLOUD_FROM` 写入环境变量。之后 `GET $BRIDGE/health` 应有 `wabaBound=true`，并用 `GET $BRIDGE/api/whatsapp/wabas?partnerCustomerId=$SUPPLIER` 看 `wabaId` / `paymentMethodAttached`。
7. `paymentMethodAttached=true` 才表示授信完成、WABA 可正常用；`false` 说明授信未完成。
8. 发消息、列号、列模板都用当前 WABA，不要沿用旧环境号。列模板可传 `?wabaId=`。
9. HTTP **429**：读 `retryAfter` / `Retry-After`，等完再 POST **一次**；仍失败再告诉用户稍后再试。
10. HTTP **400**（locale / type 错误）：按响应改参数后重试，不要把原始 JSON 丢给用户填。

智能体走 Direct Link 即可（把 URL 给客户）。不要在对话里贴带真实 Key 的 curl，不要教用户把 API Key 放进网页。

## 接口

### 探活

`GET $BRIDGE/health` → `{"ok":true,"partnerCustomerId":"...","wabaId":"...","wabaBound":true|false,"from":"+852..."}`  
`partnerCustomerId` 即 `MIO_CDP_SUPPLIER_ID`。`wabaBound` 只表示当前环境变量是否有 `YCLOUD_WABA_ID`。`false` 必须先嵌入式注册。`from` 为当前配置的默认企业号。

### 查会话窗口

`GET $BRIDGE/api/whatsapp/conversations?phone=买家号&from=当前企业号`

必须带当前 WABA 的 `from`，看这对账号的 `windowOpen` / `windowExpiresAt`。买家来信由后端 webhook 写入，智能体不要轮询 YCloud。

### 发消息

`POST $BRIDGE/api/whatsapp/messages`

窗内自由文本：

```json
{ "to": "+85290000000", "from": "+85251111111", "text": "你好", "sourceChatId": "oc_当前飞书群", "sourceOpenId": "ou_当前用户" }
```

`from` **必须是当前 WABA 企业号**（`GET /phones` 的 `defaultFrom` / `current=true`）。不传时后端会用当前 WABA 默认号；传入其它 WABA 的号会 `409 WHATSAPP_FROM_NOT_IN_WABA`。

**`sourceChatId`（群聊必填）**：当前飞书会话的群 `chat_id`。买家回复时尽量提醒该群。

**`sourceOpenId`**：必须是 **WhatsApp 客服这个飞书应用** 下的用户 `open_id`。元海精灵等其它应用的 `open_id` 不能用（会 `open_id cross app`，桥接无法私聊）。拿不到本应用的 open_id 就省略，买家消息仍会进客服话题。

后端会先对 `sourceChatId` 调 `me_join` 尝试自动进群；仅**公开群**能成功。「WA功能开发」这类私有/外部群无法 API 自助加入，靠 `sourceOpenId` 私聊兜底（或把群改为公开后再试群提醒）。

单聊可省略二者。不要编造 ID。

窗外 / 主动触达示例（有 body 变量时）：

```json
{
  "to": "+8613800138000",
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

- `to` 必填，E.164。
- `accepted` / `ok:true` 只表示后端已提交给 YCloud，**不等于已送达**。投递失败时飞书客服话题会跟「系统：WhatsApp 发送失败」。
- 409 + `code=WHATSAPP_TEMPLATE_REQUIRED`：窗外，智能体改走模板流程并**自行回填后发送**。
- 409 + `code=WHATSAPP_WABA_REQUIRED`：尚未绑定 WABA。改走嵌入式注册，禁止再 POST messages。
- 409 + `code=WHATSAPP_FROM_NOT_IN_WABA`：`from` 不是当前 WABA 号码。改用 `GET /phones` 里的号。

### 列企业号

`GET $BRIDGE/api/whatsapp/phones`  
返回 `wabaId`、`defaultFrom`、`phones[]`（含 `current`）。发送时 `from` 只用这个列表里的号。

### 列已批准模板（含变量结构）

`GET $BRIDGE/api/whatsapp/templates`  
可选：`GET $BRIDGE/api/whatsapp/templates?name=b2b_interest_check_01`  
新绑 WABA 加 `?wabaId=`。

按当前 WABA 列出已批准模板（`filter.wabaId`）。`wabaId` 来源：`?wabaId=` → 环境变量 `YCLOUD_WABA_ID`。未配置则 400，不会用库里旧 `CONNECTED`。返回每项至少含：`name`、`language`、`bodyText`、`variableCount`、`needsVariables`、`exampleBodyValues`、`sendComponentsDraft`。  
发模板时以这些字段为准，不要猜变量个数，不要默认空 `components`。智能体用这些字段自己回填，不要把原始 JSON 甩给用户填。

### 创建 Onboarding Link

`POST $BRIDGE/api/whatsapp/onboarding-links`

`partnerCustomerId` 用 `$SUPPLIER`。未传时后端用 `MIO_CDP_SUPPLIER_ID`。成功返回 `onboardingUrl`、`expiresAt`、`partnerCustomerId`、`partnerCustomerIdSource`、`status=PENDING`。把链接交给客户即可。未配置 `MIO_CDP_SUPPLIER_ID` 会 400。

### 查询 WABA 绑定

`GET $BRIDGE/api/whatsapp/wabas`  
可选 `?partnerCustomerId=` `?wabaId=` `?status=PENDING|CONNECTED`

未传 `partnerCustomerId` 时后端默认按 `MIO_CDP_SUPPLIER_ID` 过滤。智能体查询时仍应带 `?partnerCustomerId=$SUPPLIER`。未过期的 PENDING 才会带 `onboardingUrl`。`CONNECTED` 后看 `wabaId` / `paymentMethodAttached`。智能体不要轮询 YCloud，只查本接口。

## 买家来信（后端自动做，skill 不调）

买家 WhatsApp → 后端 `/webhooks/ycloud`：

- 无客服群 → 创建「WhatsApp 客服」群 → 为该买家拉话题
- 已有客服群 → 只创建/复用话题
- 若会话有 `sourceChatId`（智能体发消息时传入）→ 再往发起群发摘要/转发话题提醒

客户完成嵌入式注册 → 同一 webhook 收到 `whatsapp.business_account.updated`（`updateEvent=PARTNER_ADDED`）→ 桥接落库并尽量通知发起群 / 客服群。智能体不必订阅 YCloud。

客服在「WhatsApp 客服」话题回复 → `/webhooks/feishu` → WhatsApp。提醒群里直接回不会进 WhatsApp。智能体不必参与这条入站链路。

话题里**只有人工**，以及 `FEISHU_INVITE_APP_IDS` 里的机器人/智能体，发言才会同步到 WhatsApp。桥接自己和其它未授权应用忽略。带 @ 的内部商量仍不同步。

白名单机器人若在话题里直接回复买家，内容会按飞书原文转发；同一条不要再 `POST /api/whatsapp/messages`，否则买家会收到两遍。智能体走 HTTP 时，桥接不会再以「WhatsApp 客服」身份把正文复述进话题。

## 禁止

- 任何 `api.ycloud.com` 或 Meta Cloud API 请求（含 `partner/embeddedSignup/links`）
- 读取或打印 API Key；把 Key 放进前端 / SDK 示例
- 把 `onboardingUrl` 发到公开页面、群公告或日志
- 未完成 Meta 流程就声称 WABA 已绑定 / 已授信
- 轮询 YCloud 查绑定；有未过期 PENDING 链接还反复 POST
- 窗口外发 text
- 有变量模板却用空 `components: []` 发送
- 窗外停下来问用户每个 `{{n}}` 填什么；只列模板等用户挑/确认
- 编造模板名 / 变量个数；编造送达成功
- 无 WABA（`wabaBound=false` / `WHATSAPP_WABA_REQUIRED`）时直接发消息
- 用非当前 WABA 的企业号发消息
- 窗外发 text；窗内无故改用模板（用户明确要模板除外）
- 智能体自己改 `.env` 写 `YCLOUD_WABA_ID`（由后端在绑定成功后写入）
- 编造 `partnerCustomerId`；忽略已配置的 `MIO_CDP_SUPPLIER_ID`
- 写死桥接基址（必须读 `WHATSAPP_BRIDGE_BASE_URL` / `PORT`）
- 群聊发消息不带 `sourceChatId` / 尽量带 `sourceOpenId`（拿得到就必须带）
