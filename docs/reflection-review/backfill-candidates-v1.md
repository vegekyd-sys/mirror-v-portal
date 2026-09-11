# 待补反思清单 v1（从每日 memory 回填）

> 生成：2026-09-11 · 来源：项目 memory 文档（每日 `memory/*.md` + `ai-patterns.md`）
> 判据：**"学到了什么"（教训/纠正/规律/偏好）→ 该进 reflection**；"是什么"（规格/契约/领域事实）→ 留 memory 文档。
> 分类**仅为建议**；是否回填、是否改，由人决定。本清单**不自动改任何东西**。

## A. agent 层（方法论 / 坑）— 建议 `skill_improvement`（个别 `bug`）

| # | summary | suggested_change | evidence_ref | conf |
|---|---|---|---|---|
| A1 | 时间展示必须转业务时区 | ISO 时间先识别时区（末尾 `Z`=UTC）；展示前转 `Asia/Shanghai`；统一写「北京时间 YYYY-MM-DD HH:mm」，不心算；对外发送前交叉校验 | `memory/2026-09-04.md` | high |
| A2 | 定时脚本不要依赖 lark-cli | cron 里 lark-cli 读不到 appSecret(keychain) 会静默崩溃 → 发送前把收件数据固化成本地 JSON，脚本只读 JSON | `memory/2026-09-05.md` | high |
| A3 | 批量更新后必须逐条回读 | batch-update 返回数量对但个别记录未生效 → 逐条回读校验，不只信 `updated` 数字 | `memory/2026-09-05.md` | medium |
| A4 | 「补测试」≠「落地」 | 报「完成」前先 grep 真实入口确认它被调用链使用 | `memory/2026-09-06.md:70-71` | high |
| A5 | 对外材料只写对外口径 | 对外稿不写内部技术债（未纳入版本管理/未跑真实 E2E/隔离形态未定等），内部另记 | `memory/2026-09-02.md:79` | medium |
| A6 | payload 脱敏验证覆盖 5 类 | (.env/密钥 ／ 硬编码 key·token·secret ／ 真实邮箱 ／ 客户公司名 ／ 物料脚本)；不能只看 .env 与 key 模式 | `memory/2026-08-23.md:116` | medium |
| A7 | 飞书 xlsx 用 openpyxl 读空 | 改 zipfile+ElementTree 直接读 `sheet1.xml`（列横向分布、inlineStr） | `memory/2026-08-28.md:63` | medium |
| A8 | 飞书群 URL 必须带协议 | 群里发链接写完整 `https://`；Markdown `[文字](url)` 在飞书不生效，用裸 URL | `memory/ai-patterns.md` | high |

## B. business 层（业务纠正 / 偏好）— 建议 `tenant_only`（个别可判 `industry_knowledge`）

| # | summary | suggested_change | evidence_ref | conf |
|---|---|---|---|---|
| B1 | push 是租户级绑定 | `company_id`/supplier id 只是数据隔离边界，**不是路由主键**；路由看 chat_id 绑定 | `memory/2026-09-02.md:9`、`2026-08-29.md:25` | high |
| B2 | 报告交付口径 | 漏斗固定 **5 层**（不回到 10 层）；交付 `report.html + report.pdf`（不飞书 md）；深析/诊断由 Agent 推理、不 if/else 硬编码文案；读数据统一走 `dc_memory_data` | `memory/2026-09-07.md:8-16` | high |
| B3 | 改名/展示规则 | 对外用「小元 / 出海精灵小元」，**不展示模型名**；Bot 应用名一律不动 | `memory/2026-08-25.md:89-107` | high |
| B4 | find-buyers 交互规则 | ≤50 条无感执行、超大量才提示消耗确认；**长任务必须起实时进度卡**；退信后主动判断下一步并通知 | `memory/2026-09-08.md:124-146` | medium |
| B5 | planning 产出结构修正 | 按田耕郡 08-27 纠正后的三样产出结构 | `memory/2026-08-27.md:28` | medium |
| B6 | payload skill 裁剪规则 | 公用/Makaron 创意类 skill 全保留；只删弃用的 DealClaw 专属 skill | `memory/2026-08-24.md:164-170` | medium |

## C. 不该动的（留 memory 文档，非反思）
`customer-dossier-schema` · `cdp-api-contract` · `lead-pool-fields` · `industry-knowledge`（领域事实）· `PRD-v2` · `memory-architecture` · `security-requirements` · `feishu-standard-format` —— 属**规格/契约/事实**。

## D. 备注
- `review-reflections` 当前只读 `memory/reflections/*.jsonl` 与 `projects/dealclaw/reflections.jsonl`，**读不到每日 memory** → 上面这些现在进不了候选（这是清单存在的意义）。
- 回填方式二选一（**均不自动改系统**）：
  1. 一次性回填候选：把 A/B 抽成候选（脱敏）交人工确认；
  2. 给 writer 加一个显式入口：写每日 memory 的「关键坑与经验」时顺带落一条 reflection（不加状态机）。
