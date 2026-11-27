// deepseek-empty-budget-v1
function applyDeepSeekOutputBudget(params, model, context) {
  if (!/^deepseek-v4(?:-|$)/i.test(model?.id ?? '')) return params;
  const limit = Math.min(1048576, Number(model.contextWindow) || 1000000);
  const positive = value => Number.isFinite(value) && value > 0 ? value : 0;
  // deepseek-budget-image-v1: inline images are billed per image, not per base64 byte.
  // Counting their bytes as text made one generated image (1.5-2.5 MB of base64) look
  // like 0.8-1.2M tokens and refused the turn before any request (V 2026-09-28 14:20,
  // providerPayloadBytes=1909721). Each inline image counts as a fixed 8192 tokens.
  const IMAGE_PLACEHOLDER = 'x'.repeat(8192 * 2);
  const INLINE_IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
  const isInlineImageUrl = value => typeof value === 'string' && value.length >= 1024 && INLINE_IMAGE_DATA_URL.test(value);
  const withoutInlineImageBytes = function (key, value) {
    if (typeof value !== 'string' || value.length < 1024) return value;
    if (INLINE_IMAGE_DATA_URL.test(value)) return IMAGE_PLACEHOLDER;
    if (key === 'data' && this && this.type === 'image') return IMAGE_PLACEHOLDER;
    return value;
  };
  const bytes = value => Buffer.byteLength(typeof value === 'string' ? (isInlineImageUrl(value) ? IMAGE_PLACEHOLDER : value) : (JSON.stringify(value ?? '', withoutInlineImageBytes) ?? ''), 'utf8');
  const estimate = value => Math.ceil(bytes(value) / 2);
  // Include serialized tools, role framing, reasoning/tool-call history and system prompt.
  const wireEstimate = estimate({messages:params.messages, tools:params.tools});
  let usageEstimate = 0;
  const messages = context?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    // Do not reuse usage from a different model, excluded history, or unavailable context.
    if (message?.excludeFromContext || message?.usage?.contextUsage?.state === 'unavailable') break;
    if (message?.role !== 'assistant' || message.model !== model.id || !message.usage) continue;
    const u = message.usage;
    const input = positive(u.input) + positive(u.cacheRead) + positive(u.cacheWrite);
    if (!input) continue;
    usageEstimate = input + positive(u.output) + messages.slice(i + 1).reduce((sum, item) => sum + estimate(item), 0);
    // Provider input normally already includes system/tools. This extra allowance
    // also protects against changed tool schemas between turns.
    usageEstimate += estimate(params.tools ?? []) + estimate(context.systemPrompt ?? '');
    break;
  }
  const inputEstimate = Math.max(wireEstimate, usageEstimate);
  const reserve = Math.max(8192, Math.ceil(inputEstimate * 0.05));
  const available = Math.floor(limit - inputEstimate - reserve);
  const requested = positive(params.max_tokens) || positive(params.max_completion_tokens) || positive(model.maxTokens) || 32768;
  const minimum = Math.min(requested, 4096);
  if (!Number.isFinite(available) || available < minimum) {
    throw Object.assign(new Error('Context overflow: [V_DEEPSEEK_CONTEXT_BUDGET_EXHAUSTED] 上下文剩余空间不足，需要压缩上下文后继续；历史和任务状态未清空，恢复前请核对已执行操作，避免重复执行。'), {
      code:'V_DEEPSEEK_CONTEXT_BUDGET_EXHAUSTED',
    });
  }
  const capped = Math.min(requested, available, positive(model.maxTokens) || requested);
  const field = params.max_completion_tokens !== undefined && params.max_tokens === undefined ? 'max_completion_tokens' : 'max_tokens';
  params[field] = capped;
  return params;
}
import { t as __exportAll } from "./rolldown-runtime-BhDjJH2R.mjs";
import { t as AssistantMessageEventStream } from "./event-stream-uSMZJ3FA.mjs";
import { i as clampThinkingLevel } from "./sanitize-unicode-S6binQG-.mjs";
import { n as getAiTransportHost } from "./host-BIaiBURL.mjs";
import { n as clampOpenAIPromptCacheKey } from "./openai-prompt-cache-mZTCdRPo.mjs";
import { t as resolveCacheRetention } from "./cache-retention-0x979a5V.mjs";
import { m as sortPromptCacheToolsByName, n as buildBaseOptions, o as reasoningTagTextPolicy, u as splitSystemPromptCacheBoundary } from "./simple-options-0PLDyJ-d.mjs";
import { n as getEnvApiKey } from "./env-api-keys-bktO00EJ.mjs";
import { _ as transportAbortError, t as assignTransportErrorDetails, y as withProviderResponseHook } from "./transport-stream-shared-CytPVLIg.mjs";
import { E as tagUnresolvedTextAsCommentary, S as shouldOmitOllamaCompatResponseFormat, _ as hasToolCallHistory, b as resolveOpenAICompletionsCompat, g as convertMessages, h as resolveOpenAIReasoningEffortMap, t as processCompletionsStream, v as finalizeOpenAICompletionsToolCalls, w as clearPendingCommentaryText, x as resolveOpenAICompletionsResponseFormat } from "./openai-completions-stream-DZjwK8vp.mjs";
import { C as createOpenAIProviderAcceptanceHook, T as isOpenAICompletionsThinkingEnabled, j as resolveOpenAIClientBaseUrl, v as projectOpenAITools, y as reconcileOpenAICompletionsToolChoice } from "./openai-tool-schema-BMiHFH36.mjs";
import { i as getFirstStreamEventTimeoutMs, r as getFirstStreamEventTimeoutHandler, t as createFirstStreamEventAbortController } from "./stream-first-event-timeout-DcNjoFQE.mjs";
import { i as resolveCloudflareBaseUrl, n as hasCopilotVisionInput, r as isCloudflareProvider, t as buildCopilotDynamicHeaders } from "./github-copilot-headers-NCJtz9i0.mjs";
import OpenAI from "openai";
//#region packages/ai/src/providers/openai-completions.ts
var openai_completions_exports = /* @__PURE__ */ __exportAll({
	convertMessages: () => convertMessages,
	streamOpenAICompletions: () => streamOpenAICompletions,
	streamSimpleOpenAICompletions: () => streamSimpleOpenAICompletions
});
const streamOpenAICompletions = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			},
			stopReason: "stop",
			timestamp: Date.now()
		};
		const provisionalCommentaryTags = /* @__PURE__ */ new Map();
		let firstEventAbort;
		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const compat = resolveOpenAICompletionsCompat(model);
			const shouldEmitReasoning = Boolean(model.reasoning && options?.reasoningEffort && isOpenAICompletionsThinkingEnabled(options.reasoningEffort));
			const cacheRetention = resolveCacheRetention(options?.cacheRetention);
			const cacheSessionId = cacheRetention === "none" ? void 0 : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
			let params = buildParams(model, context, options, compat, cacheRetention);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== void 0) params = nextParams;
			params = applyDeepSeekOutputBudget(params, model, context);
			firstEventAbort = createFirstStreamEventAbortController(options?.signal);
			const requestOptions = {
				signal: firstEventAbort.signal,
				...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
				maxRetries: 0
			};
			const { data: openaiStream, response } = await client.chat.completions.create(params, requestOptions).withResponse();
			const hookedOpenAIStream = withProviderResponseHook({
				stream: openaiStream,
				signal: firstEventAbort.signal,
				abort: firstEventAbort.abort,
				hook: createOpenAIProviderAcceptanceHook(options, response, model),
				onReady: () => stream.push({
					type: "start",
					partial: output
				})
			});
			const finishedBlocks = /* @__PURE__ */ new Set();
			const contentIndices = /* @__PURE__ */ new WeakMap();
			let openTextBlock;
			let openThinkingBlock;
			const finishBlock = (block) => {
				const contentIndex = contentIndices.get(block);
				if (contentIndex === void 0 || finishedBlocks.has(block)) return;
				finishedBlocks.add(block);
				if (block.type === "text") {
					openTextBlock = void 0;
					stream.push({
						type: "text_end",
						contentIndex,
						content: block.text,
						partial: output
					});
				} else if (block.type === "thinking") {
					openThinkingBlock = void 0;
					stream.push({
						type: "thinking_end",
						contentIndex,
						content: block.thinking,
						partial: output
					});
				} else if (block.type === "toolCall") stream.push({
					type: "toolcall_end",
					contentIndex,
					toolCall: block,
					partial: output
				});
			};
			const directEventStream = { push(event) {
				if (event.type === "text_start" || event.type === "thinking_start" || event.type === "toolcall_start") {
					const block = output.content[event.contentIndex];
					if (block) {
						contentIndices.set(block, event.contentIndex);
						if (block.type === "text") openTextBlock = block;
						else if (block.type === "thinking") openThinkingBlock = block;
					}
				}
				stream.push(event);
			} };
			try {
				await processCompletionsStream(hookedOpenAIStream, output, model, directEventStream, {
					mode: "direct",
					beforeContentBlock(nextType) {
						if (openThinkingBlock) finishBlock(openThinkingBlock);
						if (openTextBlock && nextType !== "toolCall") finishBlock(openTextBlock);
					},
					provisionalCommentaryTags,
					signal: options?.signal,
					emitReasoning: shouldEmitReasoning,
					strictReasoningTags: reasoningTagTextPolicy.isStrict(options),
					firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
					abortFirstEventStream: firstEventAbort.abort,
					onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options)
				});
				if (options?.signal?.aborted) throw transportAbortError(options.signal);
				if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage || (output.stopReason === "aborted" ? "Request was aborted" : "Provider returned an invalid tool call"));
			} catch (error) {
				for (const block of output.content) if (block.type !== "toolCall") finishBlock(block);
				throw error;
			}
			for (const block of output.content) if (block.type !== "toolCall" || output.stopReason === "toolUse") finishBlock(block);
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			const terminal = assignTransportErrorDetails(output, error, options?.signal);
			finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
			clearPendingCommentaryText(provisionalCommentaryTags);
			tagUnresolvedTextAsCommentary(output);
			for (const block of output.content) {
				delete block.index;
				delete block.partialArgs;
				delete block.streamIndex;
			}
			stream.push({
				type: "error",
				reason: terminal.stopReason,
				error: output
			});
			stream.end();
		} finally {
			firstEventAbort?.dispose();
		}
	})();
	return stream;
};
const streamSimpleOpenAICompletions = (model, context, options) => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
	const reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning === "max" ? "xhigh" : clampedReasoning;
	const toolChoice = options?.toolChoice;
	return streamOpenAICompletions(model, context, {
		...base,
		reasoningEffort,
		toolChoice
	});
};
function createClient(model, context, apiKey, optionsHeaders, sessionId, compat = resolveOpenAICompletionsCompat(model)) {
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const headers = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages
		});
		Object.assign(headers, copilotHeaders);
	}
	if (sessionId && compat.sessionAffinity !== "none") {
		if (compat.sessionAffinity === "openrouter") headers["x-session-id"] = sessionId;
		else {
			headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
		}
	}
	if (optionsHeaders) Object.assign(headers, optionsHeaders);
	const defaultHeaders = model.provider === "cloudflare-ai-gateway" ? {
		...headers,
		Authorization: headers.Authorization ?? null,
		"cf-aig-authorization": `Bearer ${apiKey}`
	} : headers;
	const baseUrl = isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl;
	return new OpenAI({
		apiKey,
		baseURL: resolveOpenAIClientBaseUrl(model, baseUrl),
		dangerouslyAllowBrowser: true,
		defaultHeaders,
		maxRetries: 0,
		fetch: getAiTransportHost().buildModelFetch(model)
	});
}
function buildParams(model, context, options, compat = resolveOpenAICompletionsCompat(model), cacheRetention = resolveCacheRetention(options?.cacheRetention)) {
	const cacheControl = getCompatCacheControl(compat, cacheRetention);
	const cacheOptOutIndexes = /* @__PURE__ */ new Set();
	const messages = convertMessages(model, context, compat, {
		cacheOptOutIndexes,
		preserveSystemPromptCacheBoundary: cacheControl !== void 0
	});
	const supportsPromptCacheKey = model.baseUrl.includes("api.openai.com") || compat.supportsPromptCacheKey;
	const promptCacheKey = supportsPromptCacheKey && cacheRetention !== "none" ? clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId) : void 0;
	const params = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: supportsPromptCacheKey && cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : void 0
	};
	if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };
	if (compat.supportsStore) params.store = false;
	if (options?.maxTokens) {
		const maxTokens = clampOpenAICompletionsMaxTokens(model, options.maxTokens);
		if (compat.maxTokensField === "max_tokens") params.max_tokens = maxTokens;
		else params.max_completion_tokens = maxTokens;
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	if (options?.stop !== void 0 && options.stop.length > 0) params.stop = options.stop;
	const requestedResponseFormat = options?.responseFormat;
	const responseFormat = requestedResponseFormat === void 0 ? void 0 : resolveOpenAICompletionsResponseFormat(shouldOmitOllamaCompatResponseFormat({
		provider: model.provider,
		baseUrl: model.baseUrl,
		hasTools: () => Boolean(context.tools?.length)
	}) ? void 0 : requestedResponseFormat, compat.supportsJsonSchemaResponseFormat);
	if (responseFormat !== void 0) params.response_format = responseFormat;
	let toolProjection;
	if (context.tools) {
		const converted = convertTools(context.tools, compat);
		toolProjection = converted.projection;
		if (converted.tools.length > 0) params.tools = converted.tools;
		else if (hasToolCallHistory(context.messages)) params.tools = [];
		if (compat.zaiToolStream && converted.tools.length > 0) params.tool_stream = true;
	} else if (hasToolCallHistory(context.messages)) params.tools = [];
	if (cacheControl) applyAnthropicCacheControl(messages, params.tools, cacheControl, cacheOptOutIndexes);
	if (options?.toolChoice) {
		const toolChoice = reconcileOpenAICompletionsToolChoice(options.toolChoice, toolProjection ?? projectOpenAITools([]));
		if (toolChoice !== void 0) params.tool_choice = toolChoice;
	}
	const reasoningEffortMap = resolveOpenAIReasoningEffortMap(model);
	const thinkingLevelMap = model.thinkingLevelMap;
	const offReasoningEffort = reasoningEffortMap.off ?? model.thinkingLevelMap?.off;
	const reasoningEffort = options?.reasoningEffort === void 0 ? offReasoningEffort ?? void 0 : reasoningEffortMap[options.reasoningEffort] ?? thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	const reasoningEnabled = reasoningEffort !== void 0 && reasoningEffort !== "none";
	if (compat.thinkingFormat === "zai" && model.reasoning) params.thinking = reasoningEnabled ? {
		type: "enabled",
		clear_thinking: false
	} : { type: "disabled" };
	else if (compat.thinkingFormat === "qwen" && model.reasoning) params.enable_thinking = reasoningEnabled;
	else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) params.chat_template_kwargs = {
		enable_thinking: reasoningEnabled,
		preserve_thinking: true
	};
	else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		params.thinking = { type: reasoningEnabled ? "enabled" : "disabled" };
		if (reasoningEnabled && compat.supportsReasoningEffort) params.reasoning_effort = reasoningEffort;
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params;
		if (reasoningEnabled) openRouterParams.reasoning = { effort: reasoningEffort };
		else if (offReasoningEffort !== null) openRouterParams.reasoning = { effort: offReasoningEffort ?? "none" };
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params;
		togetherParams.reasoning = { enabled: reasoningEnabled };
		if (reasoningEnabled && compat.supportsReasoningEffort) togetherParams.reasoning_effort = reasoningEffort;
	} else if (reasoningEnabled && model.reasoning && compat.supportsReasoningEffort) params.reasoning_effort = reasoningEffort;
	else if (model.reasoning && compat.supportsReasoningEffort) {
		if (typeof offReasoningEffort === "string") params.reasoning_effort = offReasoningEffort;
	}
	if (compat.openRouterRouting) params.provider = compat.openRouterRouting;
	if (model.baseUrl.includes("ai-gateway.vercel.sh") && model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
	return params;
}
function clampOpenAICompletionsMaxTokens(model, requestedMaxTokens) {
	const modelMaxTokens = typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : void 0;
	return modelMaxTokens === void 0 || requestedMaxTokens <= modelMaxTokens ? requestedMaxTokens : modelMaxTokens;
}
function getCompatCacheControl(compat, cacheRetention) {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") return;
	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : void 0;
	return {
		type: "ephemeral",
		...ttl ? { ttl } : {}
	};
}
function applyAnthropicCacheControl(messages, tools, cacheControl, cacheOptOutIndexes) {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl, cacheOptOutIndexes);
}
function addCacheControlToSystemPrompt(messages, cacheControl) {
	for (const message of messages) if (message.role === "system" || message.role === "developer") {
		addCacheControlToInstructionMessage(message, cacheControl);
		return;
	}
}
function addCacheControlToLastConversationMessage(messages, cacheControl, cacheOptOutIndexes) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!message || cacheOptOutIndexes.has(i)) continue;
		if (message.role === "user" || message.role === "assistant") {
			if (addCacheControlToMessage(message, cacheControl)) return;
		}
	}
}
function addCacheControlToLastTool(tools, cacheControl) {
	if (!tools || tools.length === 0) return;
	const lastTool = tools.at(-1);
	if (!lastTool) return;
	lastTool.cache_control = cacheControl;
}
function addCacheControlToInstructionMessage(message, cacheControl) {
	return addCacheControlToTextContent(message, cacheControl);
}
function addCacheControlToMessage(message, cacheControl) {
	if (message.role === "user" || message.role === "assistant") return addCacheControlToTextContent(message, cacheControl);
	return false;
}
function addCacheControlToTextContent(message, cacheControl) {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) return false;
		message.content = buildCacheControlledTextParts(content, cacheControl);
		return true;
	}
	if (!Array.isArray(content)) return false;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const text = part.text;
			content.splice(i, 1, ...buildCacheControlledTextParts(text, cacheControl));
			return true;
		}
	}
	return false;
}
function buildCacheControlledTextParts(text, cacheControl) {
	const split = splitSystemPromptCacheBoundary(text);
	if (!split) return [{
		type: "text",
		text,
		cache_control: cacheControl
	}];
	const parts = [];
	if (split.stablePrefix) parts.push({
		type: "text",
		text: split.stablePrefix,
		cache_control: cacheControl
	});
	if (split.dynamicSuffix) parts.push({
		type: "text",
		text: split.dynamicSuffix
	});
	return parts.length > 0 ? parts : [{
		type: "text",
		text: ""
	}];
}
function convertTools(tools, compat) {
	const projection = projectOpenAITools(tools);
	return {
		projection,
		tools: sortPromptCacheToolsByName(projection.tools).map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				...compat.supportsStrictMode && { strict: false }
			}
		}))
	};
}
//#endregion
export { streamOpenAICompletions as n, streamSimpleOpenAICompletions as r, openai_completions_exports as t };
