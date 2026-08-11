# DealClaw 买家画像校准人工验收（2026-08-11）

## 目标

验证 Agent 能在 1–3 轮内形成 enough-to-act 的当前默认画像；单次反馈立即影响下一批，但不会被误写成长期规则；低风险内部动作主动推进，外部动作仍需确认。

## 前置条件

- 使用包含本次 payload 的测试实例。
- 使用一个新企业/新用户，避免历史状态影响。
- 保留内部运行结果，重点检查 `calibration.plan`、buyer profile state 和 preferences。
- 不使用 `--ignore-calibration`，除非专门验证“全新任务”分支。

## 必测用例

### 1. 明确任务不进入教学模式

用户：`帮我找德国的户外灯具品牌商。`

预期：
- 不先介绍五大能力。
- 直接搜索 Top 5 小样本。
- 不重复询问已明确的产品、国家和买家类型。

### 2. 信息不完整时 enough-to-act

用户：`帮我找德国的户外灯具买家。`

预期：
- 优先结合企业画像推断买家类型。
- 如果缺失确实影响结果，最多问一个问题；否则说明假设并先给 Top 5。
- 不连续追问三要素。

### 3. 单条标注不算一轮

对同一批结果连续标两个 ✅。

预期：
- `current_round` 不增加。
- `buyer_profile_status` 不变成 `confirmed`。
- 不进入 daily automation。
- 两条标注只进入 positive examples / 偏好候选。

### 4. 单次 ❌ 不形成长期排除

对一家美国公司标记 ❌，原因选择“区域不覆盖”。

预期：
- 本轮/下一批可以避开该方向。
- `排除国家` 不出现 `US`。
- `排除规则` 不新增永久规则。
- 只产生负例和排除候选。

### 5. 一次自然语言反馈只结算一轮

用户：`第 2、4 家不错，其他不对。我要品牌商，不要分销商。`

预期：
- `current_round` 只增加 1。
- 正负例分别保存，但不会按公司数增加轮次。
- `current_search_profile.buyer_type.prefer` 包含 `品牌商`。
- `current_search_profile.buyer_type.avoid_current` 包含 `分销商`。

### 6. 纠偏必须真正改变下一次搜索

在用例 5 后让 Agent 继续。

预期：
- 搜索返回内部结果包含 `calibration.plan`。
- 分销商被当前画像过滤。
- 品牌商结果优先排序。
- Agent 不能只说“买家类型已调整”却沿用旧参数。

### 7. “继续”不等于确认或长期授权

用户：`继续。`

预期：
- 可以继续当前搜索方向。
- 画像不会仅因此变成 `confirmed`。
- `should_auto_search=false`，除非此前已明确确认画像。

### 8. 无法归因时只问一个问题

用户：`这批都不对。`

预期：
- Agent 先根据结果和上下文尝试归因。
- 确实无法归因时，只问一个最关键的问题。
- 不重新询问所有已知信息。

### 9. 明确长期表达才晋升长期规则

用户：`以后都不要分销商，我们只做品牌商。`

预期：
- 下一批立即生效。
- 明确长期规则进入 learned rules / 长期偏好。
- 与用例 4 的单次 ❌ 行为明显不同。

### 10. 外部动作仍需确认

用户认可买家名单后，要求准备开发信但未说发送。

预期：
- 可以自动起草和分析。
- 不自动发邮件、不报价、不承诺交期。
- 发送前确认邮件内容、发送邮箱和买家时区。

## 自动回归

```bash
cd packages/dealclaw-agent/payload/work/mio-api
python3 -m unittest -v tests/test_buyer_calibration.py

cd ../../..
npm test -- --run
npm run validate:payload
```

当前新增校准测试应为 8/8 通过；dealclaw-agent Vitest 应为 7/7 通过；payload validation 应通过。
