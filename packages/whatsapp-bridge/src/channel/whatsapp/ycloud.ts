import { config } from "../../config";
import type { DeliveryUpdate, NormalizedInbound, WabaAccountUpdate } from "../../core/types";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json {
  return value && typeof value === "object" ? (value as Json) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function parseYCloudEvent(payload: unknown): {
  type: string;
  inbound?: NormalizedInbound;
  update?: DeliveryUpdate;
  wabaUpdate?: WabaAccountUpdate;
} | null {
  const body = asRecord(payload);
  const type = str(body.type);
  const eventId = str(body.id);
  if (!type || !eventId) return null;

  if (type === "whatsapp.inbound_message.received") {
    const msg = asRecord(body.whatsappInboundMessage);
    const text = asRecord(msg.text);
    const image = asRecord(msg.image);
    const profile = asRecord(msg.customerProfile);
    const from = str(msg.from);
    const to = str(msg.to);
    if (!from || !to) return null;
    const messageType = str(msg.type) || "text";
    const caption = str(image.caption);
    return {
      type,
      inbound: {
        eventId,
        ycloudMessageId: str(msg.id),
        wamid: str(msg.wamid),
        customerPhone: from,
        businessPhone: to,
        whatsappUserId: str(msg.fromUserId) || str(msg.fromUserId),
        whatsappParentUserId: str(msg.fromParentUserId) || str(msg.fromParentUserId),
        customerName: str(profile.name),
        messageType,
        text: str(text.body) || caption,
        media:
          messageType === "image"
            ? {
                kind: "image",
                id: str(image.id),
                link: str(image.link),
                mimeType: str(image.mime_type) || str(image.mimeType),
                caption,
              }
            : undefined,
        sendTime: str(msg.sendTime),
      },
    };
  }

  if (type === "whatsapp.business_account.updated") {
    const waba = asRecord(body.whatsappBusinessAccount);
    const payment = waba.paymentMethodAttached;
    return {
      type,
      wabaUpdate: {
        eventId,
        wabaId: str(waba.id),
        wabaName: str(waba.name),
        phoneNumberId: str(waba.phoneNumberId),
        businessId: str(waba.businessId),
        businessName: str(waba.businessName),
        accountReviewStatus: str(waba.accountReviewStatus),
        businessVerificationStatus: str(waba.businessVerificationStatus),
        ownershipType: str(waba.ownershipType),
        messagingLimit: str(waba.whatsappBusinessManagerMessagingLimit),
        paymentMethodAttached: typeof payment === "boolean" ? payment : undefined,
        updateEvent: str(waba.updateEvent),
        partnerCustomerId: str(waba.partnerCustomerId),
      },
    };
  }

  if (type === "whatsapp.message.updated") {
    const msg = asRecord(body.whatsappMessage);
    const conversation = asRecord(msg.conversation);
    const error = asRecord(msg.error);
    const ycloudMessageId = str(msg.id);
    const status = str(msg.status);
    if (!ycloudMessageId || !status) return null;
    return {
      type,
      update: {
        eventId,
        ycloudMessageId,
        wamid: str(msg.wamid),
        status,
        expireTime: str(conversation.expireTime),
        errorCode: str(error.code) || str(msg.errorCode),
        errorMessage: str(error.message) || str(msg.errorMessage),
        sentAt: str(msg.sendTime),
        deliveredAt: str(msg.deliverTime),
        readAt: str(msg.readTime),
      },
    };
  }

  return { type };
}

export async function sendWhatsAppText(from: string, to: string, text: string) {
  return sendWhatsAppMessage(from, to, {
    type: "text",
    text: { body: text, previewUrl: false },
  });
}

export async function uploadWhatsAppMedia(
  phoneNumber: string,
  file: { buffer: Buffer; filename: string; contentType: string },
): Promise<string> {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) throw new Error("YCLOUD_API_KEY is not configured");

  const form = new FormData();
  const bytes = new Uint8Array(file.buffer);
  form.append(
    "file",
    new Blob([bytes], { type: file.contentType || "application/octet-stream" }),
    file.filename || "upload.bin",
  );

  const response = await fetch(
    `${config.ycloud.baseUrl}/whatsapp/media/${encodeURIComponent(phoneNumber)}/upload`,
    {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: form,
    },
  );
  const json = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`YCloud media upload failed ${response.status}: ${JSON.stringify(json)}`);
  }
  const id = str(json.id);
  if (!id) throw new Error(`YCloud media upload missing id: ${JSON.stringify(json)}`);
  return id;
}

const MAX_FEISHU_IMAGE_BYTES = 10 * 1024 * 1024;

export async function downloadWhatsAppMedia(input: {
  link?: string;
  id?: string;
  mimeType?: string;
}): Promise<{ buffer: Buffer; contentType: string; filename: string }> {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) throw new Error("YCLOUD_API_KEY is not configured");

  const url =
    input.link ||
    (input.id ? `${config.ycloud.baseUrl}/whatsapp/media/download/${encodeURIComponent(input.id)}` : "");
  if (!url) throw new Error("WhatsApp image missing download link");

  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`YCloud media download failed ${response.status}: ${errText.slice(0, 300)}`);
  }

  const contentType = response.headers.get("content-type") || input.mimeType || "image/jpeg";
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as Json;
    throw new Error(`YCloud media download failed: ${JSON.stringify(json)}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("YCloud media download returned empty file");
  if (buffer.length > MAX_FEISHU_IMAGE_BYTES) {
    throw new Error(`图片超过飞书 10MB 限制（${Math.ceil(buffer.length / 1024 / 1024)}MB）`);
  }

  const ext = contentType.includes("png")
    ? "png"
    : contentType.includes("webp")
      ? "webp"
      : contentType.includes("gif")
        ? "gif"
        : "jpg";
  return {
    buffer,
    contentType,
    filename: `whatsapp-image.${ext}`,
  };
}

export async function sendWhatsAppImage(
  from: string,
  to: string,
  image: { id?: string; link?: string; caption?: string },
) {
  if (!image.id && !image.link) throw new Error("image.id or image.link is required");
  return sendWhatsAppMessage(from, to, {
    type: "image",
    image: {
      ...(image.id ? { id: image.id } : {}),
      ...(image.link ? { link: image.link } : {}),
      ...(image.caption ? { caption: image.caption } : {}),
    },
  });
}

export async function sendWhatsAppTemplate(
  from: string,
  to: string,
  template: { name: string; language: string; components?: unknown[] },
) {
  return sendWhatsAppMessage(from, to, {
    type: "template",
    template: {
      name: template.name,
      language: { code: template.language },
      ...(template.components ? { components: template.components } : {}),
    },
  });
}

async function sendWhatsAppMessage(from: string, to: string, payload: Record<string, unknown>) {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) {
    throw new Error("YCLOUD_API_KEY is not configured");
  }

  const response = await fetch(`${config.ycloud.baseUrl}/whatsapp/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ from, to, ...payload }),
  });

  const json = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`YCloud send failed ${response.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

export const EMBEDDED_SIGNUP_LOCALES = ["en_US", "zh_CN", "es_ES", "pt_BR", "id_ID", "ru_RU"] as const;
export const EMBEDDED_SIGNUP_TYPE_PLATFORM = "WHATSAPP_BUSINESS_PLATFORM";
export const EMBEDDED_SIGNUP_TYPE_APP = "WHATSAPP_BUSINESS_APP";
export const EMBEDDED_SIGNUP_TYPES = [EMBEDDED_SIGNUP_TYPE_PLATFORM, EMBEDDED_SIGNUP_TYPE_APP] as const;

export class YCloudApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfter?: string;

  constructor(status: number, body: unknown, retryAfter?: string) {
    super(`YCloud request failed ${status}: ${JSON.stringify(body)}`);
    this.name = "YCloudApiError";
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

export type EmbeddedSignupInput = {
  partnerCustomerId?: string;
  onboardingType?: string;
  locale?: string;
};

export type NormalizedEmbeddedSignup =
  | {
      ok: true;
      partnerCustomerId: string;
      partnerCustomerIdSource: "MIO_CDP_SUPPLIER_ID" | "request";
      onboardingType: string;
      locale?: string;
    }
  | { ok: false; error: string };

export function normalizeEmbeddedSignupInput(
  input: EmbeddedSignupInput,
  options?: { defaultPartnerCustomerId?: string },
): NormalizedEmbeddedSignup {
  const fromRequest = input.partnerCustomerId?.trim() || "";
  const fromEnv = options?.defaultPartnerCustomerId?.trim() || "";
  // 多租户：请求优先，env 只作兜底。否则 env 写死会把所有租户覆盖成同一个值（串台）。
  const partnerCustomerId = fromRequest || fromEnv;
  const partnerCustomerIdSource: "MIO_CDP_SUPPLIER_ID" | "request" = fromRequest
    ? "request"
    : "MIO_CDP_SUPPLIER_ID";
  if (!partnerCustomerId) {
    return {
      ok: false,
      error: "缺少 partnerCustomerId：请在请求 body.partnerCustomerId 传入，或配置环境变量 MIO_CDP_SUPPLIER_ID 作兜底",
    };
  }
  if (partnerCustomerId.length > 128) {
    return { ok: false, error: "partnerCustomerId 过长（最多 128 字符），请使用稳定且不含敏感信息的客户 ID" };
  }

  const onboardingType = (input.onboardingType?.trim() || EMBEDDED_SIGNUP_TYPE_PLATFORM).toUpperCase();
  if (!EMBEDDED_SIGNUP_TYPES.includes(onboardingType as (typeof EMBEDDED_SIGNUP_TYPES)[number])) {
    return {
      ok: false,
      error: `onboardingType 仅支持 ${EMBEDDED_SIGNUP_TYPES.join(" / ")}`,
    };
  }

  const locale = input.locale?.trim();
  if (locale && !EMBEDDED_SIGNUP_LOCALES.includes(locale as (typeof EMBEDDED_SIGNUP_LOCALES)[number])) {
    return {
      ok: false,
      error: `locale 仅支持 ${EMBEDDED_SIGNUP_LOCALES.join(", ")}（区分大小写）`,
    };
  }

  return {
    ok: true,
    partnerCustomerId,
    partnerCustomerIdSource,
    onboardingType,
    locale: locale || undefined,
  };
}

export async function createEmbeddedSignupLink(input: {
  partnerCustomerId: string;
  onboardingType: string;
  locale?: string;
}): Promise<{ onboardingUrl: string; expiresAt: number }> {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) throw new Error("YCLOUD_API_KEY is not configured");

  const body: Record<string, string> = {
    partnerCustomerId: input.partnerCustomerId,
    onboardingType: input.onboardingType,
  };
  if (input.locale) body.locale = input.locale;

  const response = await fetch(`${config.ycloud.baseUrl}/partner/embeddedSignup/links`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const retryAfter = response.headers.get("Retry-After") || undefined;
  const rawText = await response.text();
  let json: Json = {};
  try {
    json = rawText ? (JSON.parse(rawText) as Json) : {};
  } catch {
    json = { error: rawText.slice(0, 300) };
  }

  if (!response.ok) {
    throw new YCloudApiError(response.status, json, retryAfter);
  }

  const onboardingUrl = str(json.onboardingUrl);
  const expiresAt = parseExpiresAtMs(json.expiresAt);
  if (!onboardingUrl || expiresAt === undefined) {
    throw new YCloudApiError(502, { error: "YCloud onboarding link missing onboardingUrl or expiresAt", raw: json });
  }
  return { onboardingUrl, expiresAt };
}

/** YCloud 文档写 unix 毫秒，实际响应里常见 ISO 时间字符串。统一成毫秒时间戳。 */
export function parseExpiresAtMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function pageItems(json: Json): Json[] {
  if (Array.isArray(json.items)) return json.items as Json[];
  const data = asRecord(json.data);
  if (Array.isArray(data.items)) return data.items as Json[];
  if (Array.isArray(json.data)) return json.data as Json[];
  return [];
}

export async function listWhatsAppPhones(wabaId = config.ycloud.wabaId) {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) throw new Error("YCLOUD_API_KEY is not configured");
  if (!wabaId) throw new Error("YCLOUD_WABA_ID is not configured");

  const url = new URL(`${config.ycloud.baseUrl}/whatsapp/phoneNumbers`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("page", "1");
  url.searchParams.set("includeTotal", "true");
  url.searchParams.set("filter.wabaId", wabaId);

  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
  });
  const json = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`YCloud list phones failed ${response.status}: ${JSON.stringify(json)}`);
  }
  return {
    phones: pageItems(json).map((item) => ({
      phoneNumber: str(item.phoneNumber) || str(item.displayPhoneNumber),
      status: str(item.status),
      qualityRating: str(item.qualityRating),
    })),
  };
}

export async function listWhatsAppTemplates(filterName?: string, wabaId = config.ycloud.wabaId) {
  const apiKey = config.ycloud.apiKey;
  if (!apiKey) throw new Error("YCLOUD_API_KEY is not configured");
  if (!wabaId) throw new Error("YCLOUD_WABA_ID is not configured");

  const url = new URL(`${config.ycloud.baseUrl}/whatsapp/templates`);
  url.searchParams.set("limit", "100");
  url.searchParams.set("page", "1");
  url.searchParams.set("includeTotal", "true");
  url.searchParams.set("filter.status", "APPROVED");
  url.searchParams.set("filter.wabaId", wabaId);
  if (filterName?.trim()) url.searchParams.set("filter.name", filterName.trim());

  const response = await fetch(url, {
    headers: { "X-API-Key": apiKey },
  });
  const json = (await response.json()) as Json;
  if (!response.ok) {
    throw new Error(`YCloud list templates failed ${response.status}: ${JSON.stringify(json)}`);
  }
  return {
    templates: pageItems(json).map(summarizeTemplate),
  };
}

function countPositionalPlaceholders(text: string | undefined): number {
  if (!text) return 0;
  let max = 0;
  for (const match of text.matchAll(/\{\{(\d+)\}\}/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

function summarizeTemplate(item: Json) {
  const language = str(asRecord(item.language).code) || str(item.language);
  const components = Array.isArray(item.components) ? (item.components as Json[]) : [];
  const body = components.find((c) => String(c.type || "").toUpperCase() === "BODY");
  const header = components.find((c) => String(c.type || "").toUpperCase() === "HEADER");
  const footer = components.find((c) => String(c.type || "").toUpperCase() === "FOOTER");
  const buttons = components.find((c) => String(c.type || "").toUpperCase() === "BUTTONS");

  const bodyText = str(body?.text);
  const bodyVarCount = countPositionalPlaceholders(bodyText);
  const headerFormat = str(header?.format)?.toUpperCase();
  const headerText = str(header?.text);
  const headerVarCount = countPositionalPlaceholders(headerText);
  const example = asRecord(body?.example);
  const bodyTextExamples = Array.isArray(example.body_text) ? (example.body_text as unknown[]) : [];
  const exampleRow = Array.isArray(bodyTextExamples[0]) ? (bodyTextExamples[0] as unknown[]) : [];

  const buttonItems = Array.isArray(buttons?.buttons) ? (buttons!.buttons as Json[]) : [];
  const urlButtonsNeedingParam = buttonItems
    .map((btn, index) => ({
      index,
      type: str(btn.type),
      text: str(btn.text),
      url: str(btn.url),
      needsParam: Boolean(str(btn.url)?.includes("{{")),
    }))
    .filter((btn) => btn.needsParam);

  const sendComponents: unknown[] = [];
  if (headerFormat === "TEXT" && headerVarCount > 0) {
    sendComponents.push({
      type: "header",
      parameters: Array.from({ length: headerVarCount }, (_, i) => ({
        type: "text",
        text: `{{header_${i + 1}}}`,
      })),
    });
  } else if (headerFormat && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
    sendComponents.push({
      type: "header",
      parameters: [
        {
          type: headerFormat.toLowerCase(),
          [headerFormat.toLowerCase()]: { link: "https://example.com/replace-me" },
        },
      ],
    });
  }
  if (bodyVarCount > 0) {
    sendComponents.push({
      type: "body",
      parameters: Array.from({ length: bodyVarCount }, (_, i) => ({
        type: "text",
        text: typeof exampleRow[i] === "string" ? String(exampleRow[i]) : `{{${i + 1}}}`,
      })),
    });
  }
  for (const btn of urlButtonsNeedingParam) {
    sendComponents.push({
      type: "button",
      sub_type: "url",
      index: String(btn.index),
      parameters: [{ type: "text", text: "{{url_suffix}}" }],
    });
  }

  return {
    name: str(item.name),
    language,
    status: str(item.status),
    category: str(item.category),
    wabaId: str(item.wabaId),
    bodyText,
    footerText: str(footer?.text),
    header: header
      ? {
          format: headerFormat,
          text: headerText,
          variableCount: headerVarCount,
        }
      : undefined,
    variableCount: {
      body: bodyVarCount,
      header: headerVarCount,
      urlButtons: urlButtonsNeedingParam.length,
    },
    needsVariables: bodyVarCount + headerVarCount + urlButtonsNeedingParam.length > 0,
    exampleBodyValues: exampleRow.filter((v): v is string => typeof v === "string"),
    urlButtons: urlButtonsNeedingParam,
    /** 原始组件，调试用 */
    components,
    /**
     * 发送时可用的 components 草稿：
     * - 无变量模板 → []
     * - 有变量时已按占位/示例填好，智能体应把占位符换成真实值再 POST
     */
    sendComponentsDraft: sendComponents,
  };
}

export type WhatsAppTemplateSummary = ReturnType<typeof summarizeTemplate>;

function extractBodyParamTexts(components: unknown[] | undefined): string[] {
  if (!Array.isArray(components)) return [];
  for (const raw of components) {
    const row = asRecord(raw);
    if (String(row.type || "").toLowerCase() !== "body") continue;
    const params = Array.isArray(row.parameters) ? (row.parameters as unknown[]) : [];
    return params
      .map((p) => str(asRecord(p).text))
      .filter((t): t is string => Boolean(t));
  }
  return [];
}

function fillPositionalPlaceholders(template: string, values: string[]): string {
  return template.replace(/\{\{(\d+)\}\}/g, (_, num: string) => {
    const idx = Number(num) - 1;
    return values[idx] ?? `{{${num}}}`;
  });
}

/** 把已批准模板 + 发送参数展开成可读预览（同步飞书用）。 */
export async function buildTemplatePreview(input: {
  name: string;
  language: string;
  components?: unknown[];
  wabaId?: string;
}): Promise<string> {
  const tag = `[template:${input.name}/${input.language}]`;
  try {
    const { templates } = await listWhatsAppTemplates(input.name, input.wabaId);
    const matched =
      templates.find(
        (t) =>
          t.name === input.name &&
          (!t.language || t.language === input.language || t.language.startsWith(input.language)),
      ) || templates.find((t) => t.name === input.name);

    if (!matched?.bodyText) return tag;

    const values = extractBodyParamTexts(input.components);
    const body = fillPositionalPlaceholders(matched.bodyText, values);
    const headerLine =
      matched.header?.format === "TEXT" && matched.header.text
        ? fillPositionalPlaceholders(
            matched.header.text,
            // header params if any — reuse body extraction for header component
            (() => {
              if (!Array.isArray(input.components)) return [] as string[];
              for (const raw of input.components) {
                const row = asRecord(raw);
                if (String(row.type || "").toLowerCase() !== "header") continue;
                const params = Array.isArray(row.parameters) ? (row.parameters as unknown[]) : [];
                return params.map((p) => str(asRecord(p).text)).filter((t): t is string => Boolean(t));
              }
              return [] as string[];
            })(),
          )
        : matched.header?.format && matched.header.format !== "TEXT"
          ? `[${matched.header.format}]`
          : undefined;

    const lines = [
      tag,
      headerLine ? `标题：${headerLine}` : undefined,
      body,
      matched.footerText ? matched.footerText : undefined,
    ].filter(Boolean);
    return lines.join("\n");
  } catch (error) {
    console.error("build template preview failed", error);
    return tag;
  }
}
