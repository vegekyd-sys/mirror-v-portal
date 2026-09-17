# dealclaw-ai-hunter Skill · V4.4 接口契约参考

> 与《AI猎客-小元对接-V4需求文档》同步；**V4.4 架构收敛：全部接口统一走适配器（blade-agent-adapter），`/v4` 主服务接口（搜索/128 点解锁/点数账户/定制需求提交/lead-unlock）已全部废弃，本 Skill 不得调用。**
> Base：`$AI_HUNTER_ADAPTER_BASE_URL`（如 `https://micro.tradechina.com/blade-agent-adapter`）；`Content-Type: application/json`。
> 全部接口为 POST；响应统一包裹 `{"code":int,"msg":string,"success":bool,"data":...}`，以 `success=true` 为成功。

## 目录

1. 鉴权
2. getBasicInfo — 拉取企业现值
3. editSaveBasic — 画像回写（profile-sync）
4. addOrUpdateHunter — 服务启停（hunter-status-sync）
5. getHunterStatus — 读取启停状态
6. 买家线索广场（询盘数据来源）
7. 询盘行为类型枚举
8. 错误处理
9. 规则速查

---

## 1. 鉴权（默认：飞书请求头）

适配器**不接受 `Authorization: Bearer`**（带 Bearer 直接返回 `MISSING_AUTH_HEADER:缺少 X-Feishu-Open-Id 或 X-Supplier-Id`）。

**默认鉴权 = 飞书身份头对，不依赖环境变量：**

- `X-Feishu-Open-Id`：小元会话/机器人身份（open_id）；
- `X-Supplier-Id`：**群绑定 supplier_id**（**禁止编造、禁止让用户手输**）；
- Base：默认 `https://micro.tradechina.com/blade-agent-adapter`（`AI_HUNTER_ADAPTER_BASE_URL` 可选覆盖）。

**可选覆盖**：若宿主配置了 `AI_HUNTER_ADAPTER_API_KEY`，可用 `X-Api-Key: $AI_HUNTER_ADAPTER_API_KEY`（供应商身份由 key 解析，`supplierId` 客户端不传）。

仅当**飞书头对与 key 都不可用**（缺 open_id / 群绑定 supplier_id / key）时，才告知「AI猎客服务未配置，暂不可用」，停止；**不假装调用成功**。

`supplierId` 取值：默认（飞书头对）取**群绑定值**；`X-Api-Key` 模式下由 key 注入、客户端不传。两种模式均**禁止编造、禁止让用户手输**。

## 2. getBasicInfo `POST /agent/company/getBasicInfo.json`

无请求体。画像确认前与合并回写前**必拉**的企业现值：`companyId`（= supplierId）、`companyName`、`companyNameEn`、`productTags`、`advantage`、`businessModel`、`employees`、`yearFounded`、`address`、`email`、`phone`、`website`、`whatsapp`、`faceBook`、`linkedIn`、`logo`、`briefInfo`、`approveState`（只读）、`reasonInfo`（只读）、`orderRecords`（线下展订购记录）。

## 3. editSaveBasic `POST /agent/company/editSaveBasic.json`

接口描述即「精简字段；先拉取再合并回写」：`getBasicInfo` → 按下表合并确认版画像 → `editSaveBasic` 回写。仅在用户确认画像后执行。

**画像 → 请求字段映射（只回写画像相关字段）：**

| 画像来源 | 请求字段 | 规则 |
|---|---|---|
| 企业画像 `products` | `productTags` | 主营产品/标签（文案） |
| 企业画像 `products` 中标注主推/亮点 | `adProducts` | 主推产品/亮点产品；无主推标注则不传该字段 |
| 企业画像 `advantages` | `advantage` | 公司亮点介绍文案 |
| 企业画像 `certs` + `capacity` | 并入 `advantage` 文案末尾 | 接口无独立字段，文案合并、不丢信息 |
| 目标买家画像 `markets` | `targetMarket` | 目标市场（国家/地区拼接） |
| 目标买家画像 `buyerTypes` | `targetRole` | 目标角色（买家类型拼接） |
| 目标买家画像 `scale` + `channels` | 追加进 `targetRole` 文案 | 接口无独立字段，文案合并 |
| 目标买家画像 `certs`（要求买家具备的认证） | `cooperationCondition` | 必须满足的合作条件 |

**画像无来源、禁止编造的字段**（除非企业在对话中明确提供，否则不传、保留 getBasicInfo 现值）：`companyName`、`companyNameEn`、`email`、`phone`、`website`、`whatsapp`、`faceBook`、`linkedIn`、`address`、`yearFounded`（int）、`businessModel`、`employees`。

## 4. addOrUpdateHunter `POST /agent/company/addOrUpdateHunter.json`

请求体仅一个字段：

```json
{"status": 1}
```

- `status`（int，必填）：`1` 开启 / `0` 关闭。**服务启停状态以本接口为准。**
- **supplier_id 由鉴权注入**：请求体不得传 `supplier_id`。
- **启动时间客户端不传**：开启由服务端写 `START_TIME` 并清空 `END_TIME`；关闭写 `END_TIME`。
- 时机：画像确认并回写成功后调 `{"status":1}` 启动服务；用户明确要求关闭时调 `{"status":0}`；画像更新不涉及启停变化时不重复调。
- 失败处理：非 200 或 `success=false` → 可重试一次，不得谎称已启动/已关闭。

## 5. getHunterStatus `POST /agent/company/getHunterStatus.json`

无请求体。读取当前启停状态。**供应商从鉴权注入；无配置记录时 `status=0`。**

```json
{"code":200,"success":true,"msg":"操作成功",
 "data":{"status":1,"startTime":"2026-09-14T10:00:00.000+08:00","endTime":null}}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | Integer | `0` 关闭 / `1` 开启；**无记录为 `0`** |
| `startTime` | DateTime | 最近一次开启时间；可能为空 |
| `endTime` | DateTime | 最近一次关闭时间；开启中可能为空 |

- 调用时机：启动/停用**前读现状**，写入后**回读确认**。
- 与 §4 成对：**§5 读、§4 写**；启停状态以 `addOrUpdateHunter` 的写入结果为准，本接口用于核对。
- 失败处理：非 200 或 `success=false` → 不阻塞对话主流程，但**不得**据失败结果推断状态（不得编造「已开启 / 已关闭」）。

## 6. 买家线索广场（询盘数据来源）

> 用途：服务启动后，每日推送前以 `page` 查询买家询盘数据作为候选集，经九维打分（`matching.md`）筛选后推送 ≤5 条/日。凭证缺失或查询失败 → 当日不推送、**不编造买家**。
>
> **扣点与 `unlockStatus`（平台口径）**：`page` 与 `detail` 的**扣点由服务端处理并记账**——**能查到线索数据即表明该条已扣过点**；扣点以 `supplier_id` + `trend_id` 为幂等键，**同一组合不重复扣**。因此客户端**不得把「返回了明文」理解为未付费**，也不得重复触发扣点。返回值中的 `unlockStatus` **无意义**，**不作为任何判断依据**（不驱动解锁判断/展示/入库/打分），也不得据此放行或拦截。

### 5.1 leads-plaza-page `POST /agent/buyerLeadsPlaza/page`

请求 `BuyerLeadsPlazaPageReq`（字段均可选，按确认版画像解析填充，**不编造**）：

| 请求字段 | 类型 | 含义 | 取值来源 |
|---|---|---|---|
| `supplierId` | string | 展商ID | 小元所在群绑定的 `supplier_id`（§1 同一来源）；禁止编造、禁止让用户手输 |
| `productKeyword` | string | 产品关键词 | 画像产品名 |
| `countryId` | string | 买家国家 id | 画像目标国家，经 `countries` 接口映射（§6.2）；映射不上则不传 |
| `t1Id` / `t2Id` | string | 类目 id | 画像类目对应的平台类目 id；无可靠 id 来源则不传，禁止编造 |
| `consolidatedDays` | int | 线索合并时间范围：3/7/15/30 天 | 每日推送默认 **60**（近 60 天）；实调请求 60 与 30 返回同结果，疑似后端上限 30 |
| `page` / `limit` | int | 页码 / 页长 | 默认 `1` / 拉足候选（如 `50`）供打分筛选 |
| `contactStatus` | int | 沟通状态：1已联系 2已回复 | 可选筛选，默认不传 |
| `manualRecommend` | int | 是否为你推荐：1是 | 可选，默认不传 |
| `videoDirect` | int | 是否视频直连：1是 | 可选，默认不传 |

响应 `data` 为分页对象（`records` / `total` / `current` / `pages` / `size`）。`records[]`（`BuyerLeadsPlazaVo`）→ 推送卡片与线索池字段映射：

| 响应字段 | 含义 | 映射到 |
|---|---|---|
| `id` | 买家线索汇总ID | `线索ID`；**即解锁时 `detail` 的 `trendId`**（不得拼接改写） |
| `buyerCompany` | 买家公司 | `买家公司名称` |
| `buyerCountry` | 买家国家 | `买家国家` |
| `companyProfile` | 公司简介 | `买家公司简介` |
| `recentTrend` | 需求意向 | `需求意向` |
| `productList[].productName` / `productNameEn` | 产品列表（中/英文名） | `关注产品` |
| `buyerTag` | 买家标签（`;` 分隔） | `买家特征` |
| `exhibitionName` | 展会名称（英文） | `报名参展展会` |
| `t1` / `t2` | 类目 | `产品类别T1/T2` |
| `lastConsolidatedTime` | 最近一次线索合并处理时间 | `需求时间`（时效维度依据） |
| `unlockStatus` / `contactStatus` / `videoDirect` / `videoApplyStatus` / `chatGroupId` / `purchaserId` / `purchaserContactId` / `companyCdpId` / `contactCdpId` 等 | 内部状态与 ID | **不对外展示**，仅供内部判断；其中 **`unlockStatus` 无意义，忽略**（见 §6 开头口径） |

> 注意：广场 `page`/`detail` 均无「买家类型」字段 → 九维打分中买家类型（10 分）恒 0，**不编造**；核心闸门（产品名+类目+国家 74 分）与 ≥70 推送阈值不受影响。`lastConsolidatedTime` 为线索合并处理时间，作 `需求时间` 的近似参与时效评分。

### 5.2 countries `POST /agent/buyerLeadsPlaza/countries`

无请求体。返回国家列表（`countryId` / `cnName` / `enName`），用于把画像目标国家名映射为 `countryId`；映射不上则不传 `countryId`，**不编造 id**。

### 5.3 detail `POST /agent/buyerLeadsPlaza/detail`（解锁 = 调用即扣 360 点）

**调用即扣点**：本接口是询盘解锁的唯一入口。用户明确确认解锁后调用，**调用即扣 360 点**，扣点由服务端处理并记账（`supplier_id` + `trend_id` 幂等，同一组合不重复扣）。**用户未确认前禁止调用。**

请求：

```json
{"supplierId":"...","trendId":"..."}
```

- `supplierId`：小元所在群绑定的 `supplier_id`（§1 同一来源），禁止编造、禁止让用户手输；
- `trendId`：买家线索汇总ID，即推送卡片的 `线索ID`。

响应 `data`（`BuyerLeadsPlazaDetailVo`）→ 解锁卡片字段映射：

| 响应字段 | 含义 | 映射到解锁卡片 |
|---|---|---|
| `contactName` | 联系人名称 | 👤 联系人 |
| `jobTitle` | 职位 | 💼 职位 |
| `buyerEmail` + `emailValid` | 邮箱 + 校验状态（0不通过 1通过） | 📧 邮箱 + 校验徽标 |
| `buyerMobile` + `mobileValid` | 手机号 + 校验状态 | 📱 电话 + 校验徽标 |
| `buyerWhatsapp` + `whatsappValid` | WhatsApp + 校验状态 | 💬 WhatsApp + 校验徽标 |
| `buyerCompany` / `companyProfile` / `companyWebsite` / `buyerCountry` / `recentTrend` / `productList` 等 | 买家信息与状态 | 非明文字段，含义同 §6.1；`unlockStatus` 无意义，忽略（见 §6 开头口径） |

**硬规则（扣点与明文释放）**：联系人明文只渲染进解锁卡片、**绝不落库**（见 base-schema.md），并只发往来源群。`detail` 失败 → 重试一次；仍失败 → 告知「联系方式稍后重新拉取」，**不得编造联系人**；联系人全空 → 发无联系方式文案。响应明确返回点数不足 → 告知需 360 点、引导联系专属运营充值，不出明文。

## 7. 询盘行为类型枚举

推送的每条询盘买家数据含以下询盘行为之一（摘要与解锁话术只标注「有行为 + 行为类型」）。**展示时用业务描述，不裸贴原串；多个类型用「·」连接：**

| 行为类型 | 展示描述（业务语言） |
|---|---|
| 询盘 | 买家主动提交了采购询盘（有明确采购动作） |
| RFQ | 买家发出报价请求（Request for Quotation，已进入比价阶段） |
| 展商询盘 | 买家在展会上向展商提交了询盘（展会现场意向） |
| IM产品询盘 | 买家通过 IM 就具体产品发起询盘（产品级强意向） |

未列出的类型照原文展示，**不编造含义**。

## 8. 错误处理

适配器响应统一包裹 `{"code","msg","success","data"}`，以 `success=true` 为成功。把错误译成中文 + 下一步，不许甩英文码：

| 情形 | 对企业的说法 + 下一步 |
|---|---|
| `MISSING_AUTH_HEADER` | 服务配置异常 → 检查鉴权头（`X-Api-Key` 或飞书身份头对） |
| 点数不足（detail 返回） | 点数不足，解锁这条需 360 点 → 引导联系专属运营充值 |
| 查询无候选询盘 | 暂无匹配询盘，有了就推 → 不编造 |
| 非 200 / `success=false` | 操作暂时没完成，稍后再试 → 可重试一次，不谎称成功 |
| `SERVICE_UNCONFIGURED`（Skill 本地，凭证缺失） | 明确告知 AI猎客服务未配置、暂不可用 → 停止编造 |

## 9. 规则速查

- 服务启停状态以 `addOrUpdateHunter` 为准（`status=1` 开启 / `0` 关闭）；画像回写走 `getBasicInfo` → `editSaveBasic`，只回写画像相关字段。
- 推送询盘数据来源 = 线索广场 `page`（参数由确认版画像解析）。
- **解锁 = 用户确认后调 `detail`，调用即扣 360 点**（服务端记账，`supplier_id`+`trend_id` 幂等）；未确认禁止调 `detail`；同一 `线索ID` 已解锁不再调用。
- 询盘买家数据统一推送（专属/非专属不对外区分），解锁统一扣 360 点。
- 匹配采用九维打分（见 `matching.md`），核心闸门 = 产品名 + 产品类目 + 目标国家。
- 同一联系方式已交付，不得重复扣点。
- 余额/流水、搜索买家、定制需求提交：对话侧已下线，统一引导专属运营，不编造。
