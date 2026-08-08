---
name: "xingqing-account-bootstrapper"
description: "运营同事在群里喊 V 时，自动拉取交付权益表未开通企业，生成星擎账号并二次确认后开通"
---

# 星擎账号自动开通 Skill

> Owner: 康浩源 | 群: 星擎运营-产品群
> 最后更新: 2026-07-24 | 修正版

## 触发条件

运营同事在群里 @V 并要求开通星擎账号时触发。例如：
- "@V 帮我看下还有哪些没开账号"
- "@V 给 XX 企业开通账号"
- "@V 开账号"

## API 端点（xingqing.ultronx.tech）

⚠️ **以下端点来自接口文档确认，不要用文档未记载的端点。**

| 端点 | 方法 | 用途 | 备注 |
|------|------|------|------|
| `/api/auth/login` | POST | 管理员/用户登录 | body: {account, password:AES加密} |
| `/api/auth/register` | POST | 注册客户账号 | body: {account, password:AES加密, nickName, roleId} |
| `/api/auth/update` | POST | 修改用户信息（含密码） | body: {id, account, password, nickName, roleIds} |
| `/api/auth/logout` | POST | 登出 | |
| `/api/auth/getRoleList` | GET | 获取角色列表 | 返回 roleId→roleName 映射 |

**⚠️ 不存在的端点：** `getUserPageList`、`getUserList`、`listUsers`、`deleteUser`、`resetPassword`、`changePwd`。这些都不在接口文档里，是错误继承的历史代码。

### 验证账号是否存在

**正确方式**：尝试用该账号客户端登录 → 成功则存在，`用户名或密码错误` 则不存在。
**错误方式**：用 `getUserPageList` 查（此端点不存在，永远返回 total:0 或不报错但无数据）。

### 加密规范

- 算法：AES-128/ECB/PKCS5Padding
- Key（base64）：`4HQY2EpNhyM6V8REPR4p6A==`
- 输出：base64 字符串
- **注意事项**：`CryptoJS.enc.Base64.parse()` 在 OpenClaw write/exec 管道中会被错误转换为 `***` 或 `…`。**始终使用 fallback 方案：** `Buffer.from(keyB64, 'base64')` → `CryptoJS.lib.WordArray.create(bytes)`

### 管理员凭据
- 账号：`admin`
- 密码：存于 `~/.xingqing-pass`（群内康浩源提供：`7#kR9$mQ2@vLp`）
- 登录后 nickName 为「产品演示中心」，roles=[manager, operator]

### 角色映射（来自 getRoleList）
| roleId | roleName | description |
|--------|----------|-------------|
| 2 | operator | 运营人员 |
| 4 | sdr | SDR |
| 5 | csm | CSM |
| 6 | client | 客户 |

## 执行流程

### 1. 拉取交付权益表企业
```
lark-cli base +record-list --base-token IVlxbfPwqa9cjPsNzhucpS3rnPH --table-id tblP0D9KkJTxkwUG --as user
```
提取「企业名称」列 → 去重去空。

### 2. 查已有账号（交叉验证）
- 没有列表查询端点 → 对每个企业用户名，尝试客户端登录
- 登录成功 = 已开通；失败 = 未开通
- 同时维护本地开通记录表

### 3. 生成账号名
去「有限公司/股份/集团/责任/科技/实业」等后缀，取省市拼音全小写 + 核心词拼音全小写：
- 杭州宏科体育器材有限公司 → `hangzhouhongke`
- 绍兴挚诚针纺织品有限公司 → `shaoxingzhicheng`
- 云南互祺食品有限公司 → `yunnanhuqi`

### 4. 生成密码（⚠️ 绝对不能有中文）
格式：`XxYy@YYYY!XqNN`

- Xx：城市拼音取前 2 字符（首字母大写、第二位小写），如 Hangzhou → `Ha`
- Yy：核心词拼音取前 2 字符（首字母大写、第二位小写），如 hongke → `Ho`
- @YYYY!Xq 固定后缀 + 2位随机数字
- **所有字符必须是 ASCII**

示例：
- `hangzhouhongke` → `HaHo@2026!Xq88`
- `shaoxingzhicheng` → `SxZc@2026!Xq71`
- `zhejiangyitian` → `ZjYt@2026!Xq83`

**禁止**：直接取企业名中的中文字符作为密码组成部分（如 `绍兴兴绍`、`浙江江浙`）

### 5. 注册
```
POST /api/auth/register
{
  "account": "hangzhouhongke",
  "password": "<AES加密后的密码>",
  "nickName": "杭州宏科体育器材有限公司",
  "roleId": 6
}
```
注册后立即用客户端登录验证。

### 6. 群内通知
格式：账号、密码、登录入口。

### 7. 修改已有账号密码（如果需要）
```
# Step 1: 客户端登录获取 user id
POST /api/auth/login → cl.result.userInfo.id

# Step 2: 管理员调用 update（必须传 id！）
POST /api/auth/update
{
  "id": 55,              ← 必传！从 login 获取
  "account": "shaoxingzhicheng",
  "password": "<AES加密后的新密码>",
  "nickName": "绍兴挚诚针纺织品有限公司",
  "roleIds": [6]
}
```

## 错误处理速查

| 问题 | 原因 | 修复 |
|------|------|------|
| getUserPageList 返回 total:0 | 端点不存在于文档 | 用客户端登录验证代替 |
| 密码含中文 | 生成逻辑取了企业名中文首字母 | 用拼音首字母 |
| update 返回 405 | 没传 `id` 字段 | 先 login 拿到 id 再传 |
| CryptoJS 被工具链破坏 | `Base64` 被转换 | 用 Buffer.from + WordArray.create |

## 脚本

| 脚本 | 用途 |
|------|------|
| `scripts/xingqing-staffmis.js` | 通用脚本（含 login/list-users） |
| `scripts/xq-register-batch.js` | 批量注册 + 英文密码生成 |
| `scripts/xq-fixpwd.js` | 修改已有账号密码 |

## 安全边界

- 密码只在群内发布，不写入公开文档
- 每次开通前在群里确认
- admin 凭据只存本地
- 不修改已有账号（除非群内明确要求）
