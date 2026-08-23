#!/usr/bin/env python3
"""
DealClaw Billing Client
=======================

Import this in any skill script to bill Credits in real-time.

All billing flows follow the same pattern:
  1. estimate() → show user cost before execution
  2. settle() → deduct credits after execution
  3. can_afford() → quick balance check

Credentials are read from environment:
  DC_TENANT_ID    — tenant id (e.g. xiaoyuan-wenhua)
  DC_BILLING_URL  — credits-ledger base URL (default: http://localhost:8081)

Usage:
  from dc_billing import billing
  billing.configure(tenant_id="xiaoyuan-wenhua")
  billing.estimate("dealclaw-find-buyers", quantity=5)
  result = billing.settle("dealclaw-find-buyers", quantity=5, estimated_event_id="...")
"""

from __future__ import annotations

import json
import os
import time
import uuid
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from typing import Optional, Dict, Any


class BillingError(Exception):
    """Billing operation failed."""

    def __init__(self, message: str, code: str = "UNKNOWN", status: int = 500):
        self.message = message
        self.code = code
        self.status = status
        super().__init__(f"[{code}] {message}")


class BillingClient:
    """Singleton billing client for DealClaw Agent skills."""

    def __init__(self):
        self._tenant_id: Optional[str] = None
        self._account_id: Optional[str] = None
        self._base_url: str = os.environ.get("DC_BILLING_URL", "http://localhost:8081")
        self._last_estimate: Optional[Dict[str, Any]] = None

    def configure(self, tenant_id: str) -> "BillingClient":
        """Set up billing for a specific tenant."""
        self._tenant_id = tenant_id
        self._account_id = f"acct_{tenant_id}"
        return self

    @property
    def tenant_id(self) -> str:
        if not self._tenant_id:
            raise BillingError("BillingClient not configured. Call billing.configure(tenant_id=...)", code="NOT_CONFIGURED")
        return self._tenant_id

    @property
    def account_id(self) -> str:
        if not self._account_id:
            raise BillingError("BillingClient not configured. Call billing.configure(tenant_id=...)", code="NOT_CONFIGURED")
        return self._account_id

    def _post(self, path: str, body: dict) -> dict:
        """Make a POST request to the billing service."""
        url = f"{self._base_url.rstrip('/')}{path}"
        data = json.dumps(body).encode("utf-8")
        req = Request(url, data=data, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            try:
                err_body = json.loads(e.read())
            except Exception:
                err_body = {}
            raise BillingError(
                err_body.get("message", str(e)),
                code=err_body.get("code", "HTTP_ERROR"),
                status=e.code,
            )
        except URLError as e:
            raise BillingError(f"Billing service unreachable: {e.reason}", code="SERVICE_UNAVAILABLE")

    def _get(self, path: str) -> dict:
        """Make a GET request to the billing service."""
        url = f"{self._base_url.rstrip('/')}{path}"
        req = Request(url, headers={"Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=5) as resp:
                return json.loads(resp.read())
        except HTTPError as e:
            try:
                err_body = json.loads(e.read())
            except Exception:
                err_body = {}
            raise BillingError(
                err_body.get("message", str(e)),
                code=err_body.get("code", "HTTP_ERROR"),
                status=e.code,
            )
        except URLError as e:
            raise BillingError(f"Billing service unreachable: {e.reason}", code="SERVICE_UNAVAILABLE")

    # ─── Public API ────────────────────────────────────────

    def estimate(self, skill_id: str, quantity: int = 1, **metadata) -> dict:
        """
        Estimate credit cost BEFORE executing a skill.

        Returns: { ok, estimatedCredit, skillName, unitPrice, eventId, isDefault }
        Store the result; use eventId in settle().
        """
        result = self._post("/v1/billing/estimate", {
            "tenantId": self.tenant_id,
            "accountId": self.account_id,
            "skillId": skill_id,
            "quantity": quantity,
            "metadata": metadata,
        })

        if not result.get("ok"):
            raise BillingError(
                result.get("error", "Estimate failed"),
                code=result.get("code", "UNKNOWN"),
            )

        self._last_estimate = result
        return result

    def settle(self, skill_id: str, quantity: int = 1,
               estimated_event_id: Optional[str] = None,
               task_id: Optional[str] = None,
               result_summary: str = "") -> dict:
        """
        Execute billing AFTER a skill completes.

        Deducts credits. Returns the settlement result.
        Raises BillingError if insufficient credits.
        """
        event_id = estimated_event_id or (self._last_estimate or {}).get("eventId")
        if not event_id:
            event_id = f"est_{int(time.time())}_{uuid.uuid4().hex[:8]}"

        result = self._post("/v1/billing/settle", {
            "tenantId": self.tenant_id,
            "accountId": self.account_id,
            "taskId": task_id,
            "skillId": skill_id,
            "quantity": quantity,
            "estimatedEventId": event_id,
            "resultSummary": result_summary,
        })

        if not result.get("ok"):
            code = result.get("code", "UNKNOWN")
            if code == "INSUFFICIENT_CREDITS":
                raise BillingError(
                    result.get("error", "余额不足"),
                    code="INSUFFICIENT_CREDITS",
                    status=402,
                )
            raise BillingError(
                result.get("error", "Settlement failed"),
                code=code,
            )

        return result

    def can_afford(self, skill_id: str, quantity: int = 1) -> dict:
        """
        Quick check: does the tenant have enough credits?

        Returns: { canAfford, estimatedCredit, balance }
        """
        return self._post("/v1/billing/can-afford", {
            "accountId": self.account_id,
            "skillId": skill_id,
            "quantity": quantity,
        })

    def balance(self) -> dict:
        """Get current balance including frozen credits."""
        return self._get(f"/v1/accounts/{self.account_id}/full")

    def get_available_balance(self) -> int:
        """Get available balance (balance - frozen)."""
        info = self.balance()
        return info.get("available", info.get("balance", 0))

    # ─── Convenience ───────────────────────────────────────

    def wrap_skill(self, skill_id: str, quantity: int = 1):
        """
        Context manager for skill billing.

        Usage:
            with billing.wrap_skill("dealclaw-find-buyers", quantity=3) as ctx:
                # execute skill
                ctx.result_summary = "Found 15 buyers"
            # Credits auto-settled on exit
        """
        return _SkillBillingContext(self, skill_id, quantity)


class _SkillBillingContext:
    def __init__(self, client: BillingClient, skill_id: str, quantity: int):
        self.client = client
        self.skill_id = skill_id
        self.quantity = quantity
        self.event_id: Optional[str] = None
        self.result_summary: str = ""
        self.estimated_credit: int = 0
        self.skill_name: str = ""

    def __enter__(self):
        est = self.client.estimate(self.skill_id, self.quantity)
        self.event_id = est["eventId"]
        self.estimated_credit = est["estimatedCredit"]
        self.skill_name = est.get("skillName", self.skill_id)
        print(f"[billing] ⚡ {self.skill_name} × {self.quantity} = 预估 {self.estimated_credit:,} Credit")
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            print(f"[billing] ❌ {self.skill_name} 失败，未扣费: {exc_val}")
            return False  # propagate exception

        result = self.client.settle(
            self.skill_id,
            quantity=self.quantity,
            estimated_event_id=self.event_id,
            result_summary=self.result_summary,
        )
        print(f"[billing] ✅ {self.skill_name} × {self.quantity} = 扣费 {result.get('actualCredit', '?')} Credit")
        return False


# ─── Singleton ────────────────────────────────────────────

billing = BillingClient()


# ─── CLI for testing ──────────────────────────────────────

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 dc_billing.py <command> [args...]")
        print("Commands: balance <tenant_id>, estimate <tenant_id> <skill> [qty], settle <tenant_id> <skill> [qty]")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "balance":
        tenant = sys.argv[2] if len(sys.argv) > 2 else "xiaoyuan-wenhua"
        billing.configure(tenant)
        info = billing.balance()
        print(json.dumps(info, indent=2, ensure_ascii=False))

    elif cmd == "estimate":
        tenant, skill = sys.argv[2], sys.argv[3]
        qty = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        billing.configure(tenant)
        result = billing.estimate(skill, qty)
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "settle":
        tenant, skill = sys.argv[2], sys.argv[3]
        qty = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        billing.configure(tenant)
        est = billing.estimate(skill, qty)
        result = billing.settle(skill, qty, estimated_event_id=est["eventId"])
        print(json.dumps(result, indent=2, ensure_ascii=False))

    elif cmd == "can-afford":
        tenant, skill = sys.argv[2], sys.argv[3]
        qty = int(sys.argv[4]) if len(sys.argv) > 4 else 1
        billing.configure(tenant)
        result = billing.can_afford(skill, qty)
        print(json.dumps(result, indent=2, ensure_ascii=False))

    else:
        print(f"Unknown command: {cmd}")
