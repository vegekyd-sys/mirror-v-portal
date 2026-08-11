#!/usr/bin/env python3
"""
DC-Customer-Import — 历史客户导入 + 标签提取引擎

用法:
  python3 dc_customer_import.py import solarunis.com customers.csv
  python3 dc_customer_import.py tags solarunis.com          # 只看标签
  python3 dc_customer_import.py sim solarunis.com buyer.json # 算单个买家相似度
"""

import csv, json, os, re, sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
TAGS_DIR = DATA_DIR / "customer_tags"

# ── 必填字段 ──
REQUIRED_FIELDS = ["company_name", "domain", "country"]
OPTIONAL_FIELDS = ["product", "deal_type", "deal_date", "deal_amount", "notes"]

# ── 表头映射：用户可能用中文/英文/缩写 ──
HEADER_MAP = {
    # company_name
    "公司名": "company_name", "公司名称": "company_name", "企业名称": "company_name",
    "客户名称": "company_name", "客户": "company_name", "name": "company_name",
    "company": "company_name", "company name": "company_name",
    # domain
    "域名": "domain", "网站": "domain", "网址": "domain", "官网": "domain",
    "website": "domain", "site": "domain", "url": "domain",
    # country
    "国家": "country", "国家/地区": "country", "地区": "country",
    # product
    "产品": "product", "成交产品": "product", "主营产品": "product",
    "产品名称": "product", "品类": "product", "购买产品": "product",
    # deal_type
    "类型": "deal_type", "买家类型": "deal_type", "客户类型": "deal_type",
    "合作类型": "deal_type", "type": "deal_type",
    # deal_date
    "日期": "deal_date", "成交日期": "deal_date", "合作日期": "deal_date",
    "成交时间": "deal_date", "签约日期": "deal_date", "date": "deal_date",
    # deal_amount
    "金额": "deal_amount", "成交金额": "deal_amount", "合同金额": "deal_amount",
    "amount": "deal_amount", "price": "deal_amount",
    # notes
    "备注": "notes", "说明": "notes", "note": "notes", "remark": "notes",
}


def normalize_headers(headers):
    """将用户的各种表头统一为标准英文名"""
    result = []
    for h in headers:
        h_clean = (h or "").strip().lower().rstrip("：:")
        if h_clean in HEADER_MAP:
            result.append(HEADER_MAP[h_clean])
        else:
            result.append(h_clean)  # 保留原样（可能是已经标准的英文名）
    return result

# ── 统一买家画像 ────────────────────────────────────────

def init_persona():
    """初始化空白画像"""
    return {
        "country": {}, "keywords": {}, "buyer_type": {}, "product_pattern": {},
        "exclude_countries": [], "exclude_reasons": [],
        "version": 0, "updated_at": "", "sources": [],
    }


def merge_persona(base, incoming, weight=0.3):
    """
    合并两个画像。incoming 以 weight 权重融入 base。
    weight=1.0 用于批量导入（全量覆盖），weight=0.3 用于单条标注（渐进学习）。
    """
    import copy
    result = copy.deepcopy(base)
    for key in ("country", "keywords", "buyer_type", "product_pattern"):
        merged = {}
        all_keys = set(base.get(key, {}).keys()) | set(incoming.get(key, {}).keys())
        for k in all_keys:
            base_val = base.get(key, {}).get(k, 0)
            inc_val = incoming.get(key, {}).get(k, 0)
            merged[k] = round(base_val * (1 - weight) + inc_val * weight, 3)
        # 清理零值
        result[key] = {k: v for k, v in merged.items() if v > 0.001}
    # 排除规则: 叠加
    result["exclude_countries"] = list(set(base.get("exclude_countries", []) + incoming.get("exclude_countries", [])))
    result["exclude_reasons"] = list(set(base.get("exclude_reasons", []) + incoming.get("exclude_reasons", [])))
    result["version"] = base.get("version", 0) + 1
    result["updated_at"] = datetime.now(timezone.utc).isoformat()
    return result


def load_persona(enterprise):
    """加载企业画像，不存在则返回空白"""
    tag_file = TAGS_DIR / f"{normalize_domain(enterprise)}.json"
    if tag_file.exists():
        data = json.loads(tag_file.read_text())
        return data.get("persona") or init_persona()
    return init_persona()


def save_persona(enterprise, persona, customers=None, evolution_entry=None):
    """保存画像到文件。可选更新客户列表和进化日志。"""
    os.makedirs(str(TAGS_DIR), exist_ok=True)
    tag_file = TAGS_DIR / f"{normalize_domain(enterprise)}.json"
    existing = {}
    if tag_file.exists():
        existing = json.loads(tag_file.read_text())
    existing["enterprise"] = enterprise
    existing["persona"] = persona
    if customers is not None:
        existing["customers"] = customers
        existing["customer_count"] = len(customers)
    existing["updated_at"] = persona.get("updated_at") or datetime.now(timezone.utc).isoformat()
    # 进化日志
    if evolution_entry:
        if "evolution" not in existing:
            existing["evolution"] = []
        existing["evolution"].append(evolution_entry)
    tag_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
STOP_WORDS = {
    "the", "a", "an", "and", "or", "of", "in", "for", "on", "to", "with",
    "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
    "do", "does", "did", "will", "would", "could", "should", "may", "might",
    "can", "shall", "its", "it", "at", "by", "from", "as", "into", "through",
    "during", "before", "after", "above", "below", "between", "under", "again",
    "further", "then", "once", "here", "there", "when", "where", "why", "how",
    "all", "both", "each", "few", "more", "most", "other", "some", "such",
    "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very",
    "just", "also", "now", "new", "like", "our", "we", "you", "your", "they",
    "co", "ltd", "gmbh", "inc", "llc", "bv", "sa", "srl", "sl", "spa",
    "energy", "solutions", "technologies", "systems", "group", "international",
}


# ── 买家类型标准化（中英文 → 统一中文） ──
TYPE_MAP = {
    "分销商": "分销商", "distributor": "分销商", "distribuidor": "分销商",
    "经销商": "分销商", "代理商": "分销商", "wholesale": "分销商", "wholesaler": "分销商",
    "安装商": "安装商", "installer": "安装商", "installateur": "安装商",
    "系统集成商": "系统集成商", "system integrator": "系统集成商",
    "integrator": "系统集成商", "epc": "系统集成商", "solution provider": "系统集成商",
    "oem": "OEM", "制造商": "OEM", "manufacturer": "OEM", "工厂": "OEM",
    "终端": "终端用户", "终端用户": "终端用户", "end user": "终端用户",
}

def normalize_deal_type(t):
    t = (t or "").strip()
    return TYPE_MAP.get(t.lower(), t)


def normalize_domain(d):
    d = (d or "").strip().lower()
    d = re.sub(r'^https?://', '', d)
    d = re.sub(r'^www\.', '', d)
    d = d.split('/')[0]
    return d


def extract_keywords(text):
    """从文本中提取有效关键词（去停用词、保留技术术语和规格号）"""
    text = (text or "").lower()
    # 保留字母数字混合、数字+字母组合（如 400W, FDE-800）
    tokens = re.findall(r'[a-z0-9]+(?:[-/][a-z0-9]+)*', text)
    keywords = []
    for t in tokens:
        t = t.strip('-/')
        if len(t) < 2:
            continue
        if t in STOP_WORDS:
            continue
        if t.isdigit():
            continue
        keywords.append(t)
    return keywords


def extract_product_patterns(product_text):
    """从产品描述中提取规格模式（功率、型号等）"""
    text = (product_text or "").lower()
    patterns = []
    # 功率: 400W, 800W, 2000W, 400-2200W
    for m in re.finditer(r'(\d{3,4})\s*w', text):
        patterns.append(f"{m.group(1)}W")
    # 型号: FDE-400, IQ8, etc
    for m in re.finditer(r'([a-z]{2,4}[-/]?\d{2,4})', text):
        patterns.append(m.group(1).upper())
    return list(dict.fromkeys(patterns))  # 去重保序


def normalize_country(c):
    c = (c or "").strip().upper()
    if len(c) == 2 and c.isascii():
        return c  # 已是标准 ISO 码
    # 中文/英文国名 → ISO 码
    m = {
        "德国": "DE", "GERMANY": "DE",
        "荷兰": "NL", "NETHERLANDS": "NL",
        "奥地利": "AT", "AUSTRIA": "AT",
        "巴西": "BR", "BRAZIL": "BR",
        "澳大利亚": "AU", "澳洲": "AU", "AUSTRALIA": "AU",
        "美国": "US", "美国": "US", "UNITED STATES": "US", "USA": "US",
        "英国": "GB", "UK": "GB", "UNITED KINGDOM": "GB", "ENGLAND": "GB",
        "法国": "FR", "FRANCE": "FR",
        "意大利": "IT", "ITALY": "IT",
        "西班牙": "ES", "SPAIN": "ES",
        "波兰": "PL", "POLAND": "PL",
        "墨西哥": "MX", "MEXICO": "MX",
        "印尼": "ID", "印度尼西亚": "ID", "INDONESIA": "ID",
        "越南": "VN", "VIETNAM": "VN",
        "马来西亚": "MY", "MALAYSIA": "MY",
        "日本": "JP", "JAPAN": "JP",
        "韩国": "KR", "SOUTH KOREA": "KR", "KOREA": "KR",
        "印度": "IN", "INDIA": "IN",
        "南非": "ZA", "SOUTH AFRICA": "ZA",
        "阿联酋": "AE", "UAE": "AE", "UNITED ARAB EMIRATES": "AE",
        "加拿大": "CA", "CANADA": "CA",
        "俄罗斯": "RU", "RUSSIA": "RU",
        "土耳其": "TR", "TURKEY": "TR",
        "泰国": "TH", "THAILAND": "TH",
        "新加坡": "SG", "SINGAPORE": "SG",
    }
    return m.get(c.upper(), c[:2].upper())


# ═══════════════════════════════════════════════════════════
#  标签提取
# ═══════════════════════════════════════════════════════════

def extract_tags(customers):
    """从历史客户列表提取四层标签，返回归一化权重"""
    total = len(customers)
    if total == 0:
        return {"country": {}, "keywords": {}, "buyer_type": {}, "product_pattern": {}}

    country = Counter()
    keywords = Counter()
    buyer_type = Counter()
    product_pattern = Counter()

    for c in customers:
        # L1: 国家
        country[c.get("country", "")] += 1

        # L2: 关键词（公司名 + 产品名）
        text = f"{c.get('product','')} {c.get('company_name','')}"
        for kw in extract_keywords(text):
            keywords[kw] += 1

        # L3: 买家类型
        dt = c.get("deal_type", "").strip()
        if dt:
            buyer_type[dt] += 1

        # L4: 产品模式
        for p in extract_product_patterns(c.get("product", "")):
            product_pattern[p] += 1

    return {
        "country": {k: round(v/total, 3) for k, v in country.most_common(15)},
        "keywords": {k: round(v/total, 3) for k, v in keywords.most_common(30)},
        "buyer_type": {k: round(v/total, 3) for k, v in buyer_type.most_common(10)},
        "product_pattern": {k: round(v/total, 3) for k, v in product_pattern.most_common(15)},
    }


# ═══════════════════════════════════════════════════════════
#  相似度评分
# ═══════════════════════════════════════════════════════════

def buyer_similarity(buyer, persona):
    """
    计算单个买家与画像的相似度。
    直接传入 persona 对象（不是 tags 包裹）。
    """
    total_score = 0.0
    reasons = []

    # L1: 国家匹配 (30%)
    country = normalize_country(buyer.get("country", ""))
    country_weight = persona.get("country", {}).get(country, 0)
    total_score += country_weight * 0.30
    if country_weight > 0.1:
        reasons.append(f"历史成交国 ({country}:{country_weight:.0%})")

    # L2: 关键词匹配 (40%)
    buyer_kws = set(extract_keywords(
        f"{buyer.get('company_name','')} {buyer.get('keywords','')}"
    ))
    persona_kws = persona.get("keywords", {})
    matched_kws = buyer_kws & set(persona_kws.keys())
    if persona_kws:
        kw_score = sum(persona_kws[kw] for kw in matched_kws) / max(sum(persona_kws.values()), 0.001)
    else:
        kw_score = 0
    total_score += kw_score * 0.40
    if matched_kws:
        top = sorted(matched_kws, key=lambda k: persona_kws.get(k, 0), reverse=True)[:3]
        reasons.append(f"关键词: {', '.join(top)}")

    # L3: 买家类型匹配 (15%) — 从公司名/关键词推断
    buyer_text = f"{buyer.get('company_name','')} {buyer.get('keywords','')}".lower()
    type_hints = {
        "分销商": ["distributor", "wholesale", "distribution", "distribuidor"],
        "安装商": ["installer", "installation", "solar install", "installateur"],
        "系统集成商": ["system integrator", "integrator", "epc", "solution provider"],
        "OEM": ["oem", "manufacturer", "factory"],
    }
    type_score = 0
    matched_type = None
    for tname, hints in type_hints.items():
        if any(h in buyer_text for h in hints):
            w = persona.get("buyer_type", {}).get(tname, 0)
            if w > type_score:
                type_score = w
                matched_type = tname
    total_score += type_score * 0.15
    if matched_type:
        reasons.append(f"买家类型: {matched_type}")

    # L4: 产品模式匹配 (15%)
    buyer_patterns = set(extract_product_patterns(buyer.get("keywords", "")))
    persona_patterns = persona.get("product_pattern", {})
    matched_patterns = buyer_patterns & set(persona_patterns.keys())
    if persona_patterns:
        pat_score = sum(persona_patterns[p] for p in matched_patterns) / max(sum(persona_patterns.values()), 0.001)
    else:
        pat_score = 0
    total_score += pat_score * 0.15
    if matched_patterns:
        reasons.append(f"规格: {', '.join(sorted(matched_patterns))}")

    # 探索奖励 (5%)
    total_score = total_score * 0.95 + 0.05

    return round(total_score, 4), reasons[:3]


# ═══════════════════════════════════════════════════════════
#  CSV 导入
# ═══════════════════════════════════════════════════════════

def import_csv(enterprise, filepath):
    """导入 CSV 或 Excel 文件，提取标签，存储。自动识别格式。"""
    ext = Path(filepath).suffix.lower()
    if ext in ('.xlsx', '.xls'):
        return _import_excel(enterprise, filepath)
    return _import_csv(enterprise, filepath)


def _process_rows(enterprise, rows, fieldnames, errors):
    """校验、去重、标准化行数据，返回 customers 列表"""
    os.makedirs(str(TAGS_DIR), exist_ok=True)
    customers = []
    seen_domains = set()

    # 检查必填字段
    missing_fields = [f for f in REQUIRED_FIELDS if f not in fieldnames]
    if missing_fields:
        return None, {"error": f"缺少必填列: {', '.join(missing_fields)}"}

    for i, row in enumerate(rows, start=2):
        row_errors = []
        for f in REQUIRED_FIELDS:
            if not row.get(f, "").strip():
                row_errors.append(f"第{i}行缺少 {f}")
        if row_errors:
            errors.extend(row_errors)
            continue

        domain = normalize_domain(row["domain"])
        if domain in seen_domains:
            continue
        seen_domains.add(domain)

        customer = {
            "company_name": row["company_name"].strip(),
            "domain": domain,
            "country": normalize_country(row["country"]),
        }
        for f in OPTIONAL_FIELDS:
            val = row.get(f, "").strip()
            if val:
                if f == "deal_type":
                    val = normalize_deal_type(val)
                customer[f] = val
        customers.append(customer)

    return customers, None


def _save_tags(enterprise, customers, source="import"):
    """提取标签，写入 KB 买家画像"""
    if not customers:
        return {"error": "没有有效的客户记录"}
    incoming_tags = extract_tags(customers)
    incoming_persona = {
        "country": incoming_tags["country"],
        "keywords": incoming_tags["keywords"],
        "buyer_type": incoming_tags["buyer_type"],
        "product_pattern": incoming_tags["product_pattern"],
        "exclude_countries": [], "exclude_reasons": [],
    }
    weight = 1.0 if source == "import" else 0.08
    change = f"{'导入' if source=='import' else '标注'} {len(customers)} 条"

    # 写入 KB
    try:
        from dc_kb_engine import KBEngine
        kb = KBEngine()
        kb.update_persona(enterprise, incoming_persona, source=source, weight=weight, change=change)
        # 也保留独立文件用于兼容
        os.makedirs(str(TAGS_DIR), exist_ok=True)
        tag_file = TAGS_DIR / f"{normalize_domain(enterprise)}.json"
        existing = {}
        if tag_file.exists():
            existing = json.loads(tag_file.read_text())
        existing["enterprise"] = enterprise
        existing["persona"] = kb.get_persona(enterprise)
        existing["customers"] = customers
        existing["customer_count"] = len(customers)
        tag_file.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
    except ImportError:
        # 降级到仅写文件
        existing = load_persona(enterprise)
        persona = merge_persona(existing, incoming_persona, weight=weight)
        persona["sources"] = existing.get("sources", []) + [source]
        save_persona(enterprise, persona, customers)

    persona = load_persona(enterprise)
    return {
        "status": "ok",
        "customer_count": len(customers),
        "persona_version": persona.get("version", 1),
        "tag_summary": {
            "top_countries": list(persona["country"].keys())[:5],
            "top_keywords": list(persona["keywords"].keys())[:10],
            "buyer_types": list(persona["buyer_type"].keys()),
            "product_patterns": list(persona["product_pattern"].keys())[:5],
        },
    }


def _import_csv(enterprise, filepath):
    errors = []
    with open(filepath, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames:
            return {"error": "CSV 文件为空或无法解析"}
        headers = normalize_headers(reader.fieldnames)
        rows_raw = []
        for row in reader:
            mapped = {}
            for k, v in row.items():
                k_clean = (k or "").strip().lower().rstrip("：:")
                new_k = HEADER_MAP.get(k_clean, k_clean)
                mapped[new_k] = v
            rows_raw.append(mapped)
        customers, err = _process_rows(enterprise, rows_raw, headers, errors)
        if err:
            return err
        if not customers:
            return {"error": "没有有效的客户记录", "errors": errors}
        result = _save_tags(enterprise, customers)
        result["errors"] = errors
        return result


def _import_excel(enterprise, filepath):
    """读取 Excel (.xlsx) 文件，提取首张工作表"""
    try:
        import openpyxl
    except ImportError:
        return {"error": "需要安装 openpyxl: pip install openpyxl"}

    try:
        wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
        ws = wb.active
        rows_iter = ws.iter_rows(values_only=True)
        headers = [str(h).strip() if h else "" for h in next(rows_iter, [])]
        if not headers:
            return {"error": "Excel 文件为空"}

        headers = normalize_headers(headers)
        rows = []
        errors = []
        for row in rows_iter:
            row_dict = {}
            for j, val in enumerate(row):
                if j < len(headers) and headers[j]:
                    row_dict[headers[j]] = str(val).strip() if val is not None else ""
            if not any(row_dict.values()):
                continue  # 空行跳过
            rows.append(row_dict)

        wb.close()
        customers, err = _process_rows(enterprise, rows, headers, errors)
        if err:
            return err
        if not customers:
            return {"error": "没有有效的客户记录", "errors": errors}
        result = _save_tags(enterprise, customers)
        result["errors"] = errors
        result["source"] = "Excel (.xlsx)"
        return result

    except Exception as e:
        from dc_degrade import degrade
        degrade.decide("import_excel_error", error=str(e), file=filepath)
        return {"error": f"Excel 读取失败: {str(e)[:100]}"}


def load_tags(enterprise):
    """加载企业画像数据（兼容旧接口，返回含 persona 的完整数据）"""
    tag_file = TAGS_DIR / f"{normalize_domain(enterprise)}.json"
    if not tag_file.exists():
        return None
    data = json.loads(tag_file.read_text())
    # 兼容旧格式：如果还没有 persona，从 tags 迁移
    if "persona" not in data and "tags" in data:
        data["persona"] = {
            "country": data["tags"].get("country", {}),
            "keywords": data["tags"].get("keywords", {}),
            "buyer_type": data["tags"].get("buyer_type", {}),
            "product_pattern": data["tags"].get("product_pattern", {}),
            "exclude_countries": [], "exclude_reasons": [],
            "version": 1, "updated_at": data.get("imported_at", ""),
            "sources": ["import"],
        }
    return data


# ═══════════════════════════════════════════════════════════
#  标注反哺 — dc_ls_store.annotate() 调此方法
# ═══════════════════════════════════════════════════════════

def learn_from_annotate(enterprise, lead, promote_long_term=False):
    """
    从单次标注中学习，增量更新画像。
    lead: {"company_name": str, "domain": str, "country": str, "status": str, "exclude_reason": str}
    """
    status = lead.get("status", "")
    country = normalize_country(lead.get("country", ""))
    reason = lead.get("exclude_reason", "")
    company = lead.get("company_name", "")

    incoming = init_persona()
    keywords = extract_keywords(company)
    kw_dict = {k: 1.0 for k in keywords} if keywords else {}

    if status == "我的买家" and promote_long_term:
        incoming["country"] = {country: 1.0} if country else {}
        incoming["keywords"] = kw_dict
        label = "标注为买家"
    elif status == "不是我的买家" and reason and promote_long_term:
        incoming["exclude_reasons"] = [reason]
        label = f"排除: {reason}"
    elif status == "黑名单买家" and promote_long_term:
        incoming["exclude_reasons"] = ["黑名单"]
        label = "加入黑名单"
    else:
        return  # 不需要更新画像

    existing = load_persona(enterprise)
    persona = merge_persona(existing, incoming, weight=0.08)  # 单条标注权重低，渐进学习
    persona["sources"] = existing.get("sources", []) + ["annotate"]

    evolution_entry = {
        "version": persona["version"],
        "source": "annotate",
        "at": persona["updated_at"],
        "change": f"{label} {company[:20]} | 画像 v{persona['version']}",
    }
    save_persona(enterprise, persona, evolution_entry=evolution_entry)


# ═══════════════════════════════════════════════════════════
#  CLI
# ═══════════════════════════════════════════════════════════

if __name__ == "__main__":
    # Shadow billing
    try:
        from dc_billing import billing
        tenant = os.environ.get("DC_TENANT_ID", "") or os.environ.get("DEALCLAW_TENANT_ID", "")
        if tenant:
            billing.configure(tenant)
            billing.estimate("dealclaw-lead-import", quantity=1)
    except Exception:
        pass

    if len(sys.argv) < 2:
        print("用法:")
        print("  python3 dc_customer_import.py import <enterprise> <file.csv>")
        print("  python3 dc_customer_import.py tags <enterprise>")
        print("  python3 dc_customer_import.py sim <enterprise> <buyer_json>")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "import":
        if len(sys.argv) < 4:
            print("用法: import <enterprise> <file.csv>")
            sys.exit(1)
        result = import_csv(sys.argv[2], sys.argv[3])
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == "tags":
        enterprise = sys.argv[2]
        tags = load_tags(enterprise)
        if tags:
            print(json.dumps(tags["tags"], ensure_ascii=False, indent=2))
        else:
            print(f"❌ {enterprise} 没有历史客户标签")

    elif cmd == "sim":
        if len(sys.argv) < 4:
            print("用法: sim <enterprise> <buyer_json>")
            sys.exit(1)
        enterprise = sys.argv[2]
        tags_data = load_tags(enterprise)
        if not tags_data:
            print(f"❌ {enterprise} 没有历史客户标签，先导入: python3 dc_customer_import.py import {enterprise} <file.csv>")
            sys.exit(1)
        buyer = json.loads(sys.argv[3])
        score, reasons = buyer_similarity(buyer, tags_data["tags"])
        print(json.dumps({"similarity_score": score, "reasons": reasons}, ensure_ascii=False, indent=2))
