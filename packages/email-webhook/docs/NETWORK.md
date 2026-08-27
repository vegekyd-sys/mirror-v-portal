# 网络要求说明

DealClaw 邮件 Webhook 服务（`114.55.150.21`，阿里云杭州）的网络出入站需求。
给网络/安全团队开通策略用。

## 一句话结论

**当前架构不需要为 Resend 开放任何入站端口。** 流量走 Cloudflare Tunnel，
由本机主动向外建立长连接，回调数据沿这条连接反向送达。

## 流量路径

```
Resend/Svix  ──https:443──►  Cloudflare 边缘（anycast）
                                    │
                                    │  沿已建立的隧道下行
                                    ▼
本机 cloudflared  ──出站 7844──►  Cloudflare 边缘
        │
        └──http──► nginx 127.0.0.1:8081 ──► node 127.0.0.1:8000
```

关键点：**握手方向是由内向外的**。Cloudflare 不会主动连接本机，
Resend 更不会——它只知道 `webhook.dealclaw.io` 这个域名，解析到的是
Cloudflare 的 anycast IP，与本机 IP 无关。

## 出站要求（必须开通）

| 目标 | 端口 | 协议 | 用途 | 缺失后果 |
|---|---|---|---|---|
| `region1.v2.argotunnel.com`<br>`region2.v2.argotunnel.com`<br>（实测落在 `198.41.192.0/24`、`198.41.200.0/24`） | **7844** | **TCP + UDP** | Cloudflare Tunnel 控制与数据通道 | **服务完全不可用**，公网返回 530/502 |
| `api.resend.com` | 443 | TCP | 拉取邮件正文填充飞书卡片 | 卡片缺正文，其余正常 |
| `open.feishu.cn` | 443 | TCP | 推送飞书通知 | 通知发不出去 |
| `r-bp1hlsleiv4c5axzog.redis.rds.aliyuncs.com` | 6379 | TCP | 幂等去重、线索状态 | 退化为不去重，功能可用 |
| `pkg.cloudflare.com` / `github.com` | 443 | TCP | 仅安装/升级 cloudflared 时 | 不影响运行 |

> **7844 必须同时放行 TCP 和 UDP。** cloudflared 默认走 QUIC（UDP），
> 失败时回落 HTTP/2（TCP）。只开一个会显著降低可用性。

## 入站要求

| 端口 | 当前状态 | 是否必需 | 说明 |
|---|---|---|---|
| 22 | 开放 | 运维必需 | SSH |
| 8443 | 开放 | **否** | 历史遗留的直连回源口，隧道模式下不再使用，**建议关闭** |
| 8000 / 8081 | 仅 `127.0.0.1` | — | 不对外，无需策略 |
| 80 / 443 | 被 k3s traefik 占用 | — | 不属于本服务 |

**可以把 8443 从安全组移除**，服务不受影响。移除后本机对外零入站攻击面
（除 SSH 外）。

## 如果改为直连（不走隧道）

只有在放弃隧道、让 Cloudflare 直接回源时才需要以下入站规则。

**回源来源是 Cloudflare 的边缘节点，不是 Resend。** 因为域名开了橙云代理，
Resend 只会连到 Cloudflare。需要放行的是 Cloudflare 的出口网段：

- IPv4：<https://www.cloudflare.com/ips-v4>
- IPv6：<https://www.cloudflare.com/ips-v6>

若连 Cloudflare 也不用、让 Resend 直连本机，才需要放行 Svix 的发送节点。
实测观察到的来源（AWS us-west-2 / 俄勒冈）：

```
54.148.139.208    52.24.126.164    44.228.126.217    50.112.21.217
User-Agent: Svix-Webhooks/rolling (sender-9YMgn; +https://www.svix.com/http-sender/)
```

⚠️ **这些是观测值，不是官方承诺的固定列表。** Svix 不保证源 IP 稳定，
按 IP 放行前请以 Svix/Resend 官方公布的清单为准，并做好变更跟踪。
更稳妥的做法是不依赖来源 IP，改用请求签名校验（服务已实现，见下）。

## 应用层安全（不依赖网络策略）

即使入站完全开放，以下机制仍然生效：

- **Svix 签名校验**：`/inbound` 校验 `svix-signature`，基于原始字节的
  HMAC-SHA256，且时间戳超出 300 秒窗口直接拒绝（防重放）。未配置密钥时
  拒绝所有请求（fail closed）。
- **管理接口鉴权**：`/bindings`、`/suppliers` 需要 `X-Admin-Token`，
  并按 `X-Supplier-Id` 做租户隔离。
- **事件拉取鉴权**：`/v1/events` 需要 `Authorization: Bearer <ADMIN_TOKEN>`。
- **k8s 部署**：同样的鉴权在应用层生效，路径整体前移到 `/webhook` 下
  （见 `deploy/k8s/`）；限流由 Ingress 注解承担，白名单由 Ingress 的 path 规则决定。
- **路径白名单**：nginx 只放行 `/health`、`/inbound`、`/bindings*`、`/v1/events`，
  其余一律 404。
- **限流**：管理接口 10 次/分钟。

## 已知的网络风险

源站在**中国大陆境内**，Cloudflare 边缘在境外，这条跨境链路存在实测可见的
干扰，已发生过两次可用性事故：

**2026-07-29　直连回源被 RST 注入**
Cloudflare 报 525。抓包证实：TLS ClientHello 送达源站后 0.08ms 收到 6 个
RST，而真实 RTT 是 207ms——RST 是路径上的设备注入的。换端口（8080/8443）、
换证书均无效。改用隧道后解决。

**2026-08-15　隧道端口 7844 被干扰**
20 分钟内 0 次成功注册、47 次断开，公网返回 530/502，持续约 2 天间歇性
中断。期间实测 5 个边缘 IP 只有 2 个能连；同样这些 IP 的 443 端口全通，
说明是**针对 7844 端口**而非 IP 封锁。切换 TCP（http2）同样被打。

**共同点**：只要「服务在境内 + 依赖跨境通道对外」，就会周期性中招。
网络策略解决不了这个问题。

### 缓解方向

1. **可观测性**：推送失败目前是静默的（只写日志），建议加告警
2. **架构层面**：把接收端迁到境外主机，Resend 直连，境内服务器主动拉取——
   方向反过来就不受入站干扰影响

## 故障排查

判断问题出在哪一层：

```bash
# 1. 应用层
ssh root@114.55.150.21 'curl -s http://127.0.0.1:8000/health'

# 2. nginx 层
ssh root@114.55.150.21 'curl -s http://127.0.0.1:8081/health'

# 3. 隧道层
ssh root@114.55.150.21 'systemctl status cloudflared; journalctl -u cloudflared -n 20 --no-pager'

# 4. 公网
ssh root@114.55.150.21 'curl -s -o /dev/null -w "%{http_code}\n" https://webhook.dealclaw.io/health'
```

1、2 正常而 4 异常 → 隧道或跨境链路问题，与服务无关。

**Cloudflare 错误码对照**

| 码 | 含义 |
|---|---|
| 502 / 530 | 隧道无可用连接 |
| 521 / 522 | 直连模式下源站拒绝/超时 |
| 525 | 直连模式下 TLS 握手失败 |
| 1033 | 隧道未注册或 cloudflared 未运行 |
