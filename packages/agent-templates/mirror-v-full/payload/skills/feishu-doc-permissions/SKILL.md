---
name: "feishu-doc-permissions"
description: "飞书文档/表格开权限：给本人编辑、组织内编辑、外部只读，改完回读验证并说明链接级影响。"
---

# 飞书文档权限

用户说「开编辑权限」「分享给外部」「只给他看」时，用 `lark-cli drive permission.*` 直接改，并在改完回读验证。所有 `permission.public patch` / `permission.members create` 都是 high-risk-write，用户这一句要求就是确认，可以带 `--yes`；没有用户要求时不要自己加。

每条命令都必须带文档真实 token（`--token <docx_token>`）和对应的 `--type docx`。token 写成占位符或让 shell 展开，CLI 会报 `unknown flag "--target"`，这不是权限问题，是参数没传进去。

## 先回读，再决定要不要改

`lark-cli docs +create --as bot` 新建的文档默认已是 `link_share_entity: tenant_readable`、`external_access: true`、`invite_external: true`，同企业群里的人直接能打开。这时为了「把链接发给客户」再跑 `permission.public patch` 是多余的高风险写，还要多一轮确认。

先回读确认现状，只有确实不满足时才改：

```bash
lark-cli drive permission.public get --token <doc> --type docx --as bot
```

`tenant_readable` 足够发给同企业的人；只有客户属于外部企业，才需要切到 `anyone_readable` 并同步说明链接级影响。

## 三种常见组合

本人（或指定某个人）可编辑。`--type` 会同时映射文件类型和协作者类型，传 `--type docx` 会把 body 里的 `"type":"user"` 覆盖成 `docx`，接口报 1063001 Invalid parameter；文件类型改用 `--params` 传：

```bash
lark-cli drive permission.members create --as bot --yes \
  --params '{"token":"<doc>","type":"docx"}' \
  --data '{"member_id":"ou_xxx","member_type":"openid","perm":"edit","type":"user"}'
```

组织内同事通过链接可编辑：

```bash
lark-cli drive permission.public patch --token <doc> --type docx --as bot --yes \
  --data '{"link_share_entity":"tenant_editable"}'
```

外部同事（非同企业）通过链接可看：

```bash
lark-cli drive permission.public patch --token <doc> --type docx --as bot --yes \
  --data '{"link_share_entity":"anyone_readable","external_access":true,"invite_external":true}'
```

## 链接级设置有覆盖关系

`link_share_entity` 只有一个值：设成 `tenant_editable` 就是组织内可编辑，改成 `anyone_readable` 后，链接级对所有人变只读，组织内同事也失去链接级编辑。个人级权限不受影响（单独加的 `perm=edit` 依然有效）。

所以从「组织内可编辑」切到「外部可看」后，要主动告诉用户：外部可看的是只读，原来靠链接编辑的同事现在也只能看。用户若要外部也能改，或只指定某几个人编辑，向他要飞书邮箱/手机号按人加，不要直接把链接改成互联网可编辑。

## 收尾

改完跑一次回读，确认落地：

```bash
lark-cli drive permission.public get --token <doc> --type docx --as bot
```

检查 `link_share_entity`、`external_access`、`invite_external` 三项与预期一致再回复用户；回复里写清当前谁能看、谁能改，以及个人级与链接级的区别。
