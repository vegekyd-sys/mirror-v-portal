# hihi 无回复修复

用户真实消息 `0e57342f-3b67-46f2-bb1a-b4469dece5fb` 于 16:28:00 入队后被标为 RECOVERY_REVIEW_REQUIRED，尚未调用模型。

根因：16:27:32 空闲回收进入 quiescing，控制器更新退出时只停止 timer，没有等待已经运行的 collector；数据库留下 quiescing。恢复保护将它与真正的 running 消息混为一谈，并且提前返回分支没有安排飞书失败回复。

修复：
- 关闭控制器先等待进行中的 collector 完成，再关闭存储。
- 持有租户锁时，queued 消息遇到遗留 quiescing 且没有 running 消息，幂等完成 stop 并继续唤醒；真正 running/blocked 仍不会自动重放。
- 恢复保护分支也安排失败回复，避免静默与小脸残留。

数据修复通过严格守卫脚本 `scripts/recover-unsubmitted.ts`：仅允许 RECOVERY_REVIEW_REQUIRED、无 waking/dispatch/delta/tool/runtime-completed 事件的消息恢复。检查云端 stop 后重新入队原消息，没有复制消息或重做工具。

真实结果：16:30:21.402 唤醒，16:30:37.313 首卡，16:30:39.775 飞书送达，16:30:40.131 移除 Typing；正文“你好，有什么需要我帮忙的？”。恢复后首卡 15.9 秒；不将故障期间用户已等待时间排除后宣传为原请求总耗时。

新增回归：queued 消息恢复中断的 idle stop；关闭时等待进行中的 stop 写入 sleeping。原有禁止重放真实 running 消息的测试保留。

验证：TypeScript build 通过；manager 9 项测试最终全部通过。一次原有真实队列 FIFO 测试在 20 秒等待窗内仍 queued，重跑通过；新增两项恢复/关机回归均通过，保留该队列计时波动记录。
