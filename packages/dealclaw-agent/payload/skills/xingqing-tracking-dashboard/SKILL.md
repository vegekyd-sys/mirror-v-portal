---
name: "xingqing-tracking-dashboard"
description: "加入云机 durationMs 异常值过滤规则（>2h 视为埋点 bug）"
---

# xingqing-tracking-dashboard — 星擎埋点看板

## 数据源

- 活跃看板：`POST https://xingqing.ultronx.tech/api/track/selectList` → `channel:"CLIENT"`
- 漏斗分析：`POST https://xingqing.ultronx.tech/api/hotVideo/getTrackingEventList`
- 用户昵称映射：`GET https://staffmis.ultronx.tech/api/auth/getUserInfoById?id={userId}` → `result.userInfo.nickName`

## 数据处理规则

### 云机使用时长过滤

`remote_phone_connect` 事件的 `extraParams.durationMs` 存在埋点 bug：云机连接开始后，如果结束事件未正确记录，`durationMs` 会异常偏大（可达 97 小时）。

**过滤规则**：单次连接 `durationMs > 7200000`（2小时）视为异常，不计入总时长。正常的云机单次连接通常在 1-60 分钟。

### 用户 ID → 企业名映射

API 返回的是内部 userId（数字），需要通过 staffmis 接口转换为企业昵称：
```
GET https://staffmis.ultronx.tech/api/auth/getUserInfoById?id={userId}
```
参数名是 `id`，不是 `userId`。

## 部署

- 项目：report-aochuang（ultronx team）
- 域名：report.ultronx.tech
- 路径：/aochuang/xingqing-dashboard
