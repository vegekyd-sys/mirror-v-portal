# HEARTBEAT.md — DealClaw 周期自检

## Trigger
- 每 6 小时自动运行
- 手动触发：用户发送 `/heartbeat`

## 检查清单
1. Gateway 健康
2. Agent 可达
3. Memory 索引正常
4. 外部 API 连通（米奥、DeepSeek）
5. 租户状态正常
6. Credits 余量

## 巡检命令
```bash
python3 scripts/heartbeat.py
```
