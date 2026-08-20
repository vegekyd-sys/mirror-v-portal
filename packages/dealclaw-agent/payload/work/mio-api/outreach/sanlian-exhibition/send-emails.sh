#!/bin/bash
# sanlian-batch-send.sh — Batch send exhibition invitation emails
# Usage: bash sanlian-batch-send.sh [--dry-run]

set -euo pipefail
DRY_RUN="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/send-log.jsonl"
mkdir -p "$SCRIPT_DIR"

FROM_EMAIL="tiangengjun@meorient.com"
FROM_NAME="Xue Liang / Sanlian Transmission"

declare -A EMAILS=(
  ["Minastek"]="minastek@minastek.com.br"
  ["RUD Correntes"]="mazzon@exituscomercial.com"
  ["Oriental Redutores"]="evajo.rojas@gmail.com"
  ["ABECOM"]="rogerio@abecom.com.br"
  ["Dieckmann"]="ary@dieckmann.com.br"
  ["MCM Fornos"]="fabio@mcmfornos.com.br"
  ["Sopetra"]="wagnerguilherme1@hotmail.com"
  ["Lúcios"]="tokiomkt@gmail.com"
)

declare -A SUBJECTS=(
  ["Minastek"]="Gear Reducers from China @ MACHINEX — Direct From Manufacturer"
  ["RUD Correntes"]="Heavy-Duty Gear Reducers for Conveyor Systems — MACHINEX São Paulo"
  ["Oriental Redutores"]="Food Industry Gear Reducers — Meet Sanlian @ MACHINEX São Paulo"
  ["ABECOM"]="Adding a Gear Reducer Line to Your SKF Portfolio — MACHINEX São Paulo"
  ["Dieckmann"]="Gear Reducers for Conveyor & Lubrication Systems — Sanlian @ MACHINEX"
  ["MCM Fornos"]="High-Power Gear Reducers for Mining Equipment — Sanlian @ MACHINEX"
  ["Sopetra"]="Complete Your Power Transmission Line — Gear Reducers @ MACHINEX"
  ["Lúcios"]="Gear Reducers to Complement Your Motion Solutions — Sanlian @ MACHINEX"
)

send_one() {
  local company="$1" email="$2" subject="$3"
  local body_file="$SCRIPT_DIR/emails/${company// /_}.txt"

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sending to $company <$email>..."

  if [ "$DRY_RUN" = "--dry-run" ]; then
    echo "  [DRY RUN] Would send: $subject"
    echo "{\"company\":\"$company\",\"email\":\"$email\",\"status\":\"dry_run\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$LOG_FILE"
    return 0
  fi

  local result
  result=$(node "$HOME/makaron-openclaw/.openclaw-local/workspace/scripts/founder-direct/send-direct.mjs" \
    --from "$FROM_EMAIL" \
    --to "$email" \
    --subject "$subject" \
    --text "$(cat "$body_file")" 2>&1) || true

  if echo "$result" | grep -q "Message sent\|250\|OK"; then
    echo "  ✅ Sent"
    echo "{\"company\":\"$company\",\"email\":\"$email\",\"status\":\"sent\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$LOG_FILE"
  else
    echo "  ❌ Failed: $(echo "$result" | head -1)"
    echo "{\"company\":\"$company\",\"email\":\"$email\",\"status\":\"failed\",\"error\":\"$(echo "$result" | head -1 | sed 's/"/\\"/g')\",\"time\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" >> "$LOG_FILE"
  fi
}

# Send P1-P2 companies with email addresses
for company in "Oriental Redutores" "ABECOM" "Dieckmann" "MCM Fornos" "Sopetra" "Lúcios"; do
  email="${EMAILS[$company]}"
  subject="${SUBJECTS[$company]}"
  send_one "$company" "$email" "$subject"
  sleep 3  # Rate limit: space out sends
done

echo "Done. Log: $LOG_FILE"
