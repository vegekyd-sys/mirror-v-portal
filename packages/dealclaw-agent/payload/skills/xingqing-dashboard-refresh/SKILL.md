---
name: "xingqing-dashboard-refresh"
description: "刷新星擎数据看板：拉取 track 事件+企业名→生成数据→部署，含 API 调用/验证/回退判断。"
---

# 星擎数据看板 — 数据刷新 & 部署

## 触发

- 用户说"刷新星擎数据看板" / "更新 xingqing dashboard" / "数据看板部署"
- 浩源或星擎群要求更新数据

## 核心原则

**数据准确性优先于部署速度。** 不正确的数据部署上去比不部署更糟。生成数据后先验证，再决定是否部署。

## 数据源

| 目的 | 接口 | 方法 | 关键注意 |
|------|------|------|----------|
| 登录 | `POST /api/auth/login` | admin + AES-ECB 加密密码 | 凭据见 `scripts/fetch-dashboard-data.js` |
| 获取事件 | `POST /api/track/selectList` | body `{}` | extraParams 是 JSON 字符串，必须 parse |
| 获取企业名 | `GET /api/auth/getUserInfoById?id=X` | GET + query param | **非 POST**，POST 会 405 |

Host: `xingqing.ultronx.tech`

## 操作阶段

### 阶段 1：拉取数据

使用 `scripts/fetch-dashboard-data.js` 或等效逻辑：

1. 登录获取 token
2. 拉取 track 事件 → 收集所有 userId
3. 逐个查企业名称（GET getUserInfoById）
4. 解析 extraParams（JSON string → object）
5. 添加 `_date` / `_hour` 辅助字段
6. 按 eventName 分组，生成完整的 DASHBOARD_DATA 对象
7. 写入 `report-aochuang/lib/xingqing-dashboard-data.ts`

### 阶段 2：验证数据（部署前必须执行）

在部署之前，检查生成的数据：

- [ ] API 调用全部成功（无登录失败、无 405、无空响应）
- [ ] 所有企业名称都是真实公司名，无 "企业 #XX" 占位符
- [ ] 日期范围合理（包含最近数据）
- [ ] 事件总量 > 0
- [ ] 四种事件类型（client_login / dashboard_view / remote_phone_connect / published_video_click）都存在

**验证不通过 → 停止，报告具体问题，不要部署。**

### 阶段 3：部署

```bash
cd report-aochuang
rm -rf .vercel
source .env.local
npx vercel --token "***" --prod --yes
```

Vercel 项目：`ultronx/report-aochuang`（浩源账号，非 管理员）

### 阶段 4：生产验证

部署后访问 `https://report.ultronx.tech/aochuang/xingqing-dashboard`：
- 企业名称正确
- 数据量和 API 返回一致
- 日期范围正确

## 停止/询问条件

以下情况必须**停止并报告**，不得继续部署：

- API 返回错误或空数据
- 登录失败（token 获取失败）
- 有 userId 查不到企业名（getUserInfoById 返回异常）
- 生成的数据文件与预期差异很大（如事件数从 59 变成 3）
- Vercel 部署失败，且连续重试 2 次仍然失败 → 报告并请浩源检查 Vercel 项目状态

以下情况**先询问再决定**：

- 企业名称有变化（新增企业但查到了名称）→ 展示新增企业列表，确认后再部署
- 时间跨度突然变大（如突然多出一个月前的数据）→ 确认是否预期
- 事件量和上一次差异超过 2 倍 → 确认是否正常

## 失败模式与回退

| 失败 | 处理 |
|------|------|
| API login 失败 | 检查网络 + 凭据，重试 1 次，仍失败则报告 |
| getUserInfoById 返回 405 | 确认用的是 GET 不是 POST |
| 部分 userId 查询失败 | 用 "企业 #ID" 标记，列出失败的 ID，**询问是否继续** |
| Vercel deploy 失败 | 检查 `.env.local` token 是否有效，重试一次；仍失败则报告 |
| 部署成功但页面数据不对 | 检查 vercel 是否有缓存 → `rm -rf .vercel` 后重新部署 |

## 相关 Skill

- `aochuang-report-web`：管理奥创报告的常规部署流程（管理侧 `dealclaw-report.example.com`）
- 本 skill 只负责浩源侧 `report.ultronx.tech` 的星擎数据看板刷新

## 资源消耗判断

- API 拉取 + 数据生成：轻量，同步执行即可
- Vercel 构建部署：~1 分钟，在 IM 群聊中可接受（同步），不需要 spawn 子 agent
- 除非一次性部署多个项目，否则保持单 lane 执行
