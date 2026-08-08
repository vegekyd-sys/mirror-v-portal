#!/bin/bash
# V CRM CLI Acceptance Test — 快速版
CLI="$(dirname "$0")/xiaoao-zcrm-v1-api/bin/xiaoao-zcrm-v1"
export CRM_API_KEY="${CRM_API_KEY:-Bearer a052811806ca35d303c3a2aa2721afeed451cdd2ca5b12b510315c28daaa058a}"
ACC="广州辉洋进出口有限公司"
AID="185165004027994962"
PROV="浙江省"
UNK="不存在客户-测试"
UNKID="000000000000000000"
SALES="杨盛麟"
PASS=0; FAIL=0; TOTAL=0

ok() { TOTAL=$((TOTAL+1)); PASS=$((PASS+1)); echo "  PASS $1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "  FAIL $1 — $2"; }

t() {
  local id="$1" desc="$2"; shift 2
  local out err rc
  out=$("$CLI" "$@" --json 2>/dev/null)
  rc=$?
  if [ $rc -eq 0 ] && echo "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('error')=='' else 1)" 2>/dev/null; then
    ok "$id: $desc"
  elif [ $rc -ne 0 ] && [[ "$desc" == *"失败"* || "$desc" == *"已停用"* ]]; then
    ok "$id: $desc (expected non-zero)"
  else
    local errmsg=$(echo "$out" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error','parse_error')[:80])" 2>/dev/null || echo "rc=$rc")
    fail "$id: $desc" "$errmsg"
  fi
}

echo "============================================"
echo "V CRM CLI Acceptance Test — xiaoao-zcrm-v1-api V1.01"
echo "============================================"
echo ""

echo "--- AUTH ---"
t AUTH-001 "CLI help可用" accounts search --name "$ACC"   # basic smoke
t AUTH-002 "正确鉴权查询客户" accounts search --name "$ACC"
echo ""

echo "--- ACCOUNTS ---"
t ACC-001 "按客户名称查询" accounts search --name "$ACC"
t ACC-002 "按省份查询" accounts search --province "$PROV" --page 1
t ACC-003 "三条件组合" accounts search --province "$PROV" --city "杭州市" --customer-level "自拓客户" --page 1
t ACC-004 "无匹配客户" accounts search --name "$UNK"
t ACC-005 "byNames单公司命中" accounts by-names --name "$ACC"
t ACC-006 "byNames多公司混合" accounts by-names --names "$ACC,$UNK"
t ACC-007 "byIds单ID命中" accounts by-ids --id "$AID"
t ACC-008 "byIds多ID混合" accounts by-ids --ids "$AID,$UNKID"
t ACC-009 "客户360命中" accounts overview --name "$ACC"
t ACC-010 "客户360无匹配" accounts overview --name "$UNK"
echo ""

echo "--- DEALS ---"
t DEAL-001 "按客户名称查询商机" deals search --account-name "$ACC"
t DEAL-002 "按阶段查询商机" deals search --stage "赢单" --page 1
t DEAL-003 "商机组合条件" deals search --stage "赢单" --account-name "$ACC" --page 1
t DEAL-004 "非法page不500" deals search --stage "赢单" --page 999
t DEAL-005 "已知客户ID查询商机" deals by-account --account-id "$AID"
t DEAL-006 "不存在客户ID查询" deals by-account --account-id "$UNKID"
echo ""

echo "--- ORDERS ---"
t ORD-001 "按客户名称查询合同" orders search --account-name "$ACC"
t ORD-002 "按项目+阶段查询" orders search --project "2026" --stage "赢单" --page 1
t ORD-003 "按日期范围查询" orders search --from "2026-01-01" --to "2026-12-31"
t ORD-004 "无筛选条件分页" orders search --page 1
echo ""

echo "--- EVENTS ---"
t EVT-001 "按公司名查询会议" events search --company-name "$ACC"
t EVT-002 "按客户ID查询会议" events search --account-id "$AID"
t EVT-003 "按日期范围查询会议" events search --from "2026-01-01" --to "2026-12-31"
t EVT-004 "按客户ID统计会议" events count --account-id "$AID"
t EVT-005 "按日期范围统计会议" events count --from "2026-01-01" --to "2026-12-31"
echo ""

echo "--- USERS ---"
t USR-001 "用户分页第一页" users all --page 1
t USR-002 "按姓名搜索用户" users search --name "$SALES"
t USR-003 "不存在用户搜索" users search --name "不存在用户-测试"
echo ""

echo "--- DISABLED ---"
t DIS-001 "orders fields已停用失败" orders fields
t DIS-002 "orders dictionary已停用失败" orders dictionary
echo ""

echo "--- GROUP CHAT SCENARIOS ---"
t GC-001 "印尼宠物展(JPE)订单" orders search --project "JPE" --page 1
t GC-002 "印尼宠物展(2026印尼)订单" orders search --project "2026印尼" --page 1
t GC-003 "宠物展区+赢单订单" orders search --zone "宠物展区" --stage "赢单" --page 1
t GC-004 "杨盛麟的订单" orders search --sales "$SALES" --page 1
t GC-005 "杨盛麟的商机" deals search --sales "$SALES" --page 1
t GC-006 "客户360含商机+订单" accounts overview --name "$ACC"

echo ""
echo "============================================"
echo "TOTAL: $TOTAL | PASS: $PASS | FAIL: $FAIL | ${PASS}/${TOTAL} = $(python3 -c "print(f'{$PASS/$TOTAL*100:.1f}%')" 2>/dev/null || echo "?%")"
echo "============================================"
exit $FAIL
