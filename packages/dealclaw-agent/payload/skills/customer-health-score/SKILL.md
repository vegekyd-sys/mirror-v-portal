---
name: "customer-health-score"
description: "健康度评分：15子项+100分制。1.3.2埋点接入client_login(POST /api/track/selectList)+3个补充指标。report-web设计系统输出。"
---

# Customer Health Score

当用户要求做「客户健康度评价/健康度评分/客户续费或流失风险预警/某企业健康度报告/健康度HTML汇报/复购潜客判断/复购时机判断」时使用本 skill。

> 页面设计/构建/部署遵循 `report-web` skill 的设计系统和工作流，本 skill 只定义健康度独有的评分逻辑和数据源。

## 默认输入

- 企业名（必填）。如果只给企业名，不要反问；按默认数据源链路检索。

## 数据源（两个 Base + 星擎埋点）

### 1. AI视频营销·客户运营服务（主要）
- Base token：`IVlxbfPwqa9cjPsNzhucpS3rnPH`（`--as user`）
- 主表 tblbmcjTL3aD1EUG：企业名/合同/CSM/阶段/视频数/播放量/线索/账号/月度同步等
- 交付权益 tblP0D9KkJTxkwUG：AI混剪视频/线索/播放量/矩阵账号目标值
- TK账号 tblFkptD0HRi4TvG：SourceID→fcloud映射、播放/粉丝/视频数
- 线索 tblpHmAKnXfNSRjJ：线索明细（按辅助-公司名称搜索）
- 服务感知卡 tbllMQsUwNqnShzR：**客户KP是否互动/参会**（select字段）、参与人员、复盘日期

### 2. AI视频营销·3000W（售前商机）
- Base token：`EKwjbHqHBaDgGcs6p40cv3Xpnog`（`--as bot`）
- 商机陪访：KP信息、赢单金额、拜访形式、最近拜访时间
- Tiktok需求调研表收集：是否提交调研表
- S2业务商机表/合同表：销售阶段、合同数据

### 3. FCloud 投放系统
- 账号健康：封号/限流状态、粉丝数、作品数
- 视频投放：pubTime判断发布阶段（已开始/大批量），不显示具体条数
- 账号归属：飞书 TK 表 SourceID 解码 → fcloud accountId 匹配

### 4. 🆕 星擎 1.3.2 埋点系统
- **API Base**：`https://xingqing-test.ultronx.tech/api`
- **鉴权**：staffmis 登录 → satoken header（AES-ECB 加密，key=`4HQY2E…A==`，脚本 `scripts/xingqing-staffmis.js`）
- **查询接口**：`POST /api/track/selectList`

请求体：
```json
{"eventName": "client_login", "pageNo": 0, "pageSize": 10000}
```

响应体：
```json
{
  "responseCode": "0000", "success": true,
  "result": [{
    "id": 1, "userId": 1, "eventName": "client_login",
    "clientType": "PC", "extraParams": null, "createTime": 1783909741000
  }]
}
```

| 事件 | 字段 | 健康度用途 |
|------|------|-----------|
| `client_login` | userId, createTime(ms) | 🟢 后台登录次数 → 四、客户后台活跃·登录后台次数 |
| `dashboard_view` | userId, createTime(ms) | 🆕 Dashboard查看次数 → 辅助判断客户数据关注度 |
| `remote_phone_connect` | userId, createTime(ms), extraParams.durationMs | 🆕 云机使用次数/时长 → 辅助判断工具粘性 |
| `published_video_click` | userId, createTime(ms), extraParams.videoId | 🆕 已发布视频查看 → 辅助判断内容交付关注度 |

- **聚合方式**：按 userId + 日 count（parse createTime/1000 → date）；remote_phone_connect 额外 sum(durationMs)
- **注意**：字段是 `userId` 非 `companyId`；`extraParams` 为 JSON 字符串需 parse；无 `success` 字段；无分页 total

## ⚠️ 关键注意事项

1. **FCloud 字段名是企业名在 `categoryName`，不是 `acctName` 或 `accountName`**
2. **FCloud 活跃号去重**：只统计有作品(works>0)+status=0
3. **星擎埋点按 userId 聚合**，userId→企业名称映射需通过 staffmis getUserPageList（管理员权限）或手动维护

## 工具使用规则

1. 飞书表格：`lark-cli base +record-search --search-field "企业名称" --keyword "短名"`（优先 `--as user`）
2. TK 账号表用 `+record-search`
3. 3000W 用 `--as bot`，先 `+record-list` 再 client-side filter
4. FCloud：`cd work/fcloud && python3 -c "..."`，按 `categoryName` 匹配
5. 🆕 星擎埋点：fetch 4事件 → 按 userId 聚合 → 匹配企业
6. 不伪造数据，没有标「缺失」；字段冲突标「口径冲突」

## 数据覆盖状态

🟢 自动获取：视频数/播放量/线索/账号/月度同步/拍摄/复盘/封号限流/素材完成/方案策划/样片/KP出席/**登录后台次数**
🔴 需 CSM 手填：**查看询盘次数/回复及时率**/好评投诉/线索质量反馈(绿灯/红灯)
🆕 星擎 1.3.2 新增补充指标：Dashboard查看/云机使用/视频点击 — 不直接参与评分，作为客户活跃度参考展示

## 评分体系（100分制，6模块，15子项）

### 一、客户配合度（20分）
| 子项 | 权重 | 分值条件 | 数据来源 |
|------|------|---------|---------|
| 需求表收集 | 3% | 按时完整3分；延迟3天内2分；超3天1分；超5天0分 | 3000W调研表 |
| 素材提供 | 4% | 提前提供质量高3分；按时需筛选2分；延迟1分；未提供0分 | 主表"客户自有素材收集" |
| 拍摄对接 | 3% | 主动配合一次性3分；需2次沟通2分；推迟1分；拒不配合0分 | 主表"拍摄服务次数+进度" |
| 各节点配合度 | 5% | 全部积极参与5分；1-2次缺席2分；多次缺席0分 | 主表各节点字段 |
| KP出席率 | 5% | KP出席全部重要会4分；出席1次2分；从未出席0分 | 感知卡表"客户KP是否互动/参会" |

⚠️ **何总硬性规则**：素材超5天未提供 → 直接扣分。

### 二、方案交付（10分）
| 子项 | 权重 | 分值条件 | 数据来源 |
|------|------|---------|---------|
| 策划案交付效率 | 5% | 按时5分；延迟3天内2分；超3天1分；超5天0分 | 主表"方案策划" |
| 二次修改/满意度 | 5% | 一次通过5分；微调1次4分；大幅≥2次2分；反复0分 | 缺失时标"待CSM确认" |

### 三、指标交付（30分）
| 子项 | 权重 | 分值条件 | 数据来源 |
|------|------|---------|---------|
| 视频数量完成率 | 10% | ≥100%=10；80-99%=7；50-79%=4；<50%=0 | 主表视频数/交付权益目标 |
| 播放量完成率 | 10% | ≥100%=10；80-99%=7；50-79%=4；<50%=0 | 主表播放量/交付权益目标 |
| 有效线索完成率 | 10% | ≥100%=10；80-99%=7；50-79%=4；<50%=0 | 主表线索/交付权益目标 |

### 四、客户后台活跃（10分）
| 子项 | 权重 | 分值条件 | 数据来源 |
|------|------|---------|---------|
| 登录后台次数 | 4% | 每周≥2次4分；每周1次3分；月2-3次1分；未登录0分 | 🟢 星擎埋点 client_login |
| 查看询盘次数 | 3% | 每日查看3分；周2-3次2分；周1次1分；从未0分 | 🔴 待埋点 lead_view 上线 |
| 回复次数/及时率 | 3% | ≥80%及时3分；50-79%2分；<50%1分；不回0分 | 🔴 待埋点 lead_reply 上线 |

### 五、客情维系（20分）/ 六、客户账号健康（10分）
（保持不变，同原版）

## 等级

| 分数 | 等级 | 动作 |
|------|------|------|
| 90-100 | 🟢 健康 | 正常推进，挖掘复购 |
| 70-89 | 🟡 关注 | 识别薄弱项，改善计划 |
| 50-69 | 🟠 预警 | CSM重点干预 |
| <50 | 🔴 高风险 | 复盘+管理层参与 |

## 页面输出

页面设计、构建、部署遵循 `report-web` skill 的完整设计系统和工作流。

- 页面路径：`app/aochuang/<slug>/page.tsx`
- 风格：暗色主题（`report-web` 设计系统定义）
- 内容：15子项评分表 + 28字段 + 风险 + Agent分层 + 闭环 + 服务感知 + 🆕 星擎埋点补充数据区
- 埋点补充数据区展示近7天 client_login/dashboard_view/remote_phone_connect/published_video_click 的汇总和趋势
