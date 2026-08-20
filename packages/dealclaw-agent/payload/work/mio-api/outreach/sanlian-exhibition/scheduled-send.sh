#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

LOG="send-log.jsonl"
SEND_SCRIPT="/home/openclaw/makaron-openclaw/.openclaw-local/workspace/scripts/founder-direct/send-direct.mjs"
FROM="tiangengjun@meorient.com"

echo "=== Sanlian Batch Send Started $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG"

send() {
  local company="$1" email="$2" subject="$3" body="$4"
  echo "[$(date '+%H:%M:%S')] $company → $email" | tee -a "$LOG"
  node "$SEND_SCRIPT" --from "$FROM" --to "$email" --subject "$subject" --text "$(cat "$body")" 2>&1 && \
    echo "  ✅ $company sent" | tee -a "$LOG" || \
    echo "  ❌ $company FAILED" | tee -a "$LOG"
  sleep 5
}

# P0 (2 with email)
send "Minastek" "minastek@minastek.com.br" \
  "Gear Reducers from China @ MACHINEX — Direct From Manufacturer" \
  "emails/Minastek.txt"

send "RUD Correntes" "mazzon@exituscomercial.com" \
  "Heavy-Duty Gear Reducers for Conveyor Systems — MACHINEX São Paulo" \
  "emails/RUD_Correntes.txt"

# P1 (4)
send "Oriental Redutores" "evajo.rojas@gmail.com" \
  "Food Industry Gear Reducers — Meet Sanlian @ MACHINEX São Paulo" \
  "emails/Oriental_Redutores.txt"

send "ABECOM" "rogerio@abecom.com.br" \
  "Adding a Gear Reducer Line to Your SKF Portfolio — MACHINEX São Paulo" \
  "emails/ABECOM.txt"

send "Dieckmann" "ary@dieckmann.com.br" \
  "Gear Reducers for Conveyor & Lubrication Systems — Sanlian @ MACHINEX" \
  "emails/Dieckmann.txt"

send "MCM Fornos" "fabio@mcmfornos.com.br" \
  "High-Power Gear Reducers for Mining Equipment — Sanlian @ MACHINEX" \
  "emails/MCM_Fornos.txt"

# P2 (2)
send "Sopetra" "wagnerguilherme1@hotmail.com" \
  "Complete Your Power Transmission Line — Gear Reducers @ MACHINEX" \
  "emails/Sopetra.txt"

send "Lúcios Rolamentos" "tokiomkt@gmail.com" \
  "Gear Reducers to Complement Your Motion Solutions — Sanlian @ MACHINEX" \
  "emails/Lúcios.txt"

echo "=== Batch Complete $(date '+%Y-%m-%d %H:%M:%S') ===" >> "$LOG"
echo "DONE: 8 emails sent" | tee -a "$LOG"
