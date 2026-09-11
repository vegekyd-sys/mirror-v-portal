# DealClaw 规则（发布前由测试母体维护）

> 由 reflection 候选晋升而来（人工审核后落位）。发布时随 payload 分发；分身只读。

- **[timezone] 今日/当日口径**：任何"今日/当日"的判断，时间戳必须先转业务时区
  （`knight.config.json` 的 `timezone`，默认 `Asia/Shanghai`）再取日；**禁止**用 ISO 前 10 位直接与本地日期比较。
  - 可执行落点：`work/mio-api/dc_timeutil.py`（`today_in_tz` / `local_date_of`）
  - 回归测试：`work/mio-api/test_dc_timeutil.py`
  - 源：reflection `skill_improvement`（2026-09-11，UTC 跨日 bug 沉淀）

- **[reflection-writer] 自定位**：reflection writer 的 workspace 必须自定位（脚本上两级），
  **不得**回退到全局共享路径；日期文件按业务时区命名。
  - 回归测试：`packages/dealclaw-agent/tests/test_reflection_writers.py`
  - 源：reflection `bug`（2026-09-11）
