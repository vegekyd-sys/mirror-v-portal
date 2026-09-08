#!/usr/bin/env python3
"""find-buyers 实时进度卡：业务状态机 + job 状态文件。

田耕郡 2026-09-08 定的 12 条修订，本文件落地业务层（Card Adapter 只负责发卡/更新/渲染）。

职责：
  - 四节点推进：target_confirmed → searching → qualifying → syncing
  - 状态枚举：queued / running / waiting_user / partial / failed / cancelled / done
  - 终态规则（第 7、8 条）
  - job 状态文件：data/runtime/jobs/find-buyers/<job_id>.json（不按 sid 共用，唯一 job_id）
  - 更新节流：由 CardAdapter 承担（阶段/数字不变不重复 patch）

安全与并发（第 11 条 + 2026-09-08 补检）：
  - job_id 绑定 tenant_id / requester_id / chat_id
  - 卡片不显示内部评分、个人联系方式、接口错误栈
  - 线索池链接必须属于当前企业：finish_done / partial 展示「打开线索池」前，
    用 lead_pool_app_token / lead_pool_table_id 校验 leads_url 归属；归属失败不显示该按钮，
    但不影响 done/partial 终态（搜索事实与入池结果不受卡片影响）。
  - job 状态原子写入（临时文件 + os.replace）；终态不可被 running 覆盖；旧阶段不可覆盖新阶段。
  - job 已有 message_id 时只原地更新原卡，不重复发卡（message_id 持久化并跨重试恢复）。
  - TTL 清理跳过仍在运行的任务（running / queued）。
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from card_adapter import CardAdapter

# 状态文件根目录（workspace 根下 data/runtime/jobs/find-buyers/，不放 memory）
_WS_ROOT = Path(__file__).resolve().parents[3]
JOBS_DIR = _WS_ROOT / "data" / "runtime" / "jobs" / "find-buyers"

# 状态枚举（第 6 条）
VALID_STATES = {"queued", "running", "waiting_user", "partial", "failed", "cancelled", "done"}

# 终态：running / 旧阶段不得覆盖这些状态
TERMINAL_STATES = {"done", "partial", "failed", "cancelled", "waiting_user"}

# 四个业务节点（第 5 条）
STEP_LABELS = {
    "target_confirmed": "步骤 1/4",
    "searching": "步骤 2/4",
    "qualifying": "步骤 3/4",
    "syncing": "步骤 4/4",
}

# 阶段顺序（用于阻止旧阶段覆盖新阶段）
STEP_ORDER = {"target_confirmed": 1, "searching": 2, "qualifying": 3, "syncing": 4}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def extract_lead_pool_ids(url: str) -> tuple[str, str]:
    """从线索池 URL 提取 (app_token, table_id)。

    支持 `https://versa-ai.feishu.cn/base/{app_token}?table={table_id}` 形态；
    解析不到时返回 ("", "")。任何异常静默返回空，不抛。
    """
    if not url:
        return "", ""
    try:
        u = urlparse(str(url).strip())
    except Exception:
        return "", ""
    app_token = ""
    parts = [p for p in u.path.split("/") if p]
    for i, p in enumerate(parts):
        if p == "base" and i + 1 < len(parts):
            app_token = parts[i + 1]
            break
    table_id = ""
    try:
        table_id = (parse_qs(u.query).get("table") or [""])[0]
    except Exception:
        table_id = ""
    return app_token, table_id


class FindBuyersCard:
    """一张 find-buyers 进度卡：从 queued 一路原地更新到终态。

    用法：
        card = FindBuyersCard(
            tenant_id="...", requester_id="ou_...", chat_id="oc_...",
            lead_pool_app_token="QnHk...", lead_pool_table_id="tbl...",  # 当前租户注册的线索池身份
            dry_run=True,  # 联调；真实发卡设 False
        )
        card.start()                       # 发初始卡（步骤 1/4 之前，queued/running）
        card.target_confirmed()            # 步骤 1/4
        card.searching(pages=3, candidates=200)
        card.qualifying(qualified=80)
        card.syncing(synced=48)
        card.finish_done(created=40, updated=8, deduped=48, leads_url="...")
        # 或 card.fail() / card.waiting_user() / card.partial() / card.cancel()
    """

    def __init__(self, tenant_id: str, requester_id: str, chat_id: str,
                 dry_run: bool = False, job_id: str = "",
                 lead_pool_app_token: str = "", lead_pool_table_id: str = ""):
        if not tenant_id:
            raise ValueError("tenant_id 不能为空")
        if not requester_id:
            raise ValueError("requester_id 不能为空")
        if not chat_id:
            raise ValueError("chat_id 不能为空")
        self.tenant_id = tenant_id
        self.requester_id = requester_id
        self.chat_id = chat_id
        self.job_id = job_id or f"fb_{int(datetime.now(timezone.utc).timestamp())}_{uuid.uuid4().hex[:8]}"
        self.dry_run = dry_run
        # 当前租户注册的线索池身份（来自 dc_company_registry），用于校验 leads_url 归属
        self.lead_pool_app_token = (lead_pool_app_token or "").strip()
        self.lead_pool_table_id = (lead_pool_table_id or "").strip()
        self.adapter = CardAdapter(chat_id=chat_id, dry_run=dry_run)
        self.state: dict = {
            "job_id": self.job_id,
            "tenant_id": tenant_id,
            "requester_id": requester_id,
            "chat_id": chat_id,
            "state": "queued",
            "step": "",
            "metrics": {},
            "leads_url": "",
            "message_id": "",
            "created_at": _now(),
            "updated_at": _now(),
        }
        self._path = JOBS_DIR / f"{self.job_id}.json"
        self._load_persisted()

    # ── 状态文件读写 ──
    def _load_persisted(self) -> None:
        """重试/跨进程恢复：加载已持久化的 job 状态与 message_id。

        仅当 job 身份（tenant_id / chat_id）一致时才恢复，防止跨租户/跨会话串数据。
        """
        if self.dry_run or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if not isinstance(data, dict):
            return
        if data.get("tenant_id") != self.tenant_id or data.get("chat_id") != self.chat_id:
            return
        self.state = {**self.state, **data}
        mid = str(data.get("message_id") or "").strip()
        if mid:
            self.adapter.message_id = mid

    def _persist(self) -> None:
        self.state["updated_at"] = _now()
        self.state["message_id"] = self.adapter.message_id or self.state.get("message_id", "")
        if self.dry_run:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self._path)

    # ── 线索池归属校验 ──
    def _lead_pool_link_allowed(self, leads_url: str) -> bool:
        """校验 leads_url 的 app_token/table_id 是否属于当前租户注册的线索池。

        规则（fail-closed）：
          - 未提供线索池身份 → 无法确认归属 → 不展示「打开线索池」。
          - app_token 必须精确匹配；table_id 若双方都提供则也必须匹配。
        失败只影响按钮展示，不影响搜索完成。
        """
        if not leads_url:
            return False
        if not self.lead_pool_app_token:
            return False
        app_token, table_id = extract_lead_pool_ids(leads_url)
        if not app_token or app_token != self.lead_pool_app_token:
            return False
        if self.lead_pool_table_id and table_id and table_id != self.lead_pool_table_id:
            return False
        return True

    # ── 内部推进 ──
    def _advance(self, step: str, status: str, metrics: dict, links: list | None = None) -> None:
        if self.state["state"] in TERMINAL_STATES:
            return  # running 不能覆盖 done/partial/failed/cancelled/waiting_user
        cur = STEP_ORDER.get(self.state.get("step", ""), 0)
        new = STEP_ORDER.get(step, 0)
        if new and new < cur:
            return  # 旧阶段不能覆盖新阶段
        self.state["state"] = "running"
        self.state["step"] = step
        self.state["metrics"] = metrics
        dsl = {
            "title": "找买家",
            "status": status,
            "state": "running",
            "step": STEP_LABELS.get(step, step),
            "metrics": [{"label": k, "value": v} for k, v in metrics.items() if v],
            "links": links or [],
        }
        self._persist()
        self.adapter.update(dsl)

    # ── 四节点（第 5 条）──
    def start(self) -> None:
        """发初始卡（仅首次；重试恢复后已有 message_id 则不重复发）。"""
        if self.adapter.message_id:
            return
        self.state["state"] = "running"
        dsl = {
            "title": "找买家",
            "status": "开始处理",
            "state": "running",
            "metrics": [],
            "summary": ["已收到搜索请求"],
        }
        self._persist()
        result = self.adapter.send(dsl)
        if result.ok and result.message_id:
            self.state["message_id"] = result.message_id
            self._persist()

    def target_confirmed(self) -> None:
        """步骤 1/4：已确认国家、产品、买家类型和展会范围。"""
        self._advance("target_confirmed", "已确认国家、产品、买家类型和展会范围", {})

    def searching(self, pages: int = 0, candidates: int = 0) -> None:
        """步骤 2/4：正在建立候选池。可展示 pages_searched / candidates_found。"""
        metrics = {}
        if pages:
            metrics["已翻页"] = f"{pages} 页"
        if candidates:
            metrics["候选买家"] = f"{candidates} 家"
        self._advance("searching", "正在建立候选池", metrics)

    def qualifying(self, qualified: int = 0) -> None:
        """步骤 3/4：按买家画像质检和企业级去重。不得写死「排除所有制造商」。"""
        metrics = {"合格买家": f"{qualified} 家"} if qualified else {}
        self._advance("qualifying", "正在按买家画像质检和企业级去重", metrics)

    def syncing(self, synced: int = 0) -> None:
        """步骤 4/4：正在将最终结果同步到企业线索池。"""
        metrics = {"入池": f"{synced} 家"} if synced else {}
        self._advance("syncing", "正在将最终结果同步到企业线索池", metrics)

    # ── 终态（第 7、8 条）──
    def _final(self, state: str, status: str, metrics: dict, links: list | None = None,
               summary: list | None = None, buyers: list | None = None) -> None:
        if self.state["state"] in TERMINAL_STATES:
            return  # 终态不可被二次覆盖
        self.state["state"] = state
        self.state["metrics"] = metrics
        if links:
            self.state["leads_url"] = next((l.get("url", "") for l in links if l.get("url")), "")
        dsl = {
            "title": "找买家",
            "status": status,
            "state": state,
            "metrics": [{"label": k, "value": v} for k, v in metrics.items() if v],
            "links": links or [],
            "summary": summary or [],
            "buyers": buyers or [],
        }
        self._persist()
        self.adapter.update(dsl)

    def _lead_pool_links(self, leads_url: str, task_url: str) -> list:
        """构建终态链接；「打开线索池」仅在归属校验通过时展示。"""
        links = []
        if self._lead_pool_link_allowed(leads_url):
            links.append({"text": "打开线索池", "url": leads_url})
        if task_url:
            links.append({"text": "查看任务详情", "url": task_url})
        return links

    def finish_done(self, created: int = 0, updated: int = 0, deduped: int = 0,
                    leads_url: str = "", task_url: str = "", buyers: list | None = None) -> None:
        """done：搜索与入池计数一致（第 8 条）。

        绿色完成卡只在 lead_pool.created + lead_pool.updated == 去重记录数 时出现。
        若计数不一致，调用方不得走本方法，应走 partial()。
        buyers 为买家明细（终态卡直接展示），reason 须为用户可理解的短解释、不含内部评分/权重。
        """
        pool_total = created + updated
        if deduped and pool_total != deduped:
            # 计数不一致时不允许绿色完成卡，强制转 partial
            self.partial(created=created, updated=updated, deduped=deduped,
                         leads_url=leads_url, task_url=task_url, buyers=buyers)
            return
        metrics = {"找到买家": f"{deduped} 家"} if deduped else {}
        self._final("done", "已完成", metrics, links=self._lead_pool_links(leads_url, task_url),
                    summary=["搜索与入池计数一致，已同步到企业线索池"], buyers=buyers)

    def partial(self, created: int = 0, updated: int = 0, deduped: int = 0,
                leads_url: str = "", task_url: str = "", buyers: list | None = None) -> None:
        """partial：搜索成功但部分入池失败。"""
        metrics = {}
        if deduped:
            metrics["找到买家"] = f"{deduped} 家"
        self._final("partial", "部分完成", metrics, links=self._lead_pool_links(leads_url, task_url),
                    summary=["部分买家已入池，少量入池失败，请人工核对"], buyers=buyers)

    def waiting_user(self) -> None:
        """waiting_user：缺少关键参数。"""
        self._final("waiting_user", "等待补充信息", {},
                    summary=["缺少关键搜索参数，请补充后继续"])

    def fail(self) -> None:
        """failed：接口异常。不显示错误栈。"""
        self._final("failed", "搜索失败", {},
                    summary=["搜索接口异常，请稍后重试"])

    def cancel(self) -> None:
        """cancelled：用户取消。"""
        self._final("cancelled", "已取消", {})


# ── TTL 清理（第 11 条）──
def cleanup_expired(ttl_hours: int = 24) -> int:
    """清理超过 TTL 的 job 状态文件，返回清理数量。

    跳过仍在运行的任务（state 为 running / queued），不误删活跃任务。
    状态文件不进长期 memory。
    """
    if not JOBS_DIR.exists():
        return 0
    cutoff = datetime.now(timezone.utc).timestamp() - ttl_hours * 3600
    removed = 0
    for p in JOBS_DIR.glob("*.json"):
        try:
            if p.stat().st_mtime >= cutoff:
                continue
            data = json.loads(p.read_text(encoding="utf-8"))
            if data.get("state") in {"running", "queued"}:
                continue  # 仍在运行的任务不清理
        except (OSError, json.JSONDecodeError):
            continue
        try:
            p.unlink()
            removed += 1
        except OSError:
            continue
    return removed


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(description="find-buyers 进度卡 CLI")
    ap.add_argument("--tenant-id", required=True)
    ap.add_argument("--requester-id", required=True)
    ap.add_argument("--chat-id", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    card = FindBuyersCard(tenant_id=args.tenant_id, requester_id=args.requester_id,
                          chat_id=args.chat_id, dry_run=args.dry_run)
    card.start()
    card.target_confirmed()
    card.searching(pages=3, candidates=200)
    card.qualifying(qualified=80)
    card.syncing(synced=48)
    card.finish_done(created=40, updated=8, deduped=48, leads_url="https://example.com/leads")
    print(json.dumps({"job_id": card.job_id, "state": card.state["state"],
                      "state_file": str(card._path)}, ensure_ascii=False, indent=2))
