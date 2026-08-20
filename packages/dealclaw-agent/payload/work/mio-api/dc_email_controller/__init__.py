"""DealClaw email 接收/处理/信号/推送 控制器包（dc_email_controller）。

统一收纳邮件事件链路的模块：resend 直连拉取、ingest 幂等入口、
业务处理、七信号、push 决策。共享基础设施（dc_send_log / dc_notify / dc_iq_engine /
email_gateway）仍在顶层。
"""

__all__ = [
    "dc_resend_source",
    "dc_email_ingest",
    "dc_webhook_handler",
    "dc_signal_push",
    "dc_email_signals",
]
