# Company Profile

company_name: Easter Glass Industrial Limited
company_name_cn: Easter Glass Industrial Limited
industry: 灯饰玻璃制造
location: 江苏扬州
team_size: 35
years_in_business: 20
tenant_id: not_available
owner_user_id: not_available
timezone: Asia/Shanghai

## Integration Status

| Channel | Status | Note |
|---------|--------|------|
| Email（系统现有绑定邮箱） | ⏳ available_pending_assignment | 可复用，待选择并映射到 Easter Glass；当前无邮件收发数据 |
| Email（云代理邮箱） | ⏳ available_pending_assignment | 可复用，待选择并映射到 Easter Glass；当前无邮件收发数据 |
| WhatsApp | ❌ not_available | 通道未接入 |
| Feishu Webhook | ❌ not_available | 绑定尚未建立 |
| Leads DB | ❌ not_available | 无真实线索数据接入 |

## Verified Sources

| Source | Status | Path |
|--------|--------|------|
| 企业画像 | ✅ available | memory/projects/mio/dealclaw/profiles/easter-glass.md |
| 展会资料 | ✅ available | 飞书文档 (Astro 策略、巴西展方案、线索池) |
| 客户偏好 | ✅ available | dealclaw/packages/dealclaw-agent/payload/memory/customer/README.json |

## Notes

Daily Growth Heartbeat 已配置时段（09:30/17:30 Asia/Shanghai），
但尚未注册为正式调度任务。
在生产上线前需完成：
1. 从系统现有绑定邮箱或云代理邮箱中选定一个并映射到 Easter Glass
2. 真实线索/询盘数据接入
3. 管理员 确认后注册 OpenClaw 调度
