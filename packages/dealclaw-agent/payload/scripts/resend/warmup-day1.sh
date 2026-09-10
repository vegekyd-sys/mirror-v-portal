#!/bin/bash
# scripts/resend/warmup-day1.sh — 海诺铸业 → Osculati 冷启动首日5封预热
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSPACE="$(cd "$SCRIPT_DIR/../.." && pwd)"

export RESEND_API_KEY="re_XPud6dfo_9SA2Rn2ntkmcETQhuL6v28v6"

FROM='Hainel Casting <v@send.mail.dogarm.top>'
SUBJECT="Precision investment castings for marine hardware — IATF 16949 certified"

HTML=$(cat <<'EOF'
<p>Hi Osculati team,</p>

<p>I'm reaching out from <strong>Hainel Casting</strong>, a precision investment casting foundry based in Qingdao, China. We've been supplying marine-grade stainless steel components to European clients for over 20 years, and Osculati has been on our radar as a natural fit.</p>

<p>A few quick facts about us:</p>

<ul>
  <li><strong>Marine hardware is our sweet spot</strong> — deck hardware, hinges, cleats, stanchion bases, door locks, underwater equipment components</li>
  <li><strong>IATF 16949 + ISO 9001 certified</strong> — automotive-grade process control, applied to every part we ship</li>
  <li><strong>Full in-house</strong>: tooling → lost-wax casting → heat treatment → robotic polishing → CNC machining → QC</li>
  <li><strong>Materials</strong>: 304, 316, 316L, duplex stainless steels, plus aluminum and copper alloys</li>
</ul>

<p>We understand Osculati designs and manufactures over 7,000 in-house products. If you're sourcing precision cast stainless steel components for any of those lines, I'd love to learn more about your requirements.</p>

<p>Would it make sense to connect with the right person on your sourcing team?</p>

<p>
Best regards,<br>
<strong>Hainel Casting (Qingdao) Co., Ltd.</strong><br>
v@send.mail.dogarm.top
</p>
EOF
)

RECIPIENTS=(
  "gengjuntian0914@gmail.com"
  "tiangengnjun@meorient.com"
  "cui_turing@163.com"
  "wangqiang.davi@gmail.com"
  "judyjhy@gmail.com"
)

LOGFILE="$SCRIPT_DIR/warmup-day1-$(date +%Y%m%d-%H%M%S).log"

echo "=== Hainel → Osculati Warmup Day 1 ===" | tee "$LOGFILE"
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
    DELAY=$((300 + RANDOM % 300))  # 5-10 min
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
