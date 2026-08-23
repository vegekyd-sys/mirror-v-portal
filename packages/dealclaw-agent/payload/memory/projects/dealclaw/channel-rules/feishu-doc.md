# DealClaw 飞书文档生成规则

> 创建: 2026-07-29 | 适用于所有 DealClaw Skill 中生成的飞书文档

## 一、创建规则

1. **必须用 `--as bot`** 创建文档。`--as user` 存在跨应用 open_id 不互通问题。
2. 创建后自动执行三步：
   - `drive permission.public patch --as bot` → 设为 `anyone_readable`
   - `drive permission.members create --as bot` → 授予 Tianyi (`<OPEN_ID>`) `full_access`
   - ⚠️ **权限操作也必须用 `--as bot`**，因为 bot 是文档 owner，`--as user` 会报权限不足

## 二、文档结构

- 知识库文档首页和主题页合并为一个 docx
- 资料层为独立 bitable，在 docx 内添加可点击链接引用

## 三、权限模板

```bash
# 公开
lark-cli drive permission.public patch --token <token> --type <type> \
  --data '{"external_access_entity":"open","invite_external":true,"link_share_entity":"anyone_readable"}' \
  --as bot --yes

# 给 Tianyi 管理权
lark-cli drive permission.members create --token <token> --type <type> \
  --data '{"member_id":"<OPEN_ID>","member_type":"openid","perm":"full_access","type":"user"}' \
  --as bot --yes
```
