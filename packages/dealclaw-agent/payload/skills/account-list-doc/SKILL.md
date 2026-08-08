---
name: "account-list-doc"
description: "查客户账号→生成飞书文档清单（序号/客户/国家/昵称/密码/邮箱/邮箱密码/机器）"
---

# 客户账号清单飞书文档

## 触发条件

曹雨凡（ou_5eac3ecd615ffdd55fab15cdc3412210）要求查客户账号信息或生成账号清单时触发。关键词：账号、账号清单、账号信息、账号邮箱密码。

## 执行流程

### 第一步：确定客户名

从用户消息中提取客户名称，支持简称匹配（如「钻皇」→「广东钻皇新材料科技有限公司」，「振丰」→「广东振丰科教玩具有限公司」）。

### 第二步：FCloud 查询 TK 昵称

```python
from fcloud_common import login, fetch_all, load_config
cfg = load_config()
token, _ = login(cfg, did='account-list')
accounts = fetch_all('/user-res/open-api/account/query-list', token, config=cfg)
# 筛选 categoryName 匹配，取 name / userName / countryCode
```

### 第三步：查询凭证

用 TK 昵称在两个 Base 中查找：

- **交付大表**：`RhLpbdSSAacfwYsK8tLc0gGjn4g` / `tblyPPIVulGmAzC3`
  - 字段：TK昵称(fld88uxr2x)、绑定邮箱(fldzUoat6u)、邮箱密码(fldb3kpFc6)、TK密码(fldb88ahQd)、国家(fldBbAFNjd)
  - `lark-cli base +record-search --keyword <昵称> --search-field TK昵称`

- **凭证库**：`TMvybfYnAaEnzvslq2scXy70nve` / `tblPVqWW6ybvS4BV`
  - 字段：TK昵称(fldFO8SW7N)、邮箱(flddOorteH)、邮箱密码(fldXs52cYU)

凭证优先级：交付大表 > 凭证库。取到后合并去重。

### 第四步：绑定机器

从原始 Excel 文件提取「绑定机器」列，无则填「无」。

### 第五步：生成飞书文档

标题：`{客户A}&{客户B}-账号清单`

```markdown
| 序号 | 客户名称 | 国家 | TK昵称 | 密码 | 绑定邮箱 | 邮箱密码 | 绑定机器 |
```

排序：客户名称 → 国家 → TK昵称。密码栏填 TK 密码，无则留空。

### 第六步：权限与发送

```bash
# 创建
lark-cli docs +create --title "{标题}" --as bot

# 写入（必须在文件所在目录执行）
cd /tmp && lark-cli docs +update --doc {id} --command overwrite --doc-format markdown --content @{file}

# 公开可读
lark-cli drive permission.public patch --token {id} --type docx --data '{"security_entity":"anyone_can_view","comment_entity":"anyone_can_view","share_entity":"anyone","link_share_entity":"anyone_readable","external_access_entity":"open","invite_external_entity":true}' --yes

# 授 管理员 管理权
lark-cli drive permission.members create --token {id} --type docx --data '{"member_id":"ou_48fd0d8dea2bb1ad6a8c111d6d1a01da","member_type":"openid","perm":"full_access","type":"user"}' --yes
```

## 输出规则

- 群内先发摘要（客户名 + 数量 + 国家分布），再说「文档已生成」+ 链接
- 不在群聊中明文展示完整邮箱密码表；文档内可展示
- 如部分账号查不到凭证，标注来源

## 失败处理

- FCloud 不可用：跳过，仍从 Base 搜索
- Base 限流（800004135）：等 3 秒重试
- 无匹配：告知「未找到 {客户名} 的账号信息」
