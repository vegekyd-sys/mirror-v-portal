# runtime/ — 容器启动期脚本

> 这些脚本跑在 dealclaw-agent 容器里，由 `entrypoint.sh` 在 gateway `/readyz` 就绪后调用。
> 它们**不进 payload**（payload 边界见 `../PAYLOAD_BOUNDARY.md`），是镜像自带的运维层。
> 状态：2026-09-17 新增 `dc-cron-pending-send.sh`（待发队列调度器，补 2026-09-16 的漏挂事故）。

## 目录速览

| 文件 | 作用 |
|---|---|
| `entrypoint.sh` | 容器入口：写配置 → 起 gateway → 等就绪 → 注册 cron → agent 预加载 |
| `write-config.mjs` | 生成 `$OPENCLAW_STATE_DIR/openclaw.json`（渠道、模型、工具白名单、gateway auth）|
| `dc-cron-*.sh` | 7 个脚本，声明式注册 8 条产品 cron（清单见 `docs/cron-timers.md`）|
| `dc-cron-converge.py` | cron schedule 三方合并 helper（见下） |
| `dc-ensure-agent-preload.sh` | 画像 + 线索池预热 |
| `dc-env-config.sh` | 租户启动后把环境变量写进 `work/mio-api/.env` |
| `patch-feishu-*.mjs` | 构建期补丁，pin 住 `@openclaw/feishu@2026.7.1`，bundle 形状不认识就 fail closed |
| `validate-payload.mjs` | 校验 `payload/` 下必需文件齐全（边界见 `../PAYLOAD_BOUNDARY.md`）|

---

# cron 注册机制

## 一、背景：converge 会覆盖什么

`openclaw cron add --declaration-key <K>` 是**声明式 converge**：按 K 找到已有 job，把
declarative 字段拉回镜像声明的值。openclaw 2026.7.1 参与 converge 的字段见
`src/cron/service/ops.ts:608-616`：

```js
function declarativeFields(job, includeEnabled) {
  return {
    schedule, trigger, payload, delivery, displayName,
    ...(includeEnabled ? { enabled } : {}),
  };
}
```

| 字段 | 升级时被覆盖？ | 是否符合预期 |
|---|---|---|
| `payload`（command / cwd / env / timeoutSeconds） | ✅ 覆盖 | ✅ 要的：命令必须随镜像版本走 |
| `delivery` / `displayName` | ✅ 覆盖 | ✅ |
| `schedule`（cron 表达式 / tz / every） | ✅ 覆盖 | ❌ **这是问题所在** |
| `enabled` | ❌ 不覆盖 | ✅ 见下 |
| name / sessionTarget / routing / owner | ❌ 不覆盖 | `src/cron/service/jobs.ts:1060` 注释明示 |

### enabled 天然安全，不需要我们处理

CLI 在**带 `--declaration-key` 且没显式写 `--disabled`** 时，根本不把 `enabled` 发给
gateway（`src/cli/cron-cli/register.cron-add.ts:411-413`）：

```js
...(declarationKey && optionSource("disabled") !== "cli"
  ? {}                          // enabled 整个字段不进 RPC
  : { enabled: !opts.disabled }),
```

gateway 侧 `enabledExplicit = parsedEnabled !== undefined` 因此为 false，converge 跳过该字段。

**结论：用户执行 `openclaw cron disable <id>` 暂停某条定时器，扛得住滚动升级。**
这是 openclaw 为声明式注册特意留的口子——**让用户停用定时器，一律引导用 disable，不要 delete。**
delete 掉的 job 下次启动会被当成"不存在"重建。

## 二、问题：schedule 被无脑重置

用户让 agent 把早报从 9:30 改成 8:00（agent 执行 `openclaw cron edit`），下次滚动升级
entrypoint 重跑 `dc-cron-daily.sh`，converge 把它打回 9:30。用户的修改静默丢失。

注意**不是持久化问题**：`/data` 是 PVC（`k8s/tenants/tenant-template/all.yaml`），
`OPENCLAW_STATE_DIR=/data/state`，cron 数据在 `/data/state/state/openclaw.sqlite` 的
`cron_jobs` 表里，重启不丢。丢失完全是 converge 造成的。

## 三、解法：只对 schedule 做三方合并

思路同 `kubectl apply`：引入「上次推下去的默认值」作为第三个参照，用它区分
**用户真改过** 和 **只是继承着旧默认值**。

```
declared_now   本次镜像声明的默认值（脚本里写死的）
declared_last  上次镜像推下去的默认值（基线文件）
actual         当前 job 的真实值（openclaw cron list --json）
```

| 条件 | 采用 | SOURCE |
|---|---|---|
| `actual` 不存在 | `declared_now` | `default-new` |
| 无 `declared_last`，`actual == declared_now` | `declared_now` | `default` |
| 无 `declared_last`，`actual != declared_now` | **`actual`** | `user-bootstrap` |
| `actual == declared_last` | `declared_now` | `default` |
| `actual != declared_last`，`now == last` | **`actual`** | `user` |
| `actual != declared_last`，`now != last` | **`actual`** + 告警 | `user-conflict` |

直觉：**`declared_last` 是「上次我推给你的值」。现状还等于它 → 没人动过，可以推新值；
现状偏离了它 → 偏离只能是人改的，不能覆盖。**

好处：**agent 侧一行都不用改。** 它继续直接 `cron edit`，用户意图靠"现状偏离基线"自动
识别，不需要 agent 额外登记什么。

## 四、执行时序

```
Pod 启动
 └─ entrypoint.sh  等 /readyz 就绪
     └─ dc-cron-<x>.sh
         ├─ ① resolve   读 actual + 读 declared_last → 定出本次该用的 schedule
         ├─ ② cron add  用定好的 schedule 注册（converge 照常跑，payload 照常被覆盖）
         └─ ③ record    把 declared_now 写进基线文件
```

**③ 必须在 ② 成功之后。** 若先记基线而 add 失败，下次启动 `actual`(旧) ≠ `declared_last`(新)，
会被误判成"用户改过"，默认值从此永远推不动——一个静默死锁。

## 五、脚本接法（三种形态）

**形态 1 · 单条 job**（`dc-cron-email-poll.sh` / `dc-cron-resend-poll.sh` / `dc-cron-buyer-onsite.sh`）

```bash
CONVERGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/dc-cron-converge.py"
DEFAULT_CRON="*/5 * * * *"
sched_env="$(python3 "$CONVERGE" resolve --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ")" || {
  echo "[dc-cron-email-poll] schedule 解析失败，跳过本次注册（下次启动重试）" >&2
  exit 1
}
eval "$sched_env"

openclaw cron add --cron "$DC_CRON_EXPR" --tz "$DC_CRON_TZ" ... --declaration-key "$DECL_KEY"

python3 "$CONVERGE" record --decl-key "$DECL_KEY" --cron "$DEFAULT_CRON" --tz "$TZ" || ...
```

**形态 2 · 多条 job**（`dc-cron-daily.sh` 的 `ensure()` 函数 / `dc-cron-onsite-recommend.sh` 的循环）

同上，`decl_key` 与默认表达式是参数。这两个脚本额外做了失败隔离：单条失败只标记
`failed=1` 继续跑其余，末尾 `exit "$failed"` 保留给 entrypoint 的信号。改造前 `set -e`
会让第一条失败带崩后面所有条。

**形态 3 · cron/every 二选一**（`dc-cron-reflection.sh`）

原有分支改为产出 `DECLARED_ARGS`（镜像声明），过一遍 helper，再按 `DC_CRON_KIND` 重建：

```bash
if [[ "$DC_CRON_KIND" == "cron" ]]; then
  SCHED_ARGS=(--cron "$DC_CRON_EXPR" --tz "$DC_CRON_TZ")
else
  SCHED_ARGS=(--every "$DC_CRON_EVERY")   # 毫秒数字，openclaw 的 bare number 默认单位就是 ms
fi
```

## 六、dc-cron-converge.py 的设计取舍

| 取舍 | 原因 |
|---|---|
| 比较时忽略 `staggerMs` / `anchorMs` | 这两个是 openclaw 派生的运行时值（整点自动 stagger、every 打 anchor），纳入比较会让每条 job 都被误判成"用户改过" |
| 读不到现状默认**中止**而非用默认值兜底 | gateway 抽风时拿默认值注册 = 冲掉用户修改。宁可这次不注册（下次启动重试）。要旧行为传 `--fallback-to-default` |
| 首次上线保留现状（`user-bootstrap`） | 没有基线时无法区分"用户改过"和"默认值变过"，保守保留。代价是少推一次默认值，第二次起正常 |
| 基线放 `<workspace>/data/` | 两个硬约束：① `/data/state` 是 openclaw 的地盘（SQLite），不占；② **必须落在 `entrypoint.sh:19` 那条 `rsync -a --delete` 的 exclude 覆盖范围内**，否则每次启动被删光。workspace 根下的 `data/` 已被 `--exclude='/data/'` 保护（`tenant-env.json` 也在那儿）。可用 `DC_CRON_DECLARED_FILE` 覆盖 |
| 原子写基线 | `tempfile` + `os.replace`，升级中途被 SIGKILL 不会留半个 JSON |

## 七、运维手册

**看一条 job 的 schedule 来自哪** — 启动日志每条都会打：

```
[dc-cron-email-poll] 已同步（*/5 * * * * @ Asia/Shanghai，schedule 来源: user）
```

`user` / `user-bootstrap` / `user-conflict` = 这条被用户改过、镜像默认值已让位。

**改镜像默认值后推不下去** — 大概率该 job 的 `actual` 已偏离基线。确认：

```bash
docker exec <c> cat /data/workspace/data/dealclaw/cron-declared.json
docker exec <c> openclaw cron list --all --json | grep -A4 declarationKey
```

要强制拉回默认值：删掉基线文件里那条（退化成 bootstrap），或直接
`openclaw cron edit <id> --cron <默认值>` 让 actual 回到基线。

**查 cron 数据本体** — 不在文件系统里：

```bash
docker exec <c> ls -la /data/state/state/     # openclaw.sqlite，表 cron_jobs / cron_run_logs
```

`/data/state/cron/jobs.json` 在 2026.7.1 已退化成逻辑标识符，磁盘上不存在这个文件。

## 八、已知未覆盖

- **用户 delete 掉声明 job** → 下次升级按 `default-new` 重建。要尊重删除需加 tombstone；
  当前策略是引导用户用 `disable`（原生扛升级）
- **payload 层的用户修改**（改 command / env）→ 照旧被覆盖，这是设计意图
- **基线文件被删** → 退化成 bootstrap，安全但会少推一次默认值。⚠️ 改基线路径前先确认新位置
  不会被 `entrypoint.sh:19` 的 `rsync -a --delete` 清掉——落在 exclude 之外会导致基线**每次启动**
  被删，表现是默认值永远推不下去，且完全静默

## 九、验证方式

`dc-cron-converge.py` 的合并逻辑可以脱离 gateway 测：在 PATH 前面放一个假的 `openclaw`，
`cron list` 时 `cat` 一份 JSON 即可。已覆盖的分支见第三节表格的 6 行，外加
`--every` 路径和 gateway 读取失败路径。
