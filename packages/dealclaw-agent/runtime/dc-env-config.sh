#!/usr/bin/env bash
# dc-env-config.sh — 租户启动后把环境变量写入 work/mio-api/.env（相对路径）
#
# 由 entrypoint.sh 在启动 30s 后调用（后台，不阻塞主流程）。
# 把源码 work/mio-api/.env 的全部 key=value 硬编码在本脚本，写入租户工作区的
# work/mio-api/.env（相对路径，工作区根 = $OPENCLAW_WORKSPACE_DIR，默认 /data/workspace）。
set -euo pipefail

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"

# 相对路径写：先 cd 到工作区根，再写 work/mio-api/.env
cd "$WORKSPACE_DIR"
mkdir -p work/mio-api

cat > work/mio-api/.env <<'EOF'
# DealClaw mio-api 引擎密钥（租户镜像启动自动写入）
APOLLO_API_KEY=a2kijdyo07Wh3V8Xjsp8bA
MIO_CDP_SUPPLIER_ID=151897148668
MIO_V_OPEN_ID=ou_15273b08310b914c5f97b27af680c149
RESEND_API_KEY=re_4BUrVRx7_AKagCo6AeeaVY78UnHQ7Myx1
WEBHOOK_ADMIN_TOKEN=WLhEXgF4HMTPh1sttYFe2Wt2s8gjYfu
WQA1988_163_APP_PASSWORD=LAhTH37wZ7An9qJ2
SELECTION_APPCODE=97363dcc06ea48e3b71e7b5d97a29453
AROUNDDEAL_API_KEY=s-live-uwqedojjwtlsrobkctglpvnaatkmyxgu
UN_COMTRADE_API_KEY=f2bca70bd96e4827ab3acef024a5e2af
WTO_API_KEY=265a974f6afa4eed89e080d97a4bf21e
EOF

echo "[dc-env-config] 已写入 work/mio-api/.env"
