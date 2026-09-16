#!/usr/bin/env python3
"""生成「一客一案」样例（真实线索 + 存储结构 + 缺口）。联系方式脱敏。"""
import json, os, re, glob
from pathlib import Path
from datetime import datetime, timezone

D = Path(os.environ.get('DC_DATA_DIR', 'data'))   # 线索/邮件事实在运行时数据目录


def mask(s):
    s = str(s)
    s = re.sub(r'([\w.+-]{1,2})[\w.+-]*(@[\w.-]+)', r'\1***\2', s)
    s = re.sub(r'(\+\d{2,3})\d+', r'\1****', s)
    return s


leads = json.loads((D / 'leads.json').read_text(encoding='utf-8'))
rows = leads if isinstance(leads, list) else leads.get('leads') or []
lead = rows[1]

L = []
L.append('# 一客一案 · 样例（真实数据，联系方式已脱敏）')
L.append('')
L.append('> 生成时间：' + datetime.now(timezone.utc).astimezone().strftime('%Y-%m-%d %H:%M')
         + ' · 租户：卓立(100000834234) · 买家来自线索池')
L.append('')

L.append('## 1. 买家核心档案（线索池层）')
L.append('')
L.append('| 字段 | 值 | 存储位置 |')
L.append('|---|---|---|')
L.append('| 公司名 | ' + str(lead.get('company_name')) + ' | `data/leads.json` + 飞书线索池 Base |')
L.append('| 国家 | ' + str(lead.get('country')) + ' | 同上 |')
L.append('| 标识/域名 | ' + str(lead.get('domain')) + ' | 同上 |')
L.append('| 来源 | ' + str(lead.get('source')) + ' | 同上（来源字段） |')
L.append('| 线索状态 | ' + str(lead.get('status')) + ' | 同上 |')
L.append('| 评分 | ' + str(lead.get('_cbie_score')) + '（' + str(lead.get('_cbie_reason')) + '） | 同上 |')
L.append('| 标签/信号 | ' + str(lead.get('keywords')) + ' | 同上（keywords） |')
L.append('| 导入时间 | ' + str(lead.get('_xq_importedAt')) + ' | 同上 |')
L.append('| 租户/负责人 | ' + str(lead.get('enterprise')) + ' / ' + str(lead.get('user_open_id')) + ' | 同上（隔离键） |')
L.append('')

L.append('## 2. 联系人（同一买家可有多个联系人，都挂这条案下）')
L.append('')
L.append('| 字段 | 值 | 存储位置 |')
L.append('|---|---|---|')
L.append('| 姓名 | ' + str(lead.get('_xq_contactName')) + ' | 线索池联系人字段 / `contacts/` |')
L.append('| 职位 | ' + str(lead.get('_xq_position')) + ' | 同上 |')
L.append('| 邮箱 | ' + mask(lead.get('_xq_email') or '（空）') + ' | 同上 |')
L.append('| WhatsApp | ' + mask(lead.get('_xq_whatsApp') or '（空）') + ' | 同上 |')
L.append('| 需求原文 | ' + str(lead.get('_xq_requirementDesc')) + ' | 同上（需求描述） |')
L.append('')

L.append('## 3. 互动时间线（买家回信后要一次拉全）')
L.append('')
L.append('| 时间 | 渠道 | 事件 | 来源存储 | 本机现状 |')
L.append('|---|---|---|---|---|')
L.append('| — | 邮件(出) | 开发信/报价发送 | `email-facts/outbound/<company>/` | 空 |')
L.append('| — | 邮件(入) | 买家回信正文 | `email-facts/inbound/` | 空 |')
L.append('| — | 邮件信号 | 回复/退信/打开 | `email-signals/` | 空 |')
L.append('| — | 待回复 | 需跟进的回复 | `pending-replies/` | 空 |')
L.append('| — | 展会 | 扫码/名片/现场沟通 | `dc_exhibition_*` + 线索池字段 | 空 |')
L.append('| — | **聊天** | **飞书群/单聊与买家往来** | **会话存储（未并入案卷）** | **缺口** |')
L.append('')

L.append('## 4. 商机与阶段')
L.append('')
L.append('| 项 | 值 | 存储位置 |')
L.append('|---|---|---|')
L.append('| 商机阶段 / 逾期 / 承诺 | （空） | `dc_opportunity_stage` + 线索池阶段字段 |')
L.append('')

L.append('## 5. 物料往来（我们发过什么）')
L.append('')
L.append('| 项 | 值 | 存储位置 |')
L.append('|---|---|---|')
L.append('| 已发物料 / 对方索要 | （空） | KB materials（kb.json ↔ 物料表 ↔ 文档，双写） |')
L.append('')

L.append('---')
L.append('')
L.append('## 案卷存储结构（我的理解，等你指导）')
L.append('')
L.append('```')
L.append('买家案卷（键：tenant + 企业/公司名归一 + 联系人ID）')
L.append('├─ 核心档案    线索池 Base（人读） ↔ data/leads.json（agent 读）   ← 双写')
L.append('├─ 联系人      线索池联系人字段    ↔ data/contacts/')
L.append('├─ 互动时间线  邮件事实 email-facts（出/入/信号）+ 展会互动 + 聊天记录')
L.append('├─ 商机阶段    dc_opportunity_stage ↔ 线索池阶段/逾期字段')
L.append('├─ 物料往来    KB materials（kb.json ↔ 物料表 ↔ 文档）')
L.append('└─ 案卷视图    一页聚合（agent 读）+ 一份飞书文档（人读）')
L.append('```')
L.append('')
L.append('### 现在能一次拉全的')
L.append('')
L.append('- 买家核心档案 + 联系人 + 标签评分（线索池 ↔ leads.json）')
L.append('- 邮件出/入/信号的存储结构（本机这份数据为空）')
L.append('')
L.append('### 缺口（需要你指导的点）')
L.append('')
L.append('1. **聊天记录没并入案卷**：买家在飞书群/单聊的往来只在会话里，没按买家归集；')
L.append('2. **案卷缺稳定主键**：现在用 domain，但星擎导入的是占位（`xq-待补充-...`）→ 建议「企业 + 公司名归一 + 联系人ID」复合键；')
L.append('3. **案卷视图未落地**：还没有“打开某买家就看到上面全部”的一页（agent 侧 + 人类侧各一份）；')
L.append('4. **写入时机**：买家回信时实时补案，还是定时汇总？决定双写频率。')

out = D / 'dossier-samples' / '一客一案-样例-20260913.md'
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text('\n'.join(L), encoding='utf-8')
print('生成:', out, '| 字节:', len('\n'.join(L).encode('utf-8')))
