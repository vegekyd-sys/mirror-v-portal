# 小元内测群 → Credit 租户映射表（人工参考）

> ⚠️ 本表仅供人工查阅。计费时的实际租户解析已由 `billing.mjs` 自动完成，
> 真相源是 `scripts/billing-config.json`（chat_id → tenant_id）。请不要手工维护两套映射。

## 群 → 租户映射（与 billing-config.json 一致）

| 群名 | chat_id | tenant_id | 负责人 |
|------|---------|-----------|--------|
| 三联传动（群1） | oc_6b2e1c1227010dee8557db2b6be71f87 | dealclaw-sanlian | 三联传动 |
| 三联传动（群2） | oc_e2324866666a680c335d83961511cf6e | dealclaw-sanlian | 三联传动 |
| 小元内测 01 | oc_2f3baba6a6787efecb23a41a31caa241 | xiaoyuan-mengyuchuan | 孟雨川 |
| 小元内测 02 | oc_ebcf88ed083c8e632e0a93913f1e5c49 | xiaoyuan-yangjingxuan | 杨景轩 |
| 小元内测 03 | oc_b48e3fad0d750e272798d3e7d5a6ddb1 | xiaoyuan-wenhua | 文华 |
| 小元内测 04 | oc_1d5d5e9f8deae458aef67ad9328c1cee | xiaoyuan-xiaodong | 晓东 |
| 小元内测 05 | oc_e15af31367d012ded5450f6625d1d347 | xiaoyuan-likun | 李坤 |
| 小元内测 06 | oc_875378492c224d7265da689b4c902b38 | xiaoyuan-xu | 徐 |
| 小元内测 07 | oc_746125317cb1dc79c12ca8ede49bc90f | xiaoyuan-jielurongqi | 解璐榕奇 |
| 小元内测 08 | oc_90abc4a437858d5aa2a2ea64faae8820 | xiaoyuan-wangnuofan | 王诺凡 |
| 小元内测 09 | oc_d8e4deccd1a9c93cdd773182ad261d86 | xiaoyuan-xueliang | 学良 |
| 小元内测 10 | oc_a7f38e244a1fecb7458530c11913a522 | xiaoyuan-hongchun | 洪春 |

## 无群（服务线）

| 服务线 | tenant_id |
|--------|-----------|
| 星擎线索 | xiaoyuan-xingqing |

## 规则

1. 计费时优先用 `--group <chat_id>` 让 `billing.mjs` 从 `billing-config.json` 自动解析租户。
2. 未匹配的群 → `defaultBehavior.unknownTenant = shadow`（只记录不扣费）。
3. 新增群 → 先在 credits-ledger 建账户，再同步更新 `billing-config.json` 的 `groups` 映射。

## 使用方法

```bash
# 推荐：自动解析租户
bash scripts/dealclaw-billing-record.sh --group <chat_id> dealclaw-find-buyers 1 &

# 兜底：显式传 tenantId
bash scripts/dealclaw-billing-record.sh xiaoyuan-mengyuchuan dealclaw-find-buyers 1 &
```
