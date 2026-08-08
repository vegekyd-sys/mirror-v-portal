#!/bin/bash
# DealClaw — start all services for internal test

set -e
ROOT="/home/openclaw/makaron-openclaw/.openclaw-local/workspace/dealclaw"
DB="postgresql://postgres:***@localhost:5432/dealclaw_test"

export DATABASE_URL="$DB"

# Kill any existing dealclaw processes
pkill -f "packages/.*/src/index" 2>/dev/null || true
sleep 1

echo "=== Starting services ==="

# 1. Provisioning Service (8082)
cd "$ROOT/packages/provisioning-service"
npx tsx src/index.ts &
echo "provisioning-service PID=$!"

# 2. Credits Ledger (8081)
cd "$ROOT/packages/credits-ledger"
DATABASE_URL="$DB" PORT=8081 npx tsx src/index.ts &
echo "credits-ledger PID=$!"

# 3. Mock Agent (8086)
cd "$ROOT/packages/mock-agent"
PORT=8086 npx tsx src/index.ts &
echo "mock-agent PID=$!"

# 4. Central Gateway (8085) — needs provisioning URL
cd "$ROOT/packages/central-gateway"
PROVISIONING_SERVICE_URL="http://127.0.0.1:8082" BASE_URL="http://43.156.232.2:8085" PORT=8085 npx tsx src/index.ts &
echo "central-gateway PID=$!"

echo "=== All services started ==="
sleep 3
echo ""
echo "Testing health endpoints..."
curl -s http://127.0.0.1:8085/healthz | head -c 200
echo ""
curl -s http://127.0.0.1:8082/healthz | head -c 200
echo ""
curl -s http://127.0.0.1:8081/healthz | head -c 200
echo ""
curl -s http://127.0.0.1:8086/healthz | head -c 200
echo ""
echo "=== Done ==="
