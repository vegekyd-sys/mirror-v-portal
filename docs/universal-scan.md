# 扫码入口与渠道边界

桌面 `/onboard` 读取 Agent 模板，默认选中 Mirror V 和飞书。访客选择 Agent 后切换飞书或微信；屏幕一次只显示所选渠道的一张二维码。切换 Agent 或渠道时取消旧会话并生成新码。

飞书使用 Portal 入口码，扫码后在手机页完成 `registerApp` 授权，电脑轮询入口状态。微信使用 iLink 原生授权码：电脑向 runtime-manager 发起会话，直接显示 `get_bot_qrcode` 返回的 `qrcode_img_content`，手机用微信扫一扫扫描电脑屏幕；电脑轮询 `get_qrcode_status`，如需验证码则在电脑页输入。确认成功后才创建所选模板的 Agent 实例并绑定微信渠道。

用户实测从微信网页打开或长按识别 iLink URL 均显示“暂不支持浏览”。因此飞书 Portal 码若被微信扫描，手机页会提示回电脑选择微信；手机页不再发起 iLink 会话或展示第二张码。当前不能声称“一个二维码同时供飞书和微信扫描”。微信原生扫码和真实聊天仍需手机端到端验收。

入口及原生授权状态目前在中央网关和 runtime-manager 内存中。服务重启会使未完成的扫码过期，访客可在电脑重新生成。`PORTAL_BASE_URL` 可覆盖飞书入口码中的公开域名，默认使用 `https://mirror-v-portal.vercel.app`。钉钉尚无扫码创建新实例的接入。
