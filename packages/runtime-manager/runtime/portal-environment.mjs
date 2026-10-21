import fs from "node:fs";
import path from "node:path";

const start = "<!-- portal-environment:start -->";
const end = "<!-- portal-environment:end -->";

// Exact old platform-authored sentences only; owner edits and personal rules
// outside these legacy delivery/scheduling notes remain byte-for-byte intact.
const legacyNotes = [
  ["- 不直接改 OpenClaw 配置文件（`openclaw.json`）和系统目录；需要调整时告诉主人。", ""],
  ["- 消息由沙箱外的网关代收代发（飞书、微信等）。这里没有 lark-cli、没有飞书机器人凭据，`openclaw message send` 不可用，不要尝试。", "- 当前对话由 Portal 渠道网关投递；CLI 安装与外部账号连接是独立能力。"],
  ["- 当前对话的消息由沙箱外的 Nexus 网关代收代发（飞书、微信等）；沙箱内的 OpenClaw 没有配置这条消息通道。当前回复的附件通过 `MEDIA:` 交给 Nexus 投递。可以安装 lark-cli 等 CLI，外部账号操作再使用用户相应授权。", "- 当前对话由 Portal 渠道网关投递；CLI 安装与外部账号连接是独立能力。"],
  ["- 只用 `nexus_schedule`（add / list / update / remove）。只有返回 `durable: true` 才算建好。不要用 cron 工具，不要改 OpenClaw 配置。", "- `portal_schedule`：Portal 持久化调度接口，创建回执 `durable: true`，支持跨沙盒休眠执行。"],
  ["新的定时任务、提醒、心跳一律用 `nexus_schedule`，**不要用 cron 工具、不要改 OpenClaw 配置**：这台机器空闲时会休眠，只有 nexus_schedule 能在休眠后把你叫醒。", "Portal 调度器保存定时任务、提醒和心跳，并在任务到期后唤醒沙盒。"],
  ["- 定时任务只用 `nexus_schedule`。", "- Portal 调度接口：`portal_schedule`，支持跨沙盒休眠执行。"],
];

export function migrateLegacyPortalNotes(workspace) {
  for (const name of ["TOOLS.md", "AGENTS.md", "REDLINES.md"]) {
    const file = path.join(workspace, name);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    const before = fs.readFileSync(file, "utf8");
    const after = legacyNotes.reduce((text, [old, replacement]) => text.replaceAll(old, replacement), before);
    if (after !== before) fs.writeFileSync(file, after);
  }
}

/** Factual workspace documentation; no policy, task routing or behavior rules. */
export function writePortalEnvironment({ workspace, data, config }) {
  migrateLegacyPortalNotes(workspace);
  const facts = {
    platform: "Portal",
    isolation: "per-tenant Linux VM",
    workspace,
    execution: { ...config.tools.exec, npmPrefix: path.join(data, "npm"), installScripts: true },
    persistence: { sleepSnapshot: "VM filesystem", backup: data, processes: "restart after wake" },
    messaging: { transport: "Portal channel edge", attachmentFormat: "MEDIA: <absolute file path>", capabilities: "current request channel and client-caps headers",
      inboundVideo: { channel: "feishu", messageTypes: ["media", "file", "post"], delivery: "original file in workspace/inbound; absolute path, MIME, byte count and SHA-256 in request context", maxFileBytes: 64 * 1024 * 1024, maxAttachments: 4, followUp: "same-session previous attachments with explicit provenance" } },
    schedules: { tool: "portal_schedule", persistence: "Portal controller", acknowledgement: "durable: true", quietHeartbeatReply: "HEARTBEAT_OK" },
  };
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(data, "portal-environment.json"), JSON.stringify(facts, null, 2) + "\n");
  const block = [start, "## Portal 运行环境", "",
    `平台：Portal。隔离：每个租户独立的 Linux VM。工作区：\`${workspace}\`。`,
    `执行策略：\`${config.tools.exec.host}/${config.tools.exec.security}/${config.tools.exec.ask}\`。全局 npm：\`${facts.execution.npmPrefix}\`（bin 已在 PATH）；安装脚本已启用。`,
    "休眠快照保存 VM 文件系统；agent-data 有额外备份；进程在唤醒后重新启动。",
    "当前对话由 Portal 渠道网关收发。附件协议：回复正文中的独立行 `MEDIA: <文件绝对路径>`。当前渠道支持的消息类型来自请求的 channel/client-caps。",
    "飞书原生视频、视频文件和富文本内视频按原始文件接收；本地绝对路径、MIME、字节数和 SHA-256 在请求上下文中提供。文件位于工作区 `inbound/`，可由 exec、ffprobe 和媒体工具读取；视频上限 64 MiB、每条消息最多 4 个附件。同一会话的后续引用会标记原始来源。",
    "`portal_schedule` 提供可跨休眠运行的定时任务和心跳，创建回执为 `durable: true`；静默心跳回执为 `HEARTBEAT_OK`。",
    `环境详情：\`${path.join(data, "portal-environment.json")}\`，也可用 \`portal_environment\` 查询。`, end].join("\n");
  const file = path.join(workspace, "TOOLS.md");
  // Preserve owner-authored text, including symlinked/custom workspace files.
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) return facts;
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "# Tools\n";
  const a = text.indexOf(start), b = text.indexOf(end, a);
  text = a >= 0 && b >= a ? text.slice(0, a) + block + text.slice(b + end.length) : text + (text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
  fs.writeFileSync(file, text);
  return facts;
}
