---
name: ycloud-whatsapp
description: >-
  通过公司 WhatsApp 桥接服务收发消息，以及 Partner Direct Link 嵌入式注册开通 WABA。
  禁止直连 YCloud / Meta API，禁止读取 YCLOUD_API_KEY。买家入站由后端同步到飞书客服群话题：
  无群则自动建「WhatsApp 客服」群再拉话题，有群则只建话题。窗外发模板时智能体
  自主回填变量并发送，不要逐项问用户。无 YCLOUD_WABA_ID 时先走嵌入式注册，禁止直接发消息。开通 WABA 时 partnerCustomerId 由请求动态传入（当前租户 supplier id = 智能体环境 MIO_CDP_SUPPLIER_ID），经桥接创建 Onboarding Link。不要自己调 YCloud。适用于 WhatsApp、飞书客服、话题、模板、24h 窗口、换号、
  嵌入式注册、Direct Link、Onboarding Link、WABA、CDP 供应商。不用于 SMS。
---

# WhatsApp（经桥接服务）

智能体**只调用桥接 HTTP API**。不要 curl `api.ycloud.com`，不要读或打印 `YCLOUD_API_KEY`。

`partnerCustomerId` **是当前租户的 supplier id（CDP 供应商 ID）**，值 = 智能体环境的 `MIO_CDP_SUPPLIER_ID`，请求里**显式传 `body.partnerCustomerId`**。桥接多租户下**不写死 env**：请求优先、env 只兜底。嵌入式注册整条链路都用它：不要问用户、不要用对话里的公司名、不要生成 `pc_` / `test_onboard_001`。

**发消息前必须已有环境变量 `YCLOUD_WABA_ID`。** 智能体自己从桥接项目 env 文件读取，并在列号、列模板、发消息时**原样传入** `wabaId`。

env 里**已经有** `YCLOUD_WABA_ID` 时：这就是当前 WABA。立刻按进度列号、查窗口、发消息。**禁止**再去对 `GET /health`、`GET /wabas`。**禁止**把 env 和库里某条 `CONNECTED` 不一致说成「冲突」并问用户选哪个。两条 ID 不同很正常：`/wabas` 是开通历史，当前只用 env。

不要用 `GET /health` 的 `wabaId` / `wabaBound` 当绑定状态（那是后端进程自己的值，会和 env 文件不一致）。env 里没有 `YCLOUD_WABA_ID` → 先走嵌入式注册，**禁止** `POST /api/whatsapp/messages`。不要因为请求里带了 `from`、或以前发成功过，就跳过开通。

## 基址（必读环境变量）

调用前先解析 `$BRIDGE`、`$SUPPLIER`、`$WABA`、`$FEISHU_APP`，**不要写死** `http://127.0.0.1:8086`，**不要编造** `partnerCustomerId` / `wabaId`：

1. 读 **`WHATSAPP_BRIDGE_BASE_URL`**（当前 shell，或桥接项目根目录 `.env` / `.env.development` / `.env.shared`）。
2. 未配置时：可读同文件里的 **`PORT`**，拼成 `http://127.0.0.1:$PORT`（`PORT` 缺省按 `8086`；集群部署走公网 `https://dealclaw.datathink.com/whatsapp`）。
3. 读**当前智能体自己的** **`MIO_CDP_SUPPLIER_ID`**（tenant-env.json / .env，即当前租户 supplier id）作为 `$SUPPLIER`。不要用 `GET $BRIDGE/health` 返回的 `partnerCustomerId` 当权威值——那是后端进程 env 的兜底，多租户下通常为空。
4. `$SUPPLIER` 仍为空则停，提示在当前智能体环境补上 `MIO_CDP_SUPPLIER_ID`（tenant-env.json / .env）。
5. `$BRIDGE` 仍不确定则停，提示补上 `WHATSAPP_BRIDGE_BASE_URL`。
6. 读**当前智能体自己的环境变量** **`FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN` / `FEISHU_ENCRYPT_KEY`**，以及 **`FEISHU_INVITE_APP_IDS`**（要拉进「WhatsApp 客服」群的其它机器人 App ID，`cli_` 开头，可多个逗号分隔；通常是本智能体应用）。这是**该飞书应用**的凭证。禁止从桥接项目 `.env` 里抄这些（桥接启动不必有它们）。不要打印 Secret / Encrypt Key。四个密钥都要有值；缺 `FEISHU_ENCRYPT_KEY` 不要 POST。然后 `POST $BRIDGE/api/feishu/apps`：

```json
{
  "appId": "$FEISHU_APP_ID",
  "appSecret": "$FEISHU_APP_SECRET",
  "verificationToken": "$FEISHU_VERIFICATION_TOKEN",
  "encryptKey": "$FEISHU_ENCRYPT_KEY",
  "inviteAppIds": "$FEISHU_INVITE_APP_IDS"
}
```

返回 `appId`、`webhookUrl`、`hasEncryptKey`、`inviteAppIds`。`$FEISHU_APP` = `appId`。`hasEncryptKey` 必须为 `true` 才算注册成功；`false`、返回 `warning`、或 400 说密钥是占位符/非 ASCII 时，说明**没读到真实环境变量**。停下来让用户把该飞书应用「加密策略」里的 Encrypt Key / Verification Token 配进**智能体环境**，再 POST。禁止用中文、`***`、`$FEISHU_ENCRYPT_KEY` 原文或自己编一串去注册。Encrypt Key 和 Verification Token 不要抄反。`inviteAppIds` 应包含智能体环境的 `FEISHU_INVITE_APP_IDS`（本智能体 `cli_…`）；返回空数组说明没带上，其它机器人不会被拉进客服群。把该飞书应用「事件配置」请求地址设为 `webhookUrl`（`/webhooks/feishu/<appId>`）。每个应用配一次；凭证变了再 POST 覆盖。桥接启动**不必**带这些变量。保存 URL 若仍报「Challenge code没有返回」，是登记的 Encrypt Key 与开放平台不一致，重新用「加密策略」里的值 POST，不要改 URL 路径。
7. 读 **`YCLOUD_WABA_ID`** 作为 `$WABA`。有值 → 发消息流程。空 → 先做嵌入式注册。不要用 `GET /health` 判断有没有 WABA。

后端自己用 `PORT` 监听；智能体只用 `WHATSAPP_BRIDGE_BASE_URL`（或上面的回退）当 HTTP 基址。  
`$BRIDGE` 去掉末尾 `/`。服务未启动则先停，提示启动后端。`webhookUrl` 必须是飞书能访问的公网 HTTPS（ngrok / 已部署域名）。

```text
进度：
- [ ] 解析 $BRIDGE
- [ ] POST /api/feishu/apps 注册当前飞书应用，记下 webhookUrl / $FEISHU_APP
- [ ] 解析 $SUPPLIER、$WABA
- [ ] 无 $WABA → 嵌入式注册
- [ ] GET phones?wabaId=$WABA
- [ ] 查窗口 → POST messages 带 wabaId 与 feishuAppId=$FEISHU_APP
```

## 发消息（WABA + 企业号 + 24h 窗口）

每次发 WhatsApp **按此顺序**，不要跳过：

1. 读 env 的 `YCLOUD_WABA_ID` → `$WABA`。有值就继续发。只有空，或接口返回 `409 WHATSAPP_WABA_REQUIRED` / `400 WABA_ID_REQUIRED` 时，才走嵌入式注册。
2. 绑定成功后智能体**不要自己改 .env**。后端会在 Webhook `PARTNER_ADDED` 时写入 `YCLOUD_WABA_ID` 和 `YCLOUD_FROM`。再读一次 env 得到 `$WABA`。
3. `GET $BRIDGE/api/whatsapp/phones?wabaId=$WABA`。`from` **必须**是返回列表里的号码（优先 `defaultFrom` / `current=true`）。禁止用其它 WABA 或过期环境号。`409 WHATSAPP_FROM_NOT_IN_WABA` 时改用列表里的号再发。
4. `GET $BRIDGE/api/whatsapp/conversations?phone=买家号&from=当前企业号`，看这对账号的 `windowOpen`：
   - `true`：发自由文本（`text`），不要无故改模板。
   - `false` / 无会话：走下面「窗外」模板流程。
5. `POST /api/whatsapp/messages` 始终带 `wabaId=$WABA`、`feishuAppId=$FEISHU_APP`、`inviteAppIds=$FEISHU_INVITE_APP_IDS`、`from`（该 WABA 企业号）和 `to`（买家）。

发消息这条链路**不要** `GET /wabas`，**不要**用 `health.wabaBound`。env 和库里 `CONNECTED` 对不上时，以 env 为准，直接发。

24h 窗口是 **当前 WABA 企业号 × 买家号** 这一对会话，不是「这个买家曾经给任意企业号来过信」。换号后要重新查窗口。

## 窗外 / 主动触达（必按此流程，否则走不通）

窗口外**禁止**发 `text`。收到 `409 WHATSAPP_TEMPLATE_REQUIRED` 或 `windowOpen=false` 时，智能体**自己做完选模板、回填、发送**，不要停下来问用户「{{1}} 填什么」。

收到 `409 WHATSAPP_WABA_REQUIRED`、`400 WABA_ID_REQUIRED`，或 env 没有 `YCLOUD_WABA_ID`：改走嵌入式注册，**不要继续发消息**。

1. `GET $BRIDGE/api/whatsapp/templates?wabaId=$WABA`（或再加 `&name=某模板`）
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

**无 WABA 时发消息也会走这里**，不只是用户口头说「开通」。env 里没有 `YCLOUD_WABA_ID` 时，智能体**自己创建链接并交给客户**，不要问用户每个字段，也不要先去发 WhatsApp。不要用 `GET /health` 或 `GET /wabas` 的旧 `CONNECTED` 当成当前已绑定。

用户要**开通 / 注册 / 接入 / 连接 WhatsApp WABA**、提到 Direct Link / 嵌入式注册 / Onboarding Link 时同样走此流程。

前提（后端已配置，智能体不要读密钥、不要替用户配 Dashboard）：

- YCloud 已开通 Partner Direct Link；Webhook 已订阅 `whatsapp.business_account.updated`
- 创建链接**只能经桥接**。SDK Button 若需要，也是前端调**你们自己的后端/本桥接**拿 `onboardingUrl`，禁止在浏览器调 YCloud

### 流程

1. `GET $BRIDGE/health`（确认 `ok`。多租户下返回的 `partnerCustomerId` 是后端 env 兜底值、通常为空，**不作** `$SUPPLIER` 权威源）
2. `$SUPPLIER` 必须已解析。禁止向用户要 partnerCustomerId，禁止用其它字符串代替。
3. 先 `GET $BRIDGE/api/whatsapp/wabas?partnerCustomerId=$SUPPLIER`（**多租户下必须显式传**，桥接 env 不写死，省略 query 会查不到当前租户或串台）。**仅开通流程查这个接口**，发消息不要查：
   - 已有 `status=PENDING` 且返回了 `onboardingUrl`（未过期）→ **复用**，不要再 POST
   - 用户只是查开通状态 → 报告列表，结束；不要拿列表里的 `CONNECTED` 去改 env，也不要问用户和 env 里哪个才对
   - 用户要**新增或更换 WABA** → 再 POST 新链接
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

`partnerCustomerId` 必须是 `$SUPPLIER`（当前租户 supplier id）。桥接请求优先：显式传 `body.partnerCustomerId` 才准；不传时桥接只用 env `MIO_CDP_SUPPLIER_ID` 兜底（多租户下该 env 为空会 400）。

- `onboardingType` 默认 `WHATSAPP_BUSINESS_PLATFORM`（API WABA）。用户明确要 WhatsApp Business App / SMB 时才用 `WHATSAPP_BUSINESS_APP`。
- `locale`：中文对话用 `zh_CN`，否则 `en_US`。只允许 `en_US` `zh_CN` `es_ES` `pt_BR` `id_ID` `ru_RU`（区分大小写）。
- `sourceChatId` / `sourceOpenId`：与发消息相同；绑定成功时飞书提醒用。群聊尽量带上。
5. 立刻把 `onboardingUrl` 交给**该客户**（可点开的链接），并说明：
   - 打开链接 → **Continue with Meta** → 选择或创建业务、WABA、号码
   - 默认 **2 小时**有效；**一链一次 WABA**；完成前可刷新重试，不必新建
   - **不要**发到公开群公告、文档、分析平台
6. 不要轮询 YCloud、不要声称已经绑定成功。告诉用户：完成 Meta 后桥接会收 Webhook；`CONNECTED` 后后端会把 `YCLOUD_WABA_ID` / `YCLOUD_FROM` 写入环境变量。之后**重新读 env** 得到 `$WABA`，并用 `GET $BRIDGE/api/whatsapp/wabas?partnerCustomerId=$SUPPLIER` 看授信 `paymentMethodAttached`。
7. `paymentMethodAttached=true` 才表示授信完成、WABA 可正常用；`false` 说明授信未完成。
8. 列号、列模板、发消息都带 `wabaId=$WABA`，不要沿用旧环境号。
9. HTTP **429**：读 `retryAfter` / `Retry-After`，等完再 POST **一次**；仍失败再告诉用户稍后再试。
10. HTTP **400**（locale / type 错误）：按响应改参数后重试，不要把原始 JSON 丢给用户填。

智能体走 Direct Link 即可（把 URL 给客户）。不要在对话里贴带真实 Key 的 curl，不要教用户把 API Key 放进网页。

## 接口

### 探活

`GET $BRIDGE/health` → `{"ok":true,"partnerCustomerId":"...","wabaId":"...","wabaBound":true|false,"from":"+852..."}`  
`partnerCustomerId` 是**后端进程 env 的兜底值**（多租户下通常为空，不是当前租户的权威值）。`wabaId` / `wabaBound` 是**后端进程**里的值，智能体不要用它判断当前会话有没有 WABA。当前 WABA 以智能体读到的 env `YCLOUD_WABA_ID` 为准，并传入请求。

### 查会话窗口

`GET $BRIDGE/api/whatsapp/conversations?phone=买家号&from=当前企业号`

必须带当前 WABA 的 `from`，看这对账号的 `windowOpen` / `windowExpiresAt`。买家来信由后端 webhook 写入，智能体不要轮询 YCloud。

### 发消息

`POST $BRIDGE/api/whatsapp/messages`

窗内自由文本：

```json
{ "to": "+85290000000", "from": "+85251111111", "wabaId": "$WABA", "feishuAppId": "$FEISHU_APP", "inviteAppIds": "$FEISHU_INVITE_APP_IDS", "text": "你好", "sourceChatId": "oc_当前飞书群", "sourceOpenId": "ou_当前用户" }
```

`from` **必须是该 `wabaId` 下的企业号**（`GET /phones?wabaId=$WABA` 的 `defaultFrom` / `current=true`）。不传 `from` 时用该 WABA 列表第一个号；传入其它 WABA 的号会 `409 WHATSAPP_FROM_NOT_IN_WABA`。

**`sourceChatId`（群聊必填）**：当前飞书会话的群 `chat_id`。买家回复时尽量提醒该群。

**`sourceOpenId`**：必须是 **WhatsApp 客服这个飞书应用** 下的用户 `open_id`。元海精灵等其它应用的 `open_id` 不能用（会 `open_id cross app`，桥接无法私聊）。拿不到本应用的 open_id 就省略，买家消息仍会进客服话题。

后端会先对 `sourceChatId` 调 `me_join` 尝试自动进群；仅**公开群**能成功。「WA功能开发」这类私有/外部群无法 API 自助加入，靠 `sourceOpenId` 私聊兜底（或把群改为公开后再试群提醒）。

单聊可省略二者。不要编造 ID。

窗外 / 主动触达示例（有 body 变量时）：

```json
{
  "to": "+8613800138000",
  "from": "+85251111111",
  "wabaId": "$WABA",
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

- `to` 必填，E.164。
- `wabaId` 必填，值为 env 的 `YCLOUD_WABA_ID`。
- `feishuAppId` 建议必填，值为初始化注册返回的 appId。
- `accepted` / `ok:true` 只表示后端已提交给 YCloud，**不等于已送达**。投递失败时飞书客服话题会跟「系统：WhatsApp 发送失败」。
- 409 + `code=WHATSAPP_TEMPLATE_REQUIRED`：窗外，智能体改走模板流程并**自行回填后发送**。
- 409 + `code=WHATSAPP_WABA_REQUIRED` 或 400 `WABA_ID_REQUIRED`：没传 `wabaId` / env 没有 `YCLOUD_WABA_ID`。改走嵌入式注册。
- 409 + `code=WHATSAPP_FROM_NOT_IN_WABA`：`from` 不是该 `wabaId` 下的号码。改用 `GET /phones?wabaId=$WABA` 里的号。

### 列企业号

`GET $BRIDGE/api/whatsapp/phones?wabaId=$WABA`  
`$WABA` 来自 env `YCLOUD_WABA_ID`，**必传**。返回 `wabaId`、`defaultFrom`、`phones[]`（含 `current`）。发送时 `from` 只用这个列表里的号。

### 列已批准模板（含变量结构）

`GET $BRIDGE/api/whatsapp/templates?wabaId=$WABA`  
可选：`GET $BRIDGE/api/whatsapp/templates?wabaId=$WABA&name=b2b_interest_check_01`

`wabaId` **必传**（env `YCLOUD_WABA_ID`）。未传 400。返回每项至少含：`name`、`language`、`bodyText`、`variableCount`、`needsVariables`、`exampleBodyValues`、`sendComponentsDraft`。  
发模板时以这些字段为准，不要猜变量个数，不要默认空 `components`。智能体用这些字段自己回填，不要把原始 JSON 甩给用户填。

### 创建 Onboarding Link

`POST $BRIDGE/api/whatsapp/onboarding-links`

`partnerCustomerId` 用 `$SUPPLIER`（当前租户 supplier id，**多租户必须显式传**）。未传时后端用 env `MIO_CDP_SUPPLIER_ID` 兜底。成功返回 `onboardingUrl`、`expiresAt`、`partnerCustomerId`、`partnerCustomerIdSource`（`request` / `MIO_CDP_SUPPLIER_ID`）、`status=PENDING`。把链接交给客户即可。请求和 env 都没有会 400。

### 查询 WABA 绑定

`GET $BRIDGE/api/whatsapp/wabas`  
可选 `?partnerCustomerId=` `?wabaId=` `?status=PENDING|CONNECTED`

多租户下后端不写死 env，**必须显式传 `?partnerCustomerId=$SUPPLIER`**，否则查不到当前租户的绑定或串台。未过期的 PENDING 才会带 `onboardingUrl`。`CONNECTED` 后看 `wabaId` / `paymentMethodAttached`。智能体不要轮询 YCloud，只查本接口。

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
- 无 `YCLOUD_WABA_ID` / 请求没带 `wabaId` 时直接发消息
- 用 `GET /health` 的 `wabaId` / `wabaBound` 代替 env 里的 `YCLOUD_WABA_ID`
- 用 `GET /wabas` 的 `CONNECTED` 和 env 对账，声称冲突，停下来问用户选哪个 WABA
- env 已有 `YCLOUD_WABA_ID` 还去开通或查 `/wabas` 才肯发消息
- 用非当前 WABA 的企业号发消息
- 窗外发 text；窗内无故改用模板（用户明确要模板除外）
- 智能体自己改 `.env` 写 `YCLOUD_WABA_ID`（由后端在绑定成功后写入）
- 编造 `partnerCustomerId`；忽略当前租户的 `MIO_CDP_SUPPLIER_ID`（多租户下不显式传请求就串台）
- 写死桥接基址（必须读 `WHATSAPP_BRIDGE_BASE_URL` / `PORT`）
- 群聊发消息不带 `sourceChatId` / 尽量带 `sourceOpenId`（拿得到就必须带）
