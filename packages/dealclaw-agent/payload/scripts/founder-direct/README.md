# Founder Direct — 企业邮箱一键绑定

## 用户操作（30秒）

1. **在邮箱后台开启 SMTP + 获取专用密码**

| 邮箱服务商 | 操作 |
|-----------|------|
| Gmail / Google Workspace | ① 开启两步验证 → ② 生成[应用专用密码](https://myaccount.google.com/apppasswords) |
| Outlook / Office365 | ① 安全设置 → ② 开启 SMTP 验证 |
| 163 / 126 / QQ | ① 设置 → ② POP3/SMTP → ③ 开启 → ④ 获取授权码 |
| 企业自建邮箱 | 找 IT 要 SMTP 地址 + 端口 + 密码 |

2. **把邮箱地址和专用密码发给 V**

```
@V 绑定邮箱 buyer@example.com 密码 xxxxxxxxxxxx
```

3. **V 返回确认** — 30 秒内出结果

## V 收到后的操作

```bash
node scripts/founder-direct/bind-email.mjs --email buyer@example.com --password 'xxxx'
```

## 发送邮件

```bash
node scripts/founder-direct/send-direct.mjs \
  --from buyer@example.com \
  --to buyer@example.com \
  --subject 'Trefoil anchors — quick question' \
  --html '<p>Hi...</p>'
```

密码每次发送时交互输入，不落盘。

## 注意事项

- 密码只用于当前会话的 SMTP 连接，不持久化存储
- 配置文件 (`accounts/`) 只存 SMTP/IMAP 地址和端口，不含密码
- 发送记录存入 `sent-log.jsonl`
- 无追踪像素，无退订头，无附件过滤
- 硬限制 15 封/天（后续可调）
