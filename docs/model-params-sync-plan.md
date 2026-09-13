# DealClaw 模型供应商目录与模型参数管理方案

> 状态：待评审（V2 平台化重构）
> 更新：2026-09-13
> 目标：将现有“手工填写供应商 + 手工录入模型 ID”的页面升级为“预置主流供应商、自动发现模型与参数、允许人工覆盖、兼容自定义供应商”的统一模型接入平台。

---

## 1. 背景与问题

当前 `LlmProvidersPage` 要求管理员手工填写：

- 供应商 ID
- Base URL
- API Key
- 模型 ID（每行一个，通过 `:reasoner`、`:vision` 后缀表达能力）

后端 `LlmModelSpec` 只有：

```ts
interface LlmModelSpec {
  id: string;
  reasoning?: boolean;
  vision?: boolean;
}
```

Agent 的 `write-config.mjs` 无法获得模型真实限制，只能通过模型 ID 前缀猜测：

- `deepseek*`：`contextWindow=1,000,000`、`maxTokens=384,000`
- 其他模型：`contextWindow=131,072`、`maxTokens=8,192` 或 `65,536`

该设计已经造成实际错误。以阿里云 `qwen3.7-plus` 为例：

| 参数 | 当前生成值 | 阿里云官方 API 返回值 |
|---|---:|---:|
| 上下文窗口 | 131,072 | 1,000,000 |
| 最大输出 | 8,192 | 131,072 |
| 最大推理 Token | 65,536 | 262,144 |
| 输入模态 | text、image | text、image、video |

直接后果包括：过早触发 compaction、输出长度受限、能力标记缺失、不同供应商同名模型参数无法区分。

因此不能只给阿里云增加一个“同步参数”按钮，而应建立统一的**供应商目录、模型发现适配器和可编辑参数快照机制**。

---

## 2. 建设目标

### 2.1 用户体验目标

新增供应商使用向导式流程：

1. 选择预置供应商，或选择“自定义供应商”；
2. 系统自动填入默认协议、Base URL、认证方式和区域选项；
3. 用户填写 API Key、工作空间 ID 等凭据；
4. 点击“测试连接并加载模型”；
5. 系统调用该供应商 API，列出当前账号真正可用的模型；
6. 用户勾选需要启用的模型；
7. 系统加载模型上下文、输出上限、推理、多模态等默认参数；
8. 用户可修改默认参数，修改值明确标记为“人工覆盖”；
9. 保存后形成可审计的配置快照，再异步推送给受影响租户。

### 2.2 系统目标

- 预置主流供应商，不再要求管理员记忆 Base URL 和模型 ID；
- 参数优先来自供应商官方 API，不再通过模型名称猜测；
- 不假设每家供应商 API 能力相同，支持完整发现、部分发现、仅模型列表、完全手工四种模式；
- 自动获取值和人工覆盖值分开保存，能查看来源、时间和差异；
- 自定义 OpenAI-Compatible 供应商始终可用；
- Agent 启动只消费已保存快照，不在启动时访问外部供应商；
- 保持现有租户模型选择、LLM proxy、计费和异步推送机制兼容。

### 2.3 非目标

第一期不做：

- 根据价格或性能自动选择模型；
- 自动切换供应商；
- 自动覆盖管理员已修改的参数或价格；
- 把第三方聚合平台价格当作官方供应商价格静默覆盖；
- 依赖实时抓取网页文档作为生产价格源；
- 在 Agent 容器启动阶段动态查询供应商；
- 第一期直接完成所有非文本模型的运行时调用端点；目录可先支持，运行能力必须单独声明。

---

## 3. 总体架构

系统分为五层：

```text
供应商模板目录
  ↓ 选择模板、填写凭据
供应商实例
  ↓ 调用对应 Discovery Adapter
供应商原始模型目录
  ↓ 归一化、校验、用户选择与覆盖
已启用模型参数快照
  ↓ 生成 LLM_PROVIDERS / llm-proxy-config
租户 Agent + nexus-gateway
```

### 3.1 供应商模板目录

模板是代码内维护的非敏感静态定义，描述“如何接入”，不保存用户密钥：

```ts
interface ProviderTemplate {
  id: string;
  label: string;
  category: 'official' | 'cloud-platform' | 'aggregator' | 'custom';
  protocol: 'openai-chat' | 'openai-responses' | 'anthropic-messages' | 'gemini';
  defaultBaseUrl: string;
  discoveryAdapter: string;
  credentialFields: CredentialFieldDefinition[];
  endpointFields?: EndpointFieldDefinition[];
  capabilities: {
    listModels: boolean;
    tokenLimits: boolean;
    modalities: boolean;
    reasoning: boolean;
    pricing: boolean;
  };
  helpUrl: string;
  enabled: boolean;
}
```

模板只负责：默认地址、所需字段、适配器类型、帮助链接和能力声明。

### 3.2 供应商实例

实例是管理员在系统中实际添加的连接：

```ts
interface ProviderInstance {
  id: string;                 // UUID，数据库主键
  name: string;               // OpenClaw 引用 ID，如 aliyun-prod
  label: string;
  templateId: string;         // aliyun-bailian / anthropic / custom-openai 等
  protocol: ProviderProtocol;
  baseUrl: string;
  region?: string;
  workspaceId?: string;
  credentialsEncrypted: string;
  discoveryMode: 'full' | 'partial' | 'list-only' | 'manual';
  status: 'draft' | 'active' | 'disabled' | 'error';
  lastTestedAt?: string;
  lastDiscoveryAt?: string;
  lastDiscoveryStatus?: string;
}
```

同一种模板允许创建多个实例，例如：

- `aliyun-prod`
- `aliyun-overseas`
- `openai-main`
- `openai-backup`

### 3.3 模型发现适配器

每个适配器实现统一接口：

```ts
interface ProviderDiscoveryAdapter {
  testConnection(ctx: AdapterContext): Promise<ConnectionTestResult>;
  listModels(ctx: AdapterContext): Promise<DiscoveredModel[]>;
  getModel?(ctx: AdapterContext, modelId: string): Promise<DiscoveredModel | null>;
}
```

统一输出：

```ts
type ModelType =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'image-generation'
  | 'image-edit'
  | 'speech'
  | 'transcription'
  | 'audio-generation'
  | 'video-generation'
  | 'multimodal-embedding'
  | 'unknown';

type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'file' | 'embedding';

interface DiscoveredModel {
  id: string;
  displayName?: string;
  description?: string;
  modelType: ModelType;
  runtimeParams: ModelRuntimeParams;
  pricing?: NormalizedPricing;
  rawMetadata: unknown;
  source: 'provider-api' | 'builtin-catalog' | 'aggregator' | 'manual';
  discoveredAt: string;
}
```

### 3.4 多类型模型能力结构

模型公共字段与类型专属字段必须分层，避免给 embedding 模型伪造 `maxOutputTokens`，或给图片模型套用文本 Token 语义：

```ts
interface ModelRuntimeParams {
  contextWindow?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxReasoningTokens?: number;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  reasoning?: boolean;
  vision?: boolean;
  toolCalling?: boolean;
  structuredOutput?: boolean;

  embedding?: {
    dimensions?: number[];
    defaultDimension?: number;
    maxBatchSize?: number;
    maxItemsPerRequest?: number;
    normalizedOutput?: boolean;
    distanceMetrics?: Array<'cosine' | 'dot-product' | 'euclidean'>;
    supportsDimensionOverride?: boolean;
    supportsBatchEndpoint?: boolean;
  };
  rerank?: {
    maxDocuments?: number;
    maxDocumentTokens?: number;
    returnsDocuments?: boolean;
    supportsTopN?: boolean;
  };
  image?: {
    sizes?: string[];
    qualities?: string[];
    maxImagesPerRequest?: number;
    supportsEditing?: boolean;
    supportsMask?: boolean;
  };
  audio?: {
    formats?: string[];
    sampleRates?: number[];
    maxDurationSeconds?: number;
    voices?: string[];
  };
  video?: {
    resolutions?: string[];
    durationsSeconds?: number[];
    maxDurationSeconds?: number;
    fps?: number[];
  };
}
```

规则：

- embedding 支持文本、图片或多模态输入；输出是向量，不是文本；
- `dimensions` 表示供应商允许的离散维度，`supportsDimensionOverride` 表示是否可在请求时调整；
- `maxBatchSize` 与 `maxItemsPerRequest` 区分离线 Batch 服务和实时请求载荷；
- rerank 的核心限制是文档数、单文档长度和 top-N，不应映射成 chat 输出 Token；
- 图片、音频、视频模型保留规格、质量、时长等原生维度，供调用校验和价格解析共同使用；
- “目录支持”与“DealClaw 当前可运行”是两个维度；暂未实现运行端点的类型仍可入库，但禁止被租户选为相应业务槽位。

### 3.5 已启用模型参数快照

供应商 API 返回的是“发现值”；管理员保存的是“运行快照”。两者必须分开：

```ts
interface ConfiguredModel {
  providerInstanceId: string;
  id: string;
  displayName?: string;
  modelType: ModelType;

  discovered: ModelRuntimeParams;
  overrides: Partial<ModelRuntimeParams>;
  effective: ModelRuntimeParams;

  source: 'provider-api' | 'builtin-catalog' | 'manual';
  sourceVersion?: string;
  discoveredAt?: string;
  updatedAt: string;
  updatedBy: string;
}
```

有效值计算规则：

```text
effective.field = overrides.field ?? discovered.field ?? safeFallback.field
```

不能把供应商返回值直接覆盖用户修改值。重新同步时只更新 `discovered`，然后重新计算差异并让用户确认。

---

## 4. 首批预置供应商

### 4.1 建议首批目录

| 模板 ID | 展示名 | 协议 | 默认地址/区域 | 初始发现等级 |
|---|---|---|---|---|
| `aliyun-bailian` | 阿里云百炼 | OpenAI Compatible | 工作空间/地域地址 | 完整 |
| `openai` | OpenAI | Responses / Chat | `https://api.openai.com/v1` | 列表 + 内置元数据补全 |
| `anthropic` | Anthropic Claude | Anthropic Messages | `https://api.anthropic.com` | 完整 |
| `google-gemini` | Google Gemini | Gemini | `https://generativelanguage.googleapis.com` | 完整 |
| `moonshot` | Moonshot / Kimi | OpenAI Compatible | `https://api.moonshot.cn/v1` | 部分 |
| `deepseek` | DeepSeek | OpenAI Compatible | `https://api.deepseek.com` | 列表 + 内置元数据补全 |
| `volcengine-ark` | 火山引擎方舟 | OpenAI Compatible | 地域端点 | 部分/需 AK 适配 |
| `zhipu-bigmodel` | 智谱 BigModel | OpenAI Compatible | `https://open.bigmodel.cn/api/paas/v4` | 列表或内置目录 |
| `openrouter` | OpenRouter | OpenAI Compatible | `https://openrouter.ai/api/v1` | 完整 |
| `siliconflow` | 硅基流动 | OpenAI Compatible | `https://api.siliconflow.cn/v1` | 列表/部分 |
| `custom-openai` | 自定义 OpenAI Compatible | OpenAI Compatible | 用户填写 | 自动探测或手工 |
| `custom-anthropic` | 自定义 Anthropic Compatible | Anthropic Messages | 用户填写 | 手工/有限探测 |

> “预置供应商”是接入模板，不代表系统内置 API Key，也不代表默认启用。

### 4.2 供应商 API 能力分级

不能把 `/v1/models` 等同于“完整模型参数接口”。统一定义四级：

| 等级 | 能力 | 处理方式 |
|---|---|---|
| A 完整发现 | 返回模型、上下文、输出上限、模态、推理等 | 直接归一化，用户确认后保存 |
| B 部分发现 | 返回模型和部分参数 | 缺失字段由内置目录补全，仍允许用户修改 |
| C 仅模型列表 | 只返回 ID、owner 等 | 模型 ID 来自 API，参数来自内置目录或手填 |
| D 手工模式 | 无模型发现接口或用户自建网关 | 用户手工添加模型和全部参数 |

### 4.3 已确认的能力示例

| 供应商 | 官方 API 能力 | 归一化说明 |
|---|---|---|
| 阿里云百炼 | `GET /api/v1/models?model=<id>` 返回 `model_info`、模态、价格 | A 级；已用现有工作空间密钥实测成功 |
| Anthropic | `GET /v1/models` / `GET /v1/models/{id}` 返回 `max_input_tokens`、`max_tokens`、capabilities | A 级 |
| Google Gemini | `models.list/get` 返回 `inputTokenLimit`、`outputTokenLimit`、thinking、支持方法 | A 级 |
| OpenRouter | `/api/v1/models` 返回 context、max completion、模态、reasoning、价格 | A 级 |
| Moonshot/Kimi | `/v1/models` 返回 context length、image/video/reasoning 标记 | B 级；输出上限可能仍需补全 |
| OpenAI | `/v1/models` 主要用于列出可访问模型；完整限制需官方目录补全 | C 级 |
| DeepSeek | OpenAI-Compatible 模型列表通常不足以表达完整限制 | C 级 |
| 火山方舟 | 基础模型目录与推理凭证/鉴权体系不完全相同 | B/C 级；适配器需支持 API Key 与 AK/SK 两种模式 |
| 自定义 | 能力未知 | 先探测 `/models`，失败或字段不足进入 D 级 |

### 4.4 内置模型目录的角色

对于 B/C 级供应商，系统维护版本化的 `BuiltinModelCatalog`：

```ts
interface BuiltinModelCatalogEntry {
  providerTemplateId: string;
  modelId: string;
  aliases?: string[];
  params: Partial<ModelRuntimeParams>;
  sourceUrl: string;
  verifiedAt: string;
  catalogVersion: string;
}
```

优先级：

1. 供应商 API 实时返回；
2. 内置目录中相同供应商、相同精确模型 ID；
3. 用户手工输入；
4. 最后才使用保守 fallback，并显示醒目警告。

内置目录不得只按模型前缀匹配，也不得把其他供应商托管的同名模型参数直接套用。

---

## 5. 管理台交互设计

### 5.1 新建供应商向导

#### 第一步：选择供应商

卡片展示供应商名称、类型和自动发现能力：

- 阿里云百炼
- OpenAI
- Anthropic Claude
- Google Gemini
- Moonshot/Kimi
- DeepSeek
- 火山引擎方舟
- 智谱 BigModel
- OpenRouter
- 硅基流动
- 自定义 OpenAI Compatible
- 自定义 Anthropic Compatible

支持搜索；自定义入口始终置底但可见。

#### 第二步：配置连接

模板预填：

- 协议类型；
- 默认 Base URL；
- API 版本；
- 鉴权方式；
- 地域；
- 帮助链接。

用户填写：

- 实例名称；
- API Key 或 AK/SK；
- 工作空间 ID、项目 ID、组织 ID等模板专属字段；
- 可选自定义 Base URL。

操作：

- “测试连接”；
- 只返回成功状态、延迟、账号可访问性和安全化错误；
- 密钥不返回前端、不写普通日志。

#### 第三步：加载并选择模型

点击“加载模型”后：

- 后端调用适配器；
- 返回可用模型列表；
- 可按模型类型、模态、推理能力过滤；
- 默认只展示 chat 模型，embedding/rerank/image 等按分类折叠；
- 用户勾选要启用的模型。

每个模型显示：

- 模型 ID、展示名、版本；
- 类型；
- 上下文窗口、最大输入、最大输出；
- 推理、视觉、视频、工具调用、结构化输出；
- 参数来源和最后同步时间；
- “参数不完整”提示。

#### 第四步：检查与编辑参数

用户可编辑：

- `contextWindow`
- `maxInputTokens`
- `maxOutputTokens`
- `maxReasoningTokens`
- 输入/输出模态
- `reasoning`
- `vision`
- 工具调用/结构化输出能力
- embedding 维数（仅 embedding 模型）

每个字段必须展示状态：

- “供应商 API”
- “内置目录”
- “人工覆盖”
- “缺失/回退值”

修改后显示：

```text
供应商值：1,000,000
当前有效值：800,000
状态：人工覆盖
```

支持“恢复供应商值”。

#### 第五步：保存并生效

保存前展示影响分析：

- 新增/删除/更新的供应商与模型；
- 参数变化；
- 受影响租户数量；
- 是否需要滚动 agent；
- 是否需要更新 gateway proxy；
- 默认、视觉、压缩、备用模型引用是否仍有效。

确认后复用当前异步 push task + SSE 进度机制。

### 5.2 编辑已有供应商

编辑页包含：

- 连接信息；
- 已启用模型；
- “重新加载模型目录”；
- “检查参数更新”；
- 参数差异预览；
- 选择性接受更新；
- API Key 轮换；
- 禁用供应商。

“重新同步”只更新发现快照，不自动覆盖人工覆盖值，也不应立刻滚租户；管理员确认保存后才推送。

### 5.3 自定义供应商流程

自定义模式支持：

- OpenAI Chat Completions；
- OpenAI Responses；
- Anthropic Messages（第二期可启用）；
- 自定义 Header（严格限制名称、加密保存）；
- 自定义模型列表路径；
- 禁用自动发现，完全手工添加。

连接后按顺序探测：

1. 用户指定模型列表 URL；
2. `{baseUrl}/models`；
3. 无法加载则进入手工模式。

自定义模式所有参数均可编辑，必须显示“参数未经供应商 API 验证”的提示。

### 5.4 模型价格检查与编辑

模型选择表和参数编辑页必须同时显示价格摘要：

- 价格状态：已获取、内置目录补全、人工覆盖、未知、已过期；
- 来源：供应商官方 API、供应商官方资料、聚合平台参考、人工设置；
- 币种、计费单位、地域、服务层级、生效时间和最后核验时间；
- 常用 SKU 摘要，例如输入、输出、缓存读取、图片/秒/请求；
- 存在长上下文、Batch、峰谷、分辨率等条件时显示“含条件价格”；
- 价格未知时允许保存模型，但必须阻止启用“扣费模式”，仅允许 shadow usage 或管理员明确批准的零成本内部模型。

价格编辑不是填写两个浮点数，而是编辑一个价格方案。管理员可以：

- 接受全部自动发现价格；
- 仅覆盖某个 SKU；
- 增加私有合同价或企业折扣；
- 设置覆盖生效区间；
- 恢复官方目录值；
- 比较新旧价格并选择生效时间。

---

## 6. 数据模型设计

### 6.1 推荐：从单个加密 JSON 迁移到结构化表

现有全局 `runtime_configs.LLM_PROVIDERS` 仍保留为**下发产物/兼容快照**，不再作为唯一编辑源。

新增表：

#### `llm_provider_templates`

可选择代码静态目录，不必进数据库。若需要运行时运营配置再落表。

#### `llm_provider_instances`

```sql
id                    TEXT PRIMARY KEY
name                  TEXT UNIQUE NOT NULL
label                 TEXT NOT NULL
template_id           TEXT NOT NULL
protocol              TEXT NOT NULL
base_url              TEXT NOT NULL
region                TEXT
workspace_id          TEXT
credentials_encrypted TEXT NOT NULL
extra_config_encrypted TEXT
status                TEXT NOT NULL
last_tested_at        TIMESTAMPTZ
last_discovery_at     TIMESTAMPTZ
last_discovery_status TEXT
created_by            TEXT
updated_by            TEXT
created_at            TIMESTAMPTZ NOT NULL
updated_at            TIMESTAMPTZ NOT NULL
```

#### `llm_provider_models`

```sql
id                     TEXT PRIMARY KEY
provider_instance_id   TEXT NOT NULL REFERENCES llm_provider_instances(id)
model_id               TEXT NOT NULL
display_name           TEXT
model_type              TEXT NOT NULL
source                  TEXT NOT NULL
source_version          TEXT
raw_metadata_encrypted  TEXT

discovered_params       JSONB NOT NULL DEFAULT '{}'
override_params         JSONB NOT NULL DEFAULT '{}'
effective_params        JSONB NOT NULL DEFAULT '{}'

enabled                  BOOLEAN NOT NULL DEFAULT FALSE
last_discovered_at       TIMESTAMPTZ
updated_by               TEXT
updated_at               TIMESTAMPTZ NOT NULL
UNIQUE(provider_instance_id, model_id)
```

#### `llm_model_discovery_runs`

记录每次发现过程：

```sql
id, provider_instance_id, status, started_at, finished_at,
models_seen, models_added, models_changed, error_code, error_message_safe,
response_hash, actor
```

### 6.2 运行参数统一结构

`ModelRuntimeParams` 使用第 3.4 节的公共字段 + 类型专属子对象结构。数据库继续使用 JSONB 保存，以支持供应商能力演进；后端必须使用版本化 schema 校验，不能把任意 JSON 直接下发。

建议在 `effective_params` 中保存：

```json
{
  "schemaVersion": 1,
  "contextWindow": 8192,
  "maxInputTokens": 8192,
  "inputModalities": ["text"],
  "outputModalities": ["embedding"],
  "embedding": {
    "dimensions": [1024, 1536],
    "defaultDimension": 1024,
    "maxItemsPerRequest": 10,
    "normalizedOutput": true,
    "supportsDimensionOverride": true,
    "supportsBatchEndpoint": true
  }
}
```

### 6.3 参数语义规则

- `contextWindow` 是总窗口，不等同于最大输入；
- `maxInputTokens` 独立保存；
- `maxOutputTokens` 是普通输出限制；
- `maxReasoningTokens` 是供应商明确提供的推理预算/推理上限，不应无条件替换 `maxOutputTokens`；
- OpenClaw 当前只消费的字段才进入 `LLM_PROVIDERS`，其他字段保留在数据库供 UI、校验和未来使用；
- 不把 `maxReasoningTokens` 作为未知 OpenClaw 字段直接写入配置，除非目标版本 zod schema 已确认支持。

---

## 7. 参数来源、覆盖与重新同步规则

### 7.1 合并顺序

```text
供应商 API 值
  ↓ 缺失字段由内置目录补全
发现参数 discoveredParams
  ↓ 用户覆盖 overrideParams
有效参数 effectiveParams
  ↓ 仅挑选 OpenClaw 支持字段
LLM_PROVIDERS 运行快照
```

### 7.2 重新发现

假设供应商将 qwen3.7-plus 上下文从 1M 调整为 2M：

- 没有人工覆盖：effective 自动候选为 2M，但需管理员确认保存；
- 人工覆盖为 800K：discovered 变成 2M，effective 仍为 800K，UI 显示差异；
- 模型从供应商列表消失：标记 `unavailable`，不立即删除，阻止新增选择并提示已有引用；
- 别名指向新快照：保留 `sourceVersion/equivalentSnapshot`，显示版本变化。

### 7.3 参数校验

保存时进行跨字段校验：

- 所有 Token 数必须为正整数并设合理上限；
- `maxInputTokens <= contextWindow`；
- `maxOutputTokens <= contextWindow`；
- 若供应商声明上下文是输入+输出总和，则检查输入/输出组合；
- `vision=true` 必须包含 image 输入模态；
- embedding 模型不能被选为默认对话模型；
- chat 模型不能被选为 embedding 模型；
- 未知字段不透传给 OpenClaw。

允许用户填写低于供应商上限的值；填写高于供应商上限时默认阻止，只有具备高级权限并填写原因才可强制保存。

---

## 8. 通用价格目录与计费解析

### 8.1 价格来源分级

价格发现和模型参数发现是两套独立能力。供应商能返回模型列表，不代表能返回价格。

| 级别 | 价格来源 | 示例处理 | 是否可自动生效 |
|---|---|---|---|
| P1 官方机器可读 | 官方模型 API 或价格 API | 阿里云部分模型元数据、OpenRouter 路由价格 | 可生成候选版本；生产扣费仍需发布策略控制 |
| P2 官方资料目录 | 官方定价页、官方公告、官方文档 | OpenAI、Anthropic、Gemini、DeepSeek 等内置目录 | 由系统版本发布或管理员审核后生效 |
| P3 聚合平台参考 | 第三方聚合平台机器可读价格 | 仅用于提示、比对和缺失告警 | 默认不可静默覆盖官方供应商价格 |
| P4 人工/合同价 | 管理员录入的企业协议价、内部结算价 | 覆盖指定供应商实例、地域、项目或时间段 | 审核后生效，优先级最高 |

生产路径不得在每次调用时抓取官网价格页面。官方网页只作为内置目录维护和人工审核的证据，系统发布版本化价格数据后再供运行时读取。

### 8.2 通用价格结构

金额禁止使用 JavaScript `number` 作为权威值。API 使用 decimal 字符串，数据库使用 `NUMERIC`；币种使用 ISO 4217，时间统一保存 UTC。

```ts
type PricingUnit =
  | 'token'
  | 'request'
  | 'image'
  | 'megapixel'
  | 'second'
  | 'minute'
  | 'character'
  | 'document'
  | 'search-call'
  | 'tool-call';

type PricingMetric =
  | 'input-token'
  | 'output-token'
  | 'reasoning-token'
  | 'cache-read-token'
  | 'cache-write-token'
  | 'embedding-input-token'
  | 'rerank-input-token'
  | 'request'
  | 'image'
  | 'image-megapixel'
  | 'audio-input-second'
  | 'audio-output-second'
  | 'video-input-second'
  | 'video-output-second'
  | 'character'
  | 'document'
  | 'web-search-call'
  | 'tool-call';

interface PricingCondition {
  region?: string[];
  serviceTier?: string[];
  invocationMode?: Array<'realtime' | 'batch'>;
  inputModalities?: ModelModality[];
  outputModalities?: ModelModality[];
  minContextTokens?: number;
  maxContextTokens?: number;
  minRequestTokens?: number;
  maxRequestTokens?: number;
  cacheType?: Array<'read' | 'write' | 'ephemeral'>;
  imageSize?: string[];
  imageQuality?: string[];
  audioFormat?: string[];
  videoResolution?: string[];
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  utcTimeWindows?: Array<{ days?: number[]; start: string; end: string }>;
}

interface PricingSku {
  id: string;
  metric: PricingMetric;
  unit: PricingUnit;
  unitSize: string;       // 例如 "1000000" token、"1" image
  unitPrice: string;      // decimal 字符串，例如 "2.000000"
  currency: string;       // CNY、USD
  conditions?: PricingCondition;
  priority: number;       // 条件同时命中时的确定性排序
}

interface NormalizedPricing {
  schemaVersion: 1;
  source: 'provider-api' | 'official-catalog' | 'aggregator' | 'manual-contract';
  sourceUrl?: string;
  sourceVersion?: string;
  sourcePayloadHash?: string;
  currency: string;
  region?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
  verifiedAt: string;
  skus: PricingSku[];
}
```

`unitSize` 与 `unitPrice` 均使用 decimal 字符串，是为了表达“每百万 Token”“每千字符”“每分钟”等价格，而不产生二进制浮点误差。

### 8.3 条件价格解析规则

一次调用可能产生多个可计费量，例如输入 Token、缓存读取、输出 Token和 web search。解析器必须逐个 usage metric 匹配 SKU：

1. 按 provider instance、精确模型 ID、调用发生时间筛选已发布价格版本；
2. 按 region、service tier、realtime/batch、模态和规格筛选候选 SKU；
3. 按长上下文阈值、缓存类型、峰谷时段等条件继续筛选；
4. 选择条件最具体且 `priority` 最高的唯一 SKU；
5. 若出现多条同优先级规则，判定价格配置冲突并停止扣费，不得随机选取；
6. 按 `quantity / unitSize * unitPrice` 使用 decimal 算术计算；
7. 为每个 SKU 生成成本明细，汇总为调用成本。

长上下文阶梯应根据供应商规则明确使用“请求输入 Token”“总上下文 Token”或“输入+输出”，不能统一猜测。跨越阶梯时是否对整次请求采用新价格，或仅对超出部分计价，也必须由规则字段明确表达，建议增加 `tierMode: 'whole-request' | 'progressive'`。

### 8.4 价格合并与人工覆盖

参数采用字段合并；价格采用“方案 + SKU”合并：

```text
供应商官方 API 候选
  ↓ 缺失 SKU 由官方内置目录补全
发现价格 discoveredPricing
  ↓ 聚合平台仅作参考差异，不自动覆盖
  ↓ 人工合同价按 SKU/条件覆盖
有效价格 effectivePricing
  ↓ 审核发布
不可变价格版本 publishedPriceVersion
```

规则：

- 精确的人工合同价覆盖同一 metric + conditions 的发现价；
- 人工覆盖未涉及的 SKU 继续继承官方价；
- 同模型不同 region、service tier 或 Batch 模式不得互相覆盖；
- 自动同步只产生草稿和差异，不直接修改已发布价格版本；
- 价格下降可配置自动审核策略，价格上涨默认需要人工确认；
- 价格未知、币种未知或规则冲突时，不得用 `0` 代替；
- 明确免费的模型必须使用 `priceStatus='free'`，并保留来源，不能与“未知”混淆。

### 8.5 价格数据表

新增：

#### `llm_model_price_plans`

```sql
id                    TEXT PRIMARY KEY
provider_instance_id  TEXT NOT NULL REFERENCES llm_provider_instances(id)
provider_model_id     TEXT NOT NULL REFERENCES llm_provider_models(id)
status                TEXT NOT NULL -- draft/published/superseded/disabled
source                 TEXT NOT NULL -- provider-api/official-catalog/aggregator/manual-contract
source_url             TEXT
source_version         TEXT
source_payload_hash    TEXT
currency               TEXT NOT NULL
region                 TEXT
effective_from         TIMESTAMPTZ NOT NULL
effective_until        TIMESTAMPTZ
verified_at            TIMESTAMPTZ NOT NULL
published_at           TIMESTAMPTZ
published_by           TEXT
created_at             TIMESTAMPTZ NOT NULL
```

#### `llm_model_price_items`

```sql
id                    TEXT PRIMARY KEY
price_plan_id         TEXT NOT NULL REFERENCES llm_model_price_plans(id)
metric                TEXT NOT NULL
unit                  TEXT NOT NULL
unit_size             NUMERIC(38, 12) NOT NULL
unit_price            NUMERIC(38, 18) NOT NULL
conditions            JSONB NOT NULL DEFAULT '{}'
priority              INTEGER NOT NULL DEFAULT 0
source_item_key       TEXT
created_at            TIMESTAMPTZ NOT NULL
```

#### `llm_price_sync_runs`

记录同步来源、目录版本、开始/结束时间、发现模型数、变更 SKU 数、币种变化、涨跌幅、冲突、错误、安全化响应摘要和 actor。

必须增加排他约束或发布前校验，避免同一模型、地域和生效时间出现多个重叠的 published 方案。

### 8.6 调用时价格快照

`credits-ledger` 不能在查询历史账单时用“当前价格”重算历史事件。每次 usage 事件结算时应保存：

```ts
interface UsageCostSnapshot {
  pricePlanId: string;
  pricePlanVersion: string;
  currency: string;
  usageOccurredAt: string;
  resolvedSkus: Array<{
    priceItemId: string;
    metric: PricingMetric;
    quantity: string;
    unit: PricingUnit;
    unitSize: string;
    unitPrice: string;
    cost: string;
  }>;
  totalCost: string;
  fxRateSnapshot?: {
    from: string;
    to: string;
    rate: string;
    source: string;
    observedAt: string;
  };
}
```

建议为 `llm_usage_events` 增加：

- `price_plan_id`
- `pricing_snapshot JSONB`
- `upstream_cost_amount NUMERIC`
- `upstream_cost_currency TEXT`
- `billing_cost_amount NUMERIC`
- `billing_currency TEXT`
- `pricing_status`：`resolved/unknown/conflict/pending`

usage 原始量和价格快照都必须保留。后续价格修订不能篡改已结算事件；需要纠错时使用冲正/补差事件。

### 8.7 与现有 `llm_token_pricing` 的迁移

当前表的 `input_cache_hit_peak/offpeak`、`input_cache_miss_peak/offpeak`、`output_peak/offpeak` 是 DeepSeek 文本计费的特例，不应继续加列扩展。

迁移步骤：

1. 将每条旧记录转换为一个 published price plan；
2. 六个价格列分别转换为 cache-read/input/output SKU，并写入 peak/offpeak 时间条件；
3. 保留旧表只读，验证新旧计算结果一致；
4. `credits-ledger` 双算但只以旧逻辑扣费，记录差异；
5. 差异为零并覆盖跨时段边界后，切换新解析器为权威；
6. 旧表改为兼容视图或停止写入，不能长期双写形成两个权威价格源。

### 8.8 OpenClaw `cost` 字段边界

`write-config.mjs` 中的 OpenClaw `cost` 只能作为兼容展示或本地估算，不承担 DealClaw 权威账务。对于可无损映射的简单文本价格，可填充 input/output/cacheRead/cacheWrite；遇到地域、阶梯、Batch、峰谷或多模态条件时，不应把复杂规则压扁成错误的单价。

权威路径固定为：

```text
nexus-gateway 原始 usage
→ credits-ledger 读取调用时有效价格版本
→ 生成不可变 pricing snapshot
→ 记账/扣费/账单
```

---

## 9. 后端 API 设计

### 9.1 模板目录

```http
GET /v1/admin/llm-provider-templates
```

返回模板、字段定义、默认端点、能力等级和帮助链接，不返回任何密钥。

### 9.2 连接测试

```http
POST /v1/admin/llm-provider-connections/test
```

请求为未保存草稿或 provider instance ID。返回：

```json
{
  "ok": true,
  "latencyMs": 186,
  "adapter": "aliyun-bailian",
  "discoveryLevel": "full",
  "safeMessage": "连接成功"
}
```

### 9.3 模型发现

```http
POST /v1/admin/llm-provider-instances/:id/discover
GET  /v1/admin/llm-model-discovery-runs/:runId
```

发现可异步执行，避免模型列表分页、网络延迟阻塞请求。

### 9.4 保存模型选择和覆盖

```http
PUT /v1/admin/llm-provider-instances/:id/models
```

请求包含选中的模型及 override 参数。后端重新计算 effective，不接受前端直接指定未经校验的 effective。

### 9.5 价格发现、差异与发布

```http
POST /v1/admin/llm-provider-instances/:id/prices/discover
GET  /v1/admin/llm-price-sync-runs/:runId
GET  /v1/admin/llm-provider-models/:modelId/price-plans
POST /v1/admin/llm-provider-models/:modelId/price-plans/preview
POST /v1/admin/llm-provider-models/:modelId/price-plans/:planId/publish
```

- discover 只生成候选价格和 sync run，不改变生产扣费；
- preview 返回新增、删除、涨跌、币种、条件和冲突差异；
- publish 校验生效区间、规则唯一性、decimal 精度和审核权限；
- 已发布版本不可原地修改，只能发布新版本并让旧版本 superseded；
- API 返回来源 URL、核验时间和版本，但不返回包含凭据的原始响应。

### 9.6 配置预览和发布

```http
POST /v1/admin/llm-providers/preview
PUT  /v1/admin/llm-providers
```

- preview 返回参数、价格、运行能力与影响租户差异，不写库；
- PUT 在事务中保存结构化数据、生成兼容 `LLM_PROVIDERS` 快照、创建现有异步 push task；
- 保留当前 SSE 进度模态框；
- 模型参数发布与价格发布支持独立权限和独立生效时间，避免修改价格导致无意义的 Agent rollout。

---

## 10. 适配器设计

建议目录：

```text
packages/provisioning-service/src/services/llm-provider-catalog/
  types.ts
  registry.ts
  normalize.ts
  builtin-catalog.ts
  adapters/
    aliyun-bailian.ts
    anthropic.ts
    google-gemini.ts
    openrouter.ts
    moonshot.ts
    openai.ts
    deepseek.ts
    volcengine-ark.ts
    zhipu-bigmodel.ts
    siliconflow.ts
    custom-openai.ts
```

每个适配器负责：

- 构造请求 URL；
- 添加认证头或签名；
- 分页；
- 超时与限流；
- 供应商响应 → `DiscoveredModel`；
- 不记录密钥和原始敏感响应。

公共层负责：

- ID 去重；
- 数值边界校验；
- 模态枚举归一化；
- 字段来源记录；
- 内置目录补全；
- discovery run 审计；
- 错误信息脱敏。

---

## 11. Agent 与 Gateway 下发改造

### 11.1 `write-config.mjs`

`defaultModelSpec` 改为接收完整模型快照：

```js
function buildModelSpec(spec) {
  const fallback = legacyFallback(spec.id, spec.reasoning === true);
  return {
    id: spec.id,
    name: spec.displayName || spec.id,
    ...(spec.reasoning === true ? { reasoning: true } : {}),
    input: toOpenClawInput(spec.inputModalities, spec.vision),
    contextWindow: spec.contextWindow ?? fallback.contextWindow,
    maxTokens: spec.maxOutputTokens ?? fallback.maxTokens,
    // 仅映射可无损表达的展示价格；DealClaw 账务以 pricing snapshot 为准。
    cost: buildDisplayCost(spec.simpleDisplayPricing),
    compat: buildCompat(spec),
  };
}
```

注意：

- 保留 legacy fallback 仅用于迁移期和缺失字段；
- UI 和日志对 fallback 模型显示警告；
- `maxReasoningTokens` 是否写入 OpenClaw 必须先核对目标版本 zod schema；
- provider 的协议不能继续全部写死为 `openai-completions`，应由模板协议映射到 OpenClaw 支持的 `api` 类型；第一期若 Agent 仍只支持 OpenAI-Compatible，则非兼容协议模板先标记“目录可配置、运行接入待支持”；
- OpenClaw `cost` 只映射简单、无条件的文本 Token 价格；复杂价格不映射为虚假的单值，更不能作为 credits-ledger 扣费依据；
- embedding、rerank、图片、音视频模型不得进入 OpenClaw chat model 列表，必须由各自运行端点消费。

### 11.2 nexus-gateway

Gateway 的 `llm-proxy-config` 需要保留：

- provider instance ID；
- protocol；
- upstream base URL；
- 加密/Secret 中的凭据引用；
- 已启用模型及能力；
- 计费别名和模型归一化 ID。

禁止把供应商发现用的管理凭据返回到 Agent；Agent 继续只拿 gateway proxy 地址和租户调用凭证。

### 11.3 差分推送签名

当前 `modelSpecSignature` 仅关注 id/reasoning/vision。需扩展为至少：

```text
provider protocol + model id + contextWindow + maxOutputTokens +
inputModalities + reasoning + vision + compat
```

否则参数原地变化不会滚动受影响租户。

---

## 12. 安全设计

### 12.1 密钥安全

- API Key、AK/SK、自定义 Header 均加密保存；
- GET 接口只返回掩码与 `credentialConfigured=true`；
- discovery adapter 只在服务端解密；
- 日志、审计、异常不得包含请求头、完整 URL query 中的 key 或原始响应敏感字段；
- 密钥轮换与供应商参数编辑分离。

### 12.2 SSRF 防护

预置模板只允许请求模板声明的域名和 HTTPS。

自定义供应商：

- 默认禁止 localhost、回环、链路本地、RFC1918、集群 Service CIDR、云元数据 IP；
- DNS 解析前后均校验；
- 禁止跨域重定向；
- 连接/响应总超时；
- 限制响应体大小；
- 自定义内网地址需更高权限和显式 allowlist。

### 12.3 权限与审计

新增权限：

- `llm-provider.read`
- `llm-provider.write`
- `llm-provider.credential.rotate`
- `llm-provider.discover`
- `llm-provider.force-override`
- `llm-pricing.read`
- `llm-pricing.write`
- `llm-pricing.publish`
- `llm-pricing.contract-override`

审计记录：连接测试、模型发现、参数覆盖、价格同步、价格覆盖、价格发布、供应商禁用、密钥轮换、发布和回滚。价格变更审计必须保存旧/新版本 ID、差异摘要、生效时间、操作者和审批人。

---

## 13. 迁移方案

### 13.1 现有数据迁移

读取当前加密 `runtime_configs.LLM_PROVIDERS`：

1. 根据 baseUrl/名称匹配预置模板；
2. 无法匹配的归入 `custom-openai`；
3. 每个现有 provider 创建 provider instance；
4. 每个现有模型创建 configured model；
5. 现有 `reasoning/vision` 记为人工覆盖，避免迁移后被自动覆盖；
6. context/maxTokens 等暂为空，首次发现后产生待确认差异；
7. 生成的新运行快照必须与旧 JSON 语义等价；
8. 灰度验证后才切换 UI 的编辑源。

### 13.2 双读双写阶段

- Phase M1：结构化表只读影子导入，旧 JSON 仍为主；
- Phase M2：新 UI 写结构化表，同时生成旧 JSON；运行侧仍读旧 JSON；
- Phase M3：稳定后以结构化表为主，旧 JSON 仅作为物化快照；
- 任一阶段可回滚到旧 UI 和旧 JSON。

---

## 14. 分阶段实施计划

### Phase 0：契约确认

- 核对 OpenClaw 当前版本支持的 provider `api` 类型和 model spec zod schema；
- 明确 chat、embedding、rerank 等模型如何分别下发；
- 为首批模板逐个验证官方模型 API，不凭经验猜字段。

### Phase 1：数据基础与运行参数透传

- 新增结构化表与迁移；
- 新增 `ModelRuntimeParams`；
- 扩展 `modelSpecSignature`；
- `write-config.mjs` 读取有效快照，保留 fallback；
- 现有管理页面行为不变。

### Phase 2：供应商模板与新建向导

- 建立模板 registry；
- 管理台改为供应商卡片选择；
- 实现测试连接；
- 实现 `custom-openai` 手工流程。

### Phase 3：首批自动发现适配器

优先顺序：

1. 阿里云百炼（已有生产实测）；
2. Anthropic；
3. Google Gemini；
4. OpenRouter；
5. Moonshot/Kimi；
6. OpenAI、DeepSeek（列表 + 内置目录）；
7. 火山方舟、智谱、硅基流动。

每个适配器独立发布，不阻塞自定义模式。

### Phase 4：多类型模型参数与运行能力

- discovered / override / effective 三层 UI；
- embedding、rerank、图片、音频、视频专属参数编辑与校验；
- 参数差异预览与恢复供应商值；
- 模型下线和别名变化处理；
- 目录能力与运行能力分离；
- 影响租户分析。

### Phase 5：价格目录与 shadow 双算

- 实现 `NormalizedPricing`、price plan、price item 和 sync run；
- 首批接入官方机器可读价格源；
- 为无价格 API 的供应商发布内置官方价格目录；
- 实现条件价格解析、decimal 计算和价格冲突检测；
- 将旧 `llm_token_pricing` 转换为新价格方案；
- credits-ledger 新旧逻辑双算，保存差异但暂不切换扣费；
- 管理台提供价格来源、差异、覆盖、审核和发布流程。

### Phase 6：发布、灰度与运营

- P2 租户灰度；
- 同步 qwen3.7-plus，验证 1M/131072；
- 选取 embedding、rerank、图片模型分别验证非文本目录与价格；
- 校验 DeepSeek 峰谷、长上下文阶梯、Batch、缓存读写等价格案例；
- 检查 compaction 触发频率；
- 再灰度 3–5 个不同供应商租户；
- 新旧价格计算一致后切换 credits-ledger 权威解析器；
- 全量发布；
- 增加发现失败率、价格过期、价格冲突、未知价格、目录变化和参数异常告警。

---

## 15. 测试方案

### 15.1 单元测试

- 每个适配器的 fixture 归一化；
- 分页、空列表、字段缺失、null、别名、模型下线；
- discovered + override 合并；
- Token 跨字段校验；
- 模型类型选择约束；
- modelSpecSignature 参数变化检测；
- 密钥与错误脱敏；
- SSRF 域名/IP/重定向校验；
- embedding 维度、batch、文档数、图片规格、音视频时长等类型专属校验；
- decimal 金额计算，不得出现浮点误差；
- SKU 条件匹配、优先级、冲突和长上下文阶梯；
- region、Batch、cache read/write、峰谷窗口和模态价格；
- 价格未知与明确免费状态区分；
- 生效区间和已发布方案不可变校验。

### 15.2 集成测试

- 使用 mock server 模拟 A/B/C/D 四级模型发现和 P1/P2/P3/P4 四级价格来源；
- 测试连接 → 模型发现 → 价格发现 → 选择 → 覆盖 → preview → 发布 → push；
- 旧 `LLM_PROVIDERS` 与 `llm_token_pricing` 迁移、双算和回滚；
- API Key 轮换不改变模型覆盖参数和已发布价格；
- 供应商 API 失败时仍可保存既有快照，不影响 Agent 启动；
- 价格更新后历史 usage cost 不变化；
- 价格冲突或未知时停止扣费但保留 usage，并产生告警。

### 15.3 生产验收

- qwen3.7-plus：`contextWindow=1,000,000`、`maxTokens=131,072`；
- Agent `openclaw.json` 与数据库 effective 一致；
- embedding 模型能保存维度、批量和输入模态，且不能被选为默认对话模型；
- nexus-gateway 仍记录 proxy usage 事件；
- credits-ledger 为每次调用保存匹配的 price plan 和 SKU 快照；
- DeepSeek 峰谷边界前后分别命中正确 SKU；
- Batch、缓存和长上下文测试命中对应条件价格；
- 人工将 contextWindow 改为 800,000，重新同步后仍保持 800,000；
- 人工合同价只覆盖目标 SKU 和有效区间；
- 自定义 OpenAI-Compatible 可完全手工添加参数和价格并运行；
- discovery API 不可用时，已运行租户不受影响。

---

## 16. 主要改动文件预估

### provisioning-service

- `src/db/migrate.ts`
- `src/services/llm-providers.ts`
- `src/services/llm-provider-catalog/*`（新增）
- `src/services/llm-pricing/*`（新增：目录、合并、校验、发布）
- `src/routes/admin-ops.ts` 或拆分 `src/routes/llm-provider-catalog.ts`
- `src/services/llm-push-task.ts`
- 相关测试

### admin-web

- `src/pages/LlmProvidersPage.tsx`（建议拆组件）
- `src/components/llm-providers/ProviderTemplatePicker.tsx`
- `src/components/llm-providers/ProviderConnectionForm.tsx`
- `src/components/llm-providers/ModelDiscoveryTable.tsx`
- `src/components/llm-providers/ModelParamsEditor.tsx`
- `src/components/llm-providers/ModelPricingEditor.tsx`
- `src/components/llm-providers/PricingDiffPreview.tsx`
- `src/components/llm-providers/ProviderDiffPreview.tsx`
- `src/lib/types.ts`

### dealclaw-agent

- `runtime/write-config.mjs`
- `src/__tests__/write-config*.test.ts`

### nexus-gateway

- provider protocol/模型元数据配置（具体范围由 Phase 0 的 OpenClaw 协议核验决定）
- 按模型类型采集 token、request、image、pixel、audio/video duration 等原始 usage
- 计费模型 ID、region、service tier、Batch 与缓存属性归一化测试

### credits-ledger

- `src/db/migrate.ts`：新增通用价格方案、SKU、同步记录及 usage 价格快照字段
- `src/routes/llm-usage.ts`：替换 DeepSeek 专用价格解析，增加条件匹配与 decimal 计算
- 新增价格解析器、价格冲突检测、shadow 双算和冲正事件测试

---

## 17. 风险与决策

| 风险 | 对策 |
|---|---|
| 各供应商模型 API 字段不一致 | 适配器归一化 + 能力分级，不强行统一原始协议 |
| `/models` 只返回 ID | 内置版本化目录补全，仍允许手工覆盖 |
| 官方参数发生变化 | 发现快照与人工覆盖分离，更新需确认 |
| 模型别名漂移 | 保存 alias/snapshot/version，差异预览 |
| 大量模型导致 UI 难用 | 搜索、分类、分页，只有勾选模型进入运行配置 |
| 保存参数导致全租户重启 | preview 影响分析 + 现有差分异步推送 |
| 自定义 URL 引发 SSRF | 后端严格网络策略与域名 allowlist |
| 新协议 OpenClaw 不支持 | 模板声明“目录能力”和“运行协议能力”，不支持时禁止启用而非错误下发 |
| 自动值本身不可靠 | 展示来源/时间/原始字段，允许人工覆盖并保留审计 |
| 官方 API 不提供价格 | 使用基于官方资料维护的版本化目录，不在调用链实时抓网页 |
| 第三方聚合价与官方价不一致 | 聚合价默认仅作参考，不覆盖官方价格 |
| 条件价格规则重叠 | 发布前唯一性校验；运行时冲突则停止扣费并告警 |
| 价格更新改变历史账单 | usage 发生时固化 price plan 与 SKU 快照，纠错使用冲正事件 |
| 未知价格被误当免费 | `unknown` 与 `free` 分离，未知价格禁止正式扣费 |
| 浮点误差导致账务偏差 | API decimal 字符串 + PostgreSQL NUMERIC + decimal 算术 |
| 多类型模型误入 chat 槽位 | modelType 与 runtime capability 双重校验 |

### 17.1 推荐决策

采用以下原则：

1. **模板预置、凭据自带**；
2. **官方 API 优先、内置目录补全、人工设置兜底**；
3. **自动发现值与人工覆盖值永久分层**；
4. **保存快照后再下发，运行期不依赖供应商目录 API**；
5. **自定义模式是一等公民，不是异常分支**；
6. **供应商目录支持范围与 Agent 实际协议支持范围分开声明**；
7. **模型参数与价格分别发现、分别审核、分别发布**；
8. **官方机器可读价格优先，官方内置目录补全，聚合价仅作参考，人工合同价最终覆盖**；
9. **价格是多 SKU 条件规则，不压扁成 input/output 两个数字**；
10. **DealClaw pricing snapshot 是账务权威，OpenClaw cost 不是账务源**；
11. **历史成本不可随价格更新漂移，只能通过冲正或补差修正**。

---

## 18. 最终验收标准

管理员无需查文档即可完成：

```text
选择阿里云百炼
→ 填工作空间地址与 API Key
→ 测试连接
→ 自动加载账号可用模型
→ 勾选 qwen3.7-plus
→ 自动显示 1M 上下文 / 131072 输出 / 推理与多模态能力
→ 可将上下文手工改为 800K
→ 保存并预览受影响租户
→ 异步推送
→ Agent 使用 800K（人工覆盖），数据库仍保留供应商原始 1M 及同步时间
```

添加向量模型时：

```text
在阿里云百炼实例中筛选 embedding
→ 勾选 text-embedding-v4
→ 自动显示输入模态、最大输入、可选/默认维度和批量限制
→ 自动加载官方价格；若 API 未返回则由内置官方目录补全
→ 展示币种、单位、地域、来源和核验时间
→ 管理员可仅覆盖指定维度或指定 SKU 的合同价
→ 保存后模型只能进入 embedding 业务槽位，不能成为默认 chat 模型
```

价格更新时：

```text
发现官方价格发生变化
→ 生成候选价格版本和差异
→ 展示受影响模型、SKU、条件、生效时间与涨跌幅
→ 管理员审核发布
→ 新调用按发生时间命中新版本
→ 历史调用继续保留原 price plan / SKU 快照
```

对于系统未预置的供应商：

```text
选择“自定义 OpenAI Compatible”
→ 填 Base URL / API Key
→ 尝试加载 /models
→ 若只能得到模型 ID，则手工补参数和价格
→ 未知价格明确告警，不默认视为免费
→ 保存、校验、下发
```

达到以上场景，才算完成“主流供应商开箱即用 + 多类型模型统一管理 + 价格可追溯计费 + 任意供应商可扩展”的平台化目标。
