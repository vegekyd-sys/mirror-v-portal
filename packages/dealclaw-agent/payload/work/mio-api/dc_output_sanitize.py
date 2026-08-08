#!/usr/bin/env python3
"""
dc_output_sanitize.py — 输出脱敏引擎

在所有用户可见文本发送前，强制过滤内部名词。
阻断 > 改写 > 放行。

硬规则：命中即阻断，不模糊匹配、不降级为 warning。
"""

import re
import sys
import json
from datetime import datetime

# === 阻断名单 ===
# 格式: (正则, 描述, 改写建议)
BLOCKLIST = [
    # Skill 名
    (r'\bDC-CBIE\b', 'Skill名', '删掉或替换为"企业分析"'),
    (r'\bDC-MI\b', 'Skill名', '删掉或替换为"市场分析"'),
    (r'\bDC-PRC\b', 'Skill名', '删掉或替换为"信息确认"'),
    (r'\bDC-EL\b', 'Skill名', '删掉'),
    (r'\bDC-LS\b', 'Skill名', '删掉或替换为"买家搜索"'),
    (r'\bDC-KB\b', 'Skill名', '删掉或替换为"知识库"'),
    (r'\bDC-IQ\b', 'Skill名', '删掉'),
    (r'\bDC-OS\b', 'Skill名', '删掉或替换为"策略分析"'),
    (r'\bDC-Copy\b', 'Skill名', '删掉'),
    (r'\bDC-GS\b', 'Skill名', '删掉'),
    (r'\bDC-FD\b', 'Skill名', '删掉'),
    (r'\bDC-SL\b', 'Skill名', '删掉'),
    (r'\bDC-DB\b', 'Skill名', '删掉'),
    (r'\bDC-WA\b', 'Skill名', '删掉'),
    (r'\bDC-EM\b', 'Skill名', '删掉'),
    (r'\bDC-ED\b', 'Skill名', '删掉'),
    # 数据源名
    (r'\bCDP\b', '数据源名', '删掉，不替换'),
    (r'\bApollo\b', '数据源名', '删掉，不替换'),
    (r'\bCDP\s+searchAIV2\b', '数据源+端点', '删掉，不替换'),
    (r'\bApollo\s+(Enterprise|Contacts|People)\b', '数据源+端点', '删掉，不替换'),
    # 引擎名
    (r'\bdc_kb_publish\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_kb_engine\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_ls_store\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_evolution\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_feedback\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_registry\.py\b', '引擎文件名', '删掉'),
    (r'\bdc_output_sanitize\.py\b', '引擎文件名', '删掉'),
    (r'\bdealclaw_search\.py\b', '引擎文件名', '删掉'),
    (r'\bapollo_client\.py\b', '引擎文件名', '删掉'),
    # DC-xxx 链式引用
    (r'DC-[A-Z]+(\s*→\s*DC-[A-Z]+)+', 'Skill链', '全删'),
    # Gate/铁律 内部术语
    (r'(Gate\s*[0-9]+|硬链|铁律[0-9]+|执行守门人)', '内部流程术语', '删掉'),
    # 数据管道名
    (r'Feedback\s*→\s*Evolution\s*→\s*Registry', '回路名', '删掉'),
    (r'\bEvolution\b', '引擎名（在非聊天上下文）', '删掉'),
    (r'\bRegistry\b', '引擎名（在非聊天上下文）', '删掉'),
]


def sanitize(text: str) -> dict:
    """
    检查文本，返回 {ok, hits, cleaned}
    ok=False 表示命中阻断词，不可发送
    """
    hits = []
    cleaned = text

    for pattern, category, suggestion in BLOCKLIST:
        matches = re.findall(pattern, cleaned, flags=re.IGNORECASE)
        if matches:
            for m in set(matches):
                hits.append({
                    'match': m,
                    'category': category,
                    'suggestion': suggestion,
                })
            # 强制移除
            cleaned = re.sub(pattern, '', cleaned, flags=re.IGNORECASE)

    # 清理多余空格
    cleaned = re.sub(r'\s{2,}', ' ', cleaned).strip()
    # 清理多余标点
    cleaned = re.sub(r'。\s*。', '。', cleaned)

    return {
        'ok': len(hits) == 0,
        'hits': hits,
        'cleaned': cleaned,
        'checked_at': datetime.now().isoformat(),
    }


def sanitize_or_block(text: str) -> str:
    """
    脱敏通过 → 返回清洗后文本
    脱敏失败 → 抛出 ValueError，禁止发送
    """
    result = sanitize(text)
    if not result['ok']:
        hit_summary = '; '.join(
            f"{h['match']}({h['category']})" for h in result['hits']
        )
        raise ValueError(
            f"OUTPUT BLOCKED: 用户可见文本包含内部名词 [{hit_summary}]。"
            f"已自动清洗: {result['cleaned'][:200]}"
        )
    return result['cleaned']


# === CLI ===
if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: dc_output_sanitize.py <text>")
        print("       dc_output_sanitize.py --stdin  # read from stdin")
        print("       dc_output_sanitize.py --check <text>  # JSON output")
        sys.exit(1)

    if sys.argv[1] == '--stdin':
        text = sys.stdin.read()
        try:
            cleaned = sanitize_or_block(text)
            print(cleaned)
        except ValueError as e:
            print(f"BLOCKED: {e}", file=sys.stderr)
            sys.exit(2)
    elif sys.argv[1] == '--check':
        text = ' '.join(sys.argv[2:])
        result = sanitize(text)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        text = ' '.join(sys.argv[1:])
        try:
            cleaned = sanitize_or_block(text)
            print(cleaned)
        except ValueError as e:
            print(f"BLOCKED: {e}", file=sys.stderr)
            sys.exit(2)
