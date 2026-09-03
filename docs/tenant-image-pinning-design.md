# 租户级镜像锁定（Pinned Image）设计调研

> 背景：管理端「运行镜像更新」对单租户改了 agent 镜像后，被 ops-agent 的每 10 分钟 rollout cron 回退。
> 本文档给出「方案 2」——租户级 pinned image——的完整设计调研。

## 1. 现状链路（已核实代码）

### 1.1 三个触点

| 触点 | 位置 | 行为 |
|---|---|---|
| 管理端单租户改镜像 | `provisioning-service/src/routes/tenants.ts:783` `PATCH /v1/tenants/:id/deployment` | 直接 `patchDeploymentImage`，**不落任何意图**，不写 DB |
| ops-agent rollout cron | `ops-agent/src/services/rollout.ts` `runRolloutCycle` | 每 10 分钟（约 `:08:56`）跑一次 |
| promote（全量发布） | `provisioning-service/src/routes/admin-ops.ts:102` `POST /v1/admin/image-releases/promote` | upsert `rollout_targets`（全局每 service 一行） |

### 1.2 ops-agent rollout 内部

`runRolloutCycle` 流程：

1. `GET /v1/admin/rollout-targets`（`admin-ops.ts:168`）读 promoted tag，为空则回退 env `ROLLOUT_*_TAG`。
2. 对每个 service 调 `POST /v1/tenants/batch/deployment`（`tenants.ts:961`）。
3. `batch/deployment` 里：`SELECT tenant_id, k8s_namespace FROM tenants WHERE status NOT IN ('destroyed') AND k8s_namespace IS NOT NULL` —— **遍历所有 active 租户**，逐个 `getDeployment` 比对，偏离 promoted tag 就 `patchDeploymentImage`。

关键点：**batch/deployment 是「全量收敛」，没有任何租户维度的豁免**，所以单租户改镜像必然在下个周期被拉回 promoted tag。

### 1.3 数据模型

`rollout_targets` 只有全局维度：

```
rollout_targets ( service PK, tag, updated_by, updated_at )
```

**没有 tenant 维度**。这是根因——promote 是「舰队级」的单一真源，而「单租户灰度」在数据模型里没有位置。

---

## 2. 目标

让「管理端对单个租户改镜像」成为一种**可持久、可审计、可回退**的意图，且不破坏现有「promote 全量滚动」的机制。核心诉求：

- 单租户改镜像后，ops-agent 的 rollout cron **跳过该租户**，不再回退。
- 操作者能随时「取消锁定 / 跟随舰队」。
- 有审计痕迹（谁、何时、锁到哪个版本）。

---

## 3. 方案设计（推荐）

### 3.1 新增数据表 `tenant_image_overrides`

```sql
CREATE TABLE IF NOT EXISTS tenant_image_overrides (
  tenant_id  TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  service    TEXT NOT NULL CHECK (service IN ('dealclaw-agent','nexus-gateway')),
  image      TEXT NOT NULL,                -- 完整镜像路径（normalizeImage 后）
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, service)
);
```

- 无该行的租户 = **跟随舰队**（现状，零迁移成本）。
- 有该行的租户 = **锁定**到 `image`。
- 与现有 `runtime_configs`（`tenant_id NULL` 全局 + 非空覆盖）同一套「全局默认 + 租户覆盖」惯用法，风格一致。

> 迁移幂等：`migrate.ts` 加一段 `CREATE TABLE IF NOT EXISTS`，安全，无回填需求。

### 3.2 provisioning-service API 改动

#### (a) `PATCH /v1/tenants/:id/deployment` —— 支持锁定语义

新增可选 body 字段 `pin`（默认 `true`）：

```ts
const { service, image, pin } = req.body;
const shouldPin = pin !== false;   // 默认锁定
```

- `patchDeploymentImage(...)` 照旧。
- `shouldPin === true` → upsert 进 `tenant_image_overrides`。
- `shouldPin === false` → 删除该 `(tenant_id, service)` 行（临时更新，仍跟随舰队）。
- 写审计日志 `image-release.pin` / `image-release.unpin`（复用 `auditFor`）。

#### (b) 新增 `DELETE /v1/tenants/:id/deployment-pin?service=` —— 取消锁定

清理 `tenant_image_overrides` 行，之后该租户回到跟随舰队状态，下个 rollout 周期被收敛到 promoted tag。

#### (c) `POST /v1/tenants/batch/deployment` —— rollout 跳过锁定租户

在遍历循环里，先查该租户是否命中 override：

```sql
SELECT image FROM tenant_image_overrides WHERE tenant_id = $1 AND service = $2
```

- 命中 → 计入 `pinned` 计数，跳过（不 patch、不计 alreadyCurrent）。
- 未命中 → 走现有 `getDeployment` + patch 逻辑。

响应体新增 `pinned` 字段；`results[]` 每条新增 `pinned?: boolean`。

> **这是最关键的改动点**：把「豁免」逻辑放在 batch/deployment 里，意味着 **ops-agent 无需感知 pin**，它只是继续调 batch/deployment 并读返回计数。

#### (d) `GET /v1/tenants/:id/runtime` —— 返回锁定状态

`getTenantRuntimeStatus` 结果里附上 `pinnedImages`（该租户两个 service 的 override），供前端渲染「已锁定」徽标与「取消锁定」按钮。

### 3.3 ops-agent 改动（可选，仅日志）

- 无功能性改动必需。batch/deployment 已服务端过滤。
- 建议：`rollout.ts` 解析 `body.pinned` 并在日志里打印 `[rollout] dealclaw-agent: N pinned (skipped)`，避免「76 tenants already on X」误导排查。

### 3.4 admin-web 改动（AgentDetailPage）

「运行镜像更新」区块（`AgentDetailPage.tsx:758` 起）：

1. 新增「锁定此版本（不随舰队滚动）」勾选，**默认勾选**——因为操作者对单租户改镜像的本意就是要它保持住。
2. 勾选 → `PATCH /deployment` 带 `pin:true`；取消勾选 → `pin:false`。
3. 若 `runtime.pinnedImages` 显示该 service 已锁定，展示「已锁定」徽标 + 「取消锁定 / 跟随舰队」按钮（调 `DELETE /deployment-pin`）。
4. 更新文案：把「如需把某个版本推给全部租户，请到「镜像版本」页使用「提升发布」」补一句「勾选锁定后，本 Agent 不会随舰队滚动更新」。

---

## 4. 边界情况与取舍

| 场景 | 处理 |
|---|---|
| 锁定镜像 tag 被 GC / 不在 image_releases | 与现状「任意 tag」风险相同；锁定的是完整镜像路径，K8s 拉取失败即 CrashLoop，运维可见 |
| 全局 promote 后锁定租户「掉队」 | 正常语义：promote 滚所有非锁定租户，锁定租户保持不动；前端徽标提示「已锁定，未随舰队更新」 |
| 外部 Agent 租户（`agent_endpoint` 非空） | 现有 PATCH 已拒绝（`EXTERNAL_AGENT`），override 表天然不涉及 |
| 锁定后租户重装 / 重建 Deployment | `provisionTenant` / `bindTenantFeishuApp` 目前只读 `getPromotedTag`。**需跟进**：这两处应优先读 override（有则用 override image），否则重建会丢锁定。建议作为本方案的一部分一并改 |
| 审计 | `image-release.pin` / `image-release.unpin` 走 `audit_logs`，含 old→new |
| rollout 计数口径 | `total` 仍 = 扫描租户数；新增 `pinned` 单独计数，`updated/alreadyCurrent` 只统计非锁定租户 |

### 备选方案（评估后不推荐）

- **A1 用 K8s annotation 标记锁定**：把 pin 写进 Deployment annotation。优点是不加表；缺点是审计/列表困难、语义「漏」到 K8s 层、且 batch/deployment 要额外 `getDeployment` 读 annotation。**放弃**——DB 是唯一真源更干净。
- **A2 全功能灰度分组（多舰队 channel）**：重量级，现阶段 400 租户用不上，留作未来。
- **A3 让单租户改镜像同时改 rollout_targets**：等于把全舰队一起推，就是现有 promote 流程，不满足「单租户灰度」。

---

## 5. 落地顺序

1. `migrate.ts` 加 `tenant_image_overrides` 表。
2. `tenants.ts`：改 PATCH deployment（pin 语义）、新增 DELETE pin、改 batch/deployment（跳过 + 计数）、改 runtime（返回 pinnedImages）。
3. `admin-ops.ts`：无必需改动（promote 流程不变）。
4. `ops-agent/src/services/rollout.ts`：可选加 `pinned` 日志。
5. `admin-web/AgentDetailPage.tsx`：锁定勾选 + 徽标 + 取消锁定按钮。
6. 测试：`provisioning-service` 单测补 `pin`/`unpin`/`batch 跳过` 三条；`ops-agent` 无需。
7. 部署：provisioning-service（aochi GitOps 直滚）+ admin-web；ops-agent 仅日志改动则不必动。

---

## 6. 验证方式（上线后）

- 对某灰度租户改镜像并勾选锁定 → 观察 2 个 rollout 周期（20 分钟），`kubectl get deploy -n dealclaw-<id> -o jsonpath='{.spec.template.spec.containers[*].image}'` 保持不变。
- ops-agent 日志应出现 `N pinned (skipped)`，且该租户不在 `alreadyCurrent` 里。
- 取消锁定 → 下个周期镜像被收敛回 promoted tag。

---

## 7. 实现状态（2026-09-03 已落地）

- `migrate.ts`：新增 `tenant_image_overrides` 表（幂等）。
- `services/tenant-image-overrides.ts`（新增）：`getOverrideMap` / `getOverride` / `setOverride` / `clearOverride` / `listOverrides`。
- `routes/tenants.ts`：
  - `PATCH /v1/tenants/:id/deployment` 加 `pin`（默认 true）→ upsert/clear override + 审计；
  - 新增 `DELETE /v1/tenants/:id/deployment-pin?service=`；
  - `POST /v1/tenants/batch/deployment` 查 override 跳过锁定租户并计 `pinned`；
  - `GET /v1/tenants/:id/runtime` 返回 `pinnedImages`。
- `services/provisioning.ts` + `services/feishu-binding.ts`：重建 Deployment 时优先读 override（第 4 节「待跟进」已一并解决，override 存完整镜像路径，直接用，不再拼 tag）。
- `ops-agent/src/services/rollout.ts`：解析并打印 `pinned` 跳过日志。
- `admin-web/AgentDetailPage.tsx`：锁定勾选（默认勾选）、已锁定徽标、取消锁定按钮。
- 单测：`tenant-image-overrides.test.ts`（7 例）+ `provisioning-tags.test.ts` 增加 override 优先用例；provisioning-service 256 通过、ops-agent 39 通过。
