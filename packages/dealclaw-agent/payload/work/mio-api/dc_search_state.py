#!/usr/bin/env python3
"""
DC 搜索状态管理 — 分页追踪 + 跨搜索去重
==========================================
配合 apollo_client 和 dc_buyer_adapter 使用。
当用户说"下一页""换一批"时，自动加载上次搜索参数，page+1 继续搜。

用法:
    from dc_search_state import SearchState
    state = SearchState()

    # 开始新搜索
    state.start(enterprise='lawaken.com', source='apollo',
                keyword_tags=['smart glasses'], country='US',
                employees=['11,50'], user_open_id='ou_xxx')

    # 获取当前页参数
    params = state.current()  # → {'keyword_tags': [...], 'page': 1, ...}

    # 下一页
    state.next_page()  # page 1 → 2
    params = state.current()

    # 记录新域名（去重）
    state.add_domains(['bestbuy.com', 'newegg.com'])

    # 检查域名是否已出现过
    state.seen('bestbuy.com')  # → True/False

    # 本轮线索统计
    state.summary()  # → {'pages': 3, 'unique_domains': 25, ...}

数据存储:
    data/search_state.json — JSON 文件，按 enterprise 隔离

"""

import json
import os
import re
from datetime import datetime, timezone
from typing import Optional


_DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
_STATE_FILE = os.path.join(_DATA_DIR, "search_state.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_domain(domain: str) -> str:
    """标准化域名：去 www、https、路径、空格"""
    d = domain.strip().lower()
    d = re.sub(r'^https?://', '', d)
    d = re.sub(r'^www\.', '', d)
    d = d.split('/')[0]
    d = d.strip()
    return d


class SearchState:
    """搜索状态管理器。企业级隔离 + 用户级追踪。"""

    def __init__(self):
        os.makedirs(_DATA_DIR, exist_ok=True)
        self._data = self._load()

    def _load(self) -> dict:
        if os.path.exists(_STATE_FILE):
            with open(_STATE_FILE, 'r') as f:
                return json.load(f)
        return {}

    def _save(self):
        with open(_STATE_FILE, 'w') as f:
            json.dump(self._data, f, ensure_ascii=False, indent=2)

    # ── 搜索控制 ──────────────────────────────────────────

    def start(
        self,
        enterprise: str,
        source: str,
        keyword_tags: list[str],
        country: str = "United States",
        employees: Optional[list[str]] = None,
        industry: Optional[str] = None,
        user_open_id: str = "",
    ) -> dict:
        """
        开始一轮新搜索。会重置 page 到 1，清空本轮域名去重集。
        返回参数可直接传给 apollo_client 或 dc_buyer_adapter。
        """
        key = self._key(enterprise)
        self._data[key] = {
            "enterprise": enterprise,
            "source": source,
            "keyword_tags": keyword_tags,
            "country": country,
            "employees": employees or [],
            "industry": industry or "",
            "user_open_id": user_open_id,
            "page": 1,
            "per_page": 10,
            "seen_domains": [],       # 本轮新增域名
            "global_domains": self._data.get(key, {}).get("global_domains", []),  # 跨轮域名
            "total_pages_fetched": 0,
            "total_results_claimed": 0,
            "last_sequence": self._data.get(key, {}).get("last_sequence", 0),  # 跨批次序号
            "started_at": _now(),
            "updated_at": _now(),
        }
        self._save()
        return self.current_params()

    def current_params(self) -> dict:
        """返回当前页的搜索参数，可直接解包传给 search_organizations()"""
        st = self._data.get(self._active_key, {})
        return {
            "keyword_tags": st.get("keyword_tags", []),
            "locations": [st.get("country", "United States")],
            "employee_ranges": st.get("employees") or None,
            "industry": st.get("industry") or None,
            "per_page": st.get("per_page", 10),
            "page": st.get("page", 1),
        }

    def next_page(self) -> Optional[dict]:
        """翻到下一页。返回新参数，如果超出则返回 None。"""
        key = self._active_key
        if key not in self._data:
            return None
        st = self._data[key]
        st["page"] += 1
        st["updated_at"] = _now()
        self._save()
        return self.current_params()

    def has_more(self, total_entries: int) -> bool:
        """判断是否还有更多页"""
        st = self._data.get(self._active_key, {})
        page = st.get("page", 1)
        per_page = st.get("per_page", 10)
        return (page * per_page) < total_entries

    # ── 去重 ──────────────────────────────────────────────

    def seen(self, domain: str) -> bool:
        """检查域名是否在本轮或历史搜索中出现过"""
        d = _normalize_domain(domain)
        key = self._active_key
        if key not in self._data:
            return False
        st = self._data[key]
        return d in st.get("seen_domains", []) or d in st.get("global_domains", [])

    def add_domains(self, domains: list[str]):
        """记录一批新域名"""
        key = self._active_key
        if key not in self._data:
            return
        st = self._data[key]
        for d in domains:
            nd = _normalize_domain(d)
            if nd and nd not in st["seen_domains"]:
                st["seen_domains"].append(nd)
                if nd not in st["global_domains"]:
                    st["global_domains"].append(nd)
        st["updated_at"] = _now()
        self._save()

    def filter_new(self, results: list[dict], domain_key: str = "primary_domain") -> list[dict]:
        """过滤掉已出现的域名，只返回新结果"""
        new = []
        domains = []
        for r in results:
            d = r.get(domain_key, "")
            if d and not self.seen(d):
                new.append(r)
                domains.append(d)
        self.add_domains(domains)
        return new

    def record_page_result(self, total_entries: int, domains: list[str]):
        """记录一页搜索完成"""
        key = self._active_key
        if key not in self._data:
            return
        st = self._data[key]
        st["total_pages_fetched"] += 1
        if total_entries > st["total_results_claimed"]:
            st["total_results_claimed"] = total_entries
        st["updated_at"] = _now()
        self._save()

    # ── 查询 ──────────────────────────────────────────────

    def summary(self) -> dict:
        """本轮搜索摘要"""
        key = self._active_key
        if key not in self._data:
            return {}
        st = self._data[key]
        return {
            "enterprise": st["enterprise"],
            "keyword_tags": st["keyword_tags"],
            "country": st["country"],
            "current_page": st["page"],
            "total_pages_fetched": st["total_pages_fetched"],
            "total_results_claimed": st["total_results_claimed"],
            "unique_domains_this_round": len(st["seen_domains"]),
            "unique_domains_total": len(st["global_domains"]),
        }

    def next_sequence(self) -> int:
        """获取下一个连续序号"""
        key = self._active_key
        if key not in self._data:
            return 1
        seq = self._data[key].get("last_sequence", 0) + 1
        self._data[key]["last_sequence"] = seq
        self._save()
        return seq

    def assign_sequences(self, results: list[dict]) -> list[dict]:
        """给结果列表分配连续序号"""
        for r in results:
            r['_seq'] = self.next_sequence()
        return results

    def release(self):
        """清除当前搜索状态（搜索结束后调用）"""
        key = self._active_key
        if key in self._data:
            del self._data[key]
            self._save()

    # ── 内部 ──────────────────────────────────────────────

    @property
    def _active_key(self) -> str:
        """查找当前活跃的企业搜索"""
        for k, v in self._data.items():
            if v.get("page", 0) > 0:
                return k
        return ""

    @staticmethod
    def _key(enterprise: str) -> str:
        return enterprise


# ── CLI ───────────────────────────────────────────────────
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 3:
        print("用法:")
        print("  python dc_search_state.py start <enterprise> --keywords 'kw1,kw2' --country US")
        print("  python dc_search_state.py next <enterprise>")
        print("  python dc_search_state.py seen <enterprise> <domain>")
        print("  python dc_search_state.py summary <enterprise>")
        print("  python dc_search_state.py release <enterprise>")
        sys.exit(1)

    cmd = sys.argv[1]
    enterprise = sys.argv[2]
    state = SearchState()

    if cmd == "start":
        keywords = []
        country = "United States"
        employees = None
        i = 3
        while i < len(sys.argv):
            if sys.argv[i] == "--keywords" and i + 1 < len(sys.argv):
                keywords = [k.strip() for k in sys.argv[i + 1].split(",")]
                i += 2
            elif sys.argv[i] == "--country" and i + 1 < len(sys.argv):
                country = sys.argv[i + 1]
                i += 2
            elif sys.argv[i] == "--employees" and i + 1 < len(sys.argv):
                employees = [sys.argv[i + 1]]
                i += 2
            else:
                i += 1
        result = state.start(
            enterprise=enterprise, source="apollo",
            keyword_tags=keywords, country=country, employees=employees,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))

    elif cmd == "next":
        params = state.next_page()
        if params:
            print(json.dumps(params, ensure_ascii=False, indent=2))
        else:
            print(json.dumps({"error": "no active search"}, ensure_ascii=False))

    elif cmd == "seen":
        domain = sys.argv[3] if len(sys.argv) > 3 else ""
        print(json.dumps({"domain": domain, "seen": state.seen(domain)}))

    elif cmd == "summary":
        print(json.dumps(state.summary(), ensure_ascii=False, indent=2))

    elif cmd == "release":
        state.release()
        print(json.dumps({"ok": True, "message": f"Released {enterprise}"}))
