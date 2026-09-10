# 展会自动营销决策 — 轻量方案 Spec

> 版本 v1.0 · 2026-09-10 · 田耕郡（米奥 DealClaw）提出

## 1. 目标

不为展前/展中/展后（S1/S2/S3）分别建状态机，用一个统一决策入口
`evaluate_next_action()` 把「买家当前所处状态」映射为「下一步该做的营销动作」。

五态 → 五动作：

| 买家状态 | 动作 | 语义 |
|---------|------|------|
| 从未邀约 | `first_invite` | 发首封邀约信 |
| 已邀约 · 未到场（isCheckIn∈{2,3}） | `second_invite` | 二次邀约补发 |
| 已到场（isCheckIn=1）· 有会议/商洽证据 | `onsite_followup` | 匹配会议记录跟进 |
| 已到场（isCheckIn=1）· 无会议/商洽证据 | `missed_meeting_reengage` | 再触达约见面 |
| 多轮触达无回复（touch ≥ 阈值） | `nurture` | 长期培育 |

## 2. 核心约束

1. **复用现有 memory**：`meta`（exhibition_stage / exhibitions）、`exhibition-invitations.json`、
   `interactions.json`、opportunity、raw memory（原文引用），不复制客户/邮件正文。
2. **新增 `automations.json`**：只存流程状态 + 引用（automation_id / opportunity_id / action /
   status / idempotency_key / due_at / evidence_refs / execution_ref），**不存正文**。
3. **`evaluate_next_action()` 无副作用**：不写文件、不调外部接口、不修改输入。
4. **规则代码决定资格/频控/停止/时间；模型只生成邮件内容。**
5. **动作执行复用已有 Skill**：邀约 → `dealclaw-exhibition-invitation`；群发/跟进 →
   `dealclaw-email-growth-send` / `dealclaw-email-founder-direct` / `dc_followup`。
   本模块只产出「下一步做什么」，不负责发送。
6. **长期状态写 memory**（`data/memory/<sid>/automations.json`）；**临时任务和锁写
   `data/runtime/jobs`**（本层不实现调度，仅提供 automations store 读写 + 单活跃互斥）。
7. **同一 opportunity 同时只能有一个 active automation**（决策层返回 `already_active`，
   store 层 `activate` 前校验并接管旧 active）。
8. **不开发复杂调度框架**：无 cron worker、无 lease、无重试队列。外部轻量 cron 调
   本纯函数 + store 即可驱动。

## 3. 输入契约

`evaluate_next_action(**kwargs)` 全部参数只读：

| 参数 | 类型 | 来源 | 说明 |
|------|------|------|------|
| `customer` | dict | leads.json 行 | companyCdpId / companyName / contact_policy / touch_number / has_reply |
| `opportunity` | dict | opportunity 记录 | opportunity_id / opportunity_status / stage / match_grade |
| `invitation` | dict\|None | exhibition-invitations.json + getInvitationByPage | isCheckIn / isMeeting / isConnect / inviationState / sendTime / exhibitionId |
| `interactions` | list | interactions.json | 沟通明细（channel/direction/signals/source） |
| `meta` | dict | meta.json | exhibition_stage / exhibitions[{start,end}] |
| `automation_state` | dict | automations.json | automations 列表（用于频控 + 单活跃互斥） |
| `now` | str | — | ISO 时间，判断到期 |
| `config` | dict | 配置 | 覆盖 DEFAULT_CONFIG |

## 4. 返回契约

```json
{
  "action": "first_invite | second_invite | onsite_followup | missed_meeting_reengage | nurture | none",
  "reason": "证据化中文说明",
  "excluded_reason": "",
  "due_at": "ISO 时间或空",
  "evidence_refs": [{"interaction_id":"", "raw_record_ref":"", "signal":"", "source":""}],
  "requires_approval": true,
  "idempotency_key": "first_invite:{cdp}:{exhibitionId}",
  "rule_version": "1.0.0"
}
```

- `action == "none"`：不动作（被排除 / 未到时机 / 已有 active automation）。
- `excluded_reason` 非空 → 硬停止触达（拒绝/联系不上/do_not_contact/won/lost/paused）。

## 5. 决策顺序（规则固定）

```
1. 排除层（硬停止）→ none + excluded_reason
2. 单活跃互斥       → none + already_active
3. 主分流：
   无邀约 ── stage ∈ first_invite_stages ──→ first_invite
        └─ 否则 → none(stage_not_ready)
   有邀约 · 到场(isCheckIn=1) · 有会议证据 → onsite_followup
   有邀约 · 到场(isCheckIn=1) · 无会议证据 → missed_meeting_reengage
   有邀约 · 未到场(isCheckIn∈{2,3})：
       touch ≥ 阈值 且 无回复 → nurture
       二次邀约未用尽 且 stage ∈ second_invite_stages → second_invite
       否则 → none(no_action)
```

## 6. 频控 / 停止 / 时间（默认配置）

| 键 | 默认 | 含义 |
|----|------|------|
| `nurture_touch_threshold` | 3 | touch ≥ 3 且无回复 → nurture |
| `second_invite_max` | 1 | 每买家最多 1 次二次邀约 |
| `first_invite_stages` | ["inviting","live"] | 首邀只在邀约/展中阶段 |
| `second_invite_stages` | ["live"] | 二次邀约只在展中 |
| `onsite_stages` | ["live","followup"] | 到场跟进在展中/展后 |
| `nurture_interval_days` | 30 | nurture due_at = now + 30d |

- 停止条件（`excluded_reason`）：`contact_policy=do_not_contact`、`opportunity_status∈{won,lost,paused}`、
  `inviationState∈{2 联系不上, 3 已拒绝}`。
- 时区窗口（8:00–18:00 非工作日阻断）仍由发送层 `send_window.py` 负责，本层不重复。

## 7. automations.json schema

```json
{
  "schema_version": 1,
  "company_id": "<sid>",
  "automations": [
    {
      "automation_id": "am_<sha1-16>",
      "opportunity_id": "<opp_id 或 cdp:exhibitionId>",
      "customer_id": "<cdp>",
      "exhibition_id": "<exhibitionId>",
      "action": "second_invite",
      "status": "active | completed | cancelled | failed",
      "idempotency_key": "second_invite:<cdp>:<exhibitionId>",
      "due_at": "ISO",
      "requires_approval": false,
      "evidence_refs": [],
      "approved_at": null,
      "executed_at": null,
      "execution_ref": null,
      "created_at": "ISO",
      "updated_at": "ISO"
    }
  ]
}
```

- `execution_ref` 只存发送结果引用（draft_id / resend_id / message_id），不存正文。
- 单活跃：`activate` 前把同 opportunity 的旧 active 置 `completed`（接管），再追加新 active。

## 8. 不在本层做的事

- 不发送邮件/WhatsApp（复用 Skill）。
- 不做时区窗口、域名预热、收件人校验（发送层 MFG 负责）。
- 不建 cron/lease/重试（外部轻量调度调用本纯函数）。
