# Reflection 审核候选（分发前测试母体）

> 生成：2026-09-11T03:11:09.428494+00:00 · 共 10 条 · **只读候选，本文件不自动改系统**
> 分类：bug → 代码+回归测试；skill_improvement → Skill/规则；
> industry_knowledge → 脱敏后落通用知识；tenant_only → 不进 payload；ignore → 忽略。

## bug（1）→ 代码 + 回归测试
- [agent] DealClaw reflection 链路补装落地｜移植脚本先验证路径解析；同名脚本先查现有用途再覆盖；同名不同用途则改名共存
  - 理由：agent 层 what_failed 含缺陷特征：初版脚本默认解析到全局 workspace 导致写错目录；DealClaw 自带

## skill_improvement（4）→ Skill / 规则
- [agent] DealClaw reflection 链路补装｜移植类任务必须端到端验证路径解析
  - 理由：agent 层含可复用流程/规则特征（what_worked/next_time/tags）
- [agent] Daily Brief 早晚报 今日数据 跨日时区 bug｜任何'今日/当日'口径的时间戳，先转业务时区再取日；禁止用 ISO 前10位直接比本地日期
  - 理由：agent 层含可复用流程/规则特征（what_worked/next_time/tags）
- [agent] LLM 结构化输出的枚举白名单｜要求模型产出受限枚举字段时，必须在 prompt/输入里给出白名单并显式禁止自创；否则 Guard 会把大部分输出拦掉
  - 理由：agent 层含可复用流程/规则特征（what_worked/next_time/tags）
- [agent] payload 同步与发布通道｜同步/发布前先确认发布通道（远端/制品/OSS），不要默认 push 代码仓就等于发布；两侧 md5 校验后再提交
  - 理由：agent 层含可复用流程/规则特征（what_worked/next_time/tags）

## industry_knowledge（1）→ 通用知识（industry-knowledge.md，脱敏后）
- [business] 客户要的是数字和 ROI，不是叙事性文案：今日会谈/待跟进/回复、展会漏斗（到场率/商洽率）、高匹配买家数，才是他们感知价值的地方｜早晚报固定【本届展会战报】+【今日数据】块，Top-N 只放有商机证据的客户；把商机归因到本届展会
  - 理由：业务层为行业级事实/规律且无租户专属标识
  - 脱敏后拟落通用知识：客户要的是数字和 ROI，不是叙事性文案：今日会谈/待跟进/回复、展会漏斗（到场率/商洽率）、高匹配买家数，才是他们感知价值的地方

## tenant_only（4）→ 仅本地分身（不进 payload）
- [business] 东南亚市场只做印尼和越南，泰国不碰｜推荐买家自动过滤泰国
  - 理由：业务层 preference：租户个人偏好/纠正，不进共享层
- [business] 要的是有实际采购记录的制造商，不是询盘多的贸易商｜找买家默认按『制造商+采购记录』筛，降低分销商权重
  - 理由：业务层 correction：租户个人偏好/纠正，不进共享层
- [business] 企业主营木制猫爬架（cat tree/condo/tower），目标市场美国/加拿大/英国/德国｜找买家按猫爬架品类 + 这四国方向
  - 理由：业务层含租户专属选择（目标市场/产品/排除/偏好）
- [business] 验证业务版脚本改名后仍可用｜业务 reflection 与 Knight reflection 分离
  - 理由：业务层未识别为行业级，默认留租户层

## ignore（0）→ 忽略
- （无）

