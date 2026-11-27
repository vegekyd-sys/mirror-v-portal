---
name: "feishu-send-image"
description: "飞书发图片/截图/回信附件图到群或私聊：lark-cli --image，先 cd 到目录传相对路径，按返回 message_id 判成功。"
---

# 飞书发图片（lark-cli）

## 何时用
需要把本地图片（截图、买家回信附件、生成图）发到飞书群 `oc_...` 或私聊 `ou_...` 时。文字与卡片走 `+messages-send --text/--content`，图片走本流程。

## 步骤
1. 确认目标格式：群用 `oc_`，用户用 `ou_`。其它格式直接判为非法目标，不猜不兜底。
2. 切到图片所在目录，再传**相对文件名**：
   `cd <dir> && lark-cli im +messages-send --as bot --chat-id <oc_...> --image <name.png> --json`
   （私聊把 `--chat-id` 换成 `--user-id`。）
3. 解析返回 JSON：`data.message_id` 非空即视为发送成功，用它作为回执；`ok:false` 时把 `error.message` 原样带出去上报，不自动重试。

## HTML 报告 → 先截图再发
`message` 工具不能把 `.html` 当附件发出：媒体策略只放行纯文本文档，会直接失败并报 `hostReadCapability ... path-not-allowed`。需要视觉交付时改走截图：

1. 写一个固定宽度的竖版海报 HTML（建议 1080px），不要把整页长报告直接截成几十屏。
2. 用 node + puppeteer 本地渲染：`setViewport({width:1080, height:1200, deviceScaleFactor:2})`，`screenshot({path, fullPage:true})`。
   - `clip` 与 `fullPage` **互斥**，同时传会直接抛错。
   - `browser` 工具**拒绝 `file://`**，不要用它打开本地 HTML；用 node/puppeteer 或临时起 http server。
   - 没有 puppeteer 时用 `google-chrome --headless=new --no-sandbox --screenshot=<out.png> --window-size=W,H file://<abs>`。
3. 生成 PNG 后再按本 skill 主流程发送图片，并回读尺寸确认不是半截图。

降级顺序固定：**PNG → 纯文本/Markdown 附件**。不要反复重试 HTML 附件。

## 失败判读
- `230002 Bot/User can NOT be out of the chat`：机器人不在该群。属目标/权限问题——换目标群，或让运维把机器人拉进群；不要改发送代码。
- `--image` 报路径非法：几乎都是传了绝对路径或 `..`，按步骤 2 改相对路径。
- `lark-cli not found`：运行环境没装/没在 PATH，先确认在租户容器内执行。

## 不要做
- 不要给 `--image` 传绝对路径或含 `..` 的路径。
- 不要用 `--file` 冒充图片：那会变成文件附件，客户端不内联预览。
- 不要在 `ok:false` 时循环重试；同一目标重复失败要先查机器人是否在群。

## 完成判据
拿到 `message_id` 并把它写进结果/日志，才算发出去；只有 HTTP/CLI 退出码 0 但没有 `message_id` 不算。
