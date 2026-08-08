#!/usr/bin/env python3
"""
DC-Circuit — 熔断降级引擎

核心模式:
  circuit.call("cdp_search", fn, *args)
  连续失败 3 次 → 熔断 5 分钟 → 期间调用直接返回 fallback

用法:
  from dc_circuit import CircuitBreaker
  cb = CircuitBreaker()
  result = cb.call("cdp_search", do_cdp_search, keyword, country,
                   fallback=lambda: web_search(keyword, country))

电路状态:
  CLOSED     → 正常调用
  OPEN       → 熔断中, 直接返回 fallback 或抛出
  HALF_OPEN  → 试探一次, 成功则关闭, 失败则重新打开

配置 (可按 operation 定制):
  failure_threshold: 连续失败次数阈值 (默认 3)
  timeout_seconds: 熔断持续时间 (默认 300s = 5分钟)
"""

import time
from datetime import datetime, timezone
from collections import defaultdict

# ── 配置 ──
DEFAULT_THRESHOLD = 3
DEFAULT_TIMEOUT = 300  # 5 分钟

# 按操作类型的自定义配置
CIRCUIT_CONFIGS = {
    "cdp_search":     {"threshold": 3, "timeout": 300},
    "resend_send":    {"threshold": 2, "timeout": 180},
    "ycloud_send":    {"threshold": 2, "timeout": 180},
    "iq_process":     {"threshold": 5, "timeout": 60},   # IQ 可以更宽容
}


class CircuitBreaker:
    def __init__(self):
        self._failures = defaultdict(int)
        self._last_failure = {}
        self._opened_at = {}

    def call(self, operation, fn, *args, fallback=None, **kwargs):
        """
        通过熔断器调用函数。

        operation: 操作名 (cdp_search, resend_send, ...)
        fn:        实际调用的函数
        *args:     函数参数
        fallback:  熔断时的降级函数, None 则抛 CircuitOpenError
        """
        config = CIRCUIT_CONFIGS.get(operation, {"threshold": DEFAULT_THRESHOLD, "timeout": DEFAULT_TIMEOUT})
        threshold = config["threshold"]
        timeout = config["timeout"]

        # 检查是否熔断中
        if self._is_open(operation, timeout):
            if fallback:
                return fallback()
            raise CircuitOpenError(f"熔断中: {operation} (已熔断 {self._open_seconds(operation)}s)")

        # 尝试调用
        try:
            result = fn(*args, **kwargs)
            self._on_success(operation)
            return result
        except Exception as e:
            self._on_failure(operation)
            if self._failures[operation] >= threshold:
                self._opened_at[operation] = time.time()
            if fallback:
                return fallback()
            raise

    def _is_open(self, operation, timeout):
        if operation not in self._opened_at:
            return False
        elapsed = self._open_seconds(operation)
        if elapsed >= timeout:
            # 进入半开状态: 允许一次试探
            del self._opened_at[operation]
            self._failures[operation] = threshold // 2  # 给一点容错余量
            return False
        return True

    def _on_success(self, operation):
        if operation in self._failures:
            del self._failures[operation]
        if operation in self._opened_at:
            del self._opened_at[operation]

    def _on_failure(self, operation):
        self._failures[operation] += 1
        self._last_failure[operation] = time.time()

    def _open_seconds(self, operation):
        if operation not in self._opened_at:
            return 0
        return int(time.time() - self._opened_at[operation])

    def status(self):
        """返回所有电路的当前状态"""
        result = {}
        for op in set(list(self._failures.keys()) + list(self._opened_at.keys())):
            state = "OPEN" if self._is_open(op, CIRCUIT_CONFIGS.get(op, {}).get("timeout", DEFAULT_TIMEOUT)) else "CLOSED"
            result[op] = {
                "state": state,
                "failures": self._failures.get(op, 0),
                "opened_seconds": self._open_seconds(op) if state == "OPEN" else 0,
            }
        return result


class CircuitOpenError(Exception):
    pass


# ── 全局单例 ──
_circuit = None

def get_circuit():
    global _circuit
    if _circuit is None:
        _circuit = CircuitBreaker()
    return _circuit


# ── CLI ──
if __name__ == "__main__":
    import sys, json
    cb = get_circuit()
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        # 自测: 模拟连续失败
        print("熔断自测: 模拟连续失败 4 次")
        for i in range(4):
            try:
                cb.call("test_op", lambda: 1/0)
            except Exception as e:
                print(f"  [{i+1}] {type(e).__name__}: {e}")
        print(f"\n状态: {json.dumps(cb.status(), indent=2)}")
    else:
        import json
        print(json.dumps(cb.status(), ensure_ascii=False, indent=2))
