# LLM Advisor 影子评估报告（压缩后）

> 日期：2026-09-11 · 模型：`openai/gpt-4o-mini`（OpenRouter） · prompt_version：`1.1.0`
> 样本：28（7 场景 × 4 天）· 真实接口调用 · 未展示用户、未执行 Proposal、未接自动发送

## 1. 结论摘要

- **压缩达标**：Advice ≤ 3（实测最大 3）；claim ≤ 80 字、recommendation ≤ 120 字由 `compress_advices` 强制；无任务场景返回**空数组**（4/4）。
- **Guard/fallback**：26/28 通过 GroundingGuard→DecisionGuard；**fallback 2 条（7.1%）**，均为 grounding `fact_mismatch`（claim 出现未在 fact_refs 中的数字）。
- **关键修复（run1→run2）**：run1 未给 action_type 白名单，模型自创类型（`follow_up`/`profiling`/`action`…）→ DecisionGuard.permission 大量拦截（18/28）。run2 在输入中暴露 `allowed_action_types` 并把输出上限提到 800 → **拦截从 18 降到 2**。

## 2. 两轮对比（同一批 28 样本）

| 指标 | run1（约束前） | run2（约束后） |
|---|---|---|
| 通过（ok） | 8 | **26** |
| fallback | 20 | **2** |
| fallback 比例 | 71.4% | **7.1%** |
| Guard 拦截 | 18（permission 27 处）| **2**（grounding）|
| fallback 原因 | guard_violation 18 / token_limit 2 | guard_violation 2 |
| 平均延迟 | 3015 ms | 4311 ms |
| 平均输入 tokens | 990 | 1134 |
| 平均输出 tokens | 323 | 395 |

> 输出上限 700→800 后 token_limit 归零；延迟上升主因输出更长（信息更完整）。

## 3. 压缩与结构指标（run2）

- Advice 条数分布：1 条 ×8、2 条 ×6、3 条 ×8、0 条 ×4（空数组）。
- 相似合并：`compress_advices` 生效；无超 3 条被截断记录。
- 与模板排序差异：8/28 样本存在 order_diff（模板/LLM 关注点不同，供人工评估）。
- 全部 Proposal `authorized=false`，未 materialize、未执行。

## 4. 场景覆盖（需求 6）

邮件 email / 买家回复 reply / 展前 pre_exhibition / 展中 during / 展后 post / 无任务 no_task / 数据异常 data_anomaly；各 4 个样本（= 4 个交易日快照）。

## 5. 典型好坏案例

**好（email，run2 ok）**：LLM 输出 2 条 Advice（“跟进 6 家（待商机分层）”“锁定第一推荐产品（画像）”），各带 1 个 proposal，fact_refs 全部命中，Guard 通过。

**差（email，run2 fallback）**：claim 写“跟进 6 家”，但 `fact_refs` 未包含值为 6 的事实 → GroundingGuard `fact_mismatch` → 降级 TemplateAdvisor。
说明：数字必须同时出现在 claim 与 fact_refs，是当前最需要模型改进的一类问题。

## 6. 人工评估（匿名并排）

- `review.md`：每样本 A/B 随机匿名（一模板、一 LLM），维度：事实准确 / 增量价值 / 优先级 / 可执行性 / 克制性 / 简洁度；末列填 A/B 更好·持平·更差。
- `review-key.json`：A/B 与 template/llm 的映射（盲评后再开）。
- 汇总位（`summary.json.human_tally`）：LLM 优于 / 持平 / 差于模板 —— **待人工填写 review.md 后回填**。

## 7. 敏感信息扫描（需求 9）

`dc_shadow_eval.py scan` 结果：**secret_clean=true，pii_clean=true**（62 文件）。无 API Key、无 Authorization/Bearer 请求头；邮箱均为合成域（@x.com/@example）。

## 8. 建议灰度上线范围（暂缓 → 有条件灰度）

**暂不**全量、不展示、不执行、不接自动发送。

有条件灰度（建议）：
1. **范围**：先单租户、单场景（如 `during` 展中：到展/会议类候选，规则最稳）。
2. **前置条件**：
   - 修 GroundingGuard 数字溯源（claim 数字必须全部落在 fact_refs）；
   - 保留 action_type 白名单输入；保持 ≤3 条 / 80 字 / 120 字。
3. **形态**：LLM 建议只作“影子对照 + 人工盲评”，展示开关默认关；即便展示也仅建议不执行，proposal 必须人工确认后才 materialize。
4. **门槛**：人工盲评中 LLM ≥ 模板（更好+持平占比）且事实准确达标，才扩大场景；否则继续影子。

**明确不做**：自动发送、自动执行 proposal、把 LLM 建议直接写入企业 Memory 或用户可见日报。

## 9. 复现

```
python3 dc_shadow_eval.py sample --out <dir> --days 4 --real --force
python3 dc_shadow_eval.py scan --dir <dir>
```
（run1 基线见 `samples-run1.jsonl` / `summary-run1.json`）
