---
name: "lark-cli-permission-issue-troubleshooting"
description: "lark-cli 权限/共享报错的标准排查流程：版本升级→+member-add→验证通过。"
---

# lark-cli 权限/共享问题排查

> 当 lark-cli 调飞书 API 返回 `field validation failed` 或权限相关错误时，按此流程排查。不要第一时间归因到 OAuth scope。

## 排查流程（按顺序）

### 1. 先检查 lark-cli 版本

```bash
lark-cli --version
```

当前可靠版本：≥ **1.0.64**。如果版本低（如 1.0.55），先升级：

```bash
lark-cli update
```

**已知 1.0.55 的 bug**：`/drive/v1/permissions/{token}/members` 的 POST/GET 都会返回 `99992402 field validation failed`，即使 scope 和参数都正确。

### 2. 用内置命令而非裸 API 调用

- ✅ **添加协作者**：`lark-cli drive +member-add`
- ✅ **解析 wiki/doc URL**：`lark-cli drive +inspect`

**不要直接调裸 API**（如 `lark-cli api POST /open-apis/drive/v1/permissions/.../members`）——旧版本 cli 对此端点有 bug。

### 3. 添加协作者正确写法

```bash
lark-cli drive +member-add \
  --token "<文档/sheet/wiki token>" \
  --type sheet \
  --member-type openid \
  --member-id "ou_xxx" \
  --perm edit \
  --as user \
  --yes
```

支持的 `--member-type`：`email`, `openid`, `unionid`, `openchat`, `opendepartmentid`, `groupid`, `appid`, `wikispaceid`

`--perm`：`view`（默认）/ `edit` / `full_access`

### 4. 解析 wiki URL → 实际 token/type

用户给的 wiki 链接（如 `https://versa-ai.feishu.cn/wiki/XXXX`）不能直接当 docx/sheet token 用：

```bash
lark-cli drive +inspect --url "https://versa-ai.feishu.cn/wiki/XXXX" --as user --format json
```

从输出的 `data.token` 和 `data.type` 获取实际资源 token 和类型（常见：sheet / docx / bitable）。

### 5. OAuth scope 才是最后一步

只有以上都排除了，才检查 scope：

```bash
lark-cli auth login --domain drive --no-wait --json
# → 生成 QR 码让用户扫码授权
lark-cli auth qrcode "<verification_url>" -o auth-qr.png
# → 用户扫码后
lark-cli auth login --device-code "<code>" --json
```

常见需要的 scope：
- `docs:permission.member:create` — 添加协作者
- `docs:permission.member:auth` — 权限验证
- `drive:drive.metadata:readonly` — 读取文档信息

## 错误归因优先级

| 信号 | 优先怀疑 | 不要先怀疑 |
|------|---------|-----------|
| `99992402 field validation failed` | lark-cli 版本过低 / API bug | OAuth scope 缺失 |
| 成员列表 GET 也失败 | API 端点本身不通 | 权限不足 |
| `+member-add` 成功但裸 API 失败 | cli 旧版本的端点 bug | 参数格式 |

## 真实案例

2026-07-03：盈兴复盘表格开编辑权限给郭希儿。
- 裸 API POST `/drive/v1/permissions/.../members` → 始终 `99992402`
- 以为是 OAuth scope 缺失 → scope 检查后发现已有 `docs:permission.member:create`
- 所有参数组合（perm/edit/full_access、type/sheet/file、带不带嵌套）全部失败
- **根因**：lark-cli 1.0.55 该端点有 bug
- **修复**：升级到 1.0.64 → `lark-cli drive +member-add` 一次成功
