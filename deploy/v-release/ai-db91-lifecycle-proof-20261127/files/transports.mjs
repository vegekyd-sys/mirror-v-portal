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
import { g as supportsClaudeAdaptiveThinking, m as resolveClaudeSonnet5ModelIdentity, p as resolveClaudeOpus5ModelIdentity, y as supportsClaudeNativeXhighEffort } from "./src-C8U7lkoa.mjs";
import { c as normalizeLowercaseStringOrEmpty, o as isRecord, s as hasNonEmptyString } from "./utf16-slice-qz3nsy87.mjs";
import { r as calculateCost } from "./sanitize-unicode-S6binQG-.mjs";
import { S as usesClaudeStreamingRefusalContract, _ as prepareClaudeNoPrefillRequestContext, a as describeToolResultMediaPlaceholder, c as extractToolResultText, d as isImageWithMediaPayload, f as ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK, g as mapAnthropicStopReason, h as defaultsClaudeAdaptiveThinking, m as applyClaudeRequestContract, n as getAiTransportHost, p as ANTHROPIC_CLAUDE_CODE_VERSION, r as resolveAiTransportHeaderSentinels, s as extractToolResultBlockText, v as requiresClaudeAdaptiveThinking, x as usesClaudeFable5MessagesContract, y as resolveAnthropicThinkingEffort } from "./host-BIaiBURL.mjs";
import { i as stableStringify } from "./provider-error-B6EGq6gg.mjs";
import { r as toErrorObject } from "./diagnostics-KhXK-QJI.mjs";
import { a as asNonNegativeFiniteNumber } from "./base64-CEFBpSkN.mjs";
import { n as uniqueStrings } from "./string-normalization--fwJ4S2q.mjs";
import { A as applyAnthropicCacheControlToMessages, C as applyAnthropicFallbackBoundary, D as createAnthropicInlineImageBudget, E as applyAnthropicRefusal, F as resolveAnthropicServerCompactionPlan, I as isAnthropicOAuthApiKey, L as omitFoundryBearerCredentialHeaders, M as applyAnthropicPayloadPolicyToParams, N as resolveAnthropicEphemeralCacheControl, O as normalizeAnthropicInlineContent, P as resolveAnthropicPayloadPolicy, R as usesFoundryBearerAuth, T as resolveAnthropicFallbackServingModelCost, _ as toClaudeCodeToolName, a as suppressAnthropicCompaction, b as ANTHROPIC_SERVER_SIDE_FALLBACKS, f as normalizeAnthropicToolCallId, g as resolveOriginalAnthropicToolName, h as reconcileAnthropicToolChoice, i as resolveNewestAnthropicCompaction, j as applyAnthropicEphemeralCacheControlMarkers, k as resolveAnthropicImageMediaType, m as projectAnthropicTools, n as createCompactionCapture, o as applyAnthropicMessageDeltaUsage, p as normalizeAnthropicToolChoice, r as isAnthropicReplayRejection, s as applyAnthropicMessageStartUsage, t as buildAnthropicReplayPlan, v as ANTHROPIC_OMITTED_REASONING_TEXT, w as readAnthropicFallbackBoundary, x as ANTHROPIC_SERVER_SIDE_FALLBACK_BETA, y as findActiveAnthropicToolTurnAssistantIndex } from "./anthropic-compaction-replay-OMJZ0uyo.mjs";
import { t as resolveCacheRetention } from "./cache-retention-0x979a5V.mjs";
import { a as codeModeToolSurfaceObserver, d as stripSystemPromptCacheBoundary, m as sortPromptCacheToolsByName, o as reasoningTagTextPolicy, t as adjustMaxTokensForThinking } from "./simple-options-0PLDyJ-d.mjs";
import { a as resolveProviderEndpoint, c as transformTransportMessages, i as resolveOpenAIStrictToolSetting, n as buildGuardedModelFetch } from "./tool-schema-json-projection-BtZiml7r.mjs";
import { a as isGoogleGemini3FlashModel, c as parseRetryAfterSeconds, f as resolveModelHeaderSentinels$1, i as isCodeModeModelVisibleToolName, l as readResponseTextSnippet, m as supportsModelTools, n as createAbortError$1, o as isGoogleGemini3ProModel, p as sha256Hex, r as estimateStringChars, t as MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, u as redactIdentifier } from "./transport-utils-CtuS1Upe.mjs";
import { n as getEnvApiKey } from "./env-api-keys-bktO00EJ.mjs";
import { S as quoteUnsafeIntegerLiterals, _ as transportAbortError, a as createWritableTransportEventStream, b as parseJsonObjectPreservingUnsafeIntegers, c as finalizeTransportStream, d as notifyProviderHttpMetadata, f as notifyProviderHttpResponse, g as sanitizeTransportPayloadText, h as sanitizeNonEmptyTransportPayloadText, i as createEmptyTransportUsage, l as mergeTransportHeaders, m as parseTerminalToolCallArguments, n as coerceTransportToolCallArguments, o as failTransportStream, p as notifyProviderStreamOpened, r as copyProviderAcceptanceObserver, s as finalizeTerminalToolCallArguments, t as assignTransportErrorDetails, u as mergeTransportMetadata, v as withProviderAcceptanceObserver, x as parseJsonPreservingUnsafeIntegers, y as withProviderResponseHook } from "./transport-stream-shared-CytPVLIg.mjs";
import { C as createDeepSeekTextFilter, E as tagUnresolvedTextAsCommentary, S as shouldOmitOllamaCompatResponseFormat, T as tagPendingCommentaryText, _ as hasToolCallHistory, a as buildOpenAISdkClientOptions, b as resolveOpenAICompletionsCompat, c as filterCodeModePayloadTools, d as readCodeModePayloadToolName, f as resolveCodeModeResponsesVisibleToolNames, g as convertMessages, h as resolveOpenAIReasoningEffortMap, i as buildOpenAIClientHeaders, l as getCompat, m as usesNativeOpenAICodexResponsesBackend, n as shouldEmitOpenAICompletionsReasoning, o as buildOpenAISdkRequestOptions, p as resolveOpenAIStrictToolFlagWithDiagnostics, r as assertCodeModeResponsesToolSurface, s as enforceCodeModeResponsesToolSurface, t as processCompletionsStream, u as isOpenAICodexResponsesModel, v as finalizeOpenAICompletionsToolCalls, x as resolveOpenAICompletionsResponseFormat, y as detectOpenAICompletionsCompat } from "./openai-completions-stream-DZjwK8vp.mjs";
import { t as createDeferredEventBuffer } from "./deferred-event-buffer-DAvyP7qA.mjs";
import { r as parseStreamingJson, t as createToolArgumentPreviewSchedule } from "./json-parse-BuAJEbdW.mjs";
import { t as notifyLlmRequestActivity } from "./llm-request-activity-BjtkplhG.mjs";
import { t as googleFlashSupportsMinimalThinking } from "./google-thinking-level-C-V3tecN.mjs";
import { B as buildResponsesInputMessage, C as summarizeResponsesTools, G as captureOpenAIResponsesCompaction, H as createOpenAIResponsesAssistantOutput, I as createResponsesStreamWithEncryptedContentRetry, J as resolveReplayableResponsesMessageId, K as resolveNewestOpenAIResponsesCompactionReplay, L as isInvalidEncryptedContentError, R as resolveAzureOpenAIApiVersion, S as summarizeResponsesPayload, U as CompactionReplayRefreshRequiredError, V as convertResponsesMessages, W as buildOpenAIResponsesReasoningReplayMetadata, X as resolveModelPayloadDebugMode, Y as emitModelTransportDebug, Z as resolveModelSseDebugMode, _ as safeDebugValue, b as summarizeOpenAITransportError, c as processResponsesStream, f as observeResponsesStream, g as normalizeResponsesFailedEvent, h as logResponsesFailedNoDetails, m as buildResponsesFailedNoDetailsObservation, n as applyResponsesServiceTierPricing, p as ResponsesStreamFailure, q as suppressOpenAIResponsesCompaction, v as stringifyRedactedEvent, x as summarizeResponsesFailedNoDetailsObservation, y as stringifyRedactedPayload, z as resolveNextResponsesEncryptedContentAttempt } from "./openai-responses-shared-DiAdpNAM.mjs";
import { A as readOpenAICompletionsReasoningBatch, C as createOpenAIProviderAcceptanceHook, D as measureUtf8AppendBytes, E as log, M as resolvePromptCacheKey, N as throwIfModelStreamAborted, O as parseOpenAICompletionsUsage, S as createModelStreamCooperativeScheduler, T as isOpenAICompletionsThinkingEnabled, b as reconcileOpenAIResponsesToolChoice, j as resolveOpenAIClientBaseUrl, k as readOpenAICompletionsContentDeltas, r as normalizeOpenAIStrictToolParameters, v as projectOpenAITools, w as createOpenAIResponseHook, x as GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP, y as reconcileOpenAICompletionsToolChoice } from "./openai-tool-schema-BMiHFH36.mjs";
import { i as getFirstStreamEventTimeoutMs, r as getFirstStreamEventTimeoutHandler, t as createFirstStreamEventAbortController } from "./stream-first-event-timeout-DcNjoFQE.mjs";
import { C as isOpenAIGpt54MiniModel, D as resolveOpenAIReasoningEffortForModel, E as normalizeOpenAIReasoningEffort, T as isOpenAIGpt56Model, _ as OpenAIResponsesWebSocketPostDispatchError, a as applyOpenAIResponsesPayloadPolicy, c as resolveOpenAIResponsesServerCompactionPlan, d as OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS, f as OPENAI_RESPONSES_APIS, i as sanitizeResponsesImagePayload, l as AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS, n as isOpenAIResponsesCompactionOutput, o as resolveOpenAIResponsesCompactEndpointPlan, s as resolveOpenAIResponsesPayloadPolicy, t as createBoundedOpenAIResponsesCompactionFetch, v as OpenAIResponsesWebSocketPreDispatchError, w as isOpenAIGpt55Model, x as parseOpenAIResponsesWebSocketServerError, y as OpenAIResponsesWebSocketSafeRetryError } from "./openai-responses-compaction-window-DO7yV7az.mjs";
import { i as resolveAzureDeploymentNameFromMap, t as isOpenAICompatibleAzureResponsesBaseUrl } from "./azure-openai-responses-client-compat-C7K7QfUE.mjs";
import { n as registerSessionResourceCleanup } from "./session-resources-CkR4WWy1.mjs";
import { t as createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal-C7x4IK7r.mjs";
import { randomUUID } from "node:crypto";
import OpenAI, { AzureOpenAI } from "openai";
import { ResponsesWS } from "openai/resources/responses/ws.js";
//#region packages/ai/src/transports/anthropic-transport-stream.ts
/**
* Native Anthropic Messages streaming transport.
* Converts OpenClaw contexts/tools into Anthropic payloads, streams SSE events
* back into runtime output blocks, and applies provider request policy.
*/
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES = 8192;
const ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS = 400;
const ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS = 1e4;
const ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS = 4096;
const ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR = 4;
const ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS = 16777216;
function resolveAnthropicRequestModelId(model) {
	if (isDirectAnthropicModel(model) && /^anthropic\//i.test(model.id)) return model.id.replace(/^anthropic\//i, "");
	return model.id;
}
const EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT = ".";
function resolvePositiveAnthropicTokenLimit(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	const floored = Math.floor(value);
	return floored > 0 ? floored : void 0;
}
function resolveAnthropicMessagesMaxTokens(params) {
	const requested = resolvePositiveAnthropicTokenLimit(params.requestedMaxTokens);
	if (requested !== void 0) return requested;
	const modelMax = resolvePositiveAnthropicTokenLimit(params.modelMaxTokens);
	if (modelMax !== void 0) return params.useModelDefault ? modelMax : Math.min(modelMax, 32e3);
	if (params.modelMaxTokens !== void 0) return;
	const contextWindow = resolvePositiveAnthropicTokenLimit(params.modelContextWindow);
	return contextWindow === void 0 ? ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS : Math.max(1, Math.min(ANTHROPIC_MESSAGES_DEFAULT_MAX_TOKENS, Math.floor(contextWindow / ANTHROPIC_MESSAGES_FALLBACK_CONTEXT_DIVISOR)));
}
function isDirectAnthropicModel(model) {
	if (normalizeLowercaseStringOrEmpty(model.provider) !== "anthropic") return false;
	const endpointClass = resolveProviderEndpoint(model).endpointClass;
	return endpointClass === "default" || endpointClass === "anthropic-public";
}
function isKimiAnthropicProvider(provider) {
	return /^kimi(?:-|$)/.test(normalizeLowercaseStringOrEmpty(provider ?? ""));
}
/**
* Server-side refusal fallback is a first-party Claude API beta: proxies and
* Bedrock/Vertex/Foundry reject the `fallbacks` param, and OAuth (Claude Code
* identity) requests are excluded until the beta is verified there.
*/
function useAnthropicServerSideFallback(model) {
	return (usesClaudeFable5MessagesContract(model) || resolveClaudeOpus5ModelIdentity(model) !== void 0) && isDirectAnthropicModel(model);
}
function supportsReasoningContentReplay(model) {
	return resolveProviderEndpoint(model).endpointClass === "xiaomi-native";
}
function buildAnthropicBetaHeader(model, betaFeatures, params) {
	if (!isDirectAnthropicModel(model)) return;
	return params.oauth ? `claude-code-20250219,oauth-2025-04-20,${betaFeatures.join(",")}` : betaFeatures.join(",");
}
const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
async function convertContentBlocks(content, model, imageBudget) {
	const text = extractToolResultText(content);
	const mediaPlaceholder = describeToolResultMediaPlaceholder(content);
	if (!(model.input.includes("image") && content.some(isImageWithMediaPayload))) return sanitizeNonEmptyTransportPayloadText(text, mediaPlaceholder ?? "(no output)");
	const blocks = [];
	let hasTextBlock = false;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		const blockText = extractToolResultBlockText(block);
		if (blockText) {
			blocks.push({
				type: "text",
				text: sanitizeTransportPayloadText(blockText)
			});
			hasTextBlock = true;
		}
		if (!isImageWithMediaPayload(record)) continue;
		const [normalizedImage] = await normalizeAnthropicInlineContent([{
			type: "image",
			data: typeof record.data === "string" ? record.data : "",
			mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png"
		}], imageBudget);
		if (normalizedImage?.type !== "image") continue;
		blocks.push({
			type: "image",
			source: {
				type: "base64",
				media_type: resolveAnthropicImageMediaType(normalizedImage.mimeType),
				data: normalizedImage.data
			}
		});
	}
	if (!hasTextBlock) blocks.unshift({
		type: "text",
		text: mediaPlaceholder ?? "(see attached image)"
	});
	return blocks;
}
async function convertAnthropicMessages(messages, model, isOAuthToken, options) {
	const params = [];
	const imageBudget = createAnthropicInlineImageBudget();
	const allowReasoningContentReplay = options.allowReasoningContentReplay === true;
	const replayThinkingEnabled = options.replayThinkingEnabled !== false;
	const transformedMessages = transformTransportMessages(messages, model, normalizeAnthropicToolCallId);
	const activeToolTurnAssistantIndex = replayThinkingEnabled ? -1 : findActiveAnthropicToolTurnAssistantIndex(transformedMessages);
	for (let i = 0; i < transformedMessages.length; i += 1) {
		const msg = transformedMessages[i];
		if (!msg) continue;
		if (msg.role === "user") {
			const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					const userParam = {
						role: "user",
						content: sanitizeTransportPayloadText(msg.content)
					};
					if (isRuntimeContextCarrier) options.cacheBreakpointOptOutMessageIndexes.add(params.length);
					params.push(userParam);
				}
				continue;
			}
			const blocks = (model.input.includes("image") ? await normalizeAnthropicInlineContent(msg.content, imageBudget) : msg.content.map((item) => item.type === "image" ? {
				type: "text",
				text: NON_VISION_USER_IMAGE_PLACEHOLDER
			} : item)).map((item) => item.type === "text" ? {
				type: "text",
				text: sanitizeTransportPayloadText(item.text)
			} : {
				type: "image",
				source: {
					type: "base64",
					media_type: resolveAnthropicImageMediaType(item.mimeType),
					data: item.data
				}
			});
			let filteredBlocks = model.input.includes("image") ? blocks : blocks.filter((block) => block.type !== "image");
			filteredBlocks = filteredBlocks.filter((block) => block.type !== "text" || block.text.trim().length > 0);
			if (filteredBlocks.length === 0) continue;
			const userParam = {
				role: "user",
				content: filteredBlocks
			};
			if (isRuntimeContextCarrier) options.cacheBreakpointOptOutMessageIndexes.add(params.length);
			params.push(userParam);
			continue;
		}
		if (msg.role === "assistant") {
			const blocks = i === 0 && options.compaction ? [options.compaction] : [];
			const reasoningContent = [];
			let omittedThinking = false;
			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length > 0) blocks.push({
						type: "text",
						text: sanitizeTransportPayloadText(block.text)
					});
					continue;
				}
				if (block.type === "thinking") {
					const thinkingSignature = block.thinkingSignature?.trim();
					const isReasoningContent = thinkingSignature === "reasoning_content";
					if (!replayThinkingEnabled && i !== activeToolTurnAssistantIndex && !isReasoningContent) {
						omittedThinking = true;
						continue;
					}
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature
						});
						continue;
					}
					const hasNativeThinkingSignature = Boolean(thinkingSignature) && !isReasoningContent;
					if (block.thinking.trim().length === 0 && !hasNativeThinkingSignature) continue;
					if (!thinkingSignature) blocks.push({
						type: "text",
						text: sanitizeTransportPayloadText(block.thinking)
					});
					else {
						const thinking = thinkingSignature === "reasoning_content" ? sanitizeTransportPayloadText(block.thinking) : block.thinking;
						if (thinkingSignature === "reasoning_content") {
							if (allowReasoningContentReplay) {
								blocks.push({
									type: "thinking",
									thinking,
									signature: thinkingSignature
								});
								reasoningContent.push(thinking);
							}
							continue;
						}
						blocks.push({
							type: "thinking",
							thinking,
							signature: thinkingSignature
						});
					}
					continue;
				}
				if (block.type === "toolCall") blocks.push({
					type: "tool_use",
					id: block.id,
					name: isOAuthToken ? toClaudeCodeToolName(block.name) : block.name,
					input: coerceTransportToolCallArguments(block.arguments)
				});
			}
			if (blocks.length === 0 && omittedThinking) blocks.push({
				type: "text",
				text: ANTHROPIC_OMITTED_REASONING_TEXT
			});
			if (blocks.length > 0) {
				const assistantMsg = {
					role: "assistant",
					content: blocks
				};
				if (reasoningContent.length > 0) assistantMsg.reasoning_content = reasoningContent.join("\n");
				else if (allowReasoningContentReplay) blocks.unshift({
					type: "thinking",
					thinking: "",
					signature: "reasoning_content"
				});
				params.push(assistantMsg);
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const toolResult = msg;
			const toolResults = [{
				type: "tool_result",
				tool_use_id: toolResult.toolCallId,
				content: await convertContentBlocks(toolResult.content, model, imageBudget),
				is_error: toolResult.isError
			}];
			let j = i + 1;
			while (j < transformedMessages.length) {
				const nextMsg = transformedMessages.at(j);
				if (nextMsg?.role !== "toolResult") break;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: await convertContentBlocks(nextMsg.content, model, imageBudget),
					is_error: nextMsg.isError
				});
				j += 1;
			}
			i = j - 1;
			params.push({
				role: "user",
				content: toolResults
			});
		}
	}
	return params;
}
function ensureNonEmptyAnthropicMessages(messages) {
	return messages.length > 0 ? messages : [{
		role: "user",
		content: EMPTY_ANTHROPIC_MESSAGES_FALLBACK_TEXT
	}];
}
function convertAnthropicTools(tools, isOAuthToken) {
	const projection = projectAnthropicTools(tools ?? [], (name) => isOAuthToken ? toClaudeCodeToolName(name) : name);
	const converted = [];
	for (const tool of projection.tools) converted.push({
		name: tool.wireName,
		description: tool.description,
		input_schema: tool.inputSchema
	});
	return {
		projection,
		tools: converted
	};
}
function parseAnthropicToolCallArguments(inputJson) {
	return coerceTransportToolCallArguments(parseJsonObjectPreservingUnsafeIntegers(inputJson) ?? parseStreamingJson(inputJson));
}
const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";
/** Resolve the effective Anthropic API base URL from model or environment. */
function resolveAnthropicBaseUrl(baseUrl) {
	return baseUrl?.trim() || process.env.ANTHROPIC_BASE_URL?.trim() || DEFAULT_ANTHROPIC_BASE_URL;
}
/** Resolve the Anthropic Messages endpoint URL for the effective base URL. */
function resolveAnthropicMessagesUrl(baseUrl) {
	const normalized = resolveAnthropicBaseUrl(baseUrl).replace(/\/+$/, "");
	return normalized.endsWith("/v1") ? `${normalized}/messages` : `${normalized}/v1/messages`;
}
function withEffectiveAnthropicBaseUrl(model) {
	const baseUrl = resolveAnthropicBaseUrl(model.baseUrl);
	return baseUrl === model.baseUrl ? model : {
		...model,
		baseUrl
	};
}
function createAbortError(signal) {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	return createAbortError$1("Request was aborted", reason === void 0 ? void 0 : { cause: reason });
}
function readAnthropicSseChunk(reader, signal) {
	if (!signal) return reader.read();
	return new Promise((resolve, reject) => {
		let settled = false;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reader.cancel(signal.reason).catch(() => void 0);
			reject(createAbortError(signal));
		};
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then((result) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			resolve(result);
		}, (error) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			reject(toErrorObject(error, "Non-Error rejection"));
		});
	});
}
function parseAnthropicSseEventData(data) {
	try {
		return JSON.parse(data);
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause: error });
		throw error;
	}
}
function assertAnthropicSsePendingBufferWithinLimit(pendingChars) {
	if (pendingChars <= ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS) return;
	throw new Error(`Anthropic Messages SSE response exceeded max pending buffer size (${ANTHROPIC_MESSAGES_SSE_PENDING_BUFFER_MAX_CHARS} chars) without event boundary`);
}
async function* parseAnthropicSseBody(body, signal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let completed = false;
	try {
		while (true) {
			const { done, value } = await readAnthropicSseChunk(reader, signal);
			if (done) {
				completed = true;
				break;
			}
			buffer = `${buffer}${decoder.decode(value, { stream: true })}`.replaceAll("\r\n", "\n");
			let frameEnd = buffer.indexOf("\n\n");
			while (frameEnd >= 0) {
				assertAnthropicSsePendingBufferWithinLimit(frameEnd);
				const frame = buffer.slice(0, frameEnd);
				buffer = buffer.slice(frameEnd + 2);
				const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
				if (data && data !== "[DONE]") yield parseAnthropicSseEventData(data);
				frameEnd = buffer.indexOf("\n\n");
			}
			assertAnthropicSsePendingBufferWithinLimit(buffer.length);
		}
		const tailBuffer = `${buffer}${decoder.decode()}`.replaceAll("\r\n", "\n");
		assertAnthropicSsePendingBufferWithinLimit(tailBuffer.length);
		const tail = tailBuffer.trim();
		if (tail) {
			const data = tail.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
			if (data && data !== "[DONE]") yield parseAnthropicSseEventData(data);
		}
	} finally {
		if (!completed) await reader.cancel(signal?.reason).catch(() => void 0);
		reader.releaseLock();
	}
}
function createAnthropicMessagesClient(params) {
	const url = resolveAnthropicMessagesUrl(params.baseURL);
	return { messages: { async stream(body, options) {
		const headers = mergeTransportHeaders({
			"content-type": "application/json",
			"anthropic-version": "2023-06-01",
			...params.apiKey ? { "x-api-key": params.apiKey } : {},
			...params.authToken ? { authorization: `Bearer ${params.authToken}` } : {}
		}, params.defaultHeaders);
		const response = await params.fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: options?.signal
		});
		return {
			response,
			stream: response.body ? parseAnthropicSseBody(response.body, options?.signal) : []
		};
	} } };
}
function formatAnthropicMessagesHttpError(response, detail) {
	const retryAfterSeconds = parseRetryAfterSeconds(response.headers);
	const retryAfterSuffix = Number.isFinite(retryAfterSeconds) ? `; Retry-After: ${Math.ceil(retryAfterSeconds ?? 0)} seconds` : "";
	return `HTTP ${response.status}: ${detail || "Anthropic Messages request failed"}${retryAfterSuffix}`;
}
async function readAnthropicMessagesErrorBodySnippet(response) {
	try {
		return await readResponseTextSnippet(response, {
			maxBytes: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_BYTES,
			maxChars: ANTHROPIC_MESSAGES_ERROR_BODY_MAX_CHARS,
			chunkTimeoutMs: ANTHROPIC_MESSAGES_ERROR_BODY_READ_IDLE_TIMEOUT_MS,
			onIdleTimeout: ({ chunkTimeoutMs }) => /* @__PURE__ */ new Error(`Anthropic Messages error response stalled: no data received for ${chunkTimeoutMs}ms`)
		}) ?? "";
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Anthropic Messages error response stalled:")) return error.message;
		return "";
	}
}
function createAnthropicTransportClient(params) {
	const { model, context, apiKey, options } = params;
	const needsInterleavedBeta = (options?.interleavedThinking ?? true) && !supportsClaudeAdaptiveThinking(model);
	const fetch = isKimiAnthropicProvider(model.provider) && options?.thinkingEnabled === true ? buildGuardedModelFetch(model, void 0, { sanitizeSse: false }) : buildGuardedModelFetch(model);
	if (model.provider === "github-copilot") {
		const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
		return {
			client: createAnthropicMessagesClient({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: mergeTransportHeaders({
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}
				}, model.headers, getAiTransportHost().buildCopilotDynamicHeaders(context.messages), options?.headers),
				fetch
			}),
			isOAuthToken: false
		};
	}
	if (usesFoundryBearerAuth(resolveModelHeaderSentinels$1(model))) {
		const betaFeatures = needsInterleavedBeta ? ["interleaved-thinking-2025-05-14"] : [];
		return {
			client: createAnthropicMessagesClient({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: mergeTransportHeaders({
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}
				}, omitFoundryBearerCredentialHeaders(model.headers), options?.headers),
				fetch
			}),
			isOAuthToken: false
		};
	}
	const betaFeatures = ["fine-grained-tool-streaming-2025-05-14"];
	if (needsInterleavedBeta) betaFeatures.push("interleaved-thinking-2025-05-14");
	if (isAnthropicOAuthApiKey(apiKey)) {
		const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: true });
		return {
			client: createAnthropicMessagesClient({
				apiKey: null,
				authToken: apiKey,
				baseURL: model.baseUrl,
				defaultHeaders: mergeTransportHeaders({
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...betaHeader ? { "anthropic-beta": betaHeader } : {},
					"user-agent": `claude-cli/${ANTHROPIC_CLAUDE_CODE_VERSION}`,
					"x-app": "cli"
				}, model.headers, options?.headers),
				fetch
			}),
			isOAuthToken: true
		};
	}
	if (useAnthropicServerSideFallback(model)) betaFeatures.push(ANTHROPIC_SERVER_SIDE_FALLBACK_BETA);
	const betaHeader = buildAnthropicBetaHeader(model, betaFeatures, { oauth: false });
	return {
		client: createAnthropicMessagesClient({
			apiKey,
			baseURL: model.baseUrl,
			defaultHeaders: mergeTransportHeaders({
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...betaHeader ? { "anthropic-beta": betaHeader } : {}
			}, model.headers, options?.headers),
			fetch
		}),
		isOAuthToken: false
	};
}
async function buildAnthropicParams(model, context, isOAuthToken, options) {
	const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
	const replayThinkingEnabled = mandatoryAdaptiveThinking || options?.thinkingEnabled === true;
	const maxTokens = resolveAnthropicMessagesMaxTokens({
		modelContextWindow: model.contextWindow,
		modelMaxTokens: model.maxTokens,
		requestedMaxTokens: options?.maxTokens
	});
	if (maxTokens === void 0) throw new Error(`Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`);
	const payloadPolicy = resolveAnthropicPayloadPolicy({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		cacheRetention: options?.cacheRetention,
		enableCacheControl: true
	}, model);
	const cacheBreakpointOptOutMessageIndexes = /* @__PURE__ */ new Set();
	const replayPlan = buildAnthropicReplayPlan(context.messages, model, {
		enabled: !isOAuthToken && options?.anthropicServerCompaction === true,
		authProfileId: options?.authProfileId,
		sessionId: options?.sessionId
	});
	const messages = await convertAnthropicMessages(replayPlan.messages, model, isOAuthToken, {
		allowReasoningContentReplay: supportsReasoningContentReplay(model),
		cacheBreakpointOptOutMessageIndexes,
		compaction: replayPlan.compaction,
		replayThinkingEnabled
	});
	const params = {
		model: resolveAnthropicRequestModelId(model),
		messages: ensureNonEmptyAnthropicMessages(messages),
		max_tokens: maxTokens,
		stream: true
	};
	if (!isOAuthToken && useAnthropicServerSideFallback(model)) params.fallbacks = ANTHROPIC_SERVER_SIDE_FALLBACKS;
	if (isOAuthToken) params.system = [
		{
			type: "text",
			text: ANTHROPIC_CLAUDE_CODE_BILLING_SYSTEM_BLOCK
		},
		{
			type: "text",
			text: "You are Claude Code, Anthropic's official CLI for Claude."
		},
		...context.systemPrompt ? [{
			type: "text",
			text: sanitizeTransportPayloadText(context.systemPrompt)
		}] : []
	];
	else if (context.systemPrompt) params.system = [{
		type: "text",
		text: sanitizeTransportPayloadText(context.systemPrompt)
	}];
	if (options?.temperature !== void 0 && !options.thinkingEnabled && !supportsClaudeNativeXhighEffort(model)) params.temperature = options.temperature;
	if (options?.stop !== void 0 && options.stop.length > 0) params.stop_sequences = options.stop;
	let toolProjection;
	if (context.tools) {
		const convertedTools = convertAnthropicTools(context.tools, isOAuthToken);
		toolProjection = convertedTools.projection;
		if (convertedTools.tools.length > 0) params.tools = convertedTools.tools;
	}
	if (mandatoryAdaptiveThinking || model.reasoning || supportsClaudeAdaptiveThinking(model)) {
		if (mandatoryAdaptiveThinking || options?.thinkingEnabled) {
			if (supportsClaudeAdaptiveThinking(model)) {
				params.thinking = {
					type: "adaptive",
					display: options?.thinkingDisplay ?? "summarized"
				};
				const effort = options?.effort ?? (mandatoryAdaptiveThinking ? "high" : void 0);
				if (effort) params.output_config = { effort };
			} else params.thinking = {
				type: "enabled",
				budget_tokens: options?.thinkingBudgetTokens ?? 1024
			};
		} else if (options?.thinkingEnabled === false) params.thinking = { type: "disabled" };
	}
	if (options?.metadata && typeof options.metadata.user_id === "string") params.metadata = { user_id: options.metadata.user_id };
	if (options?.toolChoice) {
		const normalizedToolChoice = normalizeAnthropicToolChoice(replayThinkingEnabled, options.toolChoice);
		const projectedToolChoice = toolProjection ? reconcileAnthropicToolChoice(normalizedToolChoice, toolProjection) : normalizedToolChoice;
		if (projectedToolChoice) params.tool_choice = projectedToolChoice;
	}
	applyAnthropicPayloadPolicyToParams(params, payloadPolicy, cacheBreakpointOptOutMessageIndexes);
	return {
		params,
		toolProjection,
		usedCompactionReplay: replayPlan.compaction !== void 0
	};
}
function resolveAnthropicTransportOptions(model, options, apiKey) {
	const baseMaxTokens = resolveAnthropicMessagesMaxTokens({
		modelContextWindow: model.contextWindow,
		modelMaxTokens: model.maxTokens,
		requestedMaxTokens: options?.maxTokens,
		useModelDefault: resolveClaudeSonnet5ModelIdentity(model) !== void 0 || resolveClaudeOpus5ModelIdentity(model) !== void 0
	});
	if (baseMaxTokens === void 0) throw new Error(`Anthropic Messages transport requires a positive maxTokens value for ${model.provider}/${model.id}`);
	const reasoningModelMaxTokens = resolvePositiveAnthropicTokenLimit(model.maxTokens) ?? baseMaxTokens;
	const mandatoryAdaptiveThinking = requiresClaudeAdaptiveThinking(model);
	const reasoning = options?.reasoning === "off" && mandatoryAdaptiveThinking ? "low" : options?.reasoning;
	const resolved = copyProviderAcceptanceObserver(options, {
		temperature: options?.temperature,
		stop: options?.stop,
		maxTokens: baseMaxTokens,
		signal: options?.signal,
		apiKey,
		cacheRetention: options?.cacheRetention,
		sessionId: options?.sessionId,
		headers: options?.headers,
		onPayload: options?.onPayload,
		onResponse: options?.onResponse,
		maxRetryDelayMs: options?.maxRetryDelayMs,
		metadata: options?.metadata,
		interleavedThinking: options?.interleavedThinking,
		toolChoice: options?.toolChoice,
		thinkingBudgets: options?.thinkingBudgets,
		reasoning,
		...options?.anthropicServerCompaction === true ? { anthropicServerCompaction: true } : {},
		...options?.authProfileId ? { authProfileId: options.authProfileId } : {}
	});
	if (reasoning === "off") {
		resolved.thinkingEnabled = false;
		return resolved;
	}
	if (!reasoning) {
		resolved.thinkingEnabled = defaultsClaudeAdaptiveThinking(model);
		if (resolved.thinkingEnabled) resolved.effort = "high";
		return resolved;
	}
	if (supportsClaudeAdaptiveThinking(model)) {
		resolved.thinkingEnabled = true;
		resolved.effort = resolveAnthropicThinkingEffort(model, reasoning);
		return resolved;
	}
	const adjusted = adjustMaxTokensForThinking(baseMaxTokens, reasoningModelMaxTokens, reasoning === "max" ? "high" : reasoning, options?.thinkingBudgets);
	const thinkingEnabled = adjusted.thinkingBudget >= 1024;
	resolved.maxTokens = adjusted.maxTokens;
	resolved.thinkingEnabled = thinkingEnabled;
	resolved.thinkingBudgetTokens = thinkingEnabled ? adjusted.thinkingBudget : void 0;
	return resolved;
}
/** Create the stream function used by Anthropic Messages transport models. */
function createAnthropicMessagesTransportStreamFn() {
	return (rawModel, context, rawOptions) => {
		const model = withEffectiveAnthropicBaseUrl(rawModel);
		const options = rawOptions;
		const { eventStream, stream } = createWritableTransportEventStream();
		(async () => {
			const output = {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: model.provider,
				model: model.id,
				usage: createEmptyTransportUsage(),
				stopReason: "stop",
				timestamp: Date.now()
			};
			const refusalBuffer = usesClaudeStreamingRefusalContract(model) ? createDeferredEventBuffer(stream, () => notifyLlmRequestActivity(options?.signal)) : void 0;
			const eventSink = refusalBuffer ?? stream;
			let costModel = model;
			let messageStartPromptUsage;
			let usedCompactionReplay = false;
			try {
				const apiKey = options?.apiKey ?? getEnvApiKey(model.provider) ?? "";
				if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
				const transportOptions = resolveAnthropicTransportOptions(model, options, apiKey);
				const requestContext = prepareClaudeNoPrefillRequestContext(model, context);
				const { client, isOAuthToken } = createAnthropicTransportClient({
					model,
					context: requestContext,
					apiKey,
					options: transportOptions
				});
				const builtParams = await buildAnthropicParams(model, requestContext, isOAuthToken, transportOptions);
				usedCompactionReplay = builtParams.usedCompactionReplay;
				let params = builtParams.params;
				const toolProjection = builtParams.toolProjection;
				const nextParams = await transportOptions.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				applyClaudeRequestContract(params, model);
				const { response, stream: anthropicStream } = await client.messages.stream({
					...params,
					stream: true
				}, transportOptions.signal ? { signal: transportOptions.signal } : void 0);
				await notifyProviderHttpResponse({
					options: transportOptions,
					response,
					model
				});
				if (!response.ok) {
					const detail = await readAnthropicMessagesErrorBodySnippet(response);
					throw new Error(formatAnthropicMessagesHttpError(response, detail));
				}
				const blocks = output.content;
				const blockIndexes = /* @__PURE__ */ new Map();
				const toolArgumentPreviewSchedules = /* @__PURE__ */ new WeakMap();
				const sealedToolCalls = [];
				const compactionCapture = createCompactionCapture(output, model, transportOptions);
				const pendingThinkingSignatures = /* @__PURE__ */ new Map();
				const allowReasoningContentReplay = supportsReasoningContentReplay(model);
				const reasoningContentThinkingBlocks = /* @__PURE__ */ new Map();
				const reasoningContentTextBlocks = /* @__PURE__ */ new Map();
				let sawMessageStop = false;
				const pendingTextEnds = [];
				const flushPendingTextEnds = () => {
					for (const event of pendingTextEnds) eventSink.push(event);
					pendingTextEnds.length = 0;
				};
				const eventIndexKey = (eventIndex) => typeof eventIndex === "number" ? eventIndex : -1;
				const appendReasoningContentThinkingDelta = (eventIndex, rawText) => {
					if (typeof rawText !== "string") return false;
					const text = sanitizeTransportPayloadText(rawText);
					if (text.length === 0) return false;
					const key = eventIndexKey(eventIndex);
					let contentIndex = reasoningContentThinkingBlocks.get(key);
					let block = contentIndex === void 0 ? void 0 : output.content[contentIndex];
					if (!block || block.type !== "thinking") {
						block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "reasoning_content"
						};
						output.content.push(block);
						contentIndex = output.content.length - 1;
						reasoningContentThinkingBlocks.set(key, contentIndex);
						eventSink.push({
							type: "thinking_start",
							contentIndex,
							partial: output
						});
					}
					if (contentIndex === void 0) return false;
					block.thinking += text;
					block.thinkingSignature = "reasoning_content";
					eventSink.push({
						type: "thinking_delta",
						contentIndex,
						delta: text,
						partial: output
					});
					return true;
				};
				const appendReasoningContentTextDelta = (eventIndex, rawText) => {
					if (typeof rawText !== "string") return false;
					const text = sanitizeTransportPayloadText(rawText);
					if (text.length === 0) return false;
					const key = eventIndexKey(eventIndex);
					let contentIndex = reasoningContentTextBlocks.get(key);
					let block = contentIndex === void 0 ? void 0 : output.content[contentIndex];
					if (!block || block.type !== "text") {
						block = {
							type: "text",
							text: ""
						};
						output.content.push(block);
						contentIndex = output.content.length - 1;
						reasoningContentTextBlocks.set(key, contentIndex);
						eventSink.push({
							type: "text_start",
							contentIndex,
							partial: output
						});
					}
					if (contentIndex === void 0) return false;
					block.text += text;
					eventSink.push({
						type: "text_delta",
						contentIndex,
						delta: text,
						partial: output
					});
					return true;
				};
				const finishReasoningContentSidecars = (eventIndex) => {
					const key = eventIndexKey(eventIndex);
					const thinkingContentIndex = reasoningContentThinkingBlocks.get(key);
					if (thinkingContentIndex !== void 0) {
						reasoningContentThinkingBlocks.delete(key);
						const block = output.content[thinkingContentIndex];
						if (block?.type === "thinking") eventSink.push({
							type: "thinking_end",
							contentIndex: thinkingContentIndex,
							content: block.thinking,
							partial: output
						});
					}
					const textContentIndex = reasoningContentTextBlocks.get(key);
					if (textContentIndex === void 0) return;
					reasoningContentTextBlocks.delete(key);
					const block = output.content[textContentIndex];
					if (block?.type === "text") eventSink.push({
						type: "text_end",
						contentIndex: textContentIndex,
						content: block.text,
						partial: output
					});
				};
				for await (const event of anthropicStream) {
					if (event.type === "error") {
						const error = event.error;
						throw new Error(error?.message || "Anthropic Messages stream failed");
					}
					if (event.type === "message_start") {
						const message = event.message;
						const usage = message?.usage ?? {};
						output.responseId = typeof message?.id === "string" ? message.id : void 0;
						output.responseModel = typeof message?.model === "string" ? message.model : void 0;
						messageStartPromptUsage = applyAnthropicMessageStartUsage(output.usage, usage);
						calculateCost(costModel, output.usage);
						eventSink.push({
							type: "start",
							partial: output
						});
						continue;
					}
					if (event.type === "message_stop") {
						sawMessageStop = true;
						continue;
					}
					if (event.type === "content_block_start") {
						const contentBlock = event.content_block;
						const index = typeof event.index === "number" ? event.index : -1;
						if (transportOptions.anthropicServerCompaction === true && compactionCapture.begin(index, contentBlock, output.content.length)) continue;
						const fallbackBoundary = refusalBuffer ? readAnthropicFallbackBoundary(contentBlock) : null;
						if (fallbackBoundary) {
							refusalBuffer?.discard();
							sealedToolCalls.length = 0;
							pendingTextEnds.length = 0;
							blockIndexes.clear();
							pendingThinkingSignatures.clear();
							applyAnthropicFallbackBoundary({
								output,
								boundary: fallbackBoundary,
								provider: model.provider
							});
							costModel = {
								...model,
								cost: resolveAnthropicFallbackServingModelCost({
									requestedModelId: model.id,
									servingModelId: fallbackBoundary.toModel,
									requestedCost: model.cost
								})
							};
							calculateCost(costModel, output.usage);
							eventSink.push({
								type: "start",
								partial: output
							});
							for (const [i, block] of output.content.entries()) {
								if (block.type !== "text") continue;
								delete block.index;
								eventSink.push({
									type: "text_start",
									contentIndex: i,
									partial: output
								});
								if (block.text) eventSink.push({
									type: "text_delta",
									contentIndex: i,
									delta: block.text,
									partial: output
								});
								pendingTextEnds.push({
									type: "text_end",
									contentIndex: i,
									content: block.text,
									partial: output
								});
							}
							continue;
						}
						pendingThinkingSignatures.delete(index);
						if (contentBlock?.type === "text") {
							const text = typeof contentBlock.text === "string" ? sanitizeTransportPayloadText(contentBlock.text) : "";
							const block = {
								type: "text",
								text,
								index
							};
							output.content.push(block);
							const contentIndex = output.content.length - 1;
							blockIndexes.set(index, contentIndex);
							eventSink.push({
								type: "text_start",
								contentIndex,
								partial: output
							});
							if (text.length > 0) eventSink.push({
								type: "text_delta",
								contentIndex,
								delta: text,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "thinking") {
							const thinking = typeof contentBlock.thinking === "string" ? contentBlock.thinking : "";
							const block = {
								type: "thinking",
								thinking,
								thinkingSignature: typeof contentBlock.signature === "string" ? contentBlock.signature : "",
								index
							};
							output.content.push(block);
							const contentIndex = output.content.length - 1;
							blockIndexes.set(index, contentIndex);
							eventSink.push({
								type: "thinking_start",
								contentIndex,
								partial: output
							});
							if (thinking.length > 0) eventSink.push({
								type: "thinking_delta",
								contentIndex,
								delta: thinking,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "redacted_thinking") {
							const block = {
								type: "thinking",
								thinking: "[Reasoning redacted]",
								thinkingSignature: typeof contentBlock.data === "string" ? contentBlock.data : "",
								redacted: true,
								index
							};
							output.content.push(block);
							blockIndexes.set(index, output.content.length - 1);
							eventSink.push({
								type: "thinking_start",
								contentIndex: output.content.length - 1,
								partial: output
							});
							continue;
						}
						if (contentBlock?.type === "tool_use") {
							tagPendingCommentaryText(output.content);
							flushPendingTextEnds();
							const block = {
								type: "toolCall",
								id: typeof contentBlock.id === "string" ? contentBlock.id : "",
								name: typeof contentBlock.name === "string" ? isOAuthToken ? resolveOriginalAnthropicToolName(contentBlock.name, toolProjection) : contentBlock.name : "",
								arguments: contentBlock.input && typeof contentBlock.input === "object" ? contentBlock.input : {},
								partialJson: "",
								index
							};
							output.content.push(block);
							blockIndexes.set(index, output.content.length - 1);
							toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
							eventSink.push({
								type: "toolcall_start",
								contentIndex: output.content.length - 1,
								partial: output
							});
						}
						continue;
					}
					if (event.type === "content_block_delta") {
						const delta = event.delta;
						const eventIndex = typeof event.index === "number" ? event.index : void 0;
						if (eventIndex !== void 0 && compactionCapture.delta(eventIndex, delta)) continue;
						let index = eventIndex === void 0 ? void 0 : blockIndexes.get(eventIndex);
						let block = index === void 0 ? void 0 : blocks[index];
						if (allowReasoningContentReplay) {
							const appendedThinking = appendReasoningContentThinkingDelta(event.index, delta?.reasoning_content);
							const hasNativeAnthropicDelta = delta?.type === "text_delta" && typeof delta.text === "string" || delta?.type === "thinking_delta" && typeof delta.thinking === "string" || delta?.type === "input_json_delta" && typeof delta.partial_json === "string" || delta?.type === "signature_delta" && typeof delta.signature === "string";
							let appendedContent = false;
							if (!hasNativeAnthropicDelta && typeof delta?.content === "string" && delta.content.length > 0) {
								const text = sanitizeTransportPayloadText(delta.content);
								if (text.length > 0) {
									if (block?.type === "text" && index !== void 0) {
										block.text += text;
										eventSink.push({
											type: "text_delta",
											contentIndex: index,
											delta: text,
											partial: output
										});
										appendedContent = true;
									} else appendedContent = appendReasoningContentTextDelta(event.index, text);
								}
							}
							if ((appendedThinking || appendedContent) && !hasNativeAnthropicDelta) continue;
						}
						if (!block && delta?.type === "text_delta" && typeof delta.text === "string") {
							block = {
								type: "text",
								text: "",
								index: typeof event.index === "number" ? event.index : blocks.length
							};
							output.content.push(block);
							index = output.content.length - 1;
							if (typeof event.index === "number") blockIndexes.set(event.index, index);
							eventSink.push({
								type: "text_start",
								contentIndex: index,
								partial: output
							});
						}
						if (index === void 0) continue;
						if (block?.type === "text" && delta?.type === "text_delta" && typeof delta.text === "string") {
							block.text += delta.text;
							eventSink.push({
								type: "text_delta",
								contentIndex: index,
								delta: delta.text,
								partial: output
							});
							continue;
						}
						if (block?.type === "thinking" && delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
							block.thinking += delta.thinking;
							eventSink.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: delta.thinking,
								partial: output
							});
							continue;
						}
						if (block?.type === "toolCall" && delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
							const partialJson = `${block.partialJson ?? ""}${delta.partial_json}`;
							block.partialJson = partialJson;
							if (toolArgumentPreviewSchedules.get(block)?.(partialJson.length)) block.arguments = parseAnthropicToolCallArguments(partialJson);
							eventSink.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: delta.partial_json,
								partial: output
							});
							continue;
						}
						if (block?.type === "thinking" && delta?.type === "signature_delta" && typeof delta.signature === "string") {
							const signatureIndex = eventIndexKey(event.index);
							const pendingSignature = pendingThinkingSignatures.get(signatureIndex);
							if (pendingSignature === void 0) {
								block.thinkingSignature = "";
								pendingThinkingSignatures.set(signatureIndex, delta.signature);
							} else pendingThinkingSignatures.set(signatureIndex, pendingSignature + delta.signature);
						}
						continue;
					}
					if (event.type === "content_block_stop") {
						const eventIndex = typeof event.index === "number" ? event.index : void 0;
						if (eventIndex !== void 0 && compactionCapture.complete(eventIndex)) continue;
						const pendingSignature = eventIndex === void 0 ? void 0 : pendingThinkingSignatures.get(eventIndex);
						if (eventIndex !== void 0) pendingThinkingSignatures.delete(eventIndex);
						const index = eventIndex === void 0 ? void 0 : blockIndexes.get(eventIndex);
						const block = index === void 0 ? void 0 : blocks[index];
						if (eventIndex === void 0 || index === void 0 || !block) {
							finishReasoningContentSidecars(event.index);
							continue;
						}
						blockIndexes.delete(eventIndex);
						delete block.index;
						if (block.type === "text") {
							pendingTextEnds.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output
							});
							finishReasoningContentSidecars(event.index);
							continue;
						}
						if (block.type === "thinking") {
							if (pendingSignature !== void 0) block.thinkingSignature = pendingSignature;
							eventSink.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output
							});
							finishReasoningContentSidecars(event.index);
							continue;
						}
						if (block.type === "toolCall") {
							sealedToolCalls.push({
								block,
								contentIndex: index
							});
							finishReasoningContentSidecars(event.index);
						}
						continue;
					}
					if (event.type === "message_delta") {
						const delta = event.delta;
						const usage = event.usage;
						if (delta?.stop_reason) {
							if (delta.stop_reason === "refusal") applyAnthropicRefusal(output, delta.stop_details, model.provider);
							else output.stopReason = mapAnthropicStopReason(delta.stop_reason);
						}
						applyAnthropicMessageDeltaUsage(output.usage, usage, messageStartPromptUsage);
						calculateCost(costModel, output.usage);
						if (output.stopReason === "toolUse" || output.content.some((block) => block.type === "toolCall")) tagPendingCommentaryText(output.content);
						flushPendingTextEnds();
					}
				}
				if (isDirectAnthropicModel(model) && !sawMessageStop) throw new Error("Anthropic stream ended before message_stop");
				if (transportOptions.signal?.aborted) throw transportAbortError(transportOptions.signal);
				if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage ?? "An unknown error occurred");
				if ([...blockIndexes.values()].some((index) => blocks[index]?.type === "toolCall")) throw new Error("Provider completed stream with an incomplete tool call");
				finalizeTerminalToolCallArguments(sealedToolCalls.map(({ block }) => block), (block) => block.partialJson && block.partialJson.length > 0 ? block.partialJson : block.arguments);
				for (const sealed of sealedToolCalls) {
					delete sealed.block.partialJson;
					eventSink.push({
						type: "toolcall_end",
						contentIndex: sealed.contentIndex,
						toolCall: sealed.block,
						partial: output
					});
				}
				refusalBuffer?.flush();
				if (output.stopReason === "toolUse" || output.content.some((block) => block.type === "toolCall")) tagPendingCommentaryText(output.content);
				flushPendingTextEnds();
				finalizeTransportStream({
					stream,
					output
				});
			} catch (error) {
				failTransportStream({
					stream,
					output,
					signal: options?.signal,
					error,
					cleanup: () => {
						if (refusalBuffer) {
							refusalBuffer.discard();
							output.content = [];
						} else output.content = output.content.filter((block) => block.type !== "toolCall");
						if (usedCompactionReplay && isAnthropicReplayRejection(error)) suppressAnthropicCompaction(output, model, options);
						for (const block of output.content) delete block.index;
					}
				});
			}
		})();
		return eventStream;
	};
}
//#endregion
//#region packages/ai/src/transports/model-max-tokens-params.ts
/**
* Max-token parameter normalization across provider/native naming variants.
* Callers canonicalize aliases before dispatch so payloads cannot carry
* conflicting limits.
*/
const MAX_TOKENS_PARAM_KEYS = [
	"maxTokens",
	"max_completion_tokens",
	"max_tokens"
];
/** Resolve the first supported max-token parameter present in a params object. */
function resolveMaxTokensParam(params) {
	if (!params) return;
	for (const key of MAX_TOKENS_PARAM_KEYS) {
		const resolved = asNonNegativeFiniteNumber(params[key]);
		if (resolved !== void 0) return resolved;
	}
}
/**
* Canonicalize merged params to `maxTokens`, preserving source precedence from
* left to right across the provided source objects.
*/
function canonicalizeMaxTokensParam(params) {
	let resolved;
	for (const source of params.sources) {
		const sourceValue = resolveMaxTokensParam(source);
		if (sourceValue !== void 0) resolved = sourceValue;
	}
	if (resolved === void 0) return;
	for (const key of MAX_TOKENS_PARAM_KEYS) delete params.merged[key];
	params.merged.maxTokens = resolved;
}
//#endregion
//#region packages/ai/src/transports/model-transport-url.ts
/**
* Debug formatting helpers for model transport endpoints.
* Keeps logs useful without exposing credentials, request params, or fragments.
*/
/** Return a sanitized URL suitable for logs and diagnostics. */
function formatModelTransportDebugUrl(rawUrl) {
	try {
		const parsed = new URL(rawUrl);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return "<invalid-url>";
	}
}
/** Format a configured base URL for debug output, or the implicit default. */
function formatModelTransportDebugBaseUrl(rawUrl) {
	return rawUrl ? formatModelTransportDebugUrl(rawUrl) : "default";
}
//#endregion
//#region packages/ai/src/transports/openai-compatible-conversation-turn.ts
/**
* OpenAI-compatible conversation turn detector.
*
* Some providers reject requests without a non-empty user/assistant turn; this
* helper checks the loose message payload shape before transport submission.
*/
function hasNonEmptyContentPart(part) {
	if (!part || typeof part !== "object") return false;
	const record = part;
	if (record.type === "text") return hasNonEmptyString(record.text);
	return true;
}
function hasNonEmptyMessageContent(content) {
	if (hasNonEmptyString(content)) return true;
	if (!Array.isArray(content)) return false;
	return content.some(hasNonEmptyContentPart);
}
function hasAssistantToolCall(message) {
	const toolCalls = message.tool_calls;
	return Array.isArray(toolCalls) && toolCalls.some((toolCall) => {
		return Boolean(toolCall && typeof toolCall === "object");
	});
}
/** Returns whether an OpenAI-compatible messages payload contains a usable turn. */
function hasOpenAICompatibleConversationTurn(messages) {
	if (!Array.isArray(messages)) return false;
	return messages.some((message) => {
		if (!message || typeof message !== "object") return false;
		const record = message;
		if (record.role === "user") return hasNonEmptyMessageContent(record.content);
		if (record.role === "assistant") return hasNonEmptyMessageContent(record.content) || hasAssistantToolCall(record);
		return false;
	});
}
//#endregion
//#region packages/ai/src/transports/openai-completions-string-content.ts
/**
* OpenAI Chat Completions compatibility helpers. Some providers only accept
* role/content messages with plain string content instead of text block arrays.
*/
function flattenStringOnlyCompletionContent(content) {
	if (!Array.isArray(content)) return content;
	const textParts = [];
	for (const item of content) {
		if (!item || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") return content;
		textParts.push(item.text);
	}
	return textParts.join("\n");
}
/** Flatten string-only text block content arrays into newline-joined strings. */
function flattenCompletionMessagesToStringContent(messages) {
	return messages.map((message) => {
		if (!message || typeof message !== "object") return message;
		const content = message.content;
		const flattenedContent = flattenStringOnlyCompletionContent(content);
		if (flattenedContent === content) return message;
		return {
			...message,
			content: flattenedContent
		};
	});
}
/** Strip completion messages to role/content fields for strict providers. */
function stripCompletionMessagesToRoleContent(messages) {
	return messages.map((message) => {
		if (!message || typeof message !== "object" || Array.isArray(message)) return message;
		const record = message;
		const stripped = {};
		if (Object.hasOwn(record, "role")) stripped.role = record.role;
		if (Object.hasOwn(record, "content")) stripped.content = record.content;
		return stripped;
	});
}
//#endregion
//#region packages/ai/src/transports/openai-completions-host.ts
/**
* Chat Completions accepts Azure AI Foundry hosts in addition to traditional
* Azure OpenAI hosts. Do not replace this with isTraditionalAzureOpenAIHost,
* which intentionally excludes the .services.ai.azure.com Foundry suffix.
*/
function isAzureOpenAICompatibleHost(hostname) {
	return hostname.endsWith(".openai.azure.com") || hostname.endsWith(".services.ai.azure.com") || hostname.endsWith(".cognitiveservices.azure.com");
}
//#endregion
//#region packages/ai/src/transports/openai-completions-replay.ts
function isGoogleOpenAICompatModel(model) {
	const endpointClass = detectOpenAICompletionsCompat(model).capabilities.endpointClass;
	return model.provider === "google" || endpointClass === "google-generative-ai" || endpointClass === "google-vertex";
}
function requiresGoogleCompatToolCallThoughtSignature(model) {
	return isGoogleGemini3ProModel(model.id) || isGoogleGemini3FlashModel(model.id);
}
const GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE = /[\u2026]|\.\.\./;
const GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE = /^[A-Za-z0-9+/=]+$/;
function hasGoogleCompatThoughtSignatureTruncationFootprint(value) {
	return GOOGLE_COMPAT_THOUGHT_SIGNATURE_ELLIPSIS_RE.test(value) || GOOGLE_COMPAT_THOUGHT_SIGNATURE_BASE64_RE.test(value) && value.length % 4 !== 0;
}
function injectToolCallThoughtSignatures(outgoingMessages, context, model) {
	if (!isGoogleOpenAICompatModel(model)) return;
	const sigById = /* @__PURE__ */ new Map();
	const fallbackSig = requiresGoogleCompatToolCallThoughtSignature(model) ? GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP : void 0;
	for (const msg of context.messages ?? []) {
		if (msg.role !== "assistant") continue;
		const source = msg;
		if (!Array.isArray(source.content)) continue;
		for (const block of source.content) {
			if (block.type !== "toolCall") continue;
			const id = block.id;
			const sig = block.thoughtSignature;
			if (typeof id === "string" && typeof sig === "string" && sig.length > 0) {
				const isSameRoute = source.api === model.api && source.provider === model.provider && source.model === model.id;
				if (!isSameRoute && !fallbackSig) continue;
				sigById.set(id, isSameRoute ? sig : fallbackSig ?? sig);
			}
		}
	}
	if (sigById.size === 0 && !fallbackSig) return;
	for (const message of outgoingMessages) {
		const toolCalls = message.tool_calls;
		if (!Array.isArray(toolCalls)) continue;
		for (const toolCall of toolCalls) {
			const id = toolCall.id;
			if (typeof id !== "string") continue;
			let sig = sigById.get(id) ?? fallbackSig;
			if (typeof sig === "string" && sig.length > 0) {
				if (hasGoogleCompatThoughtSignatureTruncationFootprint(sig.trim())) sig = fallbackSig;
			}
			if (typeof sig !== "string" || sig.length === 0) continue;
			const extra = toolCall.extra_content && typeof toolCall.extra_content === "object" ? toolCall.extra_content : {};
			toolCall.extra_content = extra;
			const google = extra.google && typeof extra.google === "object" ? extra.google : {};
			extra.google = google;
			google.thought_signature = sig;
		}
	}
}
const COMPLETIONS_REASONING_REPLAY_FIELDS = [
	"reasoning_details",
	"reasoning_content",
	"reasoning",
	"reasoning_text"
];
function stripCompletionsReasoningReplayFields(record) {
	for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) if (field in record) delete record[field];
}
function sanitizeOpenRouterReasoningReplayFields(record) {
	const reasoningDetails = record.reasoning_details;
	if (typeof reasoningDetails === "string") {
		if (reasoningDetails.length > 0 && typeof record.reasoning !== "string") record.reasoning = reasoningDetails;
		delete record.reasoning_details;
	} else if (reasoningDetails !== void 0 && !Array.isArray(reasoningDetails)) delete record.reasoning_details;
	if ("reasoning" in record && (typeof record.reasoning !== "string" || record.reasoning === "")) delete record.reasoning;
	if ("reasoning_content" in record && (typeof record.reasoning_content !== "string" || record.reasoning_content === "")) delete record.reasoning_content;
	const reasoningText = record.reasoning_text;
	if (typeof reasoningText === "string" && reasoningText.length > 0 && typeof record.reasoning !== "string" && typeof record.reasoning_content !== "string") record.reasoning = reasoningText;
	if ("reasoning_text" in record) delete record.reasoning_text;
}
function sanitizeReasoningContentReplayFields(record) {
	if ("reasoning_content" in record && typeof record.reasoning_content !== "string") delete record.reasoning_content;
	delete record.reasoning_details;
	delete record.reasoning;
	delete record.reasoning_text;
}
const REASONING_CONTENT_REPLAY_MODEL_IDS = /* @__PURE__ */ new Set([
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"kimi-for-coding",
	"kimi-k2.5",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k2.7-code-highspeed",
	"kimi-k3",
	"kimi-k2-thinking",
	"kimi-k2-thinking-turbo",
	"mimo-v2-pro",
	"mimo-v2-omni",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"mimo-v2.6-pro"
]);
const REASONING_CONTENT_REPLAY_TIER_SUFFIXES = [
	"-free",
	"-paid",
	"-trial"
];
function stripReasoningContentReplayTierSuffix(modelId) {
	for (const suffix of REASONING_CONTENT_REPLAY_TIER_SUFFIXES) if (modelId.length > suffix.length && modelId.endsWith(suffix)) return modelId.slice(0, -suffix.length);
	return modelId;
}
function getReasoningContentReplayModelIdCandidates(modelId) {
	if (typeof modelId !== "string") return [];
	const normalized = modelId.trim().toLowerCase();
	if (!normalized) return [];
	const parts = normalized.split("/").filter(Boolean);
	const finalPart = parts[parts.length - 1] ?? normalized;
	const candidates = [finalPart];
	const colonParts = finalPart.split(":").filter(Boolean);
	if (colonParts.length > 1) candidates.push(colonParts[0] ?? "", colonParts[colonParts.length - 1] ?? "");
	const baseCount = candidates.length;
	for (let index = 0; index < baseCount; index += 1) {
		const candidate = candidates[index];
		if (typeof candidate !== "string") continue;
		const stripped = stripReasoningContentReplayTierSuffix(candidate);
		if (stripped !== candidate) candidates.push(stripped);
	}
	return uniqueStrings(candidates.filter(Boolean));
}
function shouldPreserveReasoningContentReplay(model, compat) {
	if (compat.requiresReasoningContentOnAssistantMessages || compat.thinkingFormat === "deepseek" || compat.thinkingFormat === "zai" || shouldTrustReasoningContentReplayMetadata(model)) return true;
	return getReasoningContentReplayModelIdCandidates(model.id).some((modelId) => REASONING_CONTENT_REPLAY_MODEL_IDS.has(modelId));
}
function shouldPreserveOpenRouterReasoningReplay(model) {
	if (model.provider !== "openrouter") return true;
	const normalizedModelId = model.id.trim().toLowerCase();
	return !(normalizedModelId.startsWith("anthropic/") || normalizedModelId.startsWith("x-ai/"));
}
function shouldTrustReasoningContentReplayMetadata(model) {
	if (!model.reasoning) return false;
	if (model.provider.trim().toLowerCase() === "openai") return false;
	return shouldPreserveOpenRouterReasoningReplay(model);
}
function sanitizeCompletionsReasoningReplayFields(messages, options) {
	if (!Array.isArray(messages)) return;
	for (const msg of messages) {
		if (!msg || typeof msg !== "object") continue;
		const record = msg;
		if (record.role !== "assistant") continue;
		if (options.preserveOpenRouterReasoning) sanitizeOpenRouterReasoningReplayFields(record);
		else if (options.preserveReasoningContent) sanitizeReasoningContentReplayFields(record);
		else stripCompletionsReasoningReplayFields(record);
	}
}
function applyCompletionsReplay(outgoingMessages, context, model, compat) {
	injectToolCallThoughtSignatures(outgoingMessages, context, model);
	sanitizeCompletionsReasoningReplayFields(outgoingMessages, {
		preserveOpenRouterReasoning: compat.thinkingFormat === "openrouter" && shouldPreserveOpenRouterReasoningReplay(model),
		preserveReasoningContent: shouldPreserveReasoningContentReplay(model, compat)
	});
}
//#endregion
//#region packages/ai/src/transports/openai-completions-params.ts
function isKnownOpenAICompletionsEndpoint(model) {
	if (!model.baseUrl.trim()) return true;
	const endpointClass = resolveProviderEndpoint(model).endpointClass;
	if (endpointClass === "openai-public" || endpointClass === "azure-openai") return true;
	try {
		return isAzureOpenAICompatibleHost(new URL(model.baseUrl).hostname.toLowerCase());
	} catch {
		return false;
	}
}
function resolveOpenAICompletionsReasoningEffort(options) {
	return options?.reasoningEffort ?? options?.reasoning ?? "high";
}
function resolveOpenAICompletionsMaxTokens(model, options) {
	if (options?.maxTokens) return {
		maxTokens: options.maxTokens,
		clampToModelMaxTokens: true
	};
	const paramsMaxTokens = resolveMaxTokensParam(model.params);
	if (paramsMaxTokens) return {
		maxTokens: paramsMaxTokens,
		clampToModelMaxTokens: false
	};
	return {
		maxTokens: model.maxTokens,
		clampToModelMaxTokens: false
	};
}
function resolveOpenAICompletionsModelMaxTokens(model) {
	return typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? Math.floor(model.maxTokens) : void 0;
}
const OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN = 1.25;
const OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE = 8e3;
function estimateOpenAICompletionsInputTokens(payload) {
	let adjustedChars = 0;
	adjustedChars += estimateOpenAICompletionsMessagesChars(payload.messages);
	if (Array.isArray(payload.tools) && payload.tools.length > 0) try {
		adjustedChars += estimateStringChars(JSON.stringify(payload.tools));
	} catch {
		adjustedChars += 1024;
	}
	if (payload.response_format !== void 0) try {
		adjustedChars += estimateStringChars(JSON.stringify(payload.response_format));
	} catch {
		adjustedChars += 256;
	}
	return Math.ceil(adjustedChars / 4 * OPENAI_COMPLETIONS_INPUT_TOKEN_SAFETY_MARGIN);
}
function estimateOpenAICompletionsMessagesChars(messages) {
	if (!Array.isArray(messages)) return 0;
	let adjustedChars = 0;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const record = message;
		adjustedChars += estimateOpenAICompletionsContentChars(record.content);
		for (const field of COMPLETIONS_REASONING_REPLAY_FIELDS) adjustedChars += estimateOpenAICompletionsContentChars(record[field]);
		if (record.tool_calls !== void 0) try {
			adjustedChars += estimateStringChars(JSON.stringify(record.tool_calls));
		} catch {
			adjustedChars += 256;
		}
	}
	return adjustedChars;
}
function estimateOpenAICompletionsContentChars(value) {
	if (typeof value === "string") return estimateStringChars(value);
	if (!Array.isArray(value)) return 0;
	let adjustedChars = 0;
	for (const block of value) {
		if (!block || typeof block !== "object") continue;
		const record = block;
		if (record.type === "image_url" || record.type === "input_image") {
			adjustedChars += OPENAI_COMPLETIONS_IMAGE_CHAR_ESTIMATE;
			continue;
		}
		const text = record.text;
		if (typeof text === "string") {
			adjustedChars += estimateStringChars(text);
			continue;
		}
		try {
			adjustedChars += estimateStringChars(JSON.stringify(block));
		} catch {
			adjustedChars += 256;
		}
	}
	return adjustedChars;
}
function resolveOpenAICompletionsEffectiveContextTokens(model) {
	const contextTokens = model.contextTokens;
	if (typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0) return contextTokens;
	return typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0 ? model.contextWindow : void 0;
}
function isQwenOpenAICompletionsThinkingFormat(format) {
	return format === "qwen" || format === "qwen-chat-template";
}
function setQwenChatTemplateThinking(params, enabled) {
	const existing = params.chat_template_kwargs;
	params.chat_template_kwargs = existing && typeof existing === "object" && !Array.isArray(existing) ? {
		...existing,
		enable_thinking: enabled
	} : { enable_thinking: enabled };
}
function applyQwenOpenAICompletionsThinkingParams(params) {
	if (!params.modelReasoning || !isQwenOpenAICompletionsThinkingFormat(params.compatThinkingFormat)) return false;
	const enabled = isOpenAICompletionsThinkingEnabled(params.requestedEffort);
	if (params.compatThinkingFormat === "qwen-chat-template") setQwenChatTemplateThinking(params.payload, enabled);
	else params.payload.enable_thinking = enabled;
	return true;
}
function applyTogetherOpenAICompletionsThinkingParams(params) {
	if (!params.modelReasoning || params.compatThinkingFormat !== "together") return;
	params.payload.reasoning = { enabled: isOpenAICompletionsThinkingEnabled(params.requestedEffort) };
}
function convertTools(tools, compat, model) {
	const projection = projectOpenAITools(tools);
	const strict = resolveOpenAIStrictToolFlagWithDiagnostics(projection, resolveOpenAIStrictToolSetting(model, {
		transport: "stream",
		supportsStrictMode: compat?.supportsStrictMode
	}), {
		transport: "completions",
		model
	});
	return {
		projection,
		tools: sortPromptCacheToolsByName(projection.tools).map((tool) => {
			const functionTool = {
				name: tool.name,
				description: tool.description,
				parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true, model.compat)
			};
			if (strict !== void 0) functionTool.strict = strict;
			return {
				type: "function",
				function: functionTool
			};
		})
	};
}
function buildOpenAICompletionsParams(model, context, options) {
	const compat = getCompat(model);
	const compatDetection = detectOpenAICompletionsCompat(model);
	const completionsContext = context.systemPrompt ? {
		...context,
		systemPrompt: stripSystemPromptCacheBoundary(context.systemPrompt)
	} : context;
	let messages = convertMessages(model, completionsContext, compat);
	applyCompletionsReplay(messages, context, model, compat);
	if (compat.strictMessageKeys) messages = stripCompletionMessagesToRoleContent(messages);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
	const params = {
		model: model.id,
		messages: compat.requiresStringContent ? flattenCompletionMessagesToStringContent(messages) : messages,
		stream: true
	};
	if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };
	if (compat.supportsStore) params.store = false;
	if (compat.supportsPromptCacheKey && promptCacheKey) {
		params.prompt_cache_key = promptCacheKey;
		if (cacheRetention === "long" && compat.supportsLongCacheRetention) params.prompt_cache_retention = "24h";
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	if (options?.topP !== void 0) params.top_p = options.topP;
	const responseFormat = resolveOpenAICompletionsResponseFormat(shouldOmitOllamaCompatResponseFormat({
		provider: model.provider,
		baseUrl: model.baseUrl,
		hasTools: () => Boolean(context.tools?.length)
	}) ? void 0 : options?.responseFormat, compat.supportsJsonSchemaResponseFormat);
	if (responseFormat !== void 0) params.response_format = responseFormat;
	if (options?.frequencyPenalty !== void 0) params.frequency_penalty = options.frequencyPenalty;
	if (options?.presencePenalty !== void 0) params.presence_penalty = options.presencePenalty;
	if (options?.seed !== void 0) params.seed = options.seed;
	if (options?.stop !== void 0 && options.stop.length > 0) params.stop = options.stop;
	if (supportsModelTools(model)) {
		if (context.tools) {
			const converted = convertTools(context.tools, compat, model);
			if (converted.tools.length > 0 || converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0) params.tools = converted.tools;
			else if (hasToolCallHistory(context.messages)) params.tools = [];
			if (options?.toolChoice) {
				const toolChoice = reconcileOpenAICompletionsToolChoice(options.toolChoice, converted.projection);
				if (toolChoice !== void 0) params.tool_choice = toolChoice;
			} else if (compatDetection.capabilities.usesExplicitProxyLikeEndpoint && Array.isArray(params.tools) && params.tools.length > 0) params.tool_choice = "auto";
		} else if (hasToolCallHistory(context.messages)) params.tools = [];
		if (compatDetection.capabilities.usesExplicitProxyLikeEndpoint && Array.isArray(params.tools) && params.tools.length === 0) {
			delete params.tools;
			delete params.tool_choice;
		}
	}
	{
		const maxTokenBudget = resolveOpenAICompletionsMaxTokens(model, options);
		const effectiveMaxTokens = maxTokenBudget.maxTokens;
		const effectiveContextTokens = resolveOpenAICompletionsEffectiveContextTokens(model);
		let clampedMaxTokens = effectiveMaxTokens;
		const modelMaxTokens = resolveOpenAICompletionsModelMaxTokens(model);
		if (maxTokenBudget.clampToModelMaxTokens && clampedMaxTokens !== void 0 && modelMaxTokens !== void 0 && clampedMaxTokens > modelMaxTokens) {
			clampedMaxTokens = modelMaxTokens;
			emitModelTransportDebug(log, `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} modelMaxTokens=${modelMaxTokens}`);
		}
		if (compatDetection.capabilities.usesExplicitProxyLikeEndpoint && clampedMaxTokens !== void 0 && effectiveContextTokens !== void 0) {
			const estimatedInputTokens = estimateOpenAICompletionsInputTokens(params);
			const remainingBudget = Math.max(1, effectiveContextTokens - estimatedInputTokens - 1);
			// completions-overflow-signal-v1: when the estimate leaves no room to answer,
			// clamping max_tokens to 1 made the provider stop with finish_reason=length and
			// one token. That reads as an incomplete turn, not an overflow, so the session
			// never compacted and fell back to a smaller model that overflowed for real
			// (V 2026-09-26..29, deepseek-flash at 484k-900k tokens; the estimate counts a
			// CJK character as 1.25 tokens, about twice DeepSeek's count). Report it as the
			// context overflow it is, so the run compacts and retries.
			const minimumOutput = Math.min(clampedMaxTokens, 4096);
			if (remainingBudget < minimumOutput) throw Object.assign(new Error(`Context overflow: [V_COMPLETIONS_CONTEXT_BUDGET_EXHAUSTED] estimated input ${estimatedInputTokens} tokens leaves ${remainingBudget} of ${effectiveContextTokens} for output; compact the context before retrying.`), { code: "V_COMPLETIONS_CONTEXT_BUDGET_EXHAUSTED" });
			if (clampedMaxTokens > remainingBudget) {
				clampedMaxTokens = remainingBudget;
				emitModelTransportDebug(log, `[completions] clamp_max_tokens provider=${model.provider} api=${model.api} model=${model.id} requested=${effectiveMaxTokens} output=${clampedMaxTokens} effectiveContext=${effectiveContextTokens} estimatedInput=${estimatedInputTokens}`);
			}
		}
		if (clampedMaxTokens) {
			if (compat.maxTokensField === "max_tokens") params.max_tokens = clampedMaxTokens;
			else params.max_completion_tokens = clampedMaxTokens;
		}
	}
	const completionsReasoningEffort = resolveOpenAICompletionsReasoningEffort(options);
	const resolvedCompletionsReasoningEffort = completionsReasoningEffort ? resolveOpenAIReasoningEffortForModel({
		model,
		effort: completionsReasoningEffort,
		fallbackMap: compat.reasoningEffortMap
	}) : void 0;
	const omitChatCompletionsToolReasoningEffort = Array.isArray(params.tools) && params.tools.length > 0 && (isOpenAIGpt54MiniModel(model) || isOpenAIGpt55Model(model) && isKnownOpenAICompletionsEndpoint(model));
	const disableChatCompletionsToolReasoning = Array.isArray(params.tools) && params.tools.length > 0 && isOpenAIGpt56Model(model) && isKnownOpenAICompletionsEndpoint(model);
	const handledQwenThinkingFormat = applyQwenOpenAICompletionsThinkingParams({
		compatThinkingFormat: compat.thinkingFormat,
		modelReasoning: model.reasoning,
		payload: params,
		requestedEffort: completionsReasoningEffort
	});
	applyTogetherOpenAICompletionsThinkingParams({
		compatThinkingFormat: compat.thinkingFormat,
		modelReasoning: model.reasoning,
		payload: params,
		requestedEffort: completionsReasoningEffort
	});
	if (disableChatCompletionsToolReasoning) params.reasoning_effort = "none";
	else if (compat.thinkingFormat === "openrouter" && model.reasoning && resolvedCompletionsReasoningEffort) params.reasoning = { effort: resolvedCompletionsReasoningEffort };
	else if (resolvedCompletionsReasoningEffort && model.reasoning && compat.supportsReasoningEffort && !handledQwenThinkingFormat && !omitChatCompletionsToolReasoningEffort) params.reasoning_effort = resolvedCompletionsReasoningEffort;
	return params;
}
//#endregion
//#region packages/ai/src/transports/openai-completions-transport.ts
function assertOpenAICompletionsPayloadHasConversationTurn(params, model) {
	const messages = params.messages;
	if (!Array.isArray(messages) || hasOpenAICompatibleConversationTurn(messages)) return;
	throw new Error(`OpenAI-compatible chat payload for ${model.provider}/${model.id} contains no non-empty user or assistant messages after compaction and transport transforms; refusing to send a system/tool-only request. Start a new user turn or repair the compacted session history.`);
}
const SSE_DONE_LINE_RE = /^data:[ \t]*\[DONE\][ \t]*$/i;
const SSE_DONE_MAX_LINE_CHARS = 1024;
function createSseDoneDetector() {
	const decoder = new TextDecoder();
	let line = "";
	let lineOverflowed = false;
	let sawDone = false;
	const finishLine = () => {
		if (!lineOverflowed && SSE_DONE_LINE_RE.test(line)) sawDone = true;
		line = "";
		lineOverflowed = false;
	};
	const observeText = (text) => {
		for (const char of text) {
			if (char === "\n" || char === "\r") {
				finishLine();
				continue;
			}
			if (!lineOverflowed && line.length < SSE_DONE_MAX_LINE_CHARS) line += char;
			else lineOverflowed = true;
		}
	};
	return {
		observe(chunk) {
			if (!sawDone) observeText(decoder.decode(chunk, { stream: true }));
		},
		finish() {
			if (sawDone) return;
			observeText(decoder.decode());
			if (line || lineOverflowed) finishLine();
		},
		sawDone: () => sawDone
	};
}
function createOpenAICompletionsClient(model, context, apiKey, optionHeaders, opts) {
	const clientConfig = buildOpenAICompletionsClientConfig(model, context, optionHeaders);
	return new OpenAI({
		apiKey,
		baseURL: clientConfig.baseURL,
		dangerouslyAllowBrowser: true,
		defaultHeaders: clientConfig.defaultHeaders,
		defaultQuery: clientConfig.defaultQuery,
		fetch: opts?.fetch ?? buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	});
}
function buildOpenAICompletionsClientConfig(model, context, optionHeaders) {
	const headers = buildOpenAIClientHeaders(model, context, optionHeaders);
	const defaultQuery = {};
	let baseURL = model.baseUrl;
	let isAzureHost = false;
	try {
		const parsed = new URL(model.baseUrl);
		isAzureHost = isAzureOpenAICompatibleHost(parsed.hostname.toLowerCase());
		parsed.searchParams.forEach((value, key) => {
			if (value) defaultQuery[key] = value;
		});
		parsed.search = "";
		baseURL = parsed.toString().replace(/\/$/, "");
	} catch {}
	if (isAzureHost) {
		const apiVersionHeader = Object.keys(headers).find((key) => key.toLowerCase() === "api-version");
		if (apiVersionHeader) {
			const apiVersion = headers[apiVersionHeader]?.trim();
			delete headers[apiVersionHeader];
			if (apiVersion && !defaultQuery["api-version"]) defaultQuery["api-version"] = apiVersion;
		}
	}
	return {
		baseURL: resolveOpenAIClientBaseUrl(model, baseURL),
		defaultHeaders: headers,
		defaultQuery: Object.keys(defaultQuery).length > 0 ? defaultQuery : void 0
	};
}
function createOpenAICompletionsTransportStreamFn() {
	return (model, context, options) => {
		const { eventStream, stream } = createWritableTransportEventStream();
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
			let firstEventAbort;
			try {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
				const doneDetector = createSseDoneDetector();
				const baseFetch = buildGuardedModelFetch(model);
				const doneDetectingFetch = async (url, init) => {
					const response = await baseFetch(url, init);
					if (!response.body || !response.ok) return response;
					if (typeof TransformStream === "undefined" || !response.body.pipeThrough) return response;
					const transformed = response.body.pipeThrough(new TransformStream({
						transform(chunk, controller) {
							doneDetector.observe(chunk);
							controller.enqueue(chunk);
						},
						flush() {
							doneDetector.finish();
						}
					}));
					return new Response(transformed, {
						headers: response.headers,
						status: response.status,
						statusText: response.statusText
					});
				};
				const client = createOpenAICompletionsClient(model, context, apiKey, options?.headers, { fetch: doneDetectingFetch });
				let params = buildOpenAICompletionsParams(model, context, options);
				const nextParams = await options?.onPayload?.(params, model);
				if (nextParams !== void 0) params = nextParams;
				if (options?.openclawCodeModeToolSurface === true) {
					const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
					enforceCodeModeResponsesToolSurface(params, visibleToolNames, void 0, codeModeToolSurfaceObserver.get(options));
					assertCodeModeResponsesToolSurface(params, visibleToolNames);
				}
				if (getCompat(model).requiresNonEmptyUserOrAssistantMessage) assertOpenAICompletionsPayloadHasConversationTurn(params, model);
				params = applyDeepSeekOutputBudget(params, model, context);
				const emitReasoning = shouldEmitOpenAICompletionsReasoning(model, options);
				firstEventAbort = createFirstStreamEventAbortController(options?.signal);
				const { data: responseStream, response } = await client.chat.completions.create(params, buildOpenAISdkRequestOptions(model, firstEventAbort.signal, { timeoutMs: options?.timeoutMs })).withResponse();
				const hookedResponseStream = withProviderResponseHook({
					stream: responseStream,
					signal: firstEventAbort.signal,
					abort: firstEventAbort.abort,
					hook: createOpenAIProviderAcceptanceHook(options, response, model),
					onReady: () => stream.push({
						type: "start",
						partial: output
					})
				});
				await processCompletionsStream(hookedResponseStream, output, model, stream, {
					signal: options?.signal,
					emitReasoning,
					strictReasoningTags: reasoningTagTextPolicy.isStrict(options),
					firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
					abortFirstEventStream: firstEventAbort.abort,
					onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
					sawStreamDONE: doneDetector.sawDone
				});
				finalizeTransportStream({
					stream,
					output,
					signal: options?.signal
				});
			} catch (error) {
				failTransportStream({
					stream,
					output,
					signal: options?.signal,
					error,
					cleanup: () => {
						output.stopReason = options?.signal?.aborted ? "aborted" : "error";
						finalizeOpenAICompletionsToolCalls(output, { allowSilentToolCallPromotion: false });
						tagUnresolvedTextAsCommentary(output);
					}
				});
			} finally {
				firstEventAbort?.dispose();
			}
		})();
		return eventStream;
	};
}
//#endregion
//#region packages/ai/src/transports/openai-responses-compact-request.ts
const COMPACT_REQUEST = Symbol("openaiResponsesCompactRequest");
function claimResponsesCompactRequest(options) {
	const controller = options ? Reflect.get(options, COMPACT_REQUEST) : void 0;
	if (controller?.claimed === false) {
		controller.claimed = true;
		return controller;
	}
}
/** Run a compact-endpoint request through the session's prepared stream stack. */
async function requestPreparedOpenAIResponsesCompaction(streamFn, model, context, options) {
	const preparedOptions = { ...options };
	let resolveResult;
	let rejectResult;
	const result = new Promise((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	const controller = {
		claimed: false,
		resolve: resolveResult,
		reject: rejectResult
	};
	Reflect.set(preparedOptions, COMPACT_REQUEST, controller);
	const stream = await Promise.resolve(streamFn(model, context, preparedOptions));
	if (!controller.claimed) throw new Error("Prepared stream did not reach an OpenAI Responses transport");
	try {
		return await result;
	} finally {
		await stream.result().catch(() => void 0);
	}
}
//#endregion
//#region packages/ai/src/transports/openai-responses-continuation.ts
const HTTP_CONTINUATION_IDLE_TTL_MS = 3e5;
const TURN_HEADERS = /* @__PURE__ */ new Set([
	"traceparent",
	"x-openclaw-turn-id",
	"x-openclaw-turn-attempt"
]);
function jsonValuesEqual(left, right) {
	return stableStringify(JSON.parse(JSON.stringify(left))) === stableStringify(JSON.parse(JSON.stringify(right)));
}
function requestWithoutInput(request) {
	const { input: _input, previous_response_id: _previousResponseId, instructions: _instructions, tools: _tools, ...rest } = request;
	if (!isRecord(rest.metadata)) return rest;
	const metadata = Object.fromEntries(Object.entries(rest.metadata).filter(([key]) => key !== "openclaw_turn_id" && key !== "openclaw_turn_attempt"));
	return {
		...rest,
		metadata
	};
}
function normalizeAssistantReplayInput(input, fromResponse = false) {
	return input.map((item) => {
		if (!isRecord(item)) return item;
		if (item.type === "reasoning") return { type: "reasoning" };
		if (item.type !== "function_call" && !(item.type === "message" && item.role === "assistant")) return item;
		const { id: _id, status: _status, ...stableItem } = item;
		if (fromResponse && item.type === "function_call") {
			const args = parseJsonObjectPreservingUnsafeIntegers(stableItem.arguments);
			stableItem.arguments = args ? JSON.stringify(args) : stableItem.arguments;
		}
		if (item.type === "message" && Array.isArray(stableItem.content)) stableItem.content = stableItem.content.map((part) => {
			if (!isRecord(part) || part.type !== "output_text") return part;
			const { annotations: _annotations, logprobs: _logprobs, ...stablePart } = part;
			return stablePart;
		});
		return stableItem;
	});
}
function resolveResponsesContinuationRequest(continuation, request) {
	if (!continuation) return {
		request,
		continuationStatus: "no_previous_response"
	};
	if (request.previous_response_id) return {
		request,
		continuationStatus: "explicit_previous_response_id"
	};
	if (!jsonValuesEqual(requestWithoutInput(request), requestWithoutInput(continuation.lastRequest))) return {
		request,
		continuationStatus: "request_changed"
	};
	const currentInput = request.input ?? [];
	const previousInput = continuation.lastRequest.input ?? [];
	const baselineLength = previousInput.length + continuation.lastResponseItems.length;
	if (currentInput.length < baselineLength) return {
		request,
		continuationStatus: "history_shorter"
	};
	if (!jsonValuesEqual(normalizeAssistantReplayInput(currentInput.slice(0, previousInput.length)), normalizeAssistantReplayInput(previousInput)) || !jsonValuesEqual(normalizeAssistantReplayInput(currentInput.slice(previousInput.length, baselineLength)), normalizeAssistantReplayInput(continuation.lastResponseItems, true))) return {
		request,
		continuationStatus: "history_changed"
	};
	return {
		request: {
			...request,
			previous_response_id: continuation.lastResponseId,
			input: currentInput.slice(baselineLength)
		},
		continuationStatus: "continued"
	};
}
const httpContinuationEntries = /* @__PURE__ */ new Map();
let nextHttpContinuationGeneration = 1;
function connectionIdentity(params) {
	const headers = Object.entries(resolveAiTransportHeaderSentinels(params.headers) ?? {}).map(([name, value]) => [name.toLowerCase(), value]).filter(([name]) => !TURN_HEADERS.has(name)).toSorted(([a], [b]) => a.localeCompare(b));
	return sha256Hex(JSON.stringify([
		getAiTransportHost().resolveSecretSentinel(params.apiKey),
		params.baseUrl,
		headers
	]));
}
function claimOpenAIResponsesHttpContinuation(params) {
	const key = `${params.sessionId}\0${connectionIdentity(params)}`;
	const previous = httpContinuationEntries.get(key);
	if (previous?.kind === "claimed") return;
	if (previous?.kind === "ready") clearTimeout(previous.idleTimer);
	const generation = nextHttpContinuationGeneration++;
	const claimed = {
		kind: "claimed",
		sessionId: params.sessionId,
		generation
	};
	httpContinuationEntries.set(key, claimed);
	return {
		request: resolveResponsesContinuationRequest(previous?.kind === "ready" ? previous.state : void 0, params.request).request,
		commit: (effectiveRequest, response) => {
			if (httpContinuationEntries.get(key) !== claimed) return;
			const idleTimer = setTimeout(() => {
				const current = httpContinuationEntries.get(key);
				if (current?.kind === "ready" && current.generation === generation) httpContinuationEntries.delete(key);
			}, HTTP_CONTINUATION_IDLE_TTL_MS);
			idleTimer.unref?.();
			const ready = {
				...claimed,
				kind: "ready",
				state: {
					lastRequest: effectiveRequest,
					lastResponseId: response.id,
					lastResponseItems: response.output
				},
				idleTimer
			};
			httpContinuationEntries.set(key, ready);
		},
		release: () => {
			if (httpContinuationEntries.get(key) === claimed) httpContinuationEntries.delete(key);
		}
	};
}
registerSessionResourceCleanup((sessionId) => {
	for (const [key, entry] of httpContinuationEntries) if (!sessionId || entry.sessionId === sessionId) {
		if (entry.kind === "ready") clearTimeout(entry.idleTimer);
		httpContinuationEntries.delete(key);
	}
});
//#endregion
//#region packages/ai/src/transports/openai-responses-params-internal.ts
const OPENAI_RESPONSES_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set([
	"openai",
	"opencode",
	"azure-openai-responses",
	"github-copilot"
]);
function convertResponsesTools(tools, model, options) {
	const projection = projectOpenAITools(tools);
	const strict = resolveOpenAIStrictToolFlagWithDiagnostics(projection, options?.strict, {
		transport: "responses",
		model
	});
	return {
		projection,
		tools: sortPromptCacheToolsByName(projection.tools).map((tool) => {
			const result = {
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: normalizeOpenAIStrictToolParameters(tool.parameters, strict === true, model.compat)
			};
			if (strict !== void 0) result.strict = strict;
			return result;
		})
	};
}
function getPromptCacheRetention(baseUrl, cacheRetention) {
	if (cacheRetention !== "long") return;
	return baseUrl?.includes("api.openai.com") ? "24h" : void 0;
}
function resolveOpenAIReasoningEffort(options) {
	return normalizeOpenAIReasoningEffort(options?.reasoningEffort ?? options?.reasoning ?? "high");
}
function hasResponsesWebSearchTool(tools) {
	if (!Array.isArray(tools)) return false;
	return tools.some((tool) => {
		if (!isRecord(tool)) return false;
		if (tool.type === "web_search") return true;
		if (tool.type === "function" && tool.name === "web_search") return true;
		const fn = tool.function;
		return isRecord(fn) && fn.name === "web_search";
	});
}
function raiseMinimalReasoningForResponsesWebSearch(params) {
	if (params.effort !== "minimal" || !hasResponsesWebSearchTool(params.tools)) return params.effort;
	for (const effort of [
		"low",
		"medium",
		"high"
	]) {
		const resolved = resolveOpenAIReasoningEffortForModel({
			model: params.model,
			effort
		});
		if (resolved && resolved !== "none" && resolved !== "minimal") return resolved;
	}
	return params.effort;
}
const OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS = [
	"max_output_tokens",
	"metadata",
	"prompt_cache_retention",
	"service_tier",
	"temperature",
	"top_p"
];
function stripOpenAICodexResponsesUnsupportedTextFields(params) {
	const text = params.text;
	if (!text || typeof text !== "object" || Array.isArray(text)) return;
	const sanitizedText = { ...text };
	delete sanitizedText.format;
	if (Object.keys(sanitizedText).length > 0) params.text = sanitizedText;
	else delete params.text;
}
function sanitizeOpenAICodexResponsesParams(model, params) {
	if (!usesNativeOpenAICodexResponsesBackend(model)) return params;
	for (const key of OPENAI_CODEX_RESPONSES_UNSUPPORTED_PARAMS) delete params[key];
	stripOpenAICodexResponsesUnsupportedTextFields(params);
	return params;
}
function buildOpenAIResponsesInstructionsText(context) {
	if (!context.systemPrompt) return;
	return sanitizeTransportPayloadText(stripSystemPromptCacheBoundary(context.systemPrompt));
}
function resolveOpenAIResponsesInstructions(model, context, usesInstructionsField) {
	if (!usesInstructionsField) return;
	const instructions = buildOpenAIResponsesInstructionsText(context);
	if (instructions && instructions.trim().length > 0) return instructions;
	return usesNativeOpenAICodexResponsesBackend(model) ? OPENAI_CODEX_RESPONSES_DEFAULT_INSTRUCTIONS : void 0;
}
function buildOpenAIResponsesCompactSystemMessage(model, instructions) {
	const compat = getCompat(model);
	const supportsDeveloperRole = typeof compat.supportsDeveloperRole === "boolean" ? compat.supportsDeveloperRole : void 0;
	const role = model.reasoning && supportsDeveloperRole !== false ? "developer" : "system";
	return buildResponsesInputMessage(role, [{
		type: "input_text",
		text: instructions
	}]);
}
function ensureOpenAIResponsesNonEmptyInput(messages, context) {
	if (messages.length > 0 || !context.systemPrompt) return;
	if (!buildOpenAIResponsesInstructionsText(context)) throw new Error("OpenAI Responses requires non-empty input when only systemPrompt is provided.");
	messages.push(buildResponsesInputMessage("user", [{
		type: "input_text",
		text: " "
	}]));
}
function resolveOpenAIResponsesTextFormat(responseFormat) {
	if (responseFormat.type === "json_schema" && responseFormat.json_schema && typeof responseFormat.json_schema === "object" && !Array.isArray(responseFormat.json_schema)) return {
		...responseFormat.json_schema,
		type: "json_schema"
	};
	return responseFormat;
}
function convertOpenAIResponsesMessagesForRequest(model, context, options, replayMode) {
	const isNativeCodexResponses = usesNativeOpenAICodexResponsesBackend(model);
	const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" });
	const policyAllowsReplayIds = payloadPolicy.explicitStore !== false && !payloadPolicy.shouldStripStore;
	const replayResponsesItemIds = !isNativeCodexResponses && (options?.replayResponsesItemIds ?? policyAllowsReplayIds);
	return convertResponsesMessages(model, context, OPENAI_RESPONSES_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: !payloadPolicy.usesInstructionsField,
		replayReasoningItems: true,
		replayResponsesItemIds,
		authProfileId: options?.authProfileId,
		sessionId: options?.sessionId,
		replayMode
	});
}
function buildOpenAIResponsesParams(model, context, options, metadata, replayMode = "checkpoint") {
	const payloadPolicy = resolveOpenAIResponsesPayloadPolicy(model, { storeMode: "disable" });
	const messages = convertOpenAIResponsesMessagesForRequest(model, context, options, replayMode);
	ensureOpenAIResponsesNonEmptyInput(messages, context);
	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = resolvePromptCacheKey(options, cacheRetention);
	const instructions = resolveOpenAIResponsesInstructions(model, context, payloadPolicy.usesInstructionsField);
	const params = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: getPromptCacheRetention(model.baseUrl, cacheRetention),
		...instructions ? { instructions } : {},
		...metadata ? { metadata } : {}
	};
	const effectiveMaxTokens = options?.maxTokens || model.maxTokens;
	if (effectiveMaxTokens) params.max_output_tokens = effectiveMaxTokens;
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	if (options?.topP !== void 0) params.top_p = options.topP;
	if (options?.responseFormat !== void 0) params.text = {
		...params.text,
		format: resolveOpenAIResponsesTextFormat(options.responseFormat)
	};
	if (options?.serviceTier !== void 0 && payloadPolicy.allowsServiceTier) params.service_tier = options.serviceTier;
	if (context.tools) {
		const converted = convertResponsesTools(context.tools, model, { strict: resolveOpenAIStrictToolSetting(model, { transport: "stream" }) });
		if (converted.tools.length > 0 || converted.projection.inputToolCount === 0 && converted.projection.diagnostics.length === 0) params.tools = converted.tools;
		if (options?.toolChoice) {
			const toolChoice = reconcileOpenAIResponsesToolChoice(options.toolChoice, converted.projection);
			if (toolChoice !== void 0) params.tool_choice = toolChoice;
		}
	}
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoning || options?.reasoningSummary) {
			const requestedReasoningEffort = resolveOpenAIReasoningEffort(options);
			const resolvedReasoningEffort = resolveOpenAIReasoningEffortForModel({
				model,
				effort: requestedReasoningEffort
			});
			const reasoningEffort = resolvedReasoningEffort ? raiseMinimalReasoningForResponsesWebSearch({
				model,
				effort: resolvedReasoningEffort,
				tools: params.tools
			}) : void 0;
			if (reasoningEffort) {
				params.reasoning = {
					effort: reasoningEffort,
					...reasoningEffort === "none" ? {} : { summary: options?.reasoningSummary || "auto" }
				};
				if (reasoningEffort !== "none") params.include = ["reasoning.encrypted_content"];
			}
		} else if (model.provider !== "github-copilot") {
			const reasoningEffort = resolveOpenAIReasoningEffortForModel({
				model,
				effort: "none"
			});
			if (reasoningEffort) params.reasoning = { effort: reasoningEffort };
		}
	}
	applyOpenAIResponsesPayloadPolicy(params, payloadPolicy);
	return sanitizeOpenAICodexResponsesParams(model, params);
}
//#endregion
//#region packages/ai/src/transports/openai-responses-websocket.ts
const SESSION_WEBSOCKET_CACHE_TTL_MS = 3e5;
const SESSION_WEBSOCKET_MAX_AGE_MS = 33e5;
const WEBSOCKET_OPEN_STATE = 1;
const websocketSessionCache = /* @__PURE__ */ new Map();
const degradedWebSocketConnections = /* @__PURE__ */ new Map();
function isOfficialOpenAIResponsesBaseUrl(baseUrl) {
	if (!baseUrl) return false;
	try {
		const url = new URL(baseUrl);
		return url.origin === "https://api.openai.com" && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && url.pathname.replace(/\/+$/, "") === "/v1";
	} catch {
		return false;
	}
}
function supportsNativeOpenAIResponsesEndpoint(params) {
	return params.provider.trim().toLowerCase() === "openai" && params.api === "openai-responses" && isOfficialOpenAIResponsesBaseUrl(params.baseUrl);
}
function closeWebSocketSilently(socket, reason = "done") {
	try {
		socket.close({
			code: 1e3,
			reason
		});
	} catch {}
}
function invalidateOwnedWebSocketSession(cacheKey, entry, reason = "done") {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
		entry.idleTimer = void 0;
	}
	closeWebSocketSilently(entry.socket, reason);
	if (websocketSessionCache.get(cacheKey) === entry) websocketSessionCache.delete(cacheKey);
}
function scheduleSessionWebSocketExpiry(cacheKey, entry) {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		invalidateOwnedWebSocketSession(cacheKey, entry, "idle_timeout");
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
	entry.idleTimer.unref?.();
}
function prepareWebSocketConnection(client, headers) {
	if (!isOfficialOpenAIResponsesBaseUrl(client.baseURL)) throw new Error("OpenAI Responses WebSocket requires the official API endpoint");
	if (typeof client.apiKey !== "string" || client.apiKey.length === 0) throw new Error("OpenAI Responses WebSocket requires an API key");
	const resolvedApiKey = getAiTransportHost().resolveSecretSentinel(client.apiKey);
	const resolvedHeaders = { ...resolveAiTransportHeaderSentinels(headers) };
	for (const key of Object.keys(resolvedHeaders)) {
		const normalizedKey = key.toLowerCase();
		if (normalizedKey === "authorization" || normalizedKey === "traceparent") delete resolvedHeaders[key];
	}
	if (!resolvedApiKey) throw new Error("OpenAI Responses WebSocket requires a resolved API key");
	return {
		client: client.withOptions({ apiKey: resolvedApiKey }),
		headers: resolvedHeaders,
		identity: sha256Hex(JSON.stringify([
			resolvedApiKey,
			client.baseURL,
			Object.entries(resolvedHeaders).toSorted(([a], [b]) => a.localeCompare(b))
		]))
	};
}
function createWebSocket(connection, onError) {
	const socket = new ResponsesWS(connection.client, {
		headers: connection.headers,
		maxQueueSize: 1
	});
	socket.on("error", () => onError(socket));
	return socket;
}
function createTransientWebSocketLease(connection) {
	const socket = createWebSocket(connection, (failedSocket) => closeWebSocketSilently(failedSocket, "transport_error"));
	return {
		socket,
		iterator: socket.stream(),
		reusedConnection: false,
		release: () => closeWebSocketSilently(socket)
	};
}
function createCachedWebSocketLease(cacheKey, entry, reusedConnection) {
	entry.busy = true;
	return {
		socket: entry.socket,
		iterator: entry.socket.stream(),
		entry,
		reusedConnection,
		release: ({ keep } = {}) => {
			if (!keep || entry.socket.socket.readyState !== WEBSOCKET_OPEN_STATE) {
				invalidateOwnedWebSocketSession(cacheKey, entry);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(cacheKey, entry);
		}
	};
}
function acquireWebSocket(params, connection) {
	if (!(params.mode !== "websocket" && Boolean(params.sessionId)) || !params.sessionId) return createTransientWebSocketLease(connection);
	const cacheKey = `${params.sessionId}\0${connection.identity}`;
	const cached = websocketSessionCache.get(cacheKey);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = void 0;
		}
		if (cached.busy) return createTransientWebSocketLease(connection);
		const expired = Date.now() - cached.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
		if (!expired && cached.socket.socket.readyState === WEBSOCKET_OPEN_STATE) return createCachedWebSocketLease(cacheKey, cached, true);
		invalidateOwnedWebSocketSession(cacheKey, cached, expired ? "connection_age_limit" : "done");
	}
	const entry = {
		socket: createWebSocket(connection, (failedSocket) => {
			const failedEntry = websocketSessionCache.get(cacheKey);
			if (failedEntry?.socket === failedSocket) invalidateOwnedWebSocketSession(cacheKey, failedEntry, "transport_error");
			else closeWebSocketSilently(failedSocket, "transport_error");
		}),
		sessionId: params.sessionId,
		busy: true,
		createdAt: Date.now()
	};
	websocketSessionCache.set(cacheKey, entry);
	return createCachedWebSocketLease(cacheKey, entry, false);
}
function sanitizeWebSocketRequest(request) {
	const { stream: _stream, background: _background, ...websocketRequest } = request;
	return websocketRequest;
}
async function nextWebSocketMessage(iterator, signal) {
	if (!signal) return iterator.next();
	if (signal.aborted) throw transportAbortError(signal);
	let onAbort;
	try {
		return await Promise.race([iterator.next(), new Promise((_resolve, reject) => {
			onAbort = () => reject(transportAbortError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
		})]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
function readServerEvent(message) {
	if (message.type === "message") return message.message;
	if (message.type === "error") throw parseOpenAIResponsesWebSocketServerError(message.error) ?? new Error("OpenAI Responses WebSocket transport failed", { cause: message.error });
	if (message.type === "close") throw new Error(`OpenAI Responses WebSocket closed before completion (code ${message.code})`);
}
function createOpenAIResponsesWebSocketStream(params) {
	const connection = prepareWebSocketConnection(params.client, params.headers);
	const fullRequest = sanitizeWebSocketRequest(params.request);
	const requestModel = typeof fullRequest.model === "string" ? fullRequest.model : "";
	const degradationKey = `${params.sessionId ?? ""}\0${connection.identity}\0${requestModel}`;
	const degraded = degradedWebSocketConnections.get(degradationKey);
	if (degraded && degraded.retryAt > Date.now()) throw new OpenAIResponsesWebSocketPreDispatchError(/* @__PURE__ */ new Error("OpenAI Responses WebSocket is cooling down after a transport failure"));
	degradedWebSocketConnections.delete(degradationKey);
	const markDegraded = () => {
		const cooldownMs = params.degradeCooldownMs;
		if (cooldownMs === void 0 || !Number.isFinite(cooldownMs) || cooldownMs <= 0) return;
		degradedWebSocketConnections.set(degradationKey, {
			sessionId: params.sessionId,
			retryAt: Date.now() + cooldownMs
		});
	};
	let lease;
	try {
		lease = acquireWebSocket(params, connection);
	} catch (error) {
		markDegraded();
		throw new OpenAIResponsesWebSocketPreDispatchError(error);
	}
	let prepared;
	try {
		const continuation = lease.entry?.continuation;
		if (continuation && lease.entry) {
			lease.entry.continuation = void 0;
			prepared = resolveResponsesContinuationRequest(continuation, fullRequest);
		} else prepared = {
			request: fullRequest,
			continuationStatus: lease.entry ? "no_previous_response" : "socket_not_cached"
		};
	} catch (error) {
		lease.iterator.return?.().catch(() => void 0);
		lease.release({ keep: false });
		throw error;
	}
	let streamStarted = false;
	let terminalResponse;
	let terminalReceived = false;
	let released = false;
	const finish = ({ keep = true } = {}) => {
		if (released) return;
		released = true;
		if (keep && lease.entry && terminalResponse) lease.entry.continuation = {
			lastRequest: fullRequest,
			lastResponseId: terminalResponse.id,
			lastResponseItems: terminalResponse.output
		};
		lease.release({ keep });
	};
	return {
		stream: { async *[Symbol.asyncIterator]() {
			if (streamStarted) throw new Error("OpenAI Responses WebSocket stream can only be consumed once");
			streamStarted = true;
			const iterator = lease.iterator;
			let requestDispatched = false;
			try {
				if (params.signal?.aborted) throw transportAbortError(params.signal);
				for (;;) {
					const next = await nextWebSocketMessage(iterator, params.signal);
					if (next.done) throw new Error("OpenAI Responses WebSocket closed before a terminal response event");
					if (next.value.type === "open") {
						if (!requestDispatched) {
							requestDispatched = true;
							lease.socket.send({
								...prepared.request,
								type: "response.create"
							});
						}
						continue;
					}
					const event = readServerEvent(next.value);
					if (!event) continue;
					if (event.type === "response.completed") terminalResponse = event.response;
					terminalReceived = event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed";
					yield event;
					if (terminalReceived) {
						degradedWebSocketConnections.delete(degradationKey);
						return;
					}
				}
			} catch (error) {
				if (lease.entry) lease.entry.continuation = void 0;
				const safeRetry = error instanceof OpenAIResponsesWebSocketSafeRetryError;
				if (!params.callerSignal?.aborted && !safeRetry) markDegraded();
				if (!requestDispatched && !params.signal?.aborted) throw new OpenAIResponsesWebSocketPreDispatchError(error);
				if (!requestDispatched || params.callerSignal?.aborted || safeRetry) throw error;
				throw new OpenAIResponsesWebSocketPostDispatchError(error);
			} finally {
				await iterator.return?.().catch(() => void 0);
				if (!terminalReceived) finish({ keep: false });
			}
		} },
		request: prepared.request,
		reusedConnection: lease.reusedConnection,
		continuationStatus: prepared.continuationStatus,
		finish
	};
}
function closeOpenAIResponsesWebSocketSessions(sessionId) {
	for (const [cacheKey, entry] of websocketSessionCache) {
		if (sessionId && entry.sessionId !== sessionId) continue;
		invalidateOwnedWebSocketSession(cacheKey, entry, "session_cleanup");
	}
	for (const [key, entry] of degradedWebSocketConnections) if (!sessionId || entry.sessionId === sessionId) degradedWebSocketConnections.delete(key);
}
registerSessionResourceCleanup(closeOpenAIResponsesWebSocketSessions);
//#endregion
//#region packages/ai/src/transports/openai-responses-client.ts
function resolveNativeOpenAIResponsesWebSocketMode(model, transport) {
	if (transport !== "websocket" && transport !== "websocket-cached" && transport !== "auto") return;
	if (getAiTransportHost().requiresManagedTransport(model)) return;
	return supportsNativeOpenAIResponsesEndpoint({
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl
	}) ? transport : void 0;
}
function combineWebSocketTimeoutSignal(signal, model, timeoutMs) {
	const resolvedTimeoutMs = timeoutMs !== void 0 && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : getAiTransportHost().resolveModelRequestTimeoutMs(model);
	if (resolvedTimeoutMs === void 0 || !Number.isFinite(resolvedTimeoutMs)) return signal;
	return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, resolvedTimeoutMs))]);
}
function resolveProviderTransportTurnState(model, params) {
	const normalizedProvider = model.provider.trim().toLowerCase();
	const allowRuntimePluginLoad = normalizedProvider === "openai" || normalizedProvider === "azure-openai" || normalizedProvider === "azure-openai-responses";
	return getAiTransportHost().plugin.resolveTransportTurnState({
		provider: model.provider,
		modelId: model.id,
		allowRuntimePluginLoad,
		context: {
			provider: model.provider,
			modelId: model.id,
			model,
			sessionId: params.sessionId,
			turnId: params.turnId,
			attempt: params.attempt,
			transport: params.transport
		}
	});
}
function createOpenAIResponsesClient(model, context, apiKey, optionHeaders, turnHeaders, sessionId, fetchOverride) {
	return new OpenAI({
		apiKey,
		baseURL: resolveOpenAIClientBaseUrl(model),
		dangerouslyAllowBrowser: true,
		defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders, sessionId),
		fetch: fetchOverride ?? buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	});
}
async function postOpenAIResponsesCompaction(params) {
	const compactInput = typeof params.request.instructions === "string" && params.request.instructions.length > 0 ? [buildOpenAIResponsesCompactSystemMessage(params.model, params.request.instructions), ...params.request.input ?? []] : params.request.input;
	const response = await params.client.post("/responses/compact", {
		...buildOpenAISdkRequestOptions(params.model, params.options?.signal, { timeoutMs: params.options?.timeoutMs }),
		body: {
			model: params.request.model,
			input: compactInput
		}
	});
	const output = isRecord(response) && Array.isArray(response.output) ? response.output : [];
	const item = output.at(-1);
	const retainedItems = output.slice(0, -1);
	const retainedUserMessageCount = retainedItems.filter((candidate) => isRecord(candidate) && candidate.type === "message" && candidate.role === "user" && Array.isArray(candidate.content)).length;
	const inputUserMessageCount = Array.isArray(params.request.input) ? params.request.input.filter((candidate) => isRecord(candidate) && candidate.type === "message" && candidate.role === "user").length : 0;
	const retainedMessagePrefixSupported = supportsNativeOpenAIResponsesEndpoint(params.model);
	const usage = isRecord(response) && isRecord(response.usage) ? response.usage : void 0;
	if (!isRecord(response) || response.object !== "response.compaction" || !isOpenAIResponsesCompactionOutput(output, params.model) || retainedItems.length > 0 && (!retainedMessagePrefixSupported || retainedUserMessageCount !== inputUserMessageCount) || !isRecord(item) || item.type !== "compaction" || typeof item.encrypted_content !== "string" || item.encrypted_content.length === 0 || !usage || typeof usage.input_tokens !== "number" || typeof usage.output_tokens !== "number") throw new Error("Responses compact endpoint did not return one trailing compaction item");
	return {
		output,
		item,
		historyMode: retainedUserMessageCount > 0 ? "retained-users" : "compacted-prefix",
		usage,
		model: params.model,
		replayMetadata: buildOpenAIResponsesReasoningReplayMetadata(params.model, {
			authProfileId: params.options?.authProfileId,
			sessionId: params.options?.sessionId
		})
	};
}
function createResponsesTransportExecutor(config) {
	return (model, context, options) => {
		const responsesOptions = options;
		const compactRequest = claimResponsesCompactRequest(responsesOptions);
		const { eventStream, stream } = createWritableTransportEventStream();
		(async () => {
			const output = createOpenAIResponsesAssistantOutput(model, config.outputApi);
			let firstEventAbort;
			let continuationClaim;
			try {
				const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
				const websocketMode = resolveNativeOpenAIResponsesWebSocketMode(model, responsesOptions?.transport);
				const turnState = resolveProviderTransportTurnState(model, {
					sessionId: options?.sessionId,
					turnId: randomUUID(),
					attempt: 1,
					transport: websocketMode ? "websocket" : "stream"
				});
				const websocketSessionPolicy = websocketMode ? turnState?.websocket : void 0;
				const websocketHeaders = websocketMode ? buildOpenAIClientHeaders(model, context, options?.headers, websocketSessionPolicy?.headers, options?.sessionId) : void 0;
				const client = config.createClient(model, context, apiKey, options?.headers, turnState?.headers, options?.sessionId, compactRequest ? createBoundedOpenAIResponsesCompactionFetch(buildGuardedModelFetch(model)) : void 0);
				const buildRequest = async (replayMode) => {
					let params = config.buildRequest(model, context, responsesOptions, turnState?.metadata, replayMode);
					const nextParams = await options?.onPayload?.(params, model);
					if (nextParams !== void 0) params = nextParams;
					if (!isOpenAICodexResponsesModel(model)) params = mergeTransportMetadata(params, turnState?.metadata);
					params = sanitizeOpenAICodexResponsesParams(model, params);
					params = sanitizeResponsesImagePayload(params);
					if (options?.openclawCodeModeToolSurface === true) {
						const visibleToolNames = resolveCodeModeResponsesVisibleToolNames(context);
						const allowedHostedToolTypes = responsesOptions?.openclawCodeModeAllowedHostedToolTypes;
						enforceCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes, codeModeToolSurfaceObserver.get(options));
						assertCodeModeResponsesToolSurface(params, visibleToolNames, allowedHostedToolTypes);
					}
					return params;
				};
				const params = await buildRequest("checkpoint");
				if (compactRequest) {
					const compacted = await postOpenAIResponsesCompaction({
						client,
						model,
						request: params,
						options: responsesOptions
					});
					output.usage.input = compacted.usage.input_tokens;
					output.usage.output = compacted.usage.output_tokens;
					output.usage.totalTokens = compacted.usage.input_tokens + compacted.usage.output_tokens;
					compactRequest.resolve(compacted);
					finalizeTransportStream({
						stream,
						output,
						signal: options?.signal
					});
					return;
				}
				const sessionId = options?.sessionId;
				if (config.httpContinuation && !websocketMode && !getAiTransportHost().requiresManagedTransport(model) && supportsNativeOpenAIResponsesEndpoint({
					provider: model.provider,
					api: model.api,
					baseUrl: model.baseUrl
				}) && sessionId && params.store === true && !params.previous_response_id) continuationClaim = claimOpenAIResponsesHttpContinuation({
					sessionId,
					apiKey,
					baseUrl: model.baseUrl,
					headers: buildOpenAIClientHeaders(model, context, options?.headers, turnState?.headers, sessionId),
					request: params
				});
				const observePrompt = createResponsesPromptEgressObserver(responsesOptions, context.systemPrompt);
				const requestStartedAt = Date.now();
				let started = false;
				const startStream = () => {
					if (!started) {
						started = true;
						stream.push({
							type: "start",
							partial: output
						});
					}
				};
				const firstEvent = createFirstStreamEventAbortController(options?.signal);
				firstEventAbort = firstEvent;
				const requestOptions = buildOpenAISdkRequestOptions(model, firstEvent.signal, {
					stream: config.streamRequest,
					timeoutMs: options?.timeoutMs
				});
				const websocketSignal = combineWebSocketTimeoutSignal(firstEvent.signal, model, requestOptions?.timeout);
				emitModelTransportDebug(log, `[responses] start provider=${model.provider} api=${model.api} model=${model.id} requestIdHash=${redactIdentifier(options?.requestId, { len: 64 })} baseUrl=${formatModelTransportDebugBaseUrl(model.baseUrl)} timeoutMs=${safeDebugValue(requestOptions?.timeout)} apiKey=${apiKey ? "present" : "missing"} ${summarizeResponsesPayload(params)}`);
				let continuationBaseline;
				const createSseStream = async (initialRequest = continuationClaim?.request ?? params, initialAttemptKind = "initial", initialRejectedCompaction) => {
					const { stream: responseStream } = await createResponsesStreamWithEncryptedContentRetry({
						client,
						request: initialRequest,
						requestOptions,
						model,
						observePrompt,
						initialAttemptKind,
						initialRejectedCompaction,
						buildFullHistoryRequest: () => buildRequest("full-history"),
						onCompactionRejected: (checkpoint) => suppressOpenAIResponsesCompaction(output, model, responsesOptions, checkpoint),
						canRetryStream: () => output.content.length === 0,
						wrapStream: ({ stream: rawResponseStream, response, attempt }) => {
							if (continuationClaim) continuationBaseline = attempt.request.previous_response_id ? params : attempt.request;
							return withProviderResponseHook({
								stream: observeResponsesStream(rawResponseStream, model, requestStartedAt),
								signal: firstEvent.signal,
								abort: firstEvent.abort,
								hook: createOpenAIProviderAcceptanceHook(options, response, model),
								onReady: () => {
									emitModelTransportDebug(log, `[responses] headers provider=${model.provider} api=${model.api} model=${model.id} transport=sse elapsedMs=${Date.now() - requestStartedAt}`);
									startStream();
								}
							});
						}
					});
					return responseStream;
				};
				let responseStream;
				let finishWebSocket;
				let transport = "sse";
				const logWebSocketFallback = (reason) => emitModelTransportDebug(log, `[responses] websocket_fallback provider=${model.provider} api=${model.api} model=${model.id} reason=${reason}`);
				const closeWebSocketForFallback = (reason) => {
					finishWebSocket?.({ keep: false });
					finishWebSocket = void 0;
					transport = "sse";
					logWebSocketFallback(reason);
				};
				if (websocketMode) try {
					const websocket = createOpenAIResponsesWebSocketStream({
						client,
						request: params,
						mode: websocketMode,
						sessionId: options?.sessionId,
						headers: websocketHeaders,
						signal: websocketSignal,
						callerSignal: options?.signal,
						degradeCooldownMs: websocketSessionPolicy?.degradeCooldownMs
					});
					finishWebSocket = websocket.finish;
					observePrompt?.(websocket.request, {
						egress: "responses-websocket",
						payloadVariant: "initial"
					});
					transport = "websocket";
					emitModelTransportDebug(log, `[responses] websocket_selected provider=${model.provider} api=${model.api} model=${model.id} mode=${websocketMode} reused=${websocket.reusedConnection} continuation=${websocket.continuationStatus === "continued"} continuationStatus=${websocket.continuationStatus} sessionIdHash=${redactIdentifier(options?.sessionId)} headersHash=${redactIdentifier(JSON.stringify(Object.entries(websocketHeaders ?? {}).toSorted(([a], [b]) => a.localeCompare(b))))}`);
					responseStream = { async *[Symbol.asyncIterator]() {
						let providerAccepted = false;
						try {
							for await (const event of websocket.stream) {
								if (!providerAccepted) {
									providerAccepted = true;
									await notifyProviderStreamOpened({
										options,
										cancelStream: () => websocket.finish({ keep: false })
									});
								}
								startStream();
								yield event;
							}
						} catch (error) {
							if (error instanceof OpenAIResponsesWebSocketSafeRetryError) {
								const encryptedContentRejected = isInvalidEncryptedContentError(error);
								const recovery = encryptedContentRejected ? await resolveNextResponsesEncryptedContentAttempt({
									kind: "initial",
									request: {
										...websocket.request,
										stream: true
									}
								}, error, { buildFullHistoryRequest: () => buildRequest("full-history") }) : void 0;
								if (encryptedContentRejected && !recovery) throw error;
								closeWebSocketForFallback(`safe_server_error code=${error.code} status=${safeDebugValue(error.status)} param=${safeDebugValue(error.param)}`);
								yield* await createSseStream(recovery?.request ?? await buildRequest("full-history"), recovery?.kind ?? "continuation-rejected", recovery?.rejectedCompaction);
								return;
							}
							if (websocketSignal.aborted || !(error instanceof OpenAIResponsesWebSocketPreDispatchError)) throw error;
							transport = "sse";
							logWebSocketFallback("before_first_event");
							yield* await createSseStream();
						}
					} };
				} catch {
					closeWebSocketForFallback("setup_failure");
					responseStream = await createSseStream();
				}
				else responseStream = await createSseStream();
				try {
					const terminal = await processResponsesStream(responseStream, output, stream, model, {
						...config.pricingOptions?.(responsesOptions, model),
						firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options) ?? config.firstEventTimeoutMs,
						abortFirstEventStream: firstEvent.abort,
						onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
						signal: options?.signal,
						reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
							authProfileId: responsesOptions?.authProfileId,
							sessionId: options?.sessionId
						})
					});
					finishWebSocket?.();
					if (options?.signal?.aborted) throw transportAbortError(options.signal);
					if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage ?? "An unknown error occurred");
					if (continuationClaim && continuationBaseline && terminal) continuationClaim.commit(continuationBaseline, terminal);
				} catch (error) {
					finishWebSocket?.({ keep: false });
					throw error;
				}
				emitModelTransportDebug(log, `[responses] completed provider=${model.provider} api=${model.api} model=${model.id} transport=${transport} elapsedMs=${Date.now() - requestStartedAt}`);
				finalizeTransportStream({
					stream,
					output,
					signal: options?.signal
				});
			} catch (error) {
				if (compactRequest) {
					compactRequest.reject(error);
					failTransportStream({
						stream,
						output,
						signal: options?.signal,
						error
					});
					return;
				}
				if (error instanceof ResponsesStreamFailure && error.observation) logResponsesFailedNoDetails(error.observation);
				log.warn(`[responses] error provider=${model.provider} api=${model.api} model=${model.id} ` + summarizeOpenAITransportError(error));
				failTransportStream({
					stream,
					output,
					signal: options?.signal,
					error
				});
			} finally {
				continuationClaim?.release();
				firstEventAbort?.dispose();
			}
		})();
		return eventStream;
	};
}
function createOpenAIResponsesTransportStreamFn() {
	return createResponsesTransportExecutor({
		streamRequest: true,
		httpContinuation: true,
		createClient: createOpenAIResponsesClient,
		buildRequest: buildOpenAIResponsesParams,
		pricingOptions: (options, model) => ({
			serviceTier: options?.serviceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyResponsesServiceTierPricing(usage, serviceTier, model)
		})
	});
}
function createAzureOpenAIResponsesTransportStreamFn() {
	return createResponsesTransportExecutor({
		outputApi: "azure-openai-responses",
		firstEventTimeoutMs: AZURE_RESPONSES_FIRST_EVENT_TIMEOUT_MS,
		createClient: createAzureOpenAIClient,
		buildRequest: (model, context, options, metadata, replayMode) => buildAzureOpenAIResponsesParams(model, context, options, resolveAzureDeploymentName(model), metadata, replayMode)
	});
}
function resolveAzureDeploymentName(model) {
	return resolveAzureDeploymentNameFromMap({
		modelId: model.id,
		deploymentMap: process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP
	});
}
function createAzureOpenAIClient(model, context, apiKey, optionHeaders, turnHeaders, _sessionId, fetchOverride) {
	const baseURL = model.baseUrl.replace(/\/+$/, "");
	const clientOptions = {
		apiKey,
		dangerouslyAllowBrowser: true,
		defaultHeaders: buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders),
		baseURL,
		fetch: fetchOverride ?? buildGuardedModelFetch(model),
		...buildOpenAISdkClientOptions(model)
	};
	if (isOpenAICompatibleAzureResponsesBaseUrl(baseURL)) return new OpenAI(clientOptions);
	return new AzureOpenAI({
		...clientOptions,
		apiVersion: resolveAzureOpenAIApiVersion()
	});
}
function buildAzureOpenAIResponsesParams(model, context, options, deploymentName, metadata, replayMode = "checkpoint") {
	const params = buildOpenAIResponsesParams(model, context, options, metadata, replayMode);
	params.model = deploymentName;
	delete params.store;
	return params;
}
//#endregion
//#region packages/ai/src/transports/openai-responses-transport.ts
/** OpenAI Responses transport facade. */
const responsesTesting = {
	getCompat,
	assertCodeModeResponsesToolSurface,
	buildOpenAIResponsesParams,
	buildOpenAIClientHeaders,
	buildOpenAISdkClientOptions,
	buildOpenAISdkRequestOptions,
	createAzureOpenAIClient,
	createOpenAIResponsesClient,
	enforceCodeModeResponsesToolSurface,
	sanitizeOpenAICodexResponsesParams,
	processResponsesStream,
	formatModelTransportDebugBaseUrl,
	buildResponsesFailedNoDetailsObservation,
	buildOpenAIResponsesReasoningReplayMetadata,
	isInvalidEncryptedContentError,
	normalizeResponsesFailedEvent,
	createResponsesStreamWithEncryptedContentRetry,
	resolveAzureOpenAIApiVersion,
	summarizeResponsesFailedNoDetailsObservation,
	summarizeResponsesPayload,
	summarizeResponsesTools,
	stringifyRedactedEvent,
	stringifyRedactedPayload
};
if (process.env.VITEST || false) globalThis.openclawOpenAIResponsesTransportTestApi = responsesTesting;
//#endregion
//#region packages/ai/src/transports/provider-compaction-replay.ts
function isAssistantReplayMessage(message) {
	return message.role === "assistant";
}
/** Resolve from prepared transport facts; never retain or return credential material. */
function resolveCompactionReplayEligibility(model, options) {
	if (OPENAI_RESPONSES_APIS.has(model.api)) return true;
	return Boolean(options.apiKey?.trim()) && resolveAnthropicServerCompactionPlan(model, options.extraParams, options.apiKey).enabled;
}
function resolveCompactionSource(messages, model, identity) {
	if (identity.enabled === false) return;
	const assistants = messages.filter(isAssistantReplayMessage);
	const selected = (() => {
		if (OPENAI_RESPONSES_APIS.has(model.api)) {
			const responses = resolveNewestOpenAIResponsesCompactionReplay(assistants, model, identity);
			return responses ? {
				family: "responses",
				...responses
			} : void 0;
		}
		if (identity.enabled !== true) return;
		const anthropic = resolveNewestAnthropicCompaction(assistants, model, identity);
		return anthropic ? {
			family: "anthropic",
			...anthropic
		} : void 0;
	})();
	if (!selected) return;
	const owner = assistants.find((message) => message === selected.owner);
	return owner ? {
		...selected,
		owner
	} : void 0;
}
/** Manual recovery uses the durable client compactor, never a guessed retained-user prefix. */
function requiresCompactionReplayRefresh(messages, model, identity) {
	const checkpoint = resolveCompactionSource(messages, model, identity);
	return checkpoint?.family === "responses" && checkpoint.mode === "refresh-required";
}
/** Carry a checkpoint immediately after reference-preserving history limiting, before repair. */
function preserveCompactionReplayWindow(source, windowed, model, identity) {
	const checkpoint = resolveCompactionSource(source, model, identity);
	if (!checkpoint || windowed.some((message) => message === checkpoint.owner)) return windowed;
	const owner = checkpoint.owner;
	const replay = checkpoint.owner.providerReplay;
	const providerReplay = replay?.type === "openai-responses-retained-compaction" ? replay : {
		...replay,
		replayIndex: 0
	};
	const suffix = new Set(source.slice(source.indexOf(owner) + 1));
	return [{
		...owner,
		content: [],
		providerReplay
	}, ...windowed.filter((message) => suffix.has(message))];
}
function estimateResponsesWindow(checkpoint, estimate) {
	return checkpoint.output.reduce((tokens, entry) => {
		if (entry.type === "compaction") {
			const { encrypted_content, ...metadata } = entry;
			return tokens + estimate.text(encrypted_content) + estimate.json(metadata);
		}
		const { content, ...metadata } = entry;
		return tokens + estimate.json(metadata) + content.reduce((sum, block) => {
			if (block.type === "input_text") {
				const { text, ...fields } = block;
				return sum + estimate.text(text) + estimate.json(fields);
			}
			if (block.type === "input_image") {
				const { image_url: _imageUrl, ...fields } = block;
				return sum + estimate.image() + estimate.json(block.image_url?.startsWith("data:") ? fields : block);
			}
			return sum + estimate.json(block);
		}, 0);
	}, 0);
}
/** Estimate the canonical prefix and its tail once, independent of unbound usage snapshots. */
function resolveCompactionReplayPressure(messages, model, identity, estimate) {
	const checkpoint = resolveCompactionSource(messages, model, identity);
	if (!checkpoint) return;
	if (checkpoint.family === "responses" && checkpoint.mode === "refresh-required") throw new CompactionReplayRefreshRequiredError();
	const ownerIndex = messages.findIndex((message) => message === checkpoint.owner);
	const owner = messages[ownerIndex];
	if (!owner) return;
	const prefixTokens = checkpoint.family === "anthropic" ? estimate.text(checkpoint.summary) : checkpoint.mode === "complete-window" ? estimateResponsesWindow(checkpoint, estimate) : estimate.text(checkpoint.item.encrypted_content);
	const { contextUsage: _staleContextUsage, ...usage } = checkpoint.owner.usage;
	const tail = [];
	for (const message of messages.slice(ownerIndex + 1)) {
		if (!isAssistantReplayMessage(message) || message.usage.contextUsage === void 0) {
			tail.push(message);
			continue;
		}
		const { contextUsage: _unboundContextUsage, ...billedUsage } = message.usage;
		tail.push({
			...message,
			usage: billedUsage
		});
	}
	return {
		messages: [{
			...owner,
			content: checkpoint.owner.content.slice(checkpoint.replayIndex),
			usage
		}, ...tail],
		prefixTokens
	};
}
/** Whether provider replay state is a prefix-bound server compaction checkpoint. */
function isCompactionReplayCheckpoint(replay) {
	const type = replay && typeof replay === "object" ? replay.type : void 0;
	return type === "anthropic-compaction" || type === "openai-responses-compaction" || type === "openai-responses-retained-compaction";
}
/** Strip prefix-bound checkpoints after local history rewrites. */
function stripCompactionReplayCheckpoint(message) {
	if (!isCompactionReplayCheckpoint(message.providerReplay)) return message;
	const replaySafeMessage = { ...message };
	delete replaySafeMessage.providerReplay;
	return replaySafeMessage;
}
/** Strip prefix-bound checkpoint state from an in-place message rewrite. */
function stripCompactionReplayCheckpointInPlace(message) {
	if (isCompactionReplayCheckpoint(message.providerReplay)) delete message.providerReplay;
}
/** Reindex a prefix-bound checkpoint after known content removals. */
function replaceCompactionReplayOwnerContent(message, content) {
	const next = {
		...message,
		content
	};
	const replay = message.providerReplay;
	if (!isCompactionReplayCheckpoint(replay)) return next;
	if (replay.type === "openai-responses-retained-compaction") return next;
	const replayIndex = replay.replayIndex ?? 0;
	if (content.length === 0 && message.content.length > 0 || replayIndex > message.content.length) return stripCompactionReplayCheckpoint(next);
	let sourceIndex = 0;
	let nextReplayIndex = 0;
	if (!content.every((block) => {
		const index = message.content.indexOf(block, sourceIndex);
		sourceIndex = index + 1;
		nextReplayIndex += index >= 0 && index < replayIndex ? 1 : 0;
		return index >= 0;
	})) return stripCompactionReplayCheckpoint(next);
	return nextReplayIndex === replayIndex ? next : {
		...next,
		providerReplay: {
			...replay,
			replayIndex: nextReplayIndex
		}
	};
}
//#endregion
//#region packages/ai/src/transports/provider-transport-stream.ts
const SUPPORTED_TRANSPORT_APIS = /* @__PURE__ */ new Set([
	"openai-responses",
	"openai-chatgpt-responses",
	"openai-completions",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai"
]);
const SIMPLE_TRANSPORT_API_ALIAS = {
	"openai-completions": "openclaw-openai-completions-transport",
	"anthropic-messages": "openclaw-anthropic-messages-transport",
	"google-generative-ai": "openclaw-google-generative-ai-transport"
};
function createProviderOwnedGoogleTransportStreamFn(model, ctx) {
	return getAiTransportHost().plugin.resolveProviderStream({
		provider: model.provider,
		config: ctx?.cfg,
		workspaceDir: ctx?.workspaceDir,
		env: ctx?.env,
		context: {
			config: ctx?.cfg,
			agentDir: ctx?.agentDir,
			workspaceDir: ctx?.workspaceDir,
			provider: model.provider,
			modelId: model.id,
			model
		}
	}) ?? getAiTransportHost().plugin.resolveProviderStream({
		provider: "google",
		config: ctx?.cfg,
		workspaceDir: ctx?.workspaceDir,
		env: ctx?.env,
		context: {
			config: ctx?.cfg,
			agentDir: ctx?.agentDir,
			workspaceDir: ctx?.workspaceDir,
			provider: model.provider,
			modelId: model.id,
			model
		}
	}) ?? void 0;
}
function createSupportedTransportStreamFn(model, ctx) {
	switch (model.api) {
		case "openai-responses":
		case "openai-chatgpt-responses": return createOpenAIResponsesTransportStreamFn();
		case "openai-completions": return createOpenAICompletionsTransportStreamFn();
		case "azure-openai-responses": return createAzureOpenAIResponsesTransportStreamFn();
		case "anthropic-messages": return createAnthropicMessagesTransportStreamFn();
		case "google-generative-ai": return createProviderOwnedGoogleTransportStreamFn(model, ctx);
		default: return;
	}
}
function hasOpenClawTransportRequirement(model) {
	return getAiTransportHost().requiresManagedTransport(model);
}
/** Returns whether OpenClaw has a managed transport implementation for this API. */
function isTransportAwareApiSupported(api) {
	return SUPPORTED_TRANSPORT_APIS.has(api);
}
/** Maps public model APIs to the internal transport API id used by simple runtime dispatch. */
function resolveTransportAwareSimpleApi(api) {
	if (OPENAI_RESPONSES_APIS.has(api)) {
		const alias = `openclaw-${api}-transport`;
		return OPENAI_RESPONSES_APIS.has(alias) ? alias : void 0;
	}
	return SIMPLE_TRANSPORT_API_ALIAS[api];
}
/** Creates a managed transport stream only when request overrides require it. */
function createTransportAwareStreamFnForModel(model, ctx) {
	if (!hasOpenClawTransportRequirement(model)) return;
	if (!isTransportAwareApiSupported(model.api)) throw new Error(`Model-provider request.proxy/request.tls/localService is not yet supported for api "${model.api}"`);
	const streamFn = createSupportedTransportStreamFn(model, ctx);
	if (!streamFn) throw new Error(`Managed transport stream is unavailable for api "${model.api}"`);
	return streamFn;
}
/** Creates a managed OpenClaw transport stream for explicit fallback/runtime callers. */
function createOpenClawTransportStreamFnForModel(model, ctx) {
	if (!isTransportAwareApiSupported(model.api)) return;
	return createSupportedTransportStreamFn(model, ctx);
}
function createBoundaryAwareStreamFnForModel(model, ctx) {
	if (!isTransportAwareApiSupported(model.api)) return;
	return createSupportedTransportStreamFn(model, ctx);
}
function prepareTransportAwareSimpleModel(model, ctx) {
	const streamFn = createTransportAwareStreamFnForModel(model, ctx);
	const alias = resolveTransportAwareSimpleApi(model.api);
	if (!streamFn || !alias) return model;
	return getAiTransportHost().inheritManagedTransport(model, {
		...model,
		api: alias
	});
}
function buildTransportAwareSimpleStreamFn(model, ctx) {
	return createTransportAwareStreamFnForModel(model, ctx);
}
//#endregion
//#region packages/ai/src/transports/simple-completion-transport.ts
const PROVIDER_SIMPLE_COMPLETION_API_PREFIX = "openclaw-provider-simple:";
const PROVIDER_STREAM_API_PREFIX = "openclaw-provider-stream:";
const INVALID_CODEX_BASE_URL_MESSAGE = "OpenAI Codex Responses baseUrl must not include query parameters or fragments";
function registerCustomApi(registry, api, streamFn) {
	getAiTransportHost().registerCustomApi(registry, api, streamFn);
	return registry.getApiProvider(api) !== void 0;
}
function projectModel(model, patch) {
	return getAiTransportHost().inheritManagedTransport(model, {
		...model,
		...patch
	});
}
function resolveAnthropicVertexSimpleApi(baseUrl) {
	return `openclaw-anthropic-vertex-simple:${baseUrl?.trim() ? encodeURIComponent(baseUrl.trim()) : "default"}`;
}
function normalizeCodexResponsesBaseUrlForOpenAISdk(baseUrl) {
	const normalized = baseUrl?.trim() || "https://chatgpt.com/backend-api";
	try {
		const parsed = new URL(normalized);
		const pathname = parsed.pathname.replace(/\/+$/u, "");
		const path = pathname.toLowerCase();
		if (parsed.hostname.toLowerCase() === "chatgpt.com" && [
			"/backend-api",
			"/backend-api/v1",
			"/backend-api/codex",
			"/backend-api/codex/v1",
			"/backend-api/codex/responses"
		].includes(path)) {
			parsed.pathname = "/backend-api/codex";
			parsed.search = "";
			parsed.hash = "";
			return parsed.toString().replace(/\/$/u, "");
		}
		if (normalized.includes("?") || normalized.includes("#")) throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
		parsed.pathname = path.endsWith("/codex/responses") ? pathname.slice(0, -10) : path.endsWith("/codex") ? pathname : `${pathname}/codex`;
		return parsed.toString();
	} catch (error) {
		if (error instanceof Error && error.message === INVALID_CODEX_BASE_URL_MESSAGE) throw error;
	}
	if (normalized.includes("?") || normalized.includes("#")) throw new Error(INVALID_CODEX_BASE_URL_MESSAGE);
	const path = normalized.replace(/\/+$/u, "");
	if (path.endsWith("/codex/responses")) return path.slice(0, -10);
	return path.endsWith("/codex") ? path : `${path}/codex`;
}
function resolveProviderSimpleCompletionApi(model) {
	const parts = [
		model.provider,
		model.id,
		model.api,
		model.baseUrl || "default"
	];
	return `${PROVIDER_SIMPLE_COMPLETION_API_PREFIX}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}
function resolveProviderStreamApi(model) {
	const parts = [
		model.provider,
		model.id,
		model.api,
		model.baseUrl || "default"
	];
	return `${PROVIDER_STREAM_API_PREFIX}${parts.map((part) => encodeURIComponent(part)).join(":")}`;
}
function applyProviderSimpleCompletionWrapper(registry, model, cfg, hookSourceApi = model.api) {
	if (model.api.startsWith(PROVIDER_SIMPLE_COMPLETION_API_PREFIX)) return model;
	const sourceProvider = registry.getApiProvider(model.api);
	if (!sourceProvider) return model;
	const dispatchApi = model.api;
	const sourceStreamFn = (runtimeModel, context, options) => sourceProvider.streamSimple(projectModel(runtimeModel, { api: dispatchApi }), context, options);
	const streamFn = getAiTransportHost().plugin.wrapSimpleCompletionStream({
		provider: model.provider,
		config: cfg,
		context: {
			config: cfg,
			provider: model.provider,
			modelId: model.id,
			model,
			sourceApi: hookSourceApi,
			streamFn: sourceStreamFn
		}
	});
	if (!streamFn) return model;
	const api = resolveProviderSimpleCompletionApi(model);
	return registerCustomApi(registry, api, streamFn) ? projectModel(model, { api }) : model;
}
function prepareCodexSimpleTransportModel(registry, model, cfg) {
	if (model.provider !== "openai" || model.api !== "openai-chatgpt-responses") return;
	const transportModel = projectModel(model, { baseUrl: normalizeCodexResponsesBaseUrlForOpenAISdk(model.baseUrl) });
	const api = resolveTransportAwareSimpleApi(model.api);
	const streamFn = createOpenClawTransportStreamFnForModel(transportModel, { cfg });
	if (!api || !streamFn) return;
	if (!registerCustomApi(registry, api, streamFn)) return;
	return projectModel(transportModel, { api });
}
function resolveModelHeaderSentinels(model) {
	const headers = resolveAiTransportHeaderSentinels(model.headers);
	return headers === model.headers ? model : projectModel(model, { headers });
}
function wrapPluginProviderStream(streamFn) {
	return (model, context, options) => {
		const host = getAiTransportHost();
		const apiKey = options?.apiKey ? host.resolveSecretSentinel(options.apiKey) : options?.apiKey;
		const headers = resolveAiTransportHeaderSentinels(options?.headers);
		return streamFn(resolveModelHeaderSentinels(model), context, apiKey === options?.apiKey && headers === options?.headers ? options : {
			...options,
			apiKey,
			headers
		});
	};
}
function prepareProviderStreamModel(params) {
	const pluginModel = resolveModelHeaderSentinels(params.model);
	const providerStreamFn = getAiTransportHost().plugin.resolveProviderStream({
		provider: params.model.provider,
		config: params.cfg,
		context: {
			config: params.cfg,
			provider: params.model.provider,
			modelId: params.model.id,
			model: pluginModel
		}
	});
	const transportFallback = providerStreamFn ? void 0 : createTransportAwareStreamFnForModel(params.model.api === "google-generative-ai" ? pluginModel : params.model, { cfg: params.cfg });
	const streamFn = providerStreamFn ? wrapPluginProviderStream(providerStreamFn) : transportFallback && params.model.api === "google-generative-ai" ? wrapPluginProviderStream(transportFallback) : transportFallback;
	if (!streamFn) return;
	const api = params.apiRegistry.getApiProvider(params.model.api) ? resolveProviderStreamApi(params.model) : params.model.api;
	if (!registerCustomApi(params.apiRegistry, api, streamFn)) return;
	return api === params.model.api ? params.model : projectModel(params.model, { api });
}
function prepareModelForSimpleCompletion(params) {
	const { apiRegistry, model, cfg } = params;
	const providerStreamModel = prepareProviderStreamModel({
		model,
		cfg,
		apiRegistry
	});
	if (providerStreamModel) return applyProviderSimpleCompletionWrapper(apiRegistry, providerStreamModel, cfg, model.api);
	const codexTransportModel = prepareCodexSimpleTransportModel(apiRegistry, model, cfg);
	if (codexTransportModel) return applyProviderSimpleCompletionWrapper(apiRegistry, codexTransportModel, cfg, model.api);
	const transportAwareModel = prepareTransportAwareSimpleModel(model, { cfg });
	if (transportAwareModel !== model) {
		const streamFn = buildTransportAwareSimpleStreamFn(model, { cfg });
		if (streamFn && registerCustomApi(apiRegistry, transportAwareModel.api, streamFn)) return applyProviderSimpleCompletionWrapper(apiRegistry, transportAwareModel, cfg, model.api);
	}
	if (model.provider === "anthropic-vertex") {
		const api = resolveAnthropicVertexSimpleApi(model.baseUrl);
		if (registerCustomApi(apiRegistry, api, getAiTransportHost().plugin.createAnthropicVertexStream(model))) return applyProviderSimpleCompletionWrapper(apiRegistry, projectModel(model, { api }), cfg, model.api);
	}
	return applyProviderSimpleCompletionWrapper(apiRegistry, model, cfg);
}
//#endregion
export { CompactionReplayRefreshRequiredError, GEMINI_THOUGHT_SIGNATURE_VALIDATOR_SKIP, MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, applyAnthropicCacheControlToMessages, applyAnthropicEphemeralCacheControlMarkers, applyAnthropicPayloadPolicyToParams, applyOpenAIResponsesPayloadPolicy, assertCodeModeResponsesToolSurface, assignTransportErrorDetails, buildOpenAIClientHeaders, buildOpenAICompletionsParams, buildOpenAISdkClientOptions, buildOpenAISdkRequestOptions, buildTransportAwareSimpleStreamFn, canonicalizeMaxTokensParam, captureOpenAIResponsesCompaction, coerceTransportToolCallArguments, copyProviderAcceptanceObserver, createAnthropicMessagesTransportStreamFn, createAzureOpenAIResponsesTransportStreamFn, createBoundaryAwareStreamFnForModel, createDeepSeekTextFilter, createEmptyTransportUsage, createModelStreamCooperativeScheduler, createOpenAICompletionsTransportStreamFn, createOpenAIProviderAcceptanceHook, createOpenAIResponseHook, createOpenAIResponsesTransportStreamFn, createOpenClawTransportStreamFnForModel, createTransportAwareStreamFnForModel, createWritableTransportEventStream, detectOpenAICompletionsCompat, emitModelTransportDebug, enforceCodeModeResponsesToolSurface, failTransportStream, filterCodeModePayloadTools, finalizeTerminalToolCallArguments, finalizeTransportStream, flattenCompletionMessagesToStringContent, formatModelTransportDebugBaseUrl, formatModelTransportDebugUrl, getCompat, googleFlashSupportsMinimalThinking, hasOpenAICompatibleConversationTurn, isCodeModeModelVisibleToolName, isCompactionReplayCheckpoint, isOpenAICodexResponsesModel, isOpenAICompletionsThinkingEnabled, log, measureUtf8AppendBytes, mergeTransportHeaders, mergeTransportMetadata, normalizeCodexResponsesBaseUrlForOpenAISdk, notifyProviderHttpMetadata, notifyProviderHttpResponse, notifyProviderStreamOpened, parseJsonObjectPreservingUnsafeIntegers, parseJsonPreservingUnsafeIntegers, parseOpenAICompletionsUsage, parseTerminalToolCallArguments, prepareModelForSimpleCompletion, prepareTransportAwareSimpleModel, preserveCompactionReplayWindow, quoteUnsafeIntegerLiterals, readCodeModePayloadToolName, readOpenAICompletionsContentDeltas, readOpenAICompletionsReasoningBatch, replaceCompactionReplayOwnerContent, requestPreparedOpenAIResponsesCompaction, requiresCompactionReplayRefresh, resolveAnthropicEphemeralCacheControl, resolveAnthropicMessagesUrl, resolveAnthropicPayloadPolicy, resolveAnthropicServerCompactionPlan, resolveCodeModeResponsesVisibleToolNames, resolveCompactionReplayEligibility, resolveCompactionReplayPressure, resolveMaxTokensParam, resolveModelPayloadDebugMode, resolveModelSseDebugMode, resolveOpenAIClientBaseUrl, resolveOpenAICompletionsCompat, resolveOpenAIReasoningEffortMap, resolveOpenAIResponsesCompactEndpointPlan, resolveOpenAIResponsesPayloadPolicy, resolveOpenAIResponsesServerCompactionPlan, resolveOpenAIStrictToolFlagWithDiagnostics, resolvePromptCacheKey, resolveReplayableResponsesMessageId, resolveTransportAwareSimpleApi, sanitizeNonEmptyTransportPayloadText, sanitizeResponsesImagePayload, sanitizeTransportPayloadText, sortPromptCacheToolsByName as sortTransportToolsByName, stripCompactionReplayCheckpoint, stripCompactionReplayCheckpointInPlace, stripCompletionMessagesToRoleContent, throwIfModelStreamAborted, transportAbortError, usesNativeOpenAICodexResponsesBackend, withProviderAcceptanceObserver, withProviderResponseHook };
