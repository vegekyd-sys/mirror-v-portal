# DealClaw 部署迁移执行 Checklist：奥创 → 奥驰

> 日期: 2026-08-20 | 版本: v2（已确认关键决策）
> 目标: 测试环境从「奥创」阿里云账号迁移到「奥驰」账号

---

## 〇、已确认决策

| 项 | 决策 |
|----|------|
| 奥驰账号 | 已就绪，region 与奥创一致（华东2 上海 `cn-shanghai`） |
| 域名 | 已确认 `api-dealclaw.datathink.com` |
| 数据库迁移 | **DTS**（数据传输服务，在线迁移） |
| CI/CD | **新建** Jenkins + ArgoCD（不复用奥创） |
| 基础设施 | **人工手动创建**（控制台操作） |

> 通用控制台入口：https://console.aliyun.com （region 选「华东2（上海）」）

---

## 一、基础设施创建（Phase 1，人工控制台操作）

按依赖顺序执行，每步标了关键配置。

### 1.1 VPC + 交换机
- 控制台：专有网络 VPC → 创建 VPC
- 关键配置：region 选 `cn-shanghai`；网段建议 `10.1.0.0/16`（避免与奥创冲突）；创建 2 个交换机（不同可用区）
- 文档：https://help.aliyun.com/zh/vpc/user-guide/create-a-vpc-and-a-vswitch

### 1.2 RDS PostgreSQL
- 控制台：云数据库 RDS → PostgreSQL → 创建实例
- 关键配置：
  - 版本与奥创一致（PG 14 或 15，**迁移前先查奥创 RDS 版本**）
  - 规格：测试环境 2C4G 即可
  - VPC：选 1.1 创建的 VPC
- 创建后：
  1. 创建数据库 `dealclaw_test`
  2. 创建账号 `app_user`（与奥创一致，避免改连接串）
- 文档：https://help.aliyun.com/zh/rds/apsaradb-rds-for-postgresql/create-an-apsaradb-rds-for-postgresql-instance

### 1.3 ACR 容器镜像仓库
- 控制台：容器镜像服务 ACR → 创建实例（个人版或企业版）
- 关键配置：
  - 创建命名空间 `dealclaw`
  - 记录仓库地址（如 `<奥驰>-registry-vpc.cn-shanghai.cr.aliyuncs.com`）
  - 创建 RAM 子账号（用于 Jenkins push + K8s pull），授权 ACR 读写
- 文档：https://help.aliyun.com/zh/acr/product-overview/what-is-container-registry

### 1.4 OSS 对象存储
- 控制台：对象存储 OSS → 创建 Bucket
- 关键配置：
  - Bucket 名 `dealclaw-backup`
  - region `cn-shanghai`
  - 权限：私有
- 创建 RAM 子账号，最小权限（备份/恢复用）：
  ```json
  {"Version":"1","Statement":[{"Effect":"Allow","Action":["oss:PutObject","oss:ListObjects","oss:GetObjectMeta","oss:GetObject"],"Resource":["acs:oss:*:*:dealclaw-backup","acs:oss:*:*:dealclaw-backup/*"]}]}
  ```
- 记录 AccessKeyId / AccessKeySecret
- 文档：https://help.aliyun.com/zh/oss/user-guide/create-buckets-2

### 1.5 文件存储 NAS（PVC 存储）
- 控制台：文件存储 NAS → 创建文件系统
- 关键配置：
  - 类型：通用型 NAS（或与奥创一致）
  - VPC：选 1.1 创建的 VPC
- 挂载到 ACK 后，K8s 用存储类 `alibabacloud-cnfs-nas`（或奥驰侧等价存储类）
- 文档：https://help.aliyun.com/zh/nas/product-overview/what-is-nas

### 1.6 ACK 集群
- 控制台：容器服务 ACK → 创建集群 → 标准托管版（ACK Pro，支持 ALB）
- 关键配置：
  - Kubernetes 版本：与奥创一致（**迁移前查奥创版本**）
  - VPC：选 1.1 创建的 VPC
  - 节点池：测试环境 2 个节点（2C4G 或 4C8G）
- 创建后配置 kubectl（控制台「集群信息」→「连接信息」）
- 文档：https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/create-an-ack-managed-cluster

### 1.7 ALB 负载均衡 + 域名
- 控制台：应用型负载均衡 ALB → 创建实例（VPC 选 1.1）
- 域名：`api-dealclaw.datathink.com`（DNS 解析到奥驰 ALB）
- TLS 证书：迁移 `ultronx-tls` 或重新签发
- 文档：https://help.aliyun.com/zh/slb/application-load-balancer/

### 1.8 确认清单（Phase 1 完成标志）

- [ ] VPC + 交换机就绪
- [ ] RDS 实例 + `dealclaw_test` 库 + `app_user` 账号就绪
- [ ] ACR 命名空间 `dealclaw` + RAM 子账号就绪
- [ ] OSS bucket `dealclaw-backup` + RAM 子账号就绪
- [ ] NAS 文件系统就绪
- [ ] ACK 集群就绪 + kubectl 可访问
- [ ] ALB + 域名 + TLS 就绪

---

## 二、数据库迁移（Phase 2，DTS）

> DTS 在线迁移，支持全量 + 增量，停机时间短。

### 2.1 前置
1. 开通数据传输服务 DTS
2. 确认源（奥创 RDS）可被 DTS 访问（白名单放行 DTS IP 段）

### 2.2 创建同步任务
1. 控制台：数据传输 DTS → 创建同步任务 → 「PostgreSQL → PostgreSQL」
2. 源库：奥创 RDS（`pgm-uf6r5j1612a482a5.pg.rds.aliyuncs.com:5432/dealclaw_test`）
3. 目标库：奥驰 RDS（1.2 创建）
4. 同步类型：**结构迁移 + 全量数据迁移 + 增量同步**
5. 同步对象：`dealclaw_test` 库所有表

### 2.3 预检查 + 启动
1. 运行预检查（DTS 自动校验源/目标连通、权限、表结构）
2. 预检查通过后启动
3. 监控全量阶段进度 → 进入增量阶段

### 2.4 迁移期间
- **暂停 onboarding**（避免新租户写入源库）
- 全量完成后，增量追平后切换

### 2.5 校验
- 表数量、行数对比
- 关键表抽样：`tenants`、`skill_prices`、`plan_templates`、credits accounts

> 文档：https://help.aliyun.com/zh/dts/user-guide/create-a-synchronization-task

---

## 三、镜像迁移（Phase 3）

### 3.1 方案
ACR 跨账号镜像同步（用 `skopeo` 或 `crane`）。

### 3.2 同步清单
8 个服务镜像 + 备份镜像，从奥创 ACR 复制到奥驰 ACR：

```
central-gateway, provisioning-service, nexus-gateway, credits-ledger,
ops-agent, admin-dashboard, dealclaw-agent, mock-agent, ossutil:2.2.1
```

```bash
# 示例（需奥创 ACR 凭证 + 奥驰 ACR 凭证）
skopeo copy docker://ultronx-acr-registry-vpc.cn-shanghai.cr.aliyuncs.com/dealclaw/<img>:<tag> \
  docker://<奥驰ACR>/dealclaw/<img>:<tag> \
  --src-creds=... --dest-creds=...
```

### 3.3 备选
新建 Jenkins 后直接重新构建（见 Phase 4），推送到奥驰 ACR。

---

## 四、CI/CD 新建（Phase 4）

### 4.1 ArgoCD
1. 奥驰 ACK 上安装 ArgoCD：
   ```bash
   kubectl create namespace argocd
   kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml
   ```
2. 配置 Git 仓库 `vkubernetes/ultronx`（奥驰 GitLab 或复用）
3. 创建 Application（指向 `aochie` overlay，见 Phase 5）
- 文档：https://argo-cd.readthedocs.io/en/stable/getting_started/

### 4.2 Jenkins
1. 奥驰侧部署 Jenkins（ACK 部署或 ECS）
2. 配置流水线（复用奥创的 Jenkinsfile，改 ACR 地址）
3. 配置 ACR 凭证（1.3 的 RAM 子账号）
4. 触发一次全量构建，确认镜像推送到奥驰 ACR

---

## 五、服务部署（Phase 5，GitOps）

### 5.1 新增 `aochie` overlay
在 `vkubernetes/ultronx` 仓库 `cd/k8s/dealclaw/` 下新增 `aochie/` overlay，只覆盖差异项：

| 差异项 | 值 |
|--------|-----|
| 镜像地址 | `<奥驰ACR>/dealclaw/...` |
| dealclaw-db secret | 奥驰 RDS 连接串 |
| dealclaw-oss secret | 奥驰 OSS AccessKey |
| registry-secret-vpc | 奥驰 ACR 凭证 |
| ultronx-tls | 奥驰域名证书 |
| ingress host | `api-dealclaw.datathink.com` |

### 5.2 ArgoCD 同步
1. Application 指向 `aochie/` overlay
2. 同步 → 确认 8 个服务 Healthy + Synced

### 5.3 飞书回调更新
- onboarding 的 `botWebhookUrl` 需指向新域名（见部署环境变量）

---

## 六、验证与切换（Phase 6）

### 6.1 冒烟测试

- [ ] 扫码 onboarding 创建新租户 → namespace + PVC + Pod 正常
- [ ] 租户 agent 对话 + 计费（搜索买家扣 credit）
- [ ] 管理后台可访问
- [ ] 备份 Job 能写奥驰 OSS
- [ ] credits-ledger 余额查询正常
- [ ] DTS 增量同步停止 → 新数据写入奥驰库

### 6.2 域名切换
1. 验证通过后，DNS 切到 `api-dealclaw.datathink.com`
2. 飞书事件订阅地址更新

### 6.3 切换
- 测试环境：验证通过直接切换
- 保留奥创环境观察期，稳定后停

---

## 七、回滚方案

1. 奥创环境保留运行（不删），直到奥驰验证通过
2. 数据库：DTS 反向同步（或 pg_dump 备份回滚）
3. DNS 回切即可回滚

---

## 八、待补充信息（迁移前需要你提供）

1. 奥驰 ACR 仓库地址（创建后给我）
2. 奥驰 RDS 连接串（创建后给我）
3. 奥驰 OSS AccessKey（创建后给我）
4. 奥创 RDS 的 PG 版本 + ACK Kubernetes 版本（用于奥驰侧对齐）
5. 最终域名：`api-dealclaw.datathink.com`（已确认）
