# DealClaw 模型目录平台增量开发 PRD（首轮）

> 文档状态：首轮开发基线
> 依据：`docs/model-params-sync-plan.md`
> 原则：先建立可验证、可回滚的数据与领域基础，不直接切换生产扣费，不一次接入全部供应商。

## 1. 项目信息

- **Language**：中文
- **Programming Language / 技术栈**：沿用现有 Monorepo；TypeScript / Node.js / Express / PostgreSQL，管理台沿用 React；Agent 配置生成使用 Node.js ESM（`write-config.mjs`）
- **Project Name**：`dealclaw_model_catalog_incremental`
- **原始需求复述**：依据模型参数同步方案，增量建设统一模型目录。首轮优先完成结构化模型类型与参数、通用价格 Schema 及数据表、目录/价格领域服务、旧 `LLM_PROVIDERS` 与 `llm_token_pricing` 兼容迁移，并让 `write-config.mjs` 可安全消费参数快照；现有生产调用、租户推送和扣费权威路径保持不变。

## 2. 产品定义

### 2.1 Product Goals

1. **建立统一且可演进的数据契约**：模型按类型保存公共参数与专属参数，价格按版本化方案和条件 SKU 表达；所有写入均经版本化 Schema 校验。
2. **保证存量业务零中断迁移**：结构化数据可由现有 `LLM_PROVIDERS`、`llm_token_pricing` 导入并重新生成语义等价兼容快照；任一阶段可切回旧读取路径。
3. **用影子验证降低上线风险**：目录与价格领域服务先提供解析、预览、校验和 shadow 对账能力，不改变生产扣费、不自动滚动租户、不依赖供应商实时 API。

### 2.2 User Stories

- As a **平台管理员**, I want 查看模型的类型、有效参数、参数来源和完整性状态 so that 我能识别错误的上下文窗口或能力标记。
- As a **平台管理员**, I want 预览旧配置迁移后的目录与价格差异 so that 我能在不影响租户的情况下确认兼容性。
- As a **平台工程师**, I want 通过统一领域服务读取模型与价格快照 so that 后续供应商适配器无需耦合旧 JSON 或 DeepSeek 特例表。
- As a **Agent 运行维护人员**, I want `write-config.mjs` 优先使用已保存的有效参数并对缺失值保守回退 so that Agent 配置准确且旧数据仍能启动。
- As a **财务/计费维护人员**, I want 新价格解析器与旧 `llm_token_pricing` 进行 shadow 双算 so that 在正式切换前可以量化差异且不会误扣费。

## 3. 首轮范围与优先级

### P0 — Must have：可安全落地的基础能力

#### P0.1 结构化模型契约与校验

- 必须定义版本化 `ModelType`、`ModelModality`、`ModelRuntimeParams` Schema，至少支持：
  - 类型：`chat`、`embedding`、`rerank`、`image-generation`、`image-edit`、`speech`、`transcription`、`audio-generation`、`video-generation`、`multimodal-embedding`、`unknown`；
  - 公共参数：上下文、最大输入/输出/推理 Token、输入/输出模态、推理、视觉、工具调用、结构化输出；
  - embedding、rerank、image、audio、video 专属子对象。
- 必须保存 `discovered_params`、`override_params`、`effective_params` 三层数据，后端按 `override ?? discovered ?? safeFallback` 计算有效值；不得接受客户端直接指定未经校验的 effective。
- 必须执行跨字段校验：Token 为正整数、输入/输出不超过上下文、`vision=true` 时包含 image 输入、非 chat 模型不得进入 chat 槽位、未知字段不得下发 OpenClaw。
- 必须显式区分“目录可收录”与“当前运行时可启用”。

#### P0.2 模型目录数据表与领域服务

- provisioning-service 必须新增或等价实现：
  - `llm_provider_instances`；
  - `llm_provider_models`；
  - 可选的 `llm_model_discovery_runs` 基础审计表（首轮可仅支持 import/manual 来源）。
- 必须建立 Catalog Domain Service，职责至少包含：Schema 校验、三层参数合并、精确 provider instance + model ID 查询、运行槽位校验、兼容快照生成、差异预览。
- 凭据必须继续加密保存；查询接口不得返回明文密钥。
- 首轮数据来源仅要求 `legacy-import`、`manual`、`builtin-catalog` 的领域占位；不得以未验证的供应商 API 数据冒充官方发现值。

#### P0.3 通用价格 Schema、数据表与领域服务

- credits-ledger 必须实现版本化 `NormalizedPricing` / `PricingSku` / `PricingCondition` Schema。
- 金额 API 必须使用 decimal 字符串，数据库必须使用 `NUMERIC`，业务计算不得以 JavaScript `number` 作为权威金额。
- 必须新增或等价实现：
  - `llm_model_price_plans`；
  - `llm_model_price_items`；
  - `llm_price_sync_runs` 基础审计表；
  - `llm_usage_events` 的 `pricing_status`、`pricing_snapshot`、价格方案引用与上游成本字段（允许为空，不改变现有写入兼容性）。
- Pricing Domain Service 必须支持：按精确 provider/model/调用时间筛选方案、条件 SKU 匹配、优先级与冲突检测、decimal 成本计算、不可变 published 版本、`unknown` 与 `free` 明确区分。
- provisioning-service 与 credits-ledger 数据库若物理隔离，表间必须使用稳定字符串 ID，不创建跨库外键；provider instance/model 映射契约必须记录版本并有契约测试。

#### P0.4 旧数据迁移与兼容快照

- 必须提供幂等迁移/回填：
  - 解密全局 `runtime_configs.LLM_PROVIDERS`；
  - 每个旧 provider 生成 provider instance，无法识别模板时归入 `custom-openai`；
  - 每个旧模型生成结构化模型，原 `reasoning/vision` 记为人工覆盖；
  - 缺失的 context/output 等参数保持未知，不伪造成供应商发现值；
  - 从结构化数据重新生成的 `LLM_PROVIDERS` 在 provider/model/default/image/compaction/fallback 引用上与旧配置语义等价。
- 必须将每条 `llm_token_pricing` 转换为 published price plan 与 cache-read/input/output 峰谷 SKU；旧表保持只读权威，不删除、不停止现有查询。
- 必须提供迁移报告：总数、成功数、跳过数、错误数、配置差异、价格双算差异。
- 迁移失败必须按单条可重试，不得损坏旧表或覆盖旧 JSON。

#### P0.5 `write-config.mjs` 安全透传

- `LLM_PROVIDERS` 兼容快照必须向后兼容现有 `{id, reasoning?, vision?}` 模型条目，并可增量携带 `displayName`、`modelType`、有效运行参数和 protocol。
- `write-config.mjs` 必须优先读取有效快照中的 `contextWindow`、`maxOutputTokens`、输入模态等 OpenClaw 已确认支持字段；字段缺失时才使用现有 legacy fallback。
- `maxReasoningTokens` 等未经目标 OpenClaw Zod Schema 确认的字段不得直接写入。
- 首轮仅允许已支持的 OpenAI-Compatible/chat 运行协议进入 Agent chat model 列表；其他类型只可入目录、不可下发。
- 必须扩展 `modelSpecSignature`，至少覆盖 protocol、model ID、contextWindow、maxOutputTokens、inputModalities、reasoning、vision、compat，确保参数变化可被差分机制识别。
- 首轮不得因结构化表写入自动触发 push；只有显式沿用现有发布动作时，才生成 `LLM_PROVIDERS` 并复用异步 push task + SSE。

#### P0.6 credits-ledger shadow accounting

- 必须保留当前 `llm_usage_events` 只记录 usage、绝不扣减 credits 的产品语义。
- 新解析器必须对旧表已覆盖的调用进行 shadow 双算：旧算法结果仍为展示/现行结果，新算法记录匹配方案、SKU、状态与差异。
- `unknown`、`conflict`、解析异常时必须保留原始 usage 并告警，不得按 0 元或免费处理，不得产生 credits 扣减。
- 历史事件的 shadow 价格快照写入后不得因目录更新而原地重算；纠错另行设计。

### P1 — Should have：基础能力稳定后的增量

- 管理台提供模型目录只读/轻编辑页面、来源标识、参数完整性警告和迁移差异预览。
- 提供结构化配置 preview API 和显式发布 API，发布时复用现有租户影响分析、差分推送、异步任务与 SSE。
- 提供价格方案/SKU 的只读列表、冲突提示、shadow 差异报表；价格发布仅影响 shadow 解析。
- 建立供应商模板 registry 与 `custom-openai` 手工模式；连接测试和自动发现接口仅做契约，不要求接入全部供应商。
- 先实现一个经过验证的自动发现适配器作为纵向样板，建议阿里云百炼；独立开关、独立发布。
- 增加权限与审计：目录读写、参数强制覆盖、价格读写/发布、迁移与回滚操作。

### P2 — Nice to have：后续平台化

- Anthropic、Gemini、OpenRouter、Moonshot、OpenAI、DeepSeek 等适配器逐个接入。
- 完整五步供应商向导、参数差异接受/恢复、模型下线与别名变化处理。
- 条件价格编辑器、合同价覆盖、价格审核流、过期与涨价告警。
- embedding/rerank/图片/音视频的真实运行端点与原始 usage 采集。
- shadow 指标达标后，再单独评审生产价格解析器权威切换和 credits 扣费策略。

## 4. 功能需求

### 4.1 领域边界

1. **Catalog Domain（provisioning-service）**负责供应商实例、模型类型、运行参数、来源/覆盖、兼容 `LLM_PROVIDERS` 快照。
2. **Pricing Domain（credits-ledger）**负责价格方案、SKU、条件匹配、价格快照与 shadow 差异。
3. **Agent Runtime**只消费已发布兼容快照，不在启动时访问供应商 API。
4. **Gateway**首轮维持现有 provider/model/raw token usage 上报；新增字段必须可选，避免破坏旧客户端。

### 4.2 核心状态与规则

- 模型参数状态：`complete` / `incomplete` / `fallback` / `invalid`。
- 价格状态：`draft` / `published` / `superseded` / `disabled`；解析状态：`resolved` / `unknown` / `conflict` / `pending` / `free`。
- published 价格方案不得原地修改；新版本发布后旧版本 superseded，但历史快照仍引用旧版本。
- 精确模型 ID 优先；首轮新领域服务不得沿用跨供应商最长前缀价格匹配作为权威规则。
- fallback 必须可观测：日志/管理台显示使用原因，但不得记录凭据或敏感原始响应。

## 5. 非功能需求

- **兼容性**：旧 `LLM_PROVIDERS` 无新增字段时，Agent 行为与改造前一致；现有 usage POST 不增加必填字段。
- **可回滚性**：所有新表为增量创建；旧 JSON、旧价格表和旧读取逻辑在首轮保留。功能开关可分别关闭结构化目录读取、快照生成、价格 shadow。
- **正确性**：迁移与快照生成必须幂等；同一输入重复执行不产生重复 provider/model/price plan。
- **性能**：常用目录读取 P95 ≤ 200ms（不含外部 API）；100 个 SKU 的单次价格解析 P95 ≤ 20ms；Agent 启动不得增加外部网络调用。
- **安全**：密钥加密且不回传；日志脱敏；原始 metadata 如可能含敏感信息必须加密或字段白名单化。
- **可观测性**：记录迁移成功率、fallback 数、无效参数数、shadow resolved/unknown/conflict 数、双算差异分布。
- **测试**：关键 Schema、合并、迁移、快照生成、decimal 计算、条件匹配与回滚路径必须具备单元/集成测试。

## 6. UI Design Draft（首轮最小范围）

首轮不重做完整供应商向导，仅在现有 `LlmProvidersPage` 增加一个可由功能开关控制的“目录数据预览”区域：

- **顶部状态条**：旧配置为权威 / 结构化导入状态 / 最近迁移时间 / 回滚可用状态。
- **模型表格**：供应商、模型 ID、模型类型、上下文、最大输出、输入模态、参数来源、完整性；默认只读。
- **模型详情抽屉**：展示 discovered / override / effective 三列差异与 fallback 警告；P0 可仅供查看。
- **价格摘要**：价格状态、币种、来源、SKU 数、shadow 解析状态；不提供“切换正式扣费”按钮。
- **操作**：`预览迁移`、`执行/重试影子导入`、`导出差异报告`；危险操作需二次确认。
- 现有供应商编辑、保存、异步推送和 SSE 进度入口保持不变。

## 7. 验收标准

### 7.1 模型目录

- 给定现有有效 `LLM_PROVIDERS`，影子导入后 provider/model 数量一致，默认、视觉、压缩和备用引用 100% 可解析。
- 重新生成兼容快照后，旧测试集全部通过；旧模型条目仍可启动 Agent。
- 给定 `qwen3.7-plus` 的有效快照 `contextWindow=1000000`、`maxOutputTokens=131072`，`write-config.mjs` 生成值必须精确一致，不再落入 131072/8192 猜测值。
- 将该模型上下文人工覆盖为 800000 后，effective 与 Agent 配置均为 800000，discovered 仍保留 1000000。
- embedding 模型可保存维度与输入模态，但尝试设为默认 chat 模型必须返回明确校验错误。
- 仅变更 contextWindow 或 maxOutputTokens 时，`modelSpecSignature` 必须变化；无关模型变更不得误判所有租户需重启。

### 7.2 价格与 shadow

- 每条旧 `llm_token_pricing` 均可转换为一个 published plan 和对应峰谷 SKU，数量及币种可核对。
- 使用现有 DeepSeek 测试样本覆盖工作日峰值、非峰值、周末和边界时刻；新旧算法在同一规则语义下金额差异为 0（以数据库 decimal 精度比较）。
- 同优先级条件冲突时结果必须为 `conflict`，不得选择任一 SKU；无方案时为 `unknown`，不得视为 `free`。
- 新功能启用期间 `credits_accounts.balance`、`monthly_used` 与 `credits_transactions` 不因 LLM usage 发生变化。
- 同一 `request_id` 重放不得产生重复 usage 或重复 shadow 成本快照。

### 7.3 迁移与可靠性

- 迁移脚本连续执行两次，第二次新增记录数为 0，已有人工覆盖不被覆盖。
- 任意一条坏数据只记录该条错误并可重试，不影响旧 `LLM_PROVIDERS` 与 `llm_token_pricing` 可读性。
- 关闭所有新功能开关后，无需回滚数据库即可恢复旧 UI、旧 JSON 读取和旧价格展示路径。
- 全量 CI 通过，新增核心逻辑分支覆盖率目标 ≥ 85%。

## 8. 迁移与回滚

### 8.1 迁移阶段

1. **M0 契约确认**：确认 OpenClaw 当前版本支持的 `api` 类型、model spec 字段和 Zod Schema；冻结 Schema v1。
2. **M1 影子导入**：创建新表，从 `LLM_PROVIDERS`、`llm_token_pricing` 幂等回填；旧源仍为唯一权威。
3. **M2 双读校验**：请求仍走旧路径，同时读取新领域服务并记录模型快照差异、价格 shadow 差异。
4. **M3 显式生成兼容快照**：管理员确认后允许结构化目录生成旧 JSON；运行侧仍消费 `LLM_PROVIDERS`，继续使用现有发布与推送机制。
5. **后续独立决策**：结构化表转主编辑源、价格解析器转权威、生产扣费切换分别立项与灰度，不属于首轮。

### 8.2 回滚方案

- 功能开关：`MODEL_CATALOG_SHADOW_IMPORT`、`MODEL_CATALOG_READ`、`MODEL_CATALOG_SNAPSHOT_WRITE`、`LLM_PRICING_SHADOW`（具体命名可由工程统一）。
- 回滚时关闭新读写开关，恢复旧 `runtime_configs.LLM_PROVIDERS` 与 `llm_token_pricing` 路径；新表保留作审计，不做破坏性删除。
- 生成新兼容快照前必须备份旧加密值及版本号；回滚使用版本化恢复，不依赖手工重建。
- 已写入 usage 的 shadow 字段允许保留；不得删除原始 usage，不得反向修改历史账户余额。
- 数据库迁移必须向前兼容旧应用版本：新增列允许为空或有安全默认值，不立即添加会阻断旧写入的必填约束。

## 9. 明确不做事项

首轮明确不做：

- 不切换 credits-ledger 的生产扣费权威逻辑，不从 LLM usage 扣减 credits。
- 不下线、改写或长期双写两个权威价格源；`llm_token_pricing` 首轮保持旧路径权威。
- 不一次实现全部供应商自动发现；最多选一个验证过的样板适配器进入 P1。
- 不在 Agent 启动或每次调用时查询供应商模型/价格 API，不实时抓取价格网页。
- 不上线完整供应商五步向导、合同价审批流或自动发布价格。
- 不实现 embedding、rerank、图片、音频、视频的完整运行调用端点；只建立目录与校验能力。
- 不把复杂条件价格压平写入 OpenClaw `cost`，也不将其作为 DealClaw 权威账务来源。
- 不自动覆盖管理员参数/价格，不把未知价格记为 0 或免费。
- 不改变现有 tenant model selection、nexus-gateway proxy、异步 push task 与 SSE 的基本产品语义。

## 10. Open Questions

1. provisioning-service 与 credits-ledger 是否确认使用独立数据库？跨服务 provider/model 稳定 ID 由谁生成、如何同步？
2. 当前部署的 OpenClaw 版本具体支持哪些 provider `api` 类型、model spec 字段和 `compat` 字段？`maxReasoningTokens` 是否在 Schema 内？
3. `LLM_PROVIDERS` 兼容快照 Schema 是否增加顶层 `schemaVersion`，旧 Agent 对未知字段是否完全容忍？
4. 首轮结构化模型表应位于 provisioning-service 数据库，还是建立独立 catalog service？本 PRD 默认前者。
5. 旧 `llm_token_pricing` 峰谷时间的时区、节假日和边界语义是否以当前 Asia/Shanghai 工作日小时逻辑为验收基准？
6. shadow 双算结果保存于 `llm_usage_events.pricing_snapshot`，还是独立 shadow 表以避免污染未来正式快照？建议独立标记或独立表，需架构确认。
7. “明确免费”的审批与证据字段由谁维护？在确认前只允许 `unknown`，不得自动标记 free。
8. M3 结构化目录生成兼容快照时，审批权限与版本恢复保留期如何定义？
9. P1 首个自动发现样板是否确认选择阿里云百炼，以及测试凭据与脱敏 fixture 由谁提供？
