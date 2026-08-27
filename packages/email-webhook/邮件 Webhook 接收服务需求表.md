# 邮件 Webhook 接收服务需求表

实现一个 FastAPI HTTP 接收服务，提供 /health 和 /inbound 两个接口，用于接收 Resend webhook、验签、记录事件、匹配 DealClaw 线索并触发飞书通知。当前可本地 \+ tunnel 测试，后续迁移到服务器。

**处理流程**

**事件字段建议**

**线索状态映射**

**飞书通知规则**

**研发交付物**

**最小验收标准**

```Plain Text
1. GET /health 返回 ok
2. POST /inbound 能接收 Resend 测试事件
3. 验签失败会拒绝
4. 原始事件能落盘或落库
5. delivered/opened/clicked/bounced/complained 能正确更新线索状态
6. opened/clicked/bounced/complained 能推送飞书通知
7. 服务后续可从本地迁移到服务器，只需要替换域名和部署方式
```
