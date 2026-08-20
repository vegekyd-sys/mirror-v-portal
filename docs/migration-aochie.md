# DealClaw 部署迁移方案：奥创 → 奥驰

> 日期: 2026-08-20 | 状态: 草案待评审
> 目标: 将 DealClaw 测试环境从「奥创」阿里云账号完整迁移到「奥驰」阿里云账号

---

## 一、迁移范围与现状盘点

### 1.1 现状基础设施（奥创账号）

| 组件 | 规格/地址 | 迁移到奥驰 |
|------|----------|-----------|
| ACK 集群 | namespace `dealclaw-test` + `dealclaw-<tenantId>`（per-tenant） | 重建 |
| RDS PostgreSQL | `pgm-uf6r5j1612a482a5.pg.rds.aliyuncs.com:5432/dealclaw_test` | 重建 + 数据迁移 |
| ACR 镜像仓库 | `ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw/` | 重建 + 镜像同步 |
| OSS 对象存储 | bucket `dealclaw-backup`（租户数据备份） | 重建 + 数据迁移 |
| CNFS NAS | storage class `alibabacloud-cnfs-nas`（PVC 10Gi/租户） | 重建 |
| ALB 负载均衡 | 域名 `dealclaw-test.ultronx.tech` | 重建 + 域名切换 |
| TLS 证书 | `ultronx-tls` secret | 迁移或重新签发 |
| CI/CD | Jenkins `devops-tools.ultronx.tech:8443` + ArgoCD | 重建/切换 |

### 1.2 服务清单（8 个模块）

| 服务 | 端口 | 说明 | 部署形态 |
|------|------|------|---------|
| central-gateway | 8085 | 飞书扫码入驻编排 | 中央 |
| provisioning-service | 8082 | 租户 CRUD + K8s 资源代理 | 中央 |
| nexus-gateway | 8080 | 租户网关（计费/限流/身份） | 中央 + per-tenant |
| credits-ledger | 8081 | 账本 + 计费 + 定价 | 中央 |
| ops-agent | 8083 | 生命周期运维 | 中央 |
| admin-dashboard | — | 管理后台 | 中央 |
| dealclaw-agent | 18789 | AI 外贸 Agent | per-tenant Pod |
| mock-agent | — | 测试桩 | 中央 |

### 1.3 数据库（dealclaw_test 库）

主要表：
- `tenants` / `tenant_status_log` / `tenant_notifications`（租户 + 生命周期）
- `skill_prices` / `plan_templates`（定价 + 套餐）
- `skill_billing_events` / credits accounts（计费）
- 其它 credits-ledger / ops-agent 相关表

### 1.4 Secrets 清单

| Secret | 内容 | 迁移方式 |
|--------|------|---------|
| dealclaw-db | RDS 连接串 | 换新地址 |
| dealclaw-oss | OSS AccessKey | 换奥驰账号的 AK |
| dealclaw-payment | 支付 token | 重新配置 |
| tenant-config | 租户配置 | 复制 |
| registry-secret-vpc | ACR 拉取凭证 | 换奥驰 ACR |
| ultronx-tls | TLS 证书 | 迁移/重签 |

---

## 二、基础设施创建（奥驰账号）

按依赖顺序执行：

### 2.1 网络
1. 创建 VPC + 交换机（建议与奥创同 region，跨账号内网互通更容易做数据迁移）
2. 安全组规则

### 2.2 RDS PostgreSQL
1. 创建 RDS PostgreSQL 实例（建议同版本，如 PG 14/15）
2. 创建 `dealclaw_test` 库 + `app_user` 账号
3. 记录新连接串

### 2.3 ACR 镜像仓库
1. 创建命名空间 `dealclaw`
2. 配置访问凭证（RAM 子账号，用于 Jenkins push + K8s pull）

### 2.4 OSS 对象存储
1. 创建 bucket `dealclaw-backup`
2. 创建 RAM 子账号（最小权限：PutObject/ListObjects/GetObjectMeta/GetObject）
3. 记录 AccessKey

### 2.5 CNFS NAS
1. 开通文件存储 NAS
2. 配置存储类 `alibabacloud-cnfs-nas`（或等价的奥驰侧存储类）

### 2.6 ACK 集群
1. 创建 ACK 集群（托管版，建议 Pro 版以支持 ALB）
2. 配置 kubectl 访问

### 2.7 域名 + TLS
1. 域名 `dealclaw-test.<奥驰域名>`（或临时用 IP + 自签证书）
2. 签发/迁移 TLS 证书

### 2.8 中间件（可选，后置）
- ArgoCD（CD）
- Jenkins（CI，或复用奥创 Jenkins 只改 ACR 地址）

---

## 三、数据库迁移

### 3.1 方案选择

| 方案 | 适用 | 说明 |
|------|------|------|
| **A. pg_dump/pg_restore** | 数据量小（当前测试环境） | 简单，停机时间可控 |
| B. DTS 数据同步 | 数据量大、需在线迁移 | 阿里云 DTS 跨账号同步 |

测试环境数据量小，推荐 **方案 A**。

### 3.2 步骤

```bash
# 1. 源库导出（在奥创侧）
pg_dump -h <源RDS> -U app_user -d dealclaw_test -F c -f dealclaw_test.dump

# 2. 目标库导入（在奥驰侧）
pg_restore -h <新RDS> -U app_user -d dealclaw_test dealclaw_test.dump

# 3. 校验
# 表数量、行数、关键表抽样对比
```

### 3.3 注意事项
1. **schema 可以靠 migrate.ts 自动建**：代码启动时会跑 migration 建表。但数据需要 pg_dump 迁移。
2. **顺序**：先迁 schema（或让 migrate 建），再迁数据。避免主键/外键冲突。
3. **迁移时停机**：迁移期间暂停 onboarding，避免新租户写入导致数据不一致。

---

## 四、镜像迁移

### 4.1 方案
ACR 跨账号镜像同步（或重新构建）。

```bash
# 用 skopeo 或 crane 同步镜像（跨账号）
skopeo copy docker://<奥创ACR>/dealclaw/<image>:<tag> \
  docker://<奥驰ACR>/dealclaw/<image>:<tag>
```

### 4.2 需要同步的镜像
- central-gateway, provisioning-service, nexus-gateway, credits-ledger, ops-agent, admin-dashboard, dealclaw-agent, mock-agent
- 备份镜像 `video-editor/ossutil:2.2.1`

### 4.3 备选：改 Jenkins 指向奥驰 ACR，重新触发构建

---

## 五、服务部署迁移

### 5.1 K8s manifests 调整（`vkubernetes/ultronx` 仓库）

需要改的点：
1. **镜像地址**：`ultronx-acr-registry-vpc...` → `<奥驰ACR>`
2. **RDS 连接串**：dealclaw-db secret
3. **OSS 凭证**：dealclaw-oss secret
4. **域名**：ingress host + TLS
5. **RUNTIME_NAMESPACE**：可保持 `dealclaw-test`（或改奥驰的命名）
6. **imagePullSecrets**：registry-secret-vpc 换奥驰 ACR 凭证

建议做法：在 `overlays/` 下新增 `aochie/` overlay，只覆盖差异项（镜像地址、secret、域名），复用 base。

### 5.2 ArgoCD

1. 奥驰 ACK 安装 ArgoCD
2. 创建 Application（指向 ultronx 仓库的 `aochie` overlay）
3. 同步

### 5.3 Secret 迁移

| Secret | 奥驰侧值 |
|--------|---------|
| dealclaw-db | 新 RDS 连接串 |
| dealclaw-oss | 奥驰 OSS 的 AK |
| registry-secret-vpc | 奥驰 ACR 凭证 |
| ultronx-tls | 奥驰域名证书 |
| tenant-config / dealclaw-payment | 复制（测试值不变） |

---

## 六、CI/CD 迁移

### 6.1 方案 A：复用奥创 Jenkins
- 只改 Jenkins 里的 ACR 地址（push 到奥驰 ACR）
- 最小改动，但 Jenkins 仍在奥创

### 6.2 方案 B：奥驰新建 Jenkins
- 完整迁移流水线
- 彻底隔离

建议先 **方案 A**（快速切换），后续再迁 Jenkins。

---

## 七、验证与切换

### 7.1 冒烟测试清单

- [ ] 扫码 onboarding 创建新租户 → namespace + PVC + Pod 正常
- [ ] 租户 agent 对话 + 计费（搜索买家扣 credit）
- [ ] 管理后台可访问
- [ ] 备份 Job 能写 OSS
- [ ] credits-ledger 余额查询正常

### 7.2 域名切换
1. 新环境用新域名（或临时 IP）先验证
2. 验证通过后 DNS 切换到奥驰域名

### 7.3 切换策略
- 测试环境：直接切换即可（无用户流量）
- 生产环境（未来）：需灰度 + 双跑

---

## 八、回滚方案

1. 保留奥创环境运行（不删除），直到奥驰验证通过
2. DNS 回切即可回滚
3. 数据库：迁移前 pg_dump 备份，必要时回滚重导

---

## 九、风险与注意事项

| 风险 | 影响 | 缓解 |
|------|------|------|
| 跨账号数据迁移泄漏 | 客户数据安全 | 用内网/专线迁移，不经过公网 |
| 数据库不一致 | 计费/租户数据错乱 | 迁移期间停 onboarding，校验行数 |
| 镜像地址遗漏 | Pod 拉不到镜像 | 全局搜索替换 + 冒烟测试 |
| 域名/TLS 未切换 | 飞书回调失效 | 提前准备证书，验证飞书事件订阅 |
| 飞书应用回调地址 | 扫码入驻失效 | onboarding 的 botWebhookUrl 需指向新域名 |

---

## 十、迁移执行顺序（推荐）

```
1. 基础设施创建（VPC → RDS → ACR → OSS → NAS → ACK → 域名）
2. 数据库迁移（pg_dump → pg_restore → 校验）
3. 镜像同步（ACR 跨账号）
4. K8s manifests 新增 aochie overlay + secret
5. ArgoCD 部署 + 同步
6. CI/CD 切换（Jenkins 指向奥驰 ACR）
7. 冒烟测试
8. 域名切换 + 飞书回调更新
9. 观察期 → 确认稳定后停奥创环境
```

---

## 待确认事项

1. 奥驰阿里云账号是否已就绪？region 是否与奥创一致（建议同 region 便于迁移）？
2. 域名：奥驰侧用什么域名？（决定 TLS + 飞书回调）
3. 数据库迁移方式确认（pg_dump 还是 DTS）？
4. CI/CD 方案确认（复用 Jenkins 还是新建）？
