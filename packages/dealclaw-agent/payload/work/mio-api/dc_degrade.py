#!/usr/bin/env python3
"""
DC-Degrade — 降级决策引擎

每个引擎在 except 块里调 degrade.decide()，返回:
  "auto"       → 自动降级，用户无感知，写 error_log
  "notify"     → 降级 + 轻量提醒用户
  "alert"      → 阻塞，必须告知用户

用法:
  from dc_degrade import degrade
  result = degrade.decide("cdp_search", error, context={"keyword": kw})
  if result.mode == "auto":     return fallback()
  if result.mode == "notify":   return {"warning": result.message, "data": fallback()}
  if result.mode == "alert":    return {"error": result.message}
"""

import time
from collections import defaultdict
from enum import Enum


class Mode(Enum):
    AUTO = "auto"       # 自动降级，静默
    NOTIFY = "notify"   # 降级 + 提醒
    ALERT = "alert"     # 阻塞 + 告警


class DegradeResult:
    def __init__(self, mode, message=""):
        self.mode = mode
        self.message = message


# ═══════════════════════════════════════════════════════════
#  降级矩阵 — 每个故障点: (模式, 消息模板, 是否记录错误日志)
# ═══════════════════════════════════════════════════════════

MATRIX = {
    # ── 外部 API ──
    "cdp_search": {
        "mode": Mode.AUTO,
        "msg": "",
        "fallback_hint": "用 web_search 替代",
    },
    "cdp_search_persistent": {
        "mode": Mode.ALERT,
        "msg": "买家搜索服务异常超过30分钟，建议稍后重试",
        "trigger_after_seconds": 1800,  # 30分钟
    },
    "resend_send": {
        "mode": Mode.AUTO,
        "msg": "",
        "fallback_hint": "写入待发队列，稍后重试",
    },
    "resend_persistent": {
        "mode": Mode.ALERT,
        "msg": "邮件服务异常超过10分钟，{count}封邮件待发送",
        "trigger_after_seconds": 600,
    },

    # ── 内部引擎 ──
    "persona_load": {
        "mode": Mode.AUTO,
        "msg": "",
        "fallback_hint": "关闭标签重排序，原始结果直出",
    },
    "persona_save": {
        "mode": Mode.NOTIFY,
        "msg": "画像保存失败，本次标注已记录但未更新画像",
    },
    "kb_load": {
        "mode": Mode.NOTIFY,
        "msg": "知识库暂时不可用，自动回复降级为通用话术",
        "fallback_hint": "跳过材料检查 + 产品匹配",
    },
    "audit_write": {
        "mode": Mode.AUTO,
        "msg": "",
        "fallback_hint": "审计日志静默丢弃",
    },
    "sendlog_read": {
        "mode": Mode.NOTIFY,
        "msg": "退订检查暂时不可用，邮件已发送",
        "fallback_hint": "跳过退订检查，允许发送",
    },
    "import_excel_error": {
        "mode": Mode.NOTIFY,
        "msg": "导入了{ok}/{total}条，{fail}条格式有问题",
    },
    "leads_corrupt": {
        "mode": Mode.ALERT,
        "msg": "线索数据损坏，请联系运维",
    },
    "sendlog_corrupt": {
        "mode": Mode.ALERT,
        "msg": "发送日志损坏，退订检查和统计不可用，请联系运维",
    },

    # ── 通知 ──
    "feishu_notice": {
        "mode": Mode.AUTO,
        "msg": "",
        "fallback_hint": "飞书通知静默丢弃",
    },
    "feishu_notice_enterprise": {
        "mode": Mode.NOTIFY,
        "msg": "知识库操作通知发送失败，KB 已正常更新",
    },

    # ── 通用 — 未知错误 ──
    "unknown": {
        "mode": Mode.AUTO,
        "msg": "",
    },
}


class Degrade:
    def __init__(self):
        self._failure_start = {}  # operation → first failure timestamp
        self._persistent_alerted = set()

    def decide(self, operation, error=None, **context):
        """
        返回 (mode, message) 元组。
        自动记录 error_log。
        """
        entry = MATRIX.get(operation, MATRIX["unknown"])
        mode = entry["mode"]
        msg_template = entry.get("msg", "")

        # 记录错误日志
        try:
            from dc_error_log import log_error
            log_error(operation.split("_")[0], operation, error or "unknown error", **context)
        except Exception:
            pass

        # 检查是否需要升级为 ALERT (persistent failure)
        trigger_after = entry.get("trigger_after_seconds")
        if trigger_after:
            now = time.time()
            if operation not in self._failure_start:
                self._failure_start[operation] = now
            elapsed = now - self._failure_start[operation]
            if elapsed >= trigger_after:
                mode = Mode.ALERT
                # 格式化消息
                if msg_template:
                    try:
                        msg_template = msg_template.format(**context)
                    except Exception:
                        pass
                return DegradeResult(mode, msg_template)
        else:
            # 成功就从持续故障计时器中移除
            if operation in self._failure_start:
                del self._failure_start[operation]

        # 格式化消息
        message = msg_template
        if message and "{" in message:
            try:
                message = message.format(**context)
            except Exception:
                pass

        return DegradeResult(mode, message)

    def reset(self, operation):
        """操作成功时调用，清除失败状态"""
        if operation in self._failure_start:
            del self._failure_start[operation]
        if operation in self._persistent_alerted:
            self._persistent_alerted.discard(operation)


# ── 全局单例 ──
degrade = Degrade()
