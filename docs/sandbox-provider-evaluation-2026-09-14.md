# Sandbox 服务选型：海外区域、价格、国内可达性

核对日期：2026-09-14。头条暂按字节跳动/火山引擎及 BytePlus 理解。本轮查资料并进行无凭据连接探测，没有迁移现有 Agent，没有开通新的付费产品。

## 结论

优先做 Vercel 新加坡与阿里 FC 云沙箱新加坡的同负载实测。Vercel 的优势是已有完整链路；阿里运行单价低，但独立计费处于邀测，需核对账户开通范围、海外价格和深休眠费用。BytePlus 有 AgentKit/沙箱产品，但本轮未取得可核对的海外区域及完整价目表，不以未经确认的数字排名。

新加坡满足中国以外运行的偏好。中国香港是中国境内、内地以外，不能等同于国外；若要求中国以外，优先新加坡、日本。云厂商归属、实例地域、API 入口和数据库/模型地域是不同维度。

## 同规格计算

每 Agent 2 vCPU、4 GiB，每日累计运行30分钟，30天共15小时。包含运行中的空闲等待，但不包括停止后的存储。下面不含模型 Token、流量、税和共享控制服务。性能等价尚未实测。

| 服务 | 计算单价 USD/小时 | 15小时计算费 | 地域/条件 |
|---|---:|---:|---|
| Vercel 美国 iad1 | 0.0848 + 0.128 × A | 1.272 + 1.92 × A | 当前已验证运行区域 |
| Vercel 新加坡 sin1 | 0.1064 + 0.160 × A | 1.596 + 2.4 × A | 已开放；A是每运行1小时实际消耗的累计CPU核小时，2vCPU上限约2 |
| 阿里 FC Eco | 0.037152 | 0.55728 | 国际站邀测参考；不支持休眠 |
| 阿里 FC Std | 0.048528 | 0.72792 | 国际站邀测参考；支持深休眠 |
| 阿里 FC Pro | 0.074880 | 1.12320 | 国际站邀测参考；支持浅/深休眠 |
| E2B | 0.1656 | 2.484 | 官网列US/EU/APAC，具体APAC区域/账户可用性待确认；Pro另有150美元/月共享基础费 |
| Daytona | 0.1656 | 2.484 | 标准共享区域US/EU，定制/BYOC区域另评估；磁盘另计 |
| Modal | 0.23796 | 3.5694 | 1物理核=2vCPU；指定区域另有倍率；本轮未确认新加坡标准可购区域 |

Vercel 以今天早期实际 Agent 记录约 A=0.15 举例，新加坡计算费约1.96美元/Agent/月，美国约1.56美元；这是外推，不是实账或保证值。满载与等待模型的成本明显不同。内存最小计费粒度可能使短会话外推有偏差。

## 休眠成本不能省略

Vercel 快照按实际存储量计，0.08美元/GB/月；新加坡网络0.16美元/GB。

阿里邀测深休眠及快照的计费占用量是内存规格×2+磁盘规格。以4GiB内存、15GiB磁盘为例，计费占用23GiB；海外磁盘0.00025308美元/GiB/小时。如每月运行15小时、深休眠705小时，休眠约4.10美元，Std计算约0.73美元，合计约4.83美元，尚不含其他资源。Eco不支持休眠，不能把最低Eco价和Std/Pro休眠能力混用。

E2B Pro的150美元是组织/账户共享基础费，不是每个Agent150美元。暂停保留费用及期限需在目标计划确认。Daytona停止/暂停仍计预留磁盘，0.000108美元/GiB/小时，首5GiB免费；归档与暂停的语义不同。

## 连接探测

腾讯云元数据返回 V 的地域为 ap-singapore（新加坡）。在该服务器执行 curl --noproxy '*'，不携带任何凭据，仅探测管理域名根路径；这是海外侧连通性，不是国内直连测试：

| 地址 | HTTP | TLS完成时间 | 总时间 |
|---|---:|---:|---:|
| api.vercel.com | 308 | 0.432s | 0.605s |
| api.ap-southeast-1.e2b.fc.aliyuncs.com | 200 | 0.041s | 0.046s |
| api.e2b.dev | 404 | 0.221s | 1.031s |
| app.daytona.io/api/ | 200 | 0.295s | 0.532s |

HTTP 308/404说明入口有HTTP响应，不代表已通过鉴权或执行沙箱操作。API可能由边缘节点响应，耗时不能当作到新加坡VM的时延。本轮没有国内网络来源的实测；海外单源、单次探测不能证明国内运营商可达，也不能证明实例端口/SSE/WebSocket可达。未把Mac上可能存在的代理环境当作国内直连证据。

下一轮同负载验证应测：国内不同运营商到产品入口；Nexus到控制API及实例数据面；Sandbox到飞书、官方DeepSeek及海外业务站点。每区域至少10次冷启/恢复，记录创建、OpenClaw就绪、首字、完整回复、存储和出站流量，保留失败与超时样本。

对飞书产品，用户不必直连Sandbox。可将Nexus控制服务和Sandbox放在同一海外区域，用户通过飞书使用；Dashboard/下载链接仍要单独验证国内直连。没有任何区域选择能保证所有域名永久不被阻断。

## 官方来源

- Vercel Sandbox定价（页面包含sin1等地区定价数据）：https://vercel.com/docs/sandbox/pricing
- 2026-09-10区域扩展公告：https://vercel.com/changelog/vercel-sandbox-is-now-available-in-all-regions
- 阿里国际站邀测价格：https://www.alibabacloud.com/help/en/functioncompute/pay-as-you-go-of-fc-agent-sandbox
- 阿里云沙箱可用区域：https://help.aliyun.com/en/functioncompute/usage-constraints-of-fc-agent-sandbox
- AgentRun迁移FC云沙箱：https://www.alibabacloud.com/help/en/agentrun/agenrun-sandbox-upgrade-fc-cloud-sandbox-scheme
- BytePlus AgentKit：https://www.byteplus.com/zh-CN/product/agentkit
- BytePlus沙箱模板：https://docs.byteplus.com/zh-CN/docs/agentkit/Creating_tools
- E2B定价：https://e2b.dev/pricing
- E2B区域概述：https://e2b.dev/
- Daytona定价：https://www.daytona.io/
- Daytona区域：https://www.daytona.io/docs/regions
- Daytona生命周期计费：https://www.daytona.io/docs/en/billing/
- Modal Sandbox专用价格：https://modal.com/products/sandboxes
- Modal区域倍率：https://modal.com/docs/guide/region-selection
