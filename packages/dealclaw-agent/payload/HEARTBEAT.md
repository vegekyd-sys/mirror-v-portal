<!-- Heartbeat template; comments-only content prevents scheduled heartbeat API calls. -->
# 本 agent 只在「用户显式请求 / 已批准的计划 / 已开启的定时器」下执行。
# 反思与维护任务已由定时器承载：周期见 runtime/dc-cron-reflection.sh（每 6h 跑 scripts/heartbeat.py），
# 任务清单见 knight.config.json → heartbeat.tasks；脚本用法见 AGENTS.md 的「V Learning Loop」段。
# 本文件保持注释-only：① 避免与定时器双触发；② 保留文件本身（REDLINES 第十一条禁止删除/改名）。
