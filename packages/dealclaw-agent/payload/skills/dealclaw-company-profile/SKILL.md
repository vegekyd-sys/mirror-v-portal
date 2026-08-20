---
name: "dealclaw-company-profile"
description: "识别用户在对话中告知的公司名称并回写到租户档案（经 nexus-gateway 转发到 provisioning）。"
---

# Company Profile 回写

## 触发场景

用户在对话中主动告知公司信息，例如：

- 「我是深圳XX光电科技有限公司」
- 「我们公司叫XX外贸」
- 「公司是XX，主要做户外灯具出口」

## 判断原则

1. **只在用户明确、完整地给出公司名时回写**，不要从零散信息臆测。
2. 公司名不确定时，先追问一次确认，不要乱写。
3. 回写是幂等的内部动作，同一公司名重复回写无害。

## 执行

用脚本回写公司名：

```bash
bash skills/dealclaw-company-profile/scripts/writeback.sh "<公司名>"
```

脚本会读取 `DEALCLAW_TENANT_ID`，经 nexus-gateway 的 `PATCH /v1/agent/profile` 转发到 provisioning-service，更新 `company_name`。

## 成功后的行为

- 简单确认一句即可（如「已记录你的公司名：XX」），不要刷屏。
- 不要输出任何内部接口、token、tenantId。
