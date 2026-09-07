# 展后复盘（dealclaw-after-exhibition-review）接口映射

<!-- project: path:/home/openclaw/makaron-openclaw/.openclaw-local/workspaces/dealclaw -->

> 定位：把 skill `dealclaw-after-exhibition-review` 的输入/输出契约（references/report-contract.md）逐字段对到现有 `work/mio-api` 函数，标记「已有 / 需映射 / 待建」三栏，作为建数据层（report-data.json + report.md 生成脚本）的施工依据。
> 版本：2026-09-07 v1（田耕郡确认口径）

## 本版定位决策（田耕郡 2026-09-07 拍板，写死）

1. 本版只做**轻量化的数据分析梳理**，不引入功能使用埋点。
2. 「功能是否完整、正确使用」**不作为评判标准，只作为推理依据**：`product_usage_review` 只在有现成使用记录时作提示，不用于下「效果差/浪费」类结论。
3. 埋点统一规则**后续单独建立**，届时再回填 `feature_events` 数据源。本版不阻塞在埋点上。

---

## 数据读取铁律（田耕郡 2026-09-07 强调，避免执行时绕远路）

**所有展会数据都在同一个 memory 目录，不需要多源查找。**

- 数据目录：`data/memory/<enterprise_id>/`（`dc_memory_data.MEMORY_DATA_DIR` = workspace 根下 `data/memory`）。
- 该目录下已有的文件：`leads.json`（线索池）、`interactions.json`（沟通明细）、`email_followup.json`/`.csv`/`.md`（邮件跟进）、`kb.json`（知识库）、`buyer-onsite-monitor-state.json`（现场监控状态）。
- 读取入口统一走 `dc_memory_data` 的 `read_leads / read_interactions / read_emails / read_signals / read_email_followup`，全部读这同一个目录，**不要再去别处找数据源**。

**真正打飞书 API 的只有一个源——线索池 Bitable。**

- `dc_memory_data.sync_all` 里 10 个 sync 函数，只有 `sync_leads_to_memory` 调 `_run_lark("base", "+record-list", ...)`（一页 200 条分页）。
- 其余 sync 全是本地归集：emails ← email-facts；signals ← dc_email_signals；interactions ← read_email_followup + flatten 推导；email_followup ← email-facts outbound + sent-log；drafts/campaign/materials ← 本地。
- 所以「数据未同步、现拉」只多一次 Bitable 分页拉取（秒级），不是多源查找。

---

## 一、已有（直接能读，无需新建）

### 1.1 展会元数据

| skill 字段 | 现成函数 | 备注 |
|---|---|---|
| `exhibition.exhibition_id/name/country/timezone/start_at/end_at` | `dc_after_exhibition_runtime.load_exhibition_config` / `query_finished_exhibitions` / `resolve_effective_config` | 闭展后按 supplier 查 |
| 展会 stage / meta | `dc_exhibition_stage.read_meta` / `read_stage` | meta.json |
| 时区解析 | `exhibition_cron.event_timezone` | cron 时区换算 |

### 1.2 客户 / 商机 / 互动

| skill 字段 | 现成函数 | 备注 |
|---|---|---|
| `customers[]` | `dc_memory_data.read_leads` / `dc_company_registry.get_lead_pool` / `CompanyRegistry.list_all` | 线索池主表 = customer 主体 |
| `interactions[]` | `dc_memory_data.read_interactions` | 16 字段 interaction |
| email 明细 | `dc_memory_data.read_emails` / `read_email_followup` | sent log + followup |
| signals | `dc_memory_data.read_signals` | 结构化信号 |

> opportunity 概念当前**由 lead 记录承载**，字段映射见 `dc_memory_data._feishu_to_board`：
> `stage / match_grade / followup_priority / priority_reason / contact_policy / opportunity_status / priority_rule_version / priority_updated_at / next_action / due / reply_count / dossier_url`。
> 无独立 `read_opportunities` 持久化，opportunity 由 `evaluate_stage` / `evaluate_priority` 动态派生（见下）。

### 1.3 匹配度 / 阶段 / 优先级

| skill 字段 | 现成函数 | 返回 |
|---|---|---|
| `fit_grade`（match_grade A/B/C/待确认） | `dc_opportunity_stage.evaluate_stage` | 由 signals 证据派生 |
| `stage`（待触达/已触达/已回复/需求明确/报价中） | `dc_opportunity_stage.evaluate_stage` | `proposed_stage / effective_stage / status / evidence / missing / conflicts / max_stage_reached / opportunity_status / contact_reachability / warnings` |
| `followup_priority`（三档）+ `priority_reason` | `dc_priority.evaluate_priority` / `compute_lead_priority` / `apply_priorities_to_leads` | `priority / actionable / excluded_reason / priority_reason / evidence_refs / missing_signals / rule_version` |

### 1.4 会议 / 扫码 / 慧记慧译

| skill 字段 | 现成函数 |
|---|---|
| meeting interaction 构建 | `dc_meeting_ingest.build_interaction` / `ingest_meeting` |
| 信号提取 + 证据核验 | `dc_meeting_ingest.classify_signals` / `extract_candidate_signals` |
| 原始记录捕获/重放/证据校验 | `dc_meeting_capture.capture_raw_response` / `FileRawLoader.load` / `verify_evidence_from_raw` / `replay` |

### 1.5 展后分流 / 建联状态

| skill 输出 | 现成函数 | 返回 |
|---|---|---|
| `buyer_actions.not_connected_priority` | `dc_after_exhibition_recommend.recommend` | `uncontacted_recommendations` + `contacted_but_not_connected` |
| `buyer_actions.connected_followups` | 同上 | `connected_followups` |
| `buyer_actions.suppressed` | 同上 | `suppressed`（+ `conflicted`） |
| 状态判定原语 | `is_connected` / `has_touch` / `is_suppressed` / `matches_ideal` / `dedupe` | 单买家布尔判断 |

### 1.6 邮件 / 档案文档

| skill 字段 | 现成函数 |
|---|---|
| 发送/回复/退信 | `dc_memory_data.sync_emails_to_memory` / `read_email_followup` |
| `buyer_actions[].dossier_url` | `dc_dossier.build_dossier_content` / `dossier_plan` / `sync_dossier` |

---

## 二、需映射（口径对齐，非新造，但要定映射规则）

### 2.1 漏斗阶段 → 事件源（report-contract 5 层主漏斗）

| 漏斗层（5） | 事件源 / 现成函数 | 明细信号 + 口径要求 |
|---|---|---|
| 目标买家 | `dc_after_exhibition_recommend.fetch_after_exhibition` + `is_in_scope` + `dedupe` | `fetch_after_exhibition` 现为 mock 返回空，9/8 接真实 |
| 已邀约 | `dc_exhibition_invitation.run_record`（写）→ 本地 `invitations[]` | 明细「确认参与」：当前无「确认」字段，需补 `confirmed_at`；邀约无独立 read 函数，需补 `read_invitations` |
| 到展/会面 | meeting capture 的 attendance + `isMeeting`；`dc_meeting_ingest.build_interaction`（source=meeting） | 明细区分「本届到展」vs「到达展位/实际会面」 |
| 有效商洽 | interaction `direction=bidirectional` + `raw_record_ref` | 明细「需求明确」：`dc_meeting_ingest.classify_signals`（product_need + quantity/usage/budget/timeline/spec/project_context），需原始证据 verified |
| 商务推进 | `dc_opportunity_stage.evaluate_stage` 的 `opportunity_status` + signals（quote_request/sample_request/contract/payment/delivery_confirm/next_negotiation） | 明细「已执行跟进」`dc_memory_data.read_emails` + sent log（outbound）；「买家回复」interaction `has_reply`，不含 delivered/opened |

> 映射原则（来自 skill diagnostic-rules.md 校验重点）：每层用唯一 `customer_id` 计数，不能按记录条数累计；分母集合含分子集合才算相邻转化率。

### 2.2 数据源状态标记 `data_sources[].status`（ready/partial/unavailable/error）

现有只有 `dc_meeting_capture.inspect_empty` / `inspect_schema` 的局部能力。
需新建一个聚合函数，把各源（invitation/attendance/booth_visit/scan/meeting/translation/email/whatsapp/lead_pool）的 `record_count + coverage + synced_through` 串成统一的 `data_sources` 状态。
**关键规则**：`error` / `unavailable` / 未完成同步 ≠ 0；只有明确 `completed_empty` 才判 0 条。

### 2.3 `demand_insights`（需求洞察）

由 `dc_meeting_ingest.classify_signals` 产出的 signals 聚合：按 `type` 分组统计产品需求/数量/用途/预算/交期/规格/异议/渠道偏好。注明样本量；同客户重复提及按一客户计。

### 2.4 `buyer_actions.nurture`（长期培育）

`recommend` 不直接输出 nurture。由 `match_grade`（B/C 级）+ `followup_priority`（长期培育档）从 lead 记录派生，无独立函数，需在生成层组合。

---

## 三、待建（本版按决策处理）

| 项 | 状态 | 本版处理 |
|---|---|---|
| `feature_events` / `feature_usage`（功能使用率） | 零落点，需埋点 | **本版不建**。埋点统一规则后续建立；本版 `product_usage_review` 只用现成使用记录作推理依据，不作评判标准 |
| `benchmarks`（行业均值/同行分位） | 零落点 | skill 允许降级「无基准只展示自身漏斗」，非阻塞 |
| report-data.json + report.html/report.pdf 生成脚本 | 零落点 | 核心待建：把漏斗+诊断+买家行动项+需求洞察组装成契约结构，HTML 渲染 + chrome headless 出 PDF |
| `data_sources` 聚合层 | 零落点 | 需新建（见 2.2） |

---

## 四、触发机制（田耕郡 2026-09-07 拍板，写死）

**触发时机（两条，写死）：**

1. **定时触发**：闭展日之后的第一个工作日，和早报一起发。
2. **意图触发**：展后识别到用户主动提出展会总结意图（如「展后报告」「参展效果怎么样」「为什么效果差」），直接触发，不等早报。

**定时触发落地**：
- 落地方式：复用现有早报 cron（`30/50 9 * * 1-5`），在 `dc_daily_cycle.py` 的 morning slot 里扫描 `query_finished_exhibitions` 返回的展会，凡「end < 今天、且尚未生成过 close_out 报告」的展会，就触发生成并随早报一起发。
- 为什么天然满足「第一个工作日」：早报 cron 本身只在工作日跑（`* * 1-5` + `is_business_day` 兜底），所以早报跑的那天必然是工作日；每个闭展展会第一次被早报扫描到的那天，就是它闭展后第一个工作日。
- 现成组件：`is_business_day`（周一～周五判断，已有）、`query_finished_exhibitions`（`end < 今日` 判已闭展，已有）、早报 cron（已有）。**不需要新增 cron**。
- `conversion_review`（D+7 转化复盘）与 `refresh`（用户主动）另行触发，不绑早报。

---

## 五、输出契约字段 → 生成来源速查

| 输出字段 | 来源 |
|---|---|
| `executive_summary` | 生成层自组装（结论 + wins + main_bottleneck + priority_action） |
| `funnel[]` | 见 2.1 各层计数 |
| `diagnoses[]` | 见 diagnostic-rules.md 诊断优先顺序 + 2.1 漏斗层 |
| `buyer_actions` | `recommend` 四类 + nurture 派生 |
| `demand_insights` | `classify_signals` 聚合 |
| `product_usage_review` | 本版仅用现成使用记录，不作评判 |
| `data_completeness` | 待建 `data_sources` 聚合层 |
| `benchmark_context` | 本版可空（降级） |
