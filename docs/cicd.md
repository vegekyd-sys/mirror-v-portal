# CI/CD 方案

> 版本: v0.3 | 2026-07-27 | Author: V
> CI: Jenkins | Registry: 阿里云 ACR | CD: ArgoCD (GitOps) | K8s: 阿里云 ACK

## 0. 基础设施清单

| 组件 | 地址 | 状态 |
|------|------|------|
| YAML 部署仓库 | `git.versa-ai.com/vkubernetes/ultronx.git` | ✅ 已确认 |
| 业务代码仓库 | `git.versa-ai.com/d12/dealclaw.git` | ✅ 已确认 |
| Jenkins | `devops-tools.ultronx.tech:8443/jenkins/` | ✅ 可访问 |
| ArgoCD | `devops-tools.ultronx.tech:8443/argocd/` | ✅ 可访问 |
| 阿里云 ACR | `ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com/dealclaw` | ✅ 已确认 |
| YAML 部署路径 | `vkubernetes/ultronx.git` → `cd/k8s/` | ⬜ 待迁移 |

## 1. GitOps 流程

```
开发者 push ──▶ dealclaw.git ──▶ Jenkins ──▶ Build Image ──▶ ACR
                     │                  │
                     │                  └── 修改 YAML ──▶ vkubernetes/ultronx.git
                     │                                               │
                     │                                          ArgoCD (自动 sync)
                     │                                               │
                     └──────────────────────────▶ 阿里云 ACK ◀────────┘
```

**步骤**：
1. 开发者提交代码到 `d12/dealclaw.git`
2. Jenkins Job 选择分支+环境 → 构建 Docker 镜像
3. 镜像 push 到阿里云 ACR
4. Jenkins 修改 YAML 部署文件（镜像 tag），提交到 `vkubernetes/ultronx.git`
5. ArgoCD 检测到 YAML 仓库变更 → 自动 sync 到 ACK

## 2. 总体设计（历史版本）

```
Git Push ──▶ Jenkins Pipeline ──▶ Build & Test ──▶ 阿里云 ACR ──▶ K8s (GitOps / kubectl)
                  │                    │                  │                │
                  │  lint              │  unit test       │  公共镜像       │  Staging → 灰度 → 全量
                  │  typecheck         │  integration test│                │
                  │                    │  kind test (K8s) │                │
```

## 2. Jenkins Pipeline

### 2.1 Jenkinsfile

```groovy
// Jenkinsfile
pipeline {
    agent { label 'dealclaw-builder' }      // 王建配置的 Jenkins agent

    environment {
        // ACR
        ACR_REGISTRY = 'ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com'
        ACR_NAMESPACE = 'dealclaw'
        IMAGE_TAG = "${env.GIT_COMMIT?.take(8) ?: 'latest'}"

        // Node
        PNPM_HOME = "${WORKSPACE}/.pnpm-home"
    }

    stages {

        stage('Install') {
            steps {
                sh 'corepack enable'
                sh 'pnpm install --frozen-lockfile'
            }
        }

        stage('Lint & TypeCheck') {
            parallel {
                stage('Lint') {
                    steps { sh 'pnpm lint' }
                }
                stage('TypeCheck') {
                    steps { sh 'pnpm typecheck' }
                }
            }
        }

        stage('Unit Tests') {
            steps {
                sh 'pnpm test'
            }
            post {
                always {
                    junit 'packages/*/test-results/*.xml'
                    publishCoverage adapters: [coberturaAdapter('coverage/cobertura-coverage.xml')]
                }
            }
        }

        stage('Integration Tests') {
            parallel {
                stage('Credits Ledger (PG)') {
                    steps {
                        sh '''
                            docker run -d --name dealclaw-test-pg \
                                -e POSTGRES_PASSWORD=*** \
                                -p 5433:5432 postgres:16-alpine
                            sleep 3
                            DATABASE_URL=postgresql://postgres:***@localhost:5433/dealclaw_test \
                                pnpm --filter @dealclaw/credits-ledger test
                            docker rm -f dealclaw-test-pg
                        '''
                    }
                }

                stage('Provisioning (kind)') {
                    steps {
                        sh '''
                            kind create cluster --name dealclaw-ci --wait 90s
                            pnpm --filter @dealclaw/provisioning test:k8s
                            kind delete cluster --name dealclaw-ci
                        '''
                    }
                }

                stage('Payment (Sandbox)') {
                    when { expression { env.ALIPAY_SANDBOX_APP_ID != null } }
                    steps {
                        dir('packages/payment-service') {
                            sh '''
                                pip install -r requirements-dev.txt
                                ALIPAY_SANDBOX=true pytest
                            '''
                        }
                    }
                }
            }
        }

        stage('Build & Push Images') {
            when { branch 'master' }
            steps {
                script {
                    docker.withRegistry(
                        "https://${ACR_REGISTRY}",
                        'acr-credentials'       // Jenkins Credential ID → 王建配置
                    ) {
                        def services = [
                            'nexus-gateway',
                            'credits-ledger',
                            'provisioning',
                            'ops-agent',
                            'central-gateway',
                            'onboarding',
                            'payment',
                            'dealclaw-agent',
                        ]
                        parallel services.collectEntries { svc ->
                            [("build-${svc}"): {
                                def img = "${ACR_REGISTRY}/${ACR_NAMESPACE}/${svc}"
                                sh "docker build -t ${img}:${IMAGE_TAG} packages/${svc}/"
                                sh "docker tag ${img}:${IMAGE_TAG} ${img}:latest"
                                sh "docker push ${img}:${IMAGE_TAG}"
                                sh "docker push ${img}:latest"
                            }]
                        }
                    }
                }
            }
        }

        stage('Deploy Staging') {
            when { branch 'master' }
            steps {
                script {
                    // 更新 k8s manifests 中的镜像 tag
                    def services = ['nexus-gateway', 'credits-ledger', 'provisioning', 'ops-agent']
                    services.each { svc ->
                        def img = "${ACR_REGISTRY}/${ACR_NAMESPACE}/${svc}:${IMAGE_TAG}"
                        sh "sed -i 's|image: .*/${svc}:.*|image: ${img}|g' k8s/overlays/staging/${svc}/deployment.yaml"
                    }

                    // 方案A: ArgoCD (自动同步)
                    // ArgoCD 检测到 k8s/ manifests 变化 → 自动 sync

                    // 方案B: kubectl apply (直接部署)
                    // withKubeConfig([credentialsId: 'staging-kubeconfig']) {
                    //     sh 'kubectl apply -k k8s/overlays/staging/'
                    // }

                    // 等待就绪
                    services.each { svc ->
                        sh """
                            kubectl rollout status deployment/${svc} \
                                -n dealclaw-staging --timeout=120s || true
                        """
                    }

                    // 冒烟检查
                    sh 'curl -fsS http://nexus-gateway.dealclaw-staging/healthz'
                }
            }
        }
    }

    post {
        failure {
            // 通知到飞书 DealClaw Nexus 群
            // 或发邮件给王建+赵大师
        }
    }
}
```

### 2.2 Jenkins Agent 要求

```yaml
# Jenkins agent 环境依赖（王建配置）
label: dealclaw-builder

预装:
  - Node.js 22+
  - pnpm (corepack enable)
  - Docker (build + kind)
  - kubectl
  - Python 3.12 (payment 模块)

Docker 权限:
  - docker build / push (推 ACR)
  - docker run (Test containers, kind)
```

### 2.3 Jenkins Credentials（王建配置）

| Credential ID | 类型 | 说明 |
|---------------|------|------|
| `acr-credentials` | Username/Password | 阿里云 ACR 推送凭证 |
| `staging-kubeconfig` | Secret file | Staging K8s 集群 kubeconfig |
| `prod-kubeconfig` | Secret file | 生产 K8s 集群 kubeconfig |
| `alipay-sandbox-appid` | Secret text | 支付宝沙箱 APPID |
| `alipay-sandbox-private-key` | Secret text | 支付宝沙箱商户私钥 |
| `alipay-sandbox-public-key` | Secret text | 支付宝沙箱公钥 |

## 3. 阿里云 ACR 镜像管理

### 3.1 镜像命名规范

```
ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com/dealclaw/${SERVICE}:${TAG}

TAG 规则:
  latest                → 最新 master
  ${GIT_COMMIT_SHORT}   → 每次 master commit (灰度/追溯)
  v1.0.0                → 正式 release tag
```

### 3.2 镜像列表

| 服务 | ACR 镜像 | 大小预估 |
|------|---------|---------|
| nexus-gateway | dealclaw/nexus-gateway | ~120MB |
| credits-ledger | dealclaw/credits-ledger | ~120MB |
| provisioning | dealclaw/provisioning | ~120MB |
| ops-agent | dealclaw/ops-agent | ~120MB |
| central-gateway | dealclaw/central-gateway | ~120MB |
| onboarding | dealclaw/onboarding | ~120MB |
| payment | dealclaw/payment | ~200MB |
| dealclaw-agent | dealclaw/dealclaw-agent | ~250MB |

### 3.3 ACR 登录

```bash
# Jenkins agent 上一次性配置（王建）:
docker login --username=<阿里云账号> ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com
# 密码使用阿里云 RAM 子账号的固定密码

# K8s 节点上配置 imagePullSecret（王建）:
kubectl create secret docker-registry acr-pull-secret \
    --docker-server=ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com \
    --docker-username=<阿里云账号> \
    --docker-password=<密码> \
    -n dealclaw-staging
```

## 4. 部署策略

### 4.1 方案对比

| 方案 | 推荐度 | 适合场景 |
|------|--------|---------|
| **kubectl apply** ✅ | 起步推荐 | 服务少（< 10），更新频率低 |
| ArgoCD | 后续升级 | 服务多，需要 GitOps/自动回滚 |

**建议先走 kubectl apply**，后续服务多了再补 ArgoCD。

### 4.2 K8s 目录结构

```
k8s/
├── base/                           # 基础配置（公共）
│   ├── nexus-gateway/
│   │   ├── deployment.yaml
│   │   ├── service.yaml
│   │   └── kustomization.yaml
│   ├── credits-ledger/
│   ├── provisioning/
│   ├── ops-agent/
│   ├── central-gateway/
│   ├── onboarding/
│   ├── payment/
│   └── dealclaw-agent/
│
├── overlays/
│   ├── staging/                    # Staging 环境
│   │   ├── kustomization.yaml
│   │   ├── namespace.yaml
│   │   └── */deployment.yaml
│   └── production/                 # 生产环境
│       ├── kustomization.yaml
│       ├── namespace.yaml
│       └── */deployment.yaml
│
└── tenants/                        # 租户模板（Provisioning 使用）
    └── tenant-template/
        ├── namespace.yaml
        ├── network-policy.yaml
        ├── gateway-deployment.yaml
        ├── agent-deployment.yaml
        └── resource-quota.yaml
```

### 4.3 部署命令

```bash
# Staging 部署
kubectl apply -k k8s/overlays/staging/

# 生产全量部署（手动/灰度后）
kubectl apply -k k8s/overlays/production/

# 单个租户 Agent 灰度（同环境 namespace 内）
kubectl set image deployment/dealclaw-agent-cust-001 \
    dealclaw-agent=ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com/dealclaw/dealclaw-agent:${NEW_TAG} \
    -n dealclaw-prod
```

## 5. 灰度升级策略

按 v3.0 文档第九章：

```
Staging 验证 (Jenkins 自动) → 1 个客户 Pod (手动) → 10% → 50% → 100%
                                    │
                                    ├── 监控: Pod Ready / 5xx率 / Credits 正确
                                    ├── 异常: kubectl rollout undo
                                    └── 正常: 推进到下一阶段
```

### 灰度命令

```bash
# 1. 先在 staging 跑通
kubectl apply -k k8s/overlays/staging/
kubectl rollout status deployment/nexus-gateway -n dealclaw-staging --timeout=120s
curl -fsS http://nexus-gateway.dealclaw-staging/healthz

# 2. 选 1 个低风险租户灰度（只升级该租户的 agent）
kubectl set image deployment/dealclaw-agent-cust-test \
    dealclaw-agent=ultronx-acr-registry.cn-shanghai.cr.aliyuncs.com/dealclaw/dealclaw-agent:abc12345 \
    -n dealclaw-prod
# 观察 24h

# 3. 扩大灰度 — 更新 kustomization overlay
# 编辑 k8s/overlays/production/nexus-gateway/kustomization.yaml
# images:
#   - name: dealclaw/nexus-gateway
#     newTag: abc12345
kubectl apply -k k8s/overlays/production/

# 4. 回滚（异常时）
kubectl rollout undo deployment/dealclaw-agent-cust-001 -n dealclaw-prod
```

## 6. 环境管理

| 环境 | 用途 | K8s Namespace | 数据 | 镜像来源 |
|------|------|--------------|------|---------|
| **Staging** | CI 自动部署 + 冒烟 | dealclaw-staging | 独立 PG | latest tag |
| **Production** | 客户生产 | dealclaw-prod | 生产 PG | ${commit_sha} tag |
| **Sandbox** | 支付宝 API 测试 | 本地 kind / CI | 沙箱 DB | CI 临时 |

## 7. 需要王建配合的事项

| 事项 | 说明 | 优先级 |
|------|------|--------|
| **Jenkins Agent** | 配置 `dealclaw-builder` label 的 agent（Node22 + Docker + kubectl） | 🔴 P0 |
| **Jenkins Credentials** | 配置 6 个 credential（ACR / kubeconfig / 支付宝沙箱） | 🔴 P0 |
| **阿里云 ACR 命名空间** | 创建 `dealclaw` 命名空间 + 推送账号 | 🔴 P0 |
| **K8s imagePullSecret** | Staging 和 Prod Namespace 配置 ACR 拉取凭证 | 🔴 P0 |
| **Staging Namespace** | 创建 `dealclaw-staging` NS + 独立 PG | 🟡 P1 |
| **K8s 集群访问** | Jenkins agent 上配置 kubeconfig（staging NS 权限） | 🟡 P1 |
| **灰度审批流程** | 从手动触发 → 未来自动化 | ⚪ P2 |

## 8. 发布 Checklist

每次 master 合并后 Jenkins 自动触发 Staging，手动推进灰度：

- [ ] Jenkins: lint + typecheck 通过
- [ ] Jenkins: unit tests 通过（覆盖率 ≥ 80%）
- [ ] Jenkins: integration tests 通过
- [ ] Jenkins: build + push 镜像到 ACR
- [ ] Jenkins: Staging 部署 + 健康检查
- [ ] 手动: 冒烟测试（curl /healthz + 发送测试消息）
- [ ] 手动: 灰度 1 个客户 Pod → 观察 24h
- [ ] 手动: 扩展到 10% → 50% → 100%
- [ ] 监控: 5xx < 1%，Credits 扣减正确，无异常审计日志
