# Host integration

## Scheduling

Configure the host automation to invoke this Skill once per day at `10:00` in `Asia/Shanghai`. The invocation must carry or resolve the target Feishu group `chat_id`. Schedule one logical run per group and prevent overlapping runs for the same group.

## Feishu capabilities

This Skill relies on the following installed tools. They are already available in the DealClaw/OpenClaw runtime:

| 操作 | 工具 | 命令示例 |
|---|---|---|
| 搜索群内文档 | `lark-cli` | `lark-cli drive files search --keyword "企业知识库"` |
| 读取 Docx 文档 | `lark-cli` | `lark-cli docs +fetch --doc "<token>"` |
| 查找/创建 Base | `feishu-bitable` Skill | 按 bitable 名称搜索 → 创建表 + 字段 |
| 增改 Base 记录 | `feishu-bitable` Skill | upsert by 唯一去重键 |
| 读取反馈字段 | `feishu-bitable` Skill | 按筛选条件查询记录 |
| 发送群消息 | `message.send` | 飞书群内推送 |

**关键：创建 Base 时用 `--as user`（bot 创建的 bitable 用户无法用飞书客户端编辑），创建后用 `lark-cli drive permission.public patch` 设为群内可编辑。创建后立即删除飞书自动生成的默认"数据表"，所有操作仅在 `买家线索` 表中进行。**

Use user identity for first-time resource creation when the platform requires user ownership, then grant the automation identity access. Do not assume that bot group membership grants document or Base access.

## Idempotency

- Serialize runs by `chat_id`.
- Upsert by `chat_id:线索ID`.
- Record the sent message ID.
- Before retrying a group send, verify whether the same lead batch already has a message ID.
- Search by exact Base title before creating; stop on multiple exact matches.

## Installation validation

Validate in this order:

1. Run the bundled `self-test`.
2. Run `contract-check` against the TradeChina endpoints.
3. Run a manual preview in one test group without Base writes.
4. Run a Base-create and upsert test with non-sensitive test data.
5. Run one manual group push.
6. Enable the daily schedule only after the previous checks pass.

The standard package cannot validate steps 3–5 without a real group, document, Feishu authorization, and permission to create or edit resources.
