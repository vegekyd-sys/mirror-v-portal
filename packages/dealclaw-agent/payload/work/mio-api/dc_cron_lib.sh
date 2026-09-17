#!/bin/bash
# dc_cron_lib.sh — payload 侧 cron 注册公共库（走 OpenClaw Gateway scheduler）
#
# ── 为什么有这个文件 ────────────────────────────────────────────────────────
# 2026-09-16 晚 27 封定时开发信一封没发出去。根因不在发送逻辑，在调度器压根没挂上：
# inject_pending_send_cron.sh 往**系统 crontab** 写任务，而 agent 镜像里既没有
# `crontab` 命令也没有 cron 守护进程（`which crontab` → not found）。
# 注入脚本那行 `crontab -` 静默失败，队列在 pending 卡了一夜。
#
# 容器里唯一真实生效的调度器是 OpenClaw Gateway 内置 scheduler（`openclaw cron add`，
# 机制详见 runtime/README.md）。本库把 runtime/dc-cron-*.sh 的注册能力搬到 payload 侧，
# 让所有 inject_*_cron.sh 都走 Gateway cron —— **payload 里不许再出现 crontab**。
#
# ── 照抄 runtime/README.md 的三条硬约束 ─────────────────────────────────────
#   1. 幂等靠 `--declaration-key`，不要自己「先查存在就跳过」——那会让脚本改动
#      （换命令 / 换 env / 换超时）永远落不了地。
#   2. schedule 过一遍 runtime/dc-cron-converge.py 做三方合并，别把用户手改的时间
#      打回镜像默认值；读不到现状就**不注册**，下次重试。
#   3. 停用一律 `disable`，不要 `delete`：被删掉的声明式 job 下次容器启动会按
#      「不存在」重建，而 disable 扛得住滚动升级。
#
# ── 还有两条是这次事故换来的 ───────────────────────────────────────────────
#   4. 注册完必须回读 Gateway 复查，确认 job 真在、真启用；查不到就**非零退出**。
#      「注入脚本跑完没报错」不等于「任务挂上了」——上次就是栽在这里。
#   5. 任何一步读不到现状（gateway 不通、CLI 缺失、输出不是 JSON）都当**致命错误**，
#      绝不降级成「那就是没注册吧」——把故障说成现状正是上次没人发现的原因。
#
# ── 用法 ────────────────────────────────────────────────────────────────────
# 调用方设好 DC_CRON_* 配置变量后调 `dc_cron::main "$@"`，见 inject_*_cron.sh：
#
#   DC_CRON_TAG               日志前缀，如 pending-send
#   DC_CRON_DECL_KEY          declaration-key，全局唯一，如 dealclaw-pending-send
#   DC_CRON_NAME              job 名（默认同 DECL_KEY）
#   DC_CRON_SUMMARY           一句话说明，进 job description
#   DC_CRON_COMMAND           要跑的命令（openclaw 会包成 `sh -lc <命令>`）
#   DC_CRON_DEFAULT_EXPR      本脚本声明的默认 cron 表达式
#   DC_CRON_DEFAULT_TZ        默认时区（可被 DEALCLAW_CRON_TZ / --tz 覆盖）
#   DC_CRON_TIMEOUT_SECONDS   单次执行超时秒数（默认 600）
#   DC_CRON_CWD               命令工作目录（默认 DEALCLAW_MIO_DIR，再默认脚本所在目录）
#   DC_CRON_ENV               额外环境变量数组，元素形如 K=V（可不设）
#   DC_CRON_DUP_MATCH         查重用的命令子串（默认取 DC_CRON_COMMAND 的最后一段）
#   DC_CRON_LEGACY_MATCH      老 crontab 行的特征串数组，用来清理历史残留（可不设）
#   DC_CRON_REQUIRE_SUPPLIER  设为 1 时，注册前校验 MIO_CDP_SUPPLIER_ID 非空
#   DC_CRON_RUNTIME_SCRIPT    该 job 已由镜像层 runtime/dc-cron-*.sh 托管时填其文件名；
#                             inject 时直接委托给它，保持单一事实源
#
# 环境变量：
#   DEALCLAW_RUNTIME_DIR   runtime 脚本目录（默认 /opt/dealclaw/runtime）
#   DEALCLAW_MIO_DIR       mio-api 目录（默认脚本所在目录）
#   DEALCLAW_CRON_TZ       默认时区（优先级低于 --tz）

DC_CRON_LIB_VERSION="1"
DC_CRON_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEALCLAW_RUNTIME_DIR="${DEALCLAW_RUNTIME_DIR:-/opt/dealclaw/runtime}"

# ── 日志 ────────────────────────────────────────────────────────────────────

dc_cron::log()  { echo "[${DC_CRON_TAG:-dc-cron}] $*"; }
dc_cron::warn() { echo "[${DC_CRON_TAG:-dc-cron}] $*" >&2; }
dc_cron::die()  { echo "[${DC_CRON_TAG:-dc-cron}] $*" >&2; exit 1; }

# ── Gateway 取数 ────────────────────────────────────────────────────────────
#
# 取数统一用 _fetch_jobs 在**父 shell**里做，结果缓存到 _DC_CRON_JOBS_CACHE。
# 不在 `$(...)` 子 shell 里取——那里的 `exit 1` 只杀得掉子 shell，故障会被调用方
# 误读成「这条 job 不存在」，正是我们要根除的那种静默降级。

_DC_CRON_JOBS_CACHE=""

dc_cron::_require_cli() {
  command -v openclaw >/dev/null 2>&1 || dc_cron::die \
"找不到 openclaw CLI，无法注册 Gateway cron。容器里它应该在 PATH 里；本机请先装 openclaw。
    注意：这里**不会**退回系统 crontab —— 镜像里没有 cron 守护进程，写进去也不会跑。"
}

# 拉全量 job 列表（含 disabled）；任何异常都是致命的
dc_cron::_fetch_jobs() {
  local out
  out="$(openclaw cron list --all --json 2>&1)" || dc_cron::die \
    "openclaw cron list 失败（gateway 不通？）：${out}"
  # 用同一个解析器验一遍形状：合法 JSON 但没有 jobs 数组也算读失败。
  # 「读不出来」不能当成「一条 job 都没有」——那正是这次事故里没人察觉的那种降级。
  printf '%s' "$out" | python3 "${DC_CRON_LIB_DIR}/dc_cron_query.py" state --decl-key __shape_probe__ \
    >/dev/null || dc_cron::die "openclaw cron list 的输出看不懂（不是合法 JSON，或找不到 jobs 数组）：${out:0:300}"
  _DC_CRON_JOBS_CACHE="$out"
}

# dc_cron::_query <mode> [--match X] —— 见 dc_cron_query.py
# 返回 0=命中，1=没这条 job。缓存已在父 shell 校验过，这里不会有「读失败」态。
dc_cron::_query() {
  local mode="$1"; shift
  printf '%s' "$_DC_CRON_JOBS_CACHE" \
    | python3 "${DC_CRON_LIB_DIR}/dc_cron_query.py" "$mode" --decl-key "$DC_CRON_DECL_KEY" "$@"
}

dc_cron::_job_id() {
  local id
  id="$(dc_cron::_query id)" || return 1
  [[ -n "$id" ]] || return 1
  printf '%s' "$id"
}

# 解析租户 ID：优先进程环境，其次 mio-api/.env。
# 有些入口（dc_marketing_automation_cron.py 等）把 company-id 做成必填 CLI 参数，
# 注册时就得把值拼进命令里。取不到就**拒绝注册**——注册一条 --company-id 为空的 job，
# 等于把故障推迟到第一次触发时才暴露，正是这次事故的同款套路。
dc_cron::supplier_id() {
  local sid="${MIO_CDP_SUPPLIER_ID:-}"
  if [[ -z "$sid" && -f "${DC_CRON_LIB_DIR}/.env" ]]; then
    sid="$(sed -n 's/^[[:space:]]*MIO_CDP_SUPPLIER_ID[[:space:]]*=[[:space:]]*//p' \
      "${DC_CRON_LIB_DIR}/.env" | tail -n1 | tr -d '\042\047' | tr -d '\r')"
  fi
  # 去掉首尾空白：纯空白等同于没配，不能让它混过下面的非空校验
  sid="${sid#"${sid%%[![:space:]]*}"}"
  sid="${sid%"${sid##*[![:space:]]}"}"
  printf '%s' "$sid"
}

# ── 历史残留：系统 crontab 里的老行 ─────────────────────────────────────────
# 老版注入脚本在**有** crontab 的机器上（比如开发本机）确实写进去了。迁到 Gateway
# 之后必须把老行摘掉，否则同一个任务两个调度器一起跑。
dc_cron::_purge_legacy_crontab() {
  declare -p DC_CRON_LEGACY_MATCH >/dev/null 2>&1 || return 0
  command -v crontab >/dev/null 2>&1 || return 0

  local existing
  existing="$(crontab -l 2>/dev/null || true)"
  [[ -n "$existing" ]] || return 0

  local needle hit=0
  for needle in "${DC_CRON_LEGACY_MATCH[@]}"; do
    if grep -qF -- "$needle" <<<"$existing"; then hit=1; break; fi
  done
  (( hit )) || return 0

  local filtered="$existing"
  for needle in "${DC_CRON_LEGACY_MATCH[@]}"; do
    filtered="$(grep -vF -- "$needle" <<<"$filtered" || true)"
  done
  if printf '%s\n' "$filtered" | crontab -; then
    dc_cron::log "已从系统 crontab 摘掉历史残留行（该任务现在归 Gateway cron 管）"
  else
    dc_cron::warn "清理系统 crontab 残留失败，请手动 crontab -e 删掉旧行"
  fi
}

# ── 注册 ────────────────────────────────────────────────────────────────────

dc_cron::_add() {
  if [[ "${DC_CRON_REQUIRE_SUPPLIER:-0}" == "1" && -z "$(dc_cron::supplier_id)" ]]; then
    dc_cron::die "取不到 MIO_CDP_SUPPLIER_ID（进程环境和 ${DC_CRON_LIB_DIR}/.env 里都没有），拒绝注册一条身份为空的 job"
  fi

  local converge="${DEALCLAW_RUNTIME_DIR}/dc-cron-converge.py"
  local expr tz sched_source

  if [[ -f "$converge" ]]; then
    # schedule 三方合并：本脚本声明的默认值 vs 用户手改（见 runtime/dc-cron-converge.py）
    local sched_env
    sched_env="$(python3 "$converge" resolve \
      --decl-key "$DC_CRON_DECL_KEY" --cron "$DC_CRON_DEFAULT_EXPR" --tz "$DC_CRON_DEFAULT_TZ")" \
      || dc_cron::die "schedule 三方合并失败，本次不注册（宁可不注册，也不拿默认值盖掉用户手改的时间）"
    eval "$sched_env"
    expr="$DC_CRON_EXPR"; tz="$DC_CRON_TZ"; sched_source="$DC_CRON_SOURCE"
  else
    expr="$DC_CRON_DEFAULT_EXPR"; tz="$DC_CRON_DEFAULT_TZ"; sched_source="default-no-converge"
    dc_cron::warn "未找到 ${converge}，跳过 schedule 三方合并，直接用默认值（用户手改过的时间会被打回）"
  fi

  local args=(cron add --cron "$expr" --tz "$tz"
    --command "$DC_CRON_COMMAND" --command-cwd "$DC_CRON_CWD")
  if declare -p DC_CRON_ENV >/dev/null 2>&1; then
    local kv
    for kv in "${DC_CRON_ENV[@]}"; do args+=(--command-env "$kv"); done
  fi
  # --no-deliver：通知走各入口脚本内部逻辑，cron 层再投 stdout 是多余的，
  # 且默认 channel:last 在隔离会话里没有路由会直接报错
  args+=(--no-deliver
    --timeout-seconds "$DC_CRON_TIMEOUT_SECONDS"
    --declaration-key "$DC_CRON_DECL_KEY"
    --name "$DC_CRON_NAME"
    --description "${DC_CRON_SUMMARY}（${expr} @ ${tz}）")

  openclaw "${args[@]}" || dc_cron::die "openclaw cron add 失败，任务没挂上"

  # record 必须在 add 成功之后：提前记基线会让 add 失败时把现状误判成「用户改过」，
  # 默认值从此永远推不动（静默死锁，见 runtime/README.md 第四节）
  if [[ -f "$converge" ]]; then
    python3 "$converge" record \
      --decl-key "$DC_CRON_DECL_KEY" --cron "$DC_CRON_DEFAULT_EXPR" --tz "$DC_CRON_DEFAULT_TZ" \
      || dc_cron::warn "基线记录失败（不影响本次注册，但下次升级可能误判用户改过 schedule）"
  fi

  dc_cron::log "已同步（${expr} @ ${tz}，schedule 来源: ${sched_source}）"
}

# 注册后回读复查：这一步是 2026-09-16 事故的直接补丁，不允许省
dc_cron::_verify() {
  local summary
  summary="$(dc_cron::_query summary)" || dc_cron::die \
    "复查失败：Gateway 里找不到 declaration-key=${DC_CRON_DECL_KEY} 的 job。任务没挂上，别当成功。"
  dc_cron::log "复查通过，当前状态："
  printf '%s\n' "$summary"

  if [[ "$(dc_cron::_query state)" == "disabled" ]]; then
    dc_cron::warn "⚠️ 这条 job 处于**停用**状态，不会被触发。恢复：bash $(basename "$0") enable"
  fi
  dc_cron::_warn_dupes
}

# 抓「同一个任务被手工注册过第二份」——手工 add 出来的没有 declaration-key，
# converge 管不到它，会和声明式 job 并行触发。
dc_cron::_warn_dupes() {
  local dupes
  dupes="$(dc_cron::_query dupes --match "$DC_CRON_DUP_MATCH")" || return 0
  [[ -n "$dupes" ]] || return 0
  dc_cron::warn "⚠️ 还有命令里同样含「${DC_CRON_DUP_MATCH}」、但不归本条 declaration-key 管的 job："
  printf '%s\n' "$dupes" | sed 's/^/    /' >&2
  dc_cron::warn "    多半是手工 \`openclaw cron add\` 留下的重复调度器。确认后 openclaw cron rm <id> 清掉。"
}

# ── 动作 ────────────────────────────────────────────────────────────────────

dc_cron::inject() {
  dc_cron::_require_cli
  dc_cron::_purge_legacy_crontab
  dc_cron::_fetch_jobs

  local runtime_script="${DEALCLAW_RUNTIME_DIR}/${DC_CRON_RUNTIME_SCRIPT:-}"
  if [[ -n "${DC_CRON_RUNTIME_SCRIPT:-}" && -f "$runtime_script" ]]; then
    # 这条 job 归镜像层管：委托给 runtime 脚本，避免两边声明漂移互相覆盖
    dc_cron::log "该 job 由镜像层 ${DC_CRON_RUNTIME_SCRIPT} 托管，委托它注册（单一事实源）"
    bash "$runtime_script" || dc_cron::die "委托 ${DC_CRON_RUNTIME_SCRIPT} 注册失败"
  else
    if [[ -n "${DC_CRON_RUNTIME_SCRIPT:-}" ]]; then
      dc_cron::warn "未找到 ${runtime_script}（非容器环境？），改为本地自行注册"
    fi
    dc_cron::_add
  fi

  dc_cron::_fetch_jobs   # 注册动作改了现状，复查前重新拉
  dc_cron::_verify
}

dc_cron::remove() {
  dc_cron::_require_cli
  dc_cron::_purge_legacy_crontab
  dc_cron::_fetch_jobs
  local id
  if ! id="$(dc_cron::_job_id)"; then
    dc_cron::log "Gateway 里没有 ${DC_CRON_DECL_KEY}，无需停用。"
    return 0
  fi
  # 用 disable 不用 rm：删掉的声明式 job 下次容器启动会被重建，disable 才扛得住升级
  openclaw cron disable "$id" || dc_cron::die "openclaw cron disable ${id} 失败"
  dc_cron::log "已停用 ${id}（恢复：bash $(basename "$0") enable）"
}

dc_cron::purge() {
  dc_cron::_require_cli
  dc_cron::_fetch_jobs
  local id
  if ! id="$(dc_cron::_job_id)"; then
    dc_cron::log "Gateway 里没有 ${DC_CRON_DECL_KEY}，无需删除。"
    return 0
  fi
  dc_cron::warn "注意：删的是声明式 job，下次容器启动或重新 inject 会被重建。只想停掉请用 remove。"
  openclaw cron rm "$id" || dc_cron::die "openclaw cron rm ${id} 失败"
  dc_cron::log "已删除 ${id}"
}

dc_cron::enable() {
  dc_cron::_require_cli
  dc_cron::_fetch_jobs
  local id
  id="$(dc_cron::_job_id)" || dc_cron::die \
    "Gateway 里没有 ${DC_CRON_DECL_KEY}，先跑 \`bash $(basename "$0") inject\`。"
  openclaw cron enable "$id" || dc_cron::die "openclaw cron enable ${id} 失败"
  dc_cron::log "已启用 ${id}"
}

# 退出码：0 已注册且启用 / 1 未注册 / 2 已注册但停用
dc_cron::status() {
  dc_cron::_require_cli
  dc_cron::_fetch_jobs
  local summary
  if ! summary="$(dc_cron::_query summary)"; then
    dc_cron::warn "未注册：Gateway 里找不到 declaration-key=${DC_CRON_DECL_KEY}。跑 \`bash $(basename "$0") inject\`。"
    dc_cron::_warn_dupes
    return 1
  fi
  printf '%s\n' "$summary"
  dc_cron::_warn_dupes
  [[ "$(dc_cron::_query state)" == "enabled" ]] || return 2
  return 0
}

# 立刻补跑一次（验证 / 补发用），不影响后续排期
dc_cron::run_now() {
  dc_cron::_require_cli
  dc_cron::_fetch_jobs
  local id
  id="$(dc_cron::_job_id)" || dc_cron::die \
    "Gateway 里没有 ${DC_CRON_DECL_KEY}，先跑 \`bash $(basename "$0") inject\`。"
  dc_cron::log "立刻触发 ${id}（不影响后续排期）"
  openclaw cron run "$id"
}

# ── 入口 ────────────────────────────────────────────────────────────────────

dc_cron::usage() {
  cat >&2 <<USAGE
用法: $(basename "$0") [inject|status|remove|enable|run-now|purge] [--tz <IANA 时区>]

  inject   注册/同步到 Gateway cron（幂等，默认动作），注册后回读复查
  status   看现状：调度、启用与否、上次/下次运行（未注册退 1，已停用退 2）
  remove   停用（openclaw cron disable，扛得住容器重启）
  enable   重新启用
  run-now  立刻补跑一次，不影响排期
  purge    真删除（慎用：声明式 job 下次启动会被重建）

调度器是 OpenClaw Gateway 内置 scheduler，**不是系统 crontab**（镜像里没有 cron 守护进程）。
全局体检：bash dc_cron_doctor.sh
USAGE
}

dc_cron::main() {
  : "${DC_CRON_DECL_KEY:?dc_cron_lib: 必须设置 DC_CRON_DECL_KEY}"
  : "${DC_CRON_COMMAND:?dc_cron_lib: 必须设置 DC_CRON_COMMAND}"
  : "${DC_CRON_DEFAULT_EXPR:?dc_cron_lib: 必须设置 DC_CRON_DEFAULT_EXPR}"

  DC_CRON_TAG="${DC_CRON_TAG:-${DC_CRON_DECL_KEY}}"
  DC_CRON_NAME="${DC_CRON_NAME:-${DC_CRON_DECL_KEY}}"
  DC_CRON_SUMMARY="${DC_CRON_SUMMARY:-${DC_CRON_NAME}}"
  DC_CRON_CWD="${DC_CRON_CWD:-${DEALCLAW_MIO_DIR:-$DC_CRON_LIB_DIR}}"
  DC_CRON_TIMEOUT_SECONDS="${DC_CRON_TIMEOUT_SECONDS:-600}"
  DC_CRON_DEFAULT_TZ="${DC_CRON_DEFAULT_TZ:-${DEALCLAW_CRON_TZ:-Asia/Shanghai}}"
  DC_CRON_DUP_MATCH="${DC_CRON_DUP_MATCH:-${DC_CRON_COMMAND##* }}"

  local cmd="inject"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      inject|status|remove|enable|purge|run-now) cmd="$1"; shift ;;
      --tz) DC_CRON_DEFAULT_TZ="${2:?--tz 后面要跟 IANA 时区}"; shift 2 ;;
      --tz=*) DC_CRON_DEFAULT_TZ="${1#--tz=}"; shift ;;
      -h|--help) dc_cron::usage; return 0 ;;
      *) dc_cron::warn "未知参数: $1"; dc_cron::usage; return 2 ;;
    esac
  done

  python3 -c "from zoneinfo import ZoneInfo; ZoneInfo('${DC_CRON_DEFAULT_TZ}')" 2>/dev/null \
    || dc_cron::die "非法时区: ${DC_CRON_DEFAULT_TZ}"

  case "$cmd" in
    inject)  dc_cron::inject ;;
    status)  dc_cron::status ;;
    remove)  dc_cron::remove ;;
    enable)  dc_cron::enable ;;
    purge)   dc_cron::purge ;;
    run-now) dc_cron::run_now ;;
  esac
}
