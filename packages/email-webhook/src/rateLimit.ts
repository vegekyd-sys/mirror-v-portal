/**
 * 应用层限流配置（@fastify/rate-limit 的 per-route `config.rateLimit`）。
 *
 * 背景：限流原本放在 ALB Ingress 级（`traffic-limit-qps`），但那是整条 Ingress
 * 共享一个 qps，没法按路径区分；email-webhook 的路径合并进 `dealclaw-ingress`
 * 之后，Ingress 级限流彻底丢失。所以改到服务内按路由配限额，比 Ingress 精确。
 *
 * 存储：当前 `replicas: 1`，用 @fastify/rate-limit 默认内存 store 即可精确，
 * 重启清零可接受；以后扩副本再把 ioredis 实例传给插件的 `redis` 选项（ioredis
 * 已在依赖里，REDIS_ADDR/REDIS_DB/REDIS_KEY_PREFIX 配置项也已留好）。
 *
 * key：默认按请求 IP（normalizeIP(request.ip, ipv6Subnet)）。管理接口/事件读取
 * 都是低频调用方，按 IP 限流即足够防爆破。每个路由各自独立计数（不设 groupId），
 * 语义是「每个 IP 对每个操作 1 req/s」——认证（ADMIN_TOKEN/app_secret）仍是第一道
 * 防线，限流只是纵深防御，不需要跨路由合并计数。
 */

/** GET /v1/events：本地 poller 增量拉取事件，10 req/s。 */
export const EVENTS_RATE_LIMIT = {
  max: 10,
  timeWindow: 1000,
} as const;

/** bindings 管理接口：低频配置操作，1 req/s 足够正常使用，防爆破/批量扫描。 */
export const BINDINGS_RATE_LIMIT = {
  max: 1,
  timeWindow: 1000,
} as const;

/** suppliers 管理接口：仅平台管理员可用（requireAdmin），同样防爆破。 */
export const SUPPLIERS_RATE_LIMIT = {
  max: 1,
  timeWindow: 1000,
} as const;
