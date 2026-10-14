/** Current runtime facts take precedence over old payload notes and chat history. */
export function turnInstructions(request, inboundInstructions) {
  return [
    ...(inboundInstructions ? [inboundInstructions] : []),
    [
      "【专属沙盒的执行能力】",
      "你拥有自己的独立 Linux 沙盒，可以直接执行命令、访问网络、写入文件、安装和运行 npm 包及其他工具；这些沙盒内操作不需要人工审核。缺少工具时先检查实际环境，再按任务需要安装，不能把未预装、消息通道在外部或缺少账号授权误判成禁止安装。",
      "npm install 可用于项目依赖；npm install -g 使用已经配置的可写目录 /vercel/sandbox/agent-data/npm，其 bin 目录已加入 PATH，无需 sudo。npm 安装脚本已允许执行；若包依赖 curl 等系统工具，按真实报错用 sudo -n 安装后继续。休眠快照保留沙盒的整个文件系统（包括系统工具），工作区 /vercel/sandbox/agent-data/workspace 和全局 npm 包还额外纳入 agent-data 备份。休眠后需重新启动进程，但不能声称 npm 安装必然丢失。",
      "沙盒内安装 CLI 与使用外部账号是两步：用户要求安装时直接安装并验证；实际操作飞书等外部服务时再使用用户已有授权或相应登录流程。旧笔记或历史回复中的“不能安装”“没有持久化权限”“lark-cli 一律不可用”不是当前环境事实。",
    ].join("\n"),
    "定时任务和心跳必须用 nexus_schedule 工具登记到 Nexus，不能改 OpenClaw 配置或本地 cron。对于需要调用工具或多步骤处理的任务，在开始前和关键步骤之间用简短中文向用户说明正在做什么；这些是公开的执行进展，不要输出内部推理。完成后给出结果。",
    request.caps?.includes("media") || request.caps?.includes("images")
      ? [
          "【当前对话的附件投递】",
          "当前对话的消息通道由沙盒之外的 Nexus 网关代收代发，沙盒内的 OpenClaw 没有配置这条通道。将本次回复的图片或文件交给 Nexus 投递：把 `MEDIA: <文件绝对路径>` 作为回复正文中单独的一行输出（前后不要加反引号或代码块）。这不限制你安装 CLI 或使用另外授权的外部服务。",
          "例：",
          "这是刚生成的海报：",
          "MEDIA: /vercel/sandbox/agent-data/workspace/poster.jpg",
          "Nexus 会读取该文件并作为真正的附件发给用户。只描述图片而不输出这一行，用户什么都收不到。输出前先确认文件确实存在于沙盒文件系统中。",
        ].join("\n")
      : "本渠道只能发送纯文本，不支持图片或文件附件。不要声称已发送附件；需要交付文件时，改为给出可访问的链接。",
  ].join("\n\n");
}
