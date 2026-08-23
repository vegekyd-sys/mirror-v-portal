# DealClaw 晋升日志（从 MEMORY.md 下沉）

> 以下是从每日记录自动晋升（openclaw-memory-promotion）的原始内容，已从 MEMORY.md 下沉到这里，避免 MEMORY.md 超重。

## Promoted From Short-Term Memory (2026-08-21)

<!-- openclaw-memory-promotion:memory:memory/2026-08-12.md:178:199 -->
<!-- openclaw-memory-promotion:memory:memory/2026-08-15.md:49:66 -->
- 代理邮箱: agent@example.com（upsert created，supplier 151897148668） - webhook: 本群自定义机器人，未开签名校验 - mention_open_id: <OPEN_ID> - 测试: sent=true, bound=true, via=custom_bot ✅ ## 20:19 发送个人邮件（wangqiang2 测试） - from agent@example.com → user@example.com - 主题「明天去找你」，Resend id b064bb85，accepted/rejected 0 - via scripts/founder-direct/send-direct.mjs（mail.dealclaw.io → Resend 代理） ## 21:59 绑定 agent@example.com 到本群为唯一真值 - 群: <GROUP_ID>（DealClaw Agent 测试群） - 田耕郡要求: thia 绑定本群，本群为唯一真值（原绑定指向王强测试群 oc_5195...需要改） - webhook:... [score=0.830 recalls=5 avg=0.742 source=memory/2026-08-15.md:49-66]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:4:7 -->
- 09:00 AI猎客-小元内测-薛亮09 cron run（直推路径，无需知识库绑定）: 群: <GROUP_ID>（薛亮09，三联传动机械有限公司，supplier S000003，company_id=sanliantmcom）; 路径: 按 skill「直接推送是默认路径」执行——查猎客(TradeChina buyerLeadsPlaza S000003 巴西170) + CDP 买家数据(search_aiv2 BR + gearbox/reducer/redutor/transmission 关键词，442 去重候选) → 相关性过滤 → 线索池去重(200 条在库) → 优先本届圣保罗展(152996309411)预报名 → sync_buyerleads_to_pool(来源=AI猎客) 创建 10 条 → 群推送 10 家; 推送 10 家（均为本届展预报名买家）: ACOPLATEC / MEVI ENGRENAGENS E REDUTORES / KALATEC AUTOMACAO / RPM MOTORES ELETRICOS / TOURO SUPRIMENTOS / AZANELLI / HPB AUTOMACAO / TEM TRATORPECAS / OBR EQUIP.... [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:4-7]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:8:9 -->
- 09:00 AI猎客-小元内测-薛亮09 cron run（直推路径，无需知识库绑定）: 踩坑: 线索池「匹配产品」仅接受选项 圆柱齿轮减速机/行星齿轮减速机，「买家类型」仅 品牌商/制造商/经销商/工程商——首次批量创建因选项值非法失败(800030005)，已按选项映射重写后成功; 状态: data/buyer-leads-v10/<GROUP_ID>.json revision 3，last_run pushed_10_leads [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:8-9]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:13:16 -->
- 10:10 AI猎客-小元-杨景轩坤02 cron run（v6绑定模型-已绑定但知识库仍已删除，静默跳过）: 群: <GROUP_ID>（小元*杨景轩*坤 02）; 绑定检查: ✅ 已绑定 → 浙江小元家纺有限公司，supplier S000004（v10 state 确认）; 知识库: FceMdCp3HoLO6CxlOSGc7f1en3g → 10:12 复核仍已删除（3380003，user 身份验证）; 群内动态核查: 最新消息仍为 08-15 10:20 上轮 cron 结果卡，之后无新消息；无「重新绑定企业知识库」命令、无新知识库文档链接 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:13-16]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:17:18 -->
- 10:10 AI猎客-小元-杨景轩坤02 cron run（v6绑定模型-已绑定但知识库仍已删除，静默跳过）: 结论: 按 skill 规则不发旧线索、不查 TradeChina、不写 Base；08-13 已发运营错误卡，本轮静默跳过不重复发卡; 状态: data/buyer-leads-v10/<GROUP_ID>.json last_run 已更新 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:17-18]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:22:25 -->
- 10:17 AI猎客-小元-晓冬健04 cron run（v6绑定模型-草稿待确认，静默跳过）: 群: <GROUP_ID>（小元内测·晓冬健04，supplier S000009）; 绑定检查: 无正式绑定。state 为 draft_pending_confirmation；knowledge_doc_token 指向草稿 G3DFdxxLUoa9CVx4omdcm7F5njd，标题仍为「佛山市顺德区雪特朗电器有限公司｜企业知识库（草稿）」，revision 3 未变；base 字段为 null; 群内动态核查: 最新消息仍为 08-15 10:39 上轮 cron 状态卡，之后无新消息；无「确认企业画像 v1」类回复；无置顶文档; 结论: 按 v6 绑定模型停留在「群历史建草稿→待企业确认」阶段；不建重复草稿、不建 Base、不查 TradeChina、不发卡片 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:22-25]
<!-- openclaw-memory-promotion:memory:memory/2026-08-16.md:26:26 -->
- 10:17 AI猎客-小元-晓冬健04 cron run（v6绑定模型-草稿待确认，静默跳过）: 状态: data/buyer-leads-v10/<GROUP_ID>.json revision 4，last_run skip_no_push [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-16.md:26-26]

## Promoted From Short-Term Memory (2026-08-22)

<!-- openclaw-memory-promotion:memory:memory/2026-08-12.md:424:436 -->
- 绑定状态: ❌ 无绑定 → ✅ 新创建 - 操作: notify_routes.json channels 新增 <GROUP_ID> - tradechina_supplier_id: S000006 - 说明: 系统指令配置，为该群绑定 TradeChina 供应商 ID ## 20:53 cron: 配供应商-立坤健05 → TradeChina supplier ID S000008 - 群: <GROUP_ID>（立坤健05） - 绑定状态: ❌ 无绑定 → ✅ 新创建 - 操作: notify_routes.json channels 新增 <GROUP_ID> - tradechina_supplier_id: S000008 - 说明: 系统指令配置，为该群绑定 TradeChina 供应商 ID [score=0.823 recalls=3 avg=0.706 source=memory/2026-08-12.md:424-436]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:5:8 -->
- 10:14 AI猎客-小元-杨景轩坤02 cron run（v6绑定模型-已绑定但知识库仍已删除，静默跳过）: 群: <GROUP_ID>（小元*杨景轩*坤 02）; 绑定检查: ✅ 已绑定 → 浙江小元家纺有限公司，supplier S000004（v10 state 确认）; 知识库: FceMdCp3HoLO6CxlOSGc7f1en3g → 10:14 复核仍已删除（3380003，user 身份验证）; 群内动态核查: 最新消息仍为 08-16 10:13 上轮 cron 结果卡，之后无新消息；无「重新绑定企业知识库」命令、无新知识库文档链接 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:5-8]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:9:10 -->
- 10:14 AI猎客-小元-杨景轩坤02 cron run（v6绑定模型-已绑定但知识库仍已删除，静默跳过）: 结论: 按 skill 规则不发旧线索、不查 TradeChina、不写 Base；08-13 已发运营错误卡，本轮静默跳过不重复发卡; 状态: data/buyer-leads-v10/<GROUP_ID>.json last_run 已更新 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:9-10]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:14:17 -->
- 10:20 AI猎客-小元-立坤健05 cron run（v6绑定模型-草稿待确认，跳过）: 群: <GROUP_ID>（小元*立坤*健 05），supplier S000008; 绑定检查: ❌ 未绑定（v10 state draft_pending_confirmation；base_app_token/base_table_id 均空；document_origin=draft_from_group_history）; 草稿: ImDOdaAuVo5oc2x6R1Kc6UFpnid 直读可用，revision 3 未变（标题「领艺智能家居｜企业知识库」）; 确认检查: 08-16 10:17 至今群内仅上轮跳过通知 1 条（bot 自己），无新消息；pin 为空；无「确认企业画像」命令、无按钮确认事件 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:14-17]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:18:19 -->
- 10:20 AI猎客-小元-立坤健05 cron run（v6绑定模型-草稿待确认，跳过）: 结果: 跳过，草稿仍待赵立坤显式确认；不建重复草稿、不建 Base、不推线索、不发线索卡; 状态写入: data/buyer-leads-v10/<GROUP_ID>.json（revision 3→4，last_run skip_no_push） [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:18-19]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:23:26 -->
- 10:25 AI猎客-小元-晓冬健04 cron run（v6绑定模型-草稿待确认，静默跳过）: 群: <GROUP_ID>（小元内测·晓冬健04，supplier S000009）; 绑定检查: 无正式绑定。state 为 draft_pending_confirmation；knowledge_doc_token 指向草稿 G3DFdxxLUoa9CVx4omdcm7F5njd，标题仍为「佛山市顺德区雪特朗电器有限公司｜企业知识库（草稿）」，revision 3 未变；base 字段为 null; 群内动态核查: 最新消息仍为 08-16 10:24 上轮 cron 状态卡，之后无新消息；无「确认企业画像 v1」类回复；置顶为空; 结论: 按 v6 绑定模型停留在「群历史建草稿→待企业确认」阶段；不建重复草稿、不建 Base、不查 TradeChina、不发线索卡 [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:23-26]
<!-- openclaw-memory-promotion:memory:memory/2026-08-17.md:27:27 -->
- 10:25 AI猎客-小元-晓冬健04 cron run（v6绑定模型-草稿待确认，静默跳过）: 状态: data/buyer-leads-v10/<GROUP_ID>.json revision 5，last_run skip_no_push [score=0.803 recalls=0 avg=0.620 source=memory/2026-08-17.md:27-27]
