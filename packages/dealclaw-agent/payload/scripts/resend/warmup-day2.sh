#!/bin/bash
# scripts/resend/warmup-day2.sh — 海诺→Osculati Day 2 真人版 5封
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export RESEND_API_KEY="re_XPud6dfo_9SA2Rn2ntkmcETQhuL6v28v6"

FROM='Tian <v@send.mail.dogarm.top>'
SUBJECT="Trefoil and Ankerplex — stainless steel casting question"

HTML=$(cat <<'EOF'
<p>Hi,</p>

<p>Just saw your 2026 Master Catalogue — 1,232 pages, that's a serious piece of work. Noticed the new Trefoil anchors come in mirror-polished AISI 316 cast steel, and the Ankerplex folding series too.</p>

<p>We're a precision investment casting foundry in Qingdao — stainless steel marine hardware is what we do every day. If your in-house anchor line uses third-party casting suppliers, I have a quick question about your current tolerances.</p>

<p>Curious if it's worth a conversation.</p>

<p>Tian</p>
EOF
)

RECIPIENTS=(
  "gengjuntian0914@gmail.com"
  "tiangengnjun@meorient.com"
  "cui_turing@163.com"
  "wangqiang.davi@gmail.com"
  "judyjhy@gmail.com"
)

LOGFILE="$SCRIPT_DIR/warmup-day2-$(date +%Y%m%d-%H%M%S).log"

echo "=== Hainel → Osculati Warmup Day 2 ===" | tee "$LOGFILE"
echo "Started at $(date '+%Y-%m-%d %H:%M:%S %Z')" | tee -a "$LOGFILE"
echo "From: $FROM" | tee -a "$LOGFILE"
echo "Total: ${#RECIPIENTS[@]} emails" | tee -a "$LOGFILE"
echo "" | tee -a "$LOGFILE"

SUCCESS=0
FAIL=0

for i in "${!RECIPIENTS[@]}"; do
  TO="${RECIPIENTS[$i]}"
  NUM=$((i + 1))
  
  if [ "$NUM" -gt 1 ]; then
    DELAY=$((300 + RANDOM % 300))
    echo "  ⏳ Waiting ${DELAY}s before email #${NUM}..." | tee -a "$LOGFILE"
    sleep "$DELAY"
  fi
  
  echo "[#${NUM}/5] Sending to $TO at $(date '+%H:%M:%S')..." | tee -a "$LOGFILE"
  
  RESULT=$(node "$SCRIPT_DIR/send.mjs" \
    --from "$FROM" \
    --to "$TO" \
    --subject "$SUBJECT" \
    --html "$HTML" 2>&1)
  
  echo "$RESULT" >> "$LOGFILE"
  
  EMAIL_ID=$(echo "$RESULT" | grep -o '"id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
  
  if [ -n "$EMAIL_ID" ]; then
    echo "  ✅ #${NUM} Sent: $EMAIL_ID" | tee -a "$LOGFILE"
    SUCCESS=$((SUCCESS + 1))
  else
    echo "  ❌ #${NUM} Failed" | tee -a "$LOGFILE"
    FAIL=$((FAIL + 1))
  fi
done

echo "" | tee -a "$LOGFILE"
echo "=== Done at $(date '+%Y-%m-%d %H:%M:%S %Z') ===" | tee -a "$LOGFILE"
echo "Sent: $SUCCESS, Failed: $FAIL" | tee -a "$LOGFILE"
