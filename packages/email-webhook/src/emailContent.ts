/**
 * 通过 Resend API 获取邮件正文，供飞书事件卡片展示。
 *
 * Webhook 只带邮件元数据，不带正文。收信与出站邮件使用不同的查询路径，
 * 但响应都包含 text/html；这里统一归一化为安全、有限长度的纯文本预览。
 */

import { logger } from "./logger.js";
import type { InboundEvent } from "./events.js";

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "div", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "li", "main", "nav", "ol", "p",
  "pre", "section", "table", "tr", "ul",
]);
const SKIP_TAGS: ReadonlySet<string> = new Set(["head", "script", "style"]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const HORIZONTAL_SPACE = /[ \t\f\v]+/g;

/**
 * 常见 HTML 实体。Python 那边用的是 html.parser（内置全套 HTML5 实体表），
 * Node 没有等价物；邮件正文里实际出现的就这些，其余保持原样不影响预览可读性。
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  bull: "•", middot: "·", laquo: "«", raquo: "»", deg: "°", euro: "€",
  pound: "£", yen: "¥", cent: "¢", sect: "§", para: "¶", dagger: "†",
  times: "×", divide: "÷", plusmn: "±", frac12: "½", ne: "≠", le: "≤", ge: "≥",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body: string) => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (Number.isNaN(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/**
 * 极简 HTML → 纯文本。只做三件事：跳过 head/script/style，块级标签和 br 变换行，
 * 其余标签丢掉、文本保留。不追求解析正确性 —— 输出只进飞书卡片的 plain_text。
 */
export function htmlToText(value: string): string {
  const parts: string[] = [];
  let skipDepth = 0;
  let index = 0;

  while (index < value.length) {
    const open = value.indexOf("<", index);
    if (open === -1) {
      if (!skipDepth) parts.push(decodeEntities(value.slice(index)));
      break;
    }
    if (open > index && !skipDepth) {
      parts.push(decodeEntities(value.slice(index, open)));
    }

    const close = value.indexOf(">", open);
    if (close === -1) {
      // 标签没闭合，剩下的整段当文本处理，和 Python 版「用已解析片段」的降级一致
      if (!skipDepth) parts.push(decodeEntities(value.slice(open)));
      break;
    }

    const rawTag = value.slice(open + 1, close).trim();
    const isEnd = rawTag.startsWith("/");
    const name = (isEnd ? rawTag.slice(1) : rawTag).split(/[\s/>]/)[0]?.toLowerCase() ?? "";

    if (SKIP_TAGS.has(name)) {
      if (isEnd) {
        if (skipDepth) skipDepth -= 1;
      } else {
        skipDepth += 1;
      }
    } else if (!skipDepth && (name === "br" || BLOCK_TAGS.has(name))) {
      parts.push("\n");
    }

    index = close + 1;
  }

  return parts.join("");
}

/** 清理正文并限制长度，避免控制字符和超大邮件进入飞书卡片。 */
export function normalizePreview(value: string, limit: number): [string, boolean] {
  const cleaned = (value || "")
    .replace(CONTROL_CHARS, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines = cleaned.split("\n").map((line) => line.replace(HORIZONTAL_SPACE, " ").trim());

  const compact: string[] = [];
  let previousBlank = true;
  for (const line of lines) {
    if (!line) {
      if (!previousBlank) compact.push("");
      previousBlank = true;
      continue;
    }
    compact.push(line);
    previousBlank = false;
  }

  const preview = compact.join("\n").trim();
  // 按 Unicode 码点计长，与 Python 的 len() 一致；否则 emoji 会被算成两个字符、
  // 截断时还可能把代理对劈开
  const chars = Array.from(preview);
  if (chars.length <= limit) return [preview, false];
  const head = chars.slice(0, Math.max(limit - 1, 0)).join("").replace(/\s+$/, "");
  return [`${head}…`, true];
}

export class EmailContent {
  readonly preview: string;
  readonly source: string;
  readonly truncated: boolean;
  readonly reason: string;

  constructor(init: { preview?: string; source?: string; truncated?: boolean; reason?: string } = {}) {
    this.preview = init.preview ?? "";
    this.source = init.source ?? "";
    this.truncated = init.truncated ?? false;
    this.reason = init.reason ?? "";
  }

  get included(): boolean {
    return Boolean(this.preview);
  }

  /** 响应中只放状态，不回显邮件正文。 */
  metadata(): Record<string, unknown> {
    return {
      included: this.included,
      source: this.source || null,
      truncated: this.truncated,
      reason: this.reason,
    };
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResendEmailClientOptions {
  baseUrl?: string;
  timeoutSeconds?: number;
  previewChars?: number;
  /** 仅测试注入用，默认走全局 fetch */
  fetchImpl?: FetchLike;
}


export class ResendEmailClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly previewChars: number;
  private readonly fetchImpl: FetchLike;

  constructor(apiKey: string, options: ResendEmailClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
    this.timeoutSeconds = options.timeoutSeconds ?? 5;
    this.previewChars = Math.max(200, Math.min(options.previewChars ?? 1200, 4000));
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  async fetch(event: InboundEvent): Promise<EmailContent> {
    if (!this.apiKey) return new EmailContent({ reason: "RESEND_API_KEY not configured" });
    if (!event.emailId) return new EmailContent({ reason: "event carries no email_id" });

    const resource = event.isInbound ? "emails/receiving" : "emails";
    const url = `${this.baseUrl}/${resource}/${encodeURIComponent(event.emailId)}`;

    let payload: unknown;
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(this.timeoutSeconds * 1000),
      });
      if (!response.ok) {
        // 只记状态码，不回显响应体 —— 里面可能有诊断信息
        logger.warn(`Resend 正文查询失败 email_id=${event.emailId} http=${response.status}`);
        return new EmailContent({ reason: `Resend API returned HTTP ${response.status}` });
      }
      payload = await response.json();
    } catch (err) {
      logger.warn(
        `Resend 正文查询失败 email_id=${event.emailId} error=${(err as Error)?.name ?? "Error"}`,
      );
      return new EmailContent({ reason: "Resend API request failed" });
    }

    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return new EmailContent({ reason: "Resend API returned invalid payload" });
    }
    const body = payload as Record<string, unknown>;

    const plain = body["text"];
    if (typeof plain === "string" && plain.trim()) {
      const [preview, truncated] = normalizePreview(plain, this.previewChars);
      return new EmailContent({ preview, source: "text", truncated });
    }

    const html = body["html"];
    if (typeof html === "string" && html.trim()) {
      const [preview, truncated] = normalizePreview(htmlToText(html), this.previewChars);
      if (preview) return new EmailContent({ preview, source: "html", truncated });
    }

    return new EmailContent({ reason: "email body is empty" });
  }
}
