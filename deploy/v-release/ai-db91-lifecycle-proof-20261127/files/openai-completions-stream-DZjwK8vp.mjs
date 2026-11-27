import { c as normalizeLowercaseStringOrEmpty, i as asOptionalObjectRecord, o as isRecord, t as truncateUtf16Safe } from "./utf16-slice-qz3nsy87.mjs";
import { t as sanitizeSurrogates } from "./sanitize-unicode-S6binQG-.mjs";
import { a as describeToolResultMediaPlaceholder, c as extractToolResultText, d as isImageWithMediaPayload, n as getAiTransportHost } from "./host-BIaiBURL.mjs";
import { n as clampOpenAIPromptCacheKey } from "./openai-prompt-cache-mZTCdRPo.mjs";
import { d as stripSystemPromptCacheBoundary } from "./simple-options-0PLDyJ-d.mjs";
import { o as resolveProviderRequestCapabilities, r as resolveModelRequestTimeoutMs, s as resolveProviderRequestPolicyConfig } from "./tool-schema-json-projection-BtZiml7r.mjs";
import { i as isCodeModeModelVisibleToolName, p as sha256Hex } from "./transport-utils-CtuS1Upe.mjs";
import { s as finalizeTerminalToolCallArguments } from "./transport-stream-shared-CytPVLIg.mjs";
import { r as parseStreamingJson, t as createToolArgumentPreviewSchedule } from "./json-parse-BuAJEbdW.mjs";
import { t as notifyLlmRequestActivity } from "./llm-request-activity-BjtkplhG.mjs";
import { A as readOpenAICompletionsReasoningBatch, D as measureUtf8AppendBytes, N as throwIfModelStreamAborted, O as parseOpenAICompletionsUsage, S as createModelStreamCooperativeScheduler, T as isOpenAICompletionsThinkingEnabled, a as resolveOpenAIProjectedToolsStrictToolFlag, k as readOpenAICompletionsContentDeltas, t as findOpenAIStrictToolProjectionDiagnostics } from "./openai-tool-schema-BMiHFH36.mjs";
import { a as withFirstStreamEventTimeout } from "./stream-first-event-timeout-DcNjoFQE.mjs";
import { t as transformProviderMessages } from "./provider-transcript-transform-WvJmFUAf.mjs";
import { t as mapOpenAIStopReason } from "./openai-stop-reason-Drnn_6Qj.mjs";
import { t as createReasoningTagTextPartitioner } from "./reasoning-tag-text-partitioner-C-4uedDb.mjs";
import { randomUUID } from "node:crypto";
//#region packages/ai/src/utils/assistant-text-phase.ts
const EMPTY_ASSISTANT_TEXT_BLOCK_SET = /* @__PURE__ */ new Set();
function isAssistantTextPhaseBlock(block) {
	if (!block || typeof block !== "object") return false;
	const record = block;
	return record.type === "text" && typeof record.text === "string";
}
function encodeAssistantTextSignatureV1(id, phase) {
	return JSON.stringify({
		v: 1,
		id,
		...phase ? { phase } : {}
	});
}
function tagUnphasedText(content, phase, idPrefix) {
	const textBlocks = content.filter(isAssistantTextPhaseBlock);
	let phaseIndex = textBlocks.filter((block) => block.textSignature !== void 0).length;
	const tagged = /* @__PURE__ */ new Map();
	for (const block of textBlocks) {
		if (block.text.trim().length === 0 || block.textSignature !== void 0) continue;
		const signature = encodeAssistantTextSignatureV1(`${idPrefix}-${phaseIndex}-${randomUUID().replaceAll("-", "").slice(0, 24)}`, phase);
		block.textSignature = signature;
		tagged.set(block, signature);
		phaseIndex += 1;
	}
	return tagged;
}
/** Tags unphased narration before a tool-call event becomes consumer-visible. */
function tagPendingCommentaryText(content) {
	return tagUnphasedText(content, "commentary", "commentary");
}
/** Records the confirmed final-answer boundary after reasoning resumes. */
function tagInterruptedTextPhases(content, interruptedText, preservedVisibleText = EMPTY_ASSISTANT_TEXT_BLOCK_SET) {
	const interruptedTextIndex = content.indexOf(interruptedText);
	if (interruptedTextIndex === -1) return;
	const finalAnswerIndex = content.findIndex((block, index) => index > interruptedTextIndex && isAssistantTextPhaseBlock(block) && block.text.trim().length > 0);
	if (finalAnswerIndex === -1) return;
	tagUnphasedText(content.slice(0, finalAnswerIndex).filter((block) => !preservedVisibleText.has(block)), "commentary", "commentary");
	tagUnphasedText(content.filter((block, index) => index >= finalAnswerIndex || preservedVisibleText.has(block)), "final_answer", "final-answer");
}
/** Prevents unresolved completion text from becoming a fallback answer after stream failure. */
function tagUnresolvedTextAsCommentary(message) {
	if (message.openclawDelivery?.textPhaseRequiresTerminal) tagUnphasedText(message.content, "commentary", "commentary");
}
/** Rolls back only the exact provisional signatures created by this transport turn. */
function clearPendingCommentaryText(tags) {
	for (const [block, signature] of tags) if (block.textSignature === signature) delete block.textSignature;
	tags.clear();
}
function rememberPendingCommentaryTags(target, tagged) {
	for (const [block, signature] of tagged) target.set(block, signature);
}
//#endregion
//#region packages/ai/src/transports/deepseek-dsml-grammar.ts
// dsml-spaced-calls-v1: upstream 910a2c1b308 (#169728) — the separator-space forms and the "calls" wrapper
const DEEPSEEK_DSML_MARKERS = [
	"|",
	"｜",
	"｜｜"
].flatMap((bar) => [`${bar}DSML${bar}`, `${bar}DSML${bar} `]);
const DEEPSEEK_DSML_SHARED_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) => [
	"calls",
	"tool_calls",
	"tool_call",
	"function_calls"
].map((kind) => `<${marker}${kind}>`));
const DEEPSEEK_DSML_MARKER_PATTERN = `(${DEEPSEEK_DSML_MARKERS.map((marker) => marker.replaceAll("|", "\\|")).join("|")})`;
//#endregion
//#region packages/ai/src/transports/deepseek-text-filter.ts
/**
* DeepSeek DSML streaming text filter.
* Removes provider-emitted DSML tool markup while buffering split tag prefixes
* across streamed chunks.
*/
const DSML_KINDS = [
	"tool_use_error",
	"tool_calls",
	"tool_call",
	"function_calls"
];
const DSML_OPEN_TOKENS = [...DEEPSEEK_DSML_SHARED_TOOL_OPEN_TOKENS, ...DEEPSEEK_DSML_MARKERS.map((marker) => `<${marker}tool_use_error>`)]; // dsml-spaced-calls-v1
const MAX_OPEN_TOKEN_LEN = Math.max(...DSML_OPEN_TOKENS.map((token) => token.length));
/** Create an incremental text filter that strips DeepSeek DSML tool blocks. */
function createDeepSeekTextFilter() {
	let buffer = "";
	let closeToken;
	const consume = (final) => {
		const output = [];
		const emit = (text) => {
			if (text) output.push(text);
		};
		while (buffer) {
			if (closeToken) {
				const closeIndex = buffer.indexOf(closeToken);
				if (closeIndex !== -1) {
					buffer = buffer.slice(closeIndex + closeToken.length);
					closeToken = void 0;
					continue;
				}
				const keep = final ? 0 : Math.min(buffer.length, closeToken.length - 1);
				buffer = buffer.slice(buffer.length - keep);
				if (final) closeToken = void 0;
				return output;
			}
			const open = findEarliestToken(buffer, DSML_OPEN_TOKENS);
			if (open) {
				emit(buffer.slice(0, open.index));
				buffer = buffer.slice(open.index + open.token.length);
				closeToken = open.token.replace("<", "</");
				continue;
			}
			if (final) {
				emit(buffer);
				buffer = "";
				return output;
			}
			const keep = longestDsmlOpenPrefixSuffixLength(buffer);
			const emitLength = buffer.length - keep;
			if (emitLength <= 0) return output;
			emit(buffer.slice(0, emitLength));
			buffer = buffer.slice(emitLength);
			return output;
		}
		return output;
	};
	return {
		push(chunk) {
			buffer += chunk;
			return consume(false);
		},
		flush() {
			return consume(true);
		}
	};
}
function findEarliestToken(text, tokens) {
	let best = null;
	for (const token of tokens) {
		const index = text.indexOf(token);
		if (index !== -1 && (!best || index < best.index)) best = {
			index,
			token
		};
	}
	return best;
}
function longestDsmlOpenPrefixSuffixLength(text) {
	const maxLength = Math.min(text.length, MAX_OPEN_TOKEN_LEN - 1);
	for (let length = maxLength; length > 0; length--) {
		const suffix = text.slice(text.length - length);
		if (DSML_OPEN_TOKENS.some((token) => token.startsWith(suffix))) return length;
	}
	return 0;
}
//#endregion
//#region packages/ai/src/providers/openai-response-format.ts
const JSON_SCHEMA_RESPONSE_FORMAT_NAME = "openclaw_response";
const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";
function isKnownOpenAIJsonSchemaModelId(modelId) {
	if (typeof modelId !== "string") return false;
	if (/^gpt-5(?:[.-]|$)/i.test(modelId) || /^gpt-4\.1(?:-|$)/i.test(modelId)) return true;
	const gpt4o = /^gpt-4o(-mini)?(?:-(\d{4}-\d{2}-\d{2}))?$/i.exec(modelId);
	if (gpt4o) {
		const snapshot = gpt4o[2];
		return !snapshot || snapshot >= (gpt4o[1] ? "2024-07-18" : "2024-08-06");
	}
	return /^(?:o1|o3(?:-mini|-pro)?|o4-mini)(?:-\d{4}-\d{2}-\d{2})?$/i.test(modelId);
}
function shouldOmitOllamaCompatResponseFormat(params) {
	if (!params.provider.includes("ollama")) return false;
	if (params.hasTools()) return true;
	try {
		return new URL(params.baseUrl).origin === OLLAMA_CLOUD_ORIGIN;
	} catch {
		return false;
	}
}
/**
* Maps the shared JSON Schema option to Chat Completions while preserving the
* older provider-shaped json_object/json_schema inputs accepted by model params.
*/
function resolveOpenAICompletionsResponseFormat(responseFormat, supportsJsonSchemaResponseFormat) {
	if (!responseFormat) return;
	if (responseFormat.type === "json_object") return responseFormat;
	if (responseFormat.type === "text") return responseFormat;
	if (responseFormat.type === "json_schema" && isRecord(responseFormat.json_schema)) return responseFormat;
	if (!supportsJsonSchemaResponseFormat) return;
	return {
		type: "json_schema",
		json_schema: {
			name: JSON_SCHEMA_RESPONSE_FORMAT_NAME,
			schema: responseFormat
		}
	};
}
//#endregion
//#region packages/ai/src/transports/openai-completions-compat.ts
function isDefaultRouteProvider(provider, ...ids) {
	return provider !== void 0 && ids.includes(provider);
}
/** Resolves default request flags for an OpenAI-compatible completions endpoint. */
function resolveOpenAICompletionsCompatDefaults(input) {
	const { provider, modelId, endpointClass, knownProviderFamily, supportsNativeStreamingUsageCompat = false, supportsOpenAICompletionsStreamingUsageCompat = false, usesExplicitProxyLikeEndpoint = false } = input;
	const isDefaultRoute = endpointClass === "default";
	const usesConfiguredNonOpenAIEndpoint = endpointClass !== "default" && endpointClass !== "openai-public";
	const isMoonshot = knownProviderFamily === "moonshot" || endpointClass === "moonshot-native";
	const isMoonshotLike = isMoonshot || knownProviderFamily === "modelstudio" || endpointClass === "modelstudio-native";
	const isModelStudioLike = knownProviderFamily === "modelstudio" || endpointClass === "modelstudio-native" || isDefaultRoute && isDefaultRouteProvider(provider, "dashscope", "modelstudio", "qwen");
	const isZai = endpointClass === "zai-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "zai");
	const isDeepSeek = endpointClass === "deepseek-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "deepseek");
	const isTogether = knownProviderFamily === "together" || input.baseUrl?.includes("api.together.ai") === true || input.baseUrl?.includes("api.together.xyz") === true || isDefaultRoute && isDefaultRouteProvider(input.provider, "together");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || input.baseUrl?.includes("gateway.ai.cloudflare.com") === true;
	const isXiaomi = endpointClass === "xiaomi-native" || isDefaultRoute && isDefaultRouteProvider(input.provider, "xiaomi");
	const isNonStandard = endpointClass === "cerebras-native" || endpointClass === "chutes-native" || endpointClass === "deepseek-native" || endpointClass === "mistral-public" || endpointClass === "opencode-native" || endpointClass === "opencode-go-native" || endpointClass === "xai-native" || isXiaomi || isZai || isDefaultRoute && isDefaultRouteProvider(input.provider, "cerebras", "chutes", "deepseek", "opencode", "xai");
	const isOpenRouterLike = input.provider === "openrouter" || endpointClass === "openrouter";
	const isLocalEndpoint = endpointClass === "local";
	const usesMaxTokens = endpointClass === "chutes-native" || endpointClass === "mistral-public" || knownProviderFamily === "mistral" || isMoonshot || isCloudflareAiGateway || isZai || isTogether || isDefaultRoute && isDefaultRouteProvider(provider, "chutes");
	return {
		supportsStore: !isNonStandard && knownProviderFamily !== "mistral" && !usesExplicitProxyLikeEndpoint,
		supportsDeveloperRole: !isNonStandard && !isMoonshotLike && !usesConfiguredNonOpenAIEndpoint,
		supportsReasoningEffort: !isZai && !isTogether && knownProviderFamily !== "mistral" && endpointClass !== "xai-native" && !usesExplicitProxyLikeEndpoint,
		supportsUsageInStreaming: supportsOpenAICompletionsStreamingUsageCompat || !isNonStandard && (isLocalEndpoint || !usesConfiguredNonOpenAIEndpoint || supportsNativeStreamingUsageCompat),
		maxTokensField: usesMaxTokens ? "max_tokens" : "max_completion_tokens",
		thinkingFormat: isDeepSeek || isXiaomi ? "deepseek" : isZai ? "zai" : isTogether ? "together" : isOpenRouterLike ? "openrouter" : "openai",
		visibleReasoningDetailTypes: isOpenRouterLike ? ["response.output_text", "response.text"] : [],
		supportsStrictMode: !isZai && !usesConfiguredNonOpenAIEndpoint,
		supportsJsonSchemaResponseFormat: (endpointClass === "openai-public" || isDefaultRoute && isDefaultRouteProvider(provider, "openai")) && isKnownOpenAIJsonSchemaModelId(modelId),
		requiresReasoningContentOnAssistantMessages: isDeepSeek || isXiaomi,
		requiresNonEmptyUserOrAssistantMessage: isModelStudioLike,
		cacheControlFormat: isModelStudioLike && endpointClass !== "custom" || provider === "openrouter" && modelId?.startsWith("anthropic/") === true ? "anthropic" : void 0,
		sessionAffinityFormat: isOpenRouterLike ? "openrouter" : "openai",
		supportsLongCacheRetention: !isModelStudioLike && provider !== "cloudflare-workers-ai" && provider !== "cloudflare-ai-gateway" && knownProviderFamily !== "together" && !input.baseUrl?.includes("api.cloudflare.com") && !input.baseUrl?.includes("gateway.ai.cloudflare.com") && !input.baseUrl?.includes("api.together.ai") && !input.baseUrl?.includes("api.together.xyz")
	};
}
function resolveOpenAICompletionsCompatDefaultsFromCapabilities(input) {
	return resolveOpenAICompletionsCompatDefaults(input);
}
/** Detects endpoint capabilities and defaults for an OpenAI-completions model. */
function detectOpenAICompletionsCompat(model, resolveCapabilities) {
	const capabilities = (resolveCapabilities ?? ((input) => resolveProviderRequestCapabilities(input, model)))({
		provider: model.provider,
		api: "openai-completions",
		baseUrl: model.baseUrl,
		capability: "llm",
		transport: "stream",
		modelId: model.id,
		compat: model.compat && typeof model.compat === "object" ? model.compat : void 0
	});
	return {
		capabilities,
		defaults: resolveOpenAICompletionsCompatDefaultsFromCapabilities({
			provider: model.provider,
			modelId: model.id,
			baseUrl: model.baseUrl,
			...capabilities
		})
	};
}
function resolveSessionAffinity(model, detectedFormat) {
	if (model.compat?.sendSessionAffinityHeaders !== true) return "none";
	if (detectedFormat === "openrouter" || model.compat.thinkingFormat === "openrouter" || model.compat.openRouterRouting !== void 0) return "openrouter";
	return "openai";
}
/** Applies explicit model overrides once on top of the canonical transport defaults. */
function resolveOpenAICompletionsCompat(model, resolveCapabilities) {
	const { defaults } = detectOpenAICompletionsCompat(model, resolveCapabilities);
	const configured = model.compat;
	return {
		supportsStore: configured?.supportsStore ?? defaults.supportsStore,
		supportsDeveloperRole: configured?.supportsDeveloperRole ?? defaults.supportsDeveloperRole,
		supportsReasoningEffort: configured?.supportsReasoningEffort ?? defaults.supportsReasoningEffort,
		supportsUsageInStreaming: configured?.supportsUsageInStreaming ?? defaults.supportsUsageInStreaming,
		maxTokensField: configured?.maxTokensField ?? defaults.maxTokensField,
		requiresToolResultName: configured?.requiresToolResultName ?? false,
		requiresAssistantAfterToolResult: configured?.requiresAssistantAfterToolResult ?? false,
		requiresThinkingAsText: configured?.requiresThinkingAsText ?? false,
		requiresReasoningContentOnAssistantMessages: configured?.requiresReasoningContentOnAssistantMessages ?? defaults.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: configured?.thinkingFormat ?? defaults.thinkingFormat,
		openRouterRouting: configured?.openRouterRouting,
		vercelGatewayRouting: configured?.vercelGatewayRouting ?? {},
		zaiToolStream: configured?.zaiToolStream ?? false,
		supportsStrictMode: configured?.supportsStrictMode ?? defaults.supportsStrictMode,
		supportsJsonSchemaResponseFormat: configured?.supportsJsonSchemaResponseFormat ?? defaults.supportsJsonSchemaResponseFormat,
		cacheControlFormat: configured?.cacheControlFormat ?? defaults.cacheControlFormat,
		sessionAffinity: resolveSessionAffinity(model, defaults.sessionAffinityFormat),
		supportsPromptCacheKey: configured?.supportsPromptCacheKey ?? false,
		supportsLongCacheRetention: configured?.supportsLongCacheRetention ?? defaults.supportsLongCacheRetention,
		visibleReasoningDetailTypes: configured && "visibleReasoningDetailTypes" in configured ? configured.visibleReasoningDetailTypes ?? defaults.visibleReasoningDetailTypes : defaults.visibleReasoningDetailTypes,
		requiresNonEmptyUserOrAssistantMessage: defaults.requiresNonEmptyUserOrAssistantMessage
	};
}
//#endregion
//#region packages/ai/src/providers/openai-completions-tool-calls.ts
const MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES = 256e3;
const MAX_BUFFERED_LEGACY_FOLLOWING_DELTA_BYTES = 256e3;
const MAX_BUFFERED_LEGACY_FOLLOWING_DELTAS = 1024;
/** Keep encrypted provider reasoning attached to the first matching tool call. */
function createOpenAIEncryptedToolCallReasoningTracker() {
	const firstBlocks = /* @__PURE__ */ new Map();
	const pendingDetails = /* @__PURE__ */ new Map();
	return {
		rememberToolCall(id, block) {
			if (!id || firstBlocks.has(id)) return;
			firstBlocks.set(id, block);
			const pendingDetail = pendingDetails.get(id);
			if (pendingDetail) {
				block.thoughtSignature = pendingDetail;
				pendingDetails.delete(id);
			}
		},
		consumeDetails(details) {
			if (!Array.isArray(details)) return;
			for (const detail of details) {
				if (!isRecord(detail) || detail.type !== "reasoning.encrypted" || typeof detail.id !== "string" || detail.id.length === 0 || typeof detail.data !== "string" || detail.data.length === 0) continue;
				const serializedDetail = JSON.stringify(detail);
				const matchingBlock = firstBlocks.get(detail.id);
				if (matchingBlock) matchingBlock.thoughtSignature = serializedDetail;
				else pendingDetails.set(detail.id, serializedDetail);
			}
		}
	};
}
/** Normalize the SDK's legacy single-function lane into its modern tool-call shape. */
function createOpenAICompletionsToolCallDeltaNormalizer() {
	let sawModernToolCall = false;
	let pendingLegacyArgumentBytes = 0;
	let pendingFollowingDeltaBytes = 0;
	let pendingLegacyToolCall;
	const modernArguments = /* @__PURE__ */ new Map();
	const pendingFollowingDeltas = [];
	const takePendingFollowingDeltas = () => {
		pendingFollowingDeltaBytes = 0;
		return pendingFollowingDeltas.splice(0).map((delta) => ({
			delta,
			toolCalls: []
		}));
	};
	const bufferFollowingDelta = (delta) => {
		const nextDeltaBytes = Buffer.byteLength(JSON.stringify(delta), "utf8");
		if (pendingFollowingDeltaBytes + nextDeltaBytes > MAX_BUFFERED_LEGACY_FOLLOWING_DELTA_BYTES || pendingFollowingDeltas.length >= MAX_BUFFERED_LEGACY_FOLLOWING_DELTAS) throw new Error("Exceeded legacy tool-call content buffer limit");
		pendingFollowingDeltaBytes += nextDeltaBytes;
		pendingFollowingDeltas.push(delta);
	};
	const withoutToolCalls = (delta) => {
		const ordinaryDelta = { ...delta };
		delete ordinaryDelta.function_call;
		delete ordinaryDelta.tool_calls;
		return ordinaryDelta;
	};
	const hasObservableContent = (value) => {
		if (typeof value === "string") return value.length > 0;
		if (Array.isArray(value)) return value.some(hasObservableContent);
		if (isRecord(value)) return Object.entries(value).some(([field, nestedValue]) => field !== "type" && field !== "id" && field !== "index" && hasObservableContent(nestedValue));
		return false;
	};
	const hasOrdinaryContent = (delta) => Object.entries(delta).some(([field, value]) => field !== "role" && hasObservableContent(value));
	return (delta, finishReason) => {
		const ordinaryDelta = withoutToolCalls(delta);
		if (delta.tool_calls && delta.tool_calls.length > 0) {
			for (const toolCall of delta.tool_calls) {
				const index = typeof toolCall.index === "number" ? toolCall.index : void 0;
				const state = (index === void 0 ? void 0 : modernArguments.get(index)) ?? (toolCall.id ? modernArguments.get(toolCall.id) : void 0) ?? {
					bytes: 0,
					pendingHighSurrogate: false
				};
				if (index !== void 0) modernArguments.set(index, state);
				if (toolCall.id) modernArguments.set(toolCall.id, state);
				const argumentDelta = toolCall.function?.arguments ?? "";
				const append = measureUtf8AppendBytes(state.pendingHighSurrogate, argumentDelta);
				state.bytes += append.bytes;
				if (state.bytes > MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES) throw new Error("Exceeded tool-call argument buffer limit");
				state.pendingHighSurrogate = append.endsWithHighSurrogate;
			}
			const precedingDeltas = takePendingFollowingDeltas();
			sawModernToolCall = true;
			pendingLegacyArgumentBytes = 0;
			pendingLegacyToolCall = void 0;
			return [...precedingDeltas, {
				delta: ordinaryDelta,
				toolCalls: delta.tool_calls
			}];
		}
		const functionCall = delta.function_call;
		if (sawModernToolCall) return [{
			delta: ordinaryDelta,
			toolCalls: []
		}];
		const hadPendingLegacyCall = pendingLegacyToolCall !== void 0;
		const leadingDeltas = [];
		if (hasOrdinaryContent(ordinaryDelta)) {
			if (hadPendingLegacyCall) bufferFollowingDelta(ordinaryDelta);
			else leadingDeltas.push({
				delta: ordinaryDelta,
				toolCalls: []
			});
		}
		if (functionCall && (functionCall.name || functionCall.arguments)) {
			const nextFunctionName = pendingLegacyToolCall?.function?.name ? void 0 : functionCall.name;
			const nextArgumentBytes = Buffer.byteLength(functionCall.arguments ?? "", "utf8") + Buffer.byteLength(nextFunctionName ?? "", "utf8");
			if (pendingLegacyArgumentBytes + nextArgumentBytes > MAX_BUFFERED_TOOL_CALL_ARGUMENT_BYTES) throw new Error("Exceeded tool-call argument buffer limit");
			pendingLegacyArgumentBytes += nextArgumentBytes;
			pendingLegacyToolCall ??= {
				index: 0,
				id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
				type: "function",
				function: {}
			};
			const pendingFunction = pendingLegacyToolCall.function ??= {};
			if (nextFunctionName) pendingFunction.name = nextFunctionName;
			if (functionCall.arguments) pendingFunction.arguments = (pendingFunction.arguments ?? "") + functionCall.arguments;
		}
		if (!pendingLegacyToolCall) return leadingDeltas.length > 0 ? leadingDeltas : [{
			delta: ordinaryDelta,
			toolCalls: []
		}];
		if (finishReason === "function_call") {
			const confirmedLegacyToolCall = pendingLegacyToolCall;
			pendingLegacyToolCall = void 0;
			pendingLegacyArgumentBytes = 0;
			return [
				...leadingDeltas,
				{
					delta: {},
					toolCalls: [confirmedLegacyToolCall]
				},
				...takePendingFollowingDeltas()
			];
		}
		if (finishReason) {
			pendingLegacyArgumentBytes = 0;
			pendingLegacyToolCall = void 0;
			return [...leadingDeltas, ...takePendingFollowingDeltas()];
		}
		return leadingDeltas;
	};
}
/** Publish only executable calls; streaming scratch state never belongs in replay. */
function finalizeOpenAICompletionsToolCalls(output, options = {}) {
	const isToolCall = (block) => block.type === "toolCall";
	const hasToolCalls = output.content.some(isToolCall);
	if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";
	if (output.stopReason === "stop" && hasToolCalls && options.allowSilentToolCallPromotion !== false && !output.content.some((block) => {
		const candidate = block;
		return candidate.type === "text" && typeof candidate.text === "string" && candidate.text.trim().length > 0;
	})) output.stopReason = "toolUse";
	if (output.stopReason !== "toolUse") {
		if (hasToolCalls) output.content = output.content.filter((block) => !isToolCall(block));
		return;
	}
	const toolCalls = output.content.filter(isToolCall);
	const rejectToolCalls = () => {
		output.stopReason = "error";
		output.errorMessage = "Provider returned an incomplete or malformed tool call";
		output.content = output.content.filter((candidate) => !isToolCall(candidate));
	};
	if (toolCalls.some((call) => typeof call.name !== "string" || call.name.trim().length === 0 || typeof call.partialArgs !== "string" || call.partialArgs.trim().length === 0)) {
		rejectToolCalls();
		return;
	}
	try {
		finalizeTerminalToolCallArguments(toolCalls, (call) => call.partialArgs);
	} catch {
		rejectToolCalls();
		return;
	}
	for (let contentIndex = 0; contentIndex < output.content.length; contentIndex += 1) {
		const block = output.content[contentIndex];
		if (!block || !isToolCall(block)) continue;
		delete block.partialArgs;
		delete block.streamIndex;
		options.onConfirmedToolCall?.(block, contentIndex);
	}
}
//#endregion
//#region packages/ai/src/openai-completions-messages.ts
const EMPTY_TOOL_RESULT_TEXT = "(no output)";
function isTextContentBlock(block) {
	return block.type === "text";
}
function isThinkingContentBlock(block) {
	return block.type === "thinking";
}
function isToolCallBlock(block) {
	return block.type === "toolCall";
}
function sanitizeToolResultText(text, fallback) {
	const sanitized = sanitizeSurrogates(text);
	return sanitized.trim().length > 0 ? sanitized : fallback;
}
/** Whether replayed messages require a tools marker for proxy compatibility. */
function hasToolCallHistory(messages) {
	return messages.some((message) => message.role === "toolResult" || message.role === "assistant" && Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"));
}
/** Convert a normalized transcript to OpenAI Chat Completions messages. */
function convertMessages(model, context, compat, options = {}) {
	const params = [];
	const normalizeToolCallId = (id) => {
		if (id.includes("|")) return id.slice(0, id.indexOf("|")).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
		if (model.provider === "openai") return id.length > 40 ? truncateUtf16Safe(id, 40) : id;
		return id;
	};
	const transformedMessages = transformProviderMessages(context.messages, model, (id) => normalizeToolCallId(id));
	if (context.systemPrompt) {
		const role = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
		const systemPrompt = options.preserveSystemPromptCacheBoundary ? context.systemPrompt : stripSystemPromptCacheBoundary(context.systemPrompt);
		params.push({
			role,
			content: sanitizeSurrogates(systemPrompt)
		});
	}
	let lastRole = null;
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (!msg) continue;
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") params.push({
			role: "assistant",
			content: "I have processed the tool results."
		});
		if (msg.role === "user") {
			const isRuntimeContextCarrier = msg.runtimeContextCarrier === true;
			if (typeof msg.content === "string") {
				const userParam = {
					role: "user",
					content: sanitizeSurrogates(msg.content)
				};
				if (isRuntimeContextCarrier) options.cacheOptOutIndexes?.add(params.length);
				params.push(userParam);
			} else {
				const content = msg.content.map((item) => {
					if (item.type === "text") return {
						type: "text",
						text: sanitizeSurrogates(item.text)
					};
					if (item.type === "video") return {
						type: "video_url",
						video_url: { url: `data:${item.mimeType};base64,${item.data}` }
					};
					return {
						type: "image_url",
						image_url: { url: `data:${item.mimeType};base64,${item.data}` }
					};
				});
				if (content.length === 0) continue;
				const userParam = {
					role: "user",
					content
				};
				if (isRuntimeContextCarrier) options.cacheOptOutIndexes?.add(params.length);
				params.push(userParam);
			}
		} else if (msg.role === "assistant") {
			const assistantMsg = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null
			};
			const assistantTextParts = msg.content.filter(isTextContentBlock).filter((block) => block.text.trim().length > 0).map((block) => ({
				type: "text",
				text: sanitizeSurrogates(block.text)
			}));
			const assistantText = assistantTextParts.map((part) => part.text).join("\n");
			const nonEmptyThinkingBlocks = msg.content.filter(isThinkingContentBlock).filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) assistantMsg.content = [{
					type: "text",
					text: nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n")
				}, ...assistantTextParts];
				else {
					if (assistantText.length > 0) assistantMsg.content = assistantText;
					let signature = nonEmptyThinkingBlocks.at(0)?.thinkingSignature;
					if (model.provider === "opencode-go" && signature === "reasoning") signature = "reasoning_content";
					if (signature && signature.length > 0) assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
				}
			} else if (assistantText.length > 0) assistantMsg.content = assistantText;
			const toolCalls = msg.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((toolCall) => ({
					id: toolCall.id,
					type: "function",
					function: {
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments)
					}
				}));
				const reasoningDetails = toolCalls.flatMap((toolCall) => {
					const signature = toolCall.thoughtSignature;
					if (!signature) return [];
					try {
						const parsed = JSON.parse(signature);
						return parsed ? [parsed] : [];
					} catch {
						return [];
					}
				});
				if (reasoningDetails.length > 0) assistantMsg.reasoning_details = reasoningDetails;
			}
			if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning && assistantMsg.reasoning_content === void 0) assistantMsg.reasoning_content = "";
			const content = assistantMsg.content;
			if (!(content !== null && content !== void 0 && (typeof content === "string" ? content.length > 0 : content.length > 0)) && !assistantMsg.tool_calls) continue;
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks = [];
			let j = i;
			while (j < transformedMessages.length) {
				const toolMsg = transformedMessages.at(j);
				if (toolMsg?.role !== "toolResult") break;
				const textResult = extractToolResultText(toolMsg.content);
				const mediaPlaceholder = describeToolResultMediaPlaceholder(toolMsg.content);
				const hasImages = toolMsg.content.some(isImageWithMediaPayload);
				const toolResultMsg = {
					role: "tool",
					content: sanitizeToolResultText(textResult, mediaPlaceholder ?? EMPTY_TOOL_RESULT_TEXT),
					tool_call_id: toolMsg.toolCallId
				};
				if (compat.requiresToolResultName && toolMsg.toolName) toolResultMsg.name = toolMsg.toolName;
				params.push(toolResultMsg);
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) if (isImageWithMediaPayload(block)) imageBlocks.push({
						type: "image_url",
						image_url: { url: `data:${block.mimeType};base64,${block.data}` }
					});
				}
				j += 1;
			}
			i = j - 1;
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) params.push({
					role: "assistant",
					content: "I have processed the tool results."
				});
				params.push({
					role: "user",
					content: [{
						type: "text",
						text: "Attached image(s) from tool result:"
					}, ...imageBlocks]
				});
				lastRole = "user";
			} else lastRole = "toolResult";
			continue;
		}
		lastRole = msg.role;
	}
	return params;
}
//#endregion
//#region packages/ai/src/transports/openai-reasoning-compat.ts
/**
* OpenAI reasoning-effort compatibility helpers.
*
* Keeps provider metadata and built-in model exceptions on one path before request payloads are built.
*/
const OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS = /* @__PURE__ */ new Set(["gpt-5.1-codex-mini"]);
function readCompatReasoningEffortMap(compat) {
	const rawMap = asOptionalObjectRecord(asOptionalObjectRecord(compat)?.reasoningEffortMap);
	if (!rawMap) return {};
	return Object.fromEntries(Object.entries(rawMap).filter((entry) => typeof entry[0] === "string" && typeof entry[1] === "string"));
}
/** Resolves the reasoning effort remap for an OpenAI-compatible model. */
function resolveOpenAIReasoningEffortMap(model, fallbackMap = {}) {
	const provider = normalizeLowercaseStringOrEmpty(model.provider ?? "");
	const id = normalizeLowercaseStringOrEmpty(model.id ?? "");
	const builtinMap = provider === "openai" && OPENAI_MEDIUM_ONLY_REASONING_MODEL_IDS.has(id) ? {
		minimal: "medium",
		low: "medium"
	} : {};
	return {
		...fallbackMap,
		...builtinMap,
		...readCompatReasoningEffortMap(model.compat)
	};
}
//#endregion
//#region packages/ai/src/transports/openai-transport-params.ts
const MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS = 256;
const OPENAI_CODEX_RESPONSES_PROVIDERS = /* @__PURE__ */ new Set(["openai"]);
const loggedOpenAIStrictToolDowngradeDiagnosticKeys = /* @__PURE__ */ new Set();
function readToolPayloadField(record, field) {
	try {
		return Object.hasOwn(record, field) ? record[field] : void 0;
	} catch {
		return;
	}
}
function readCodeModePayloadToolName(tool) {
	if (!isRecord(tool)) return;
	const name = readToolPayloadField(tool, "name");
	if (typeof name === "string") return name;
	const fn = readToolPayloadField(tool, "function");
	if (!isRecord(fn)) return;
	const fnName = readToolPayloadField(fn, "name");
	return typeof fnName === "string" ? fnName : void 0;
}
function readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes) {
	if (!isRecord(tool)) return;
	const type = readToolPayloadField(tool, "type");
	if (typeof type === "string" && allowedHostedToolTypes?.has(type)) {
		try {
			if (Object.hasOwn(tool, "name") || Object.hasOwn(tool, "function") || Object.hasOwn(tool, "functionDeclarations") || Object.hasOwn(tool, "function_declarations")) return false;
		} catch {
			return false;
		}
		return `hosted:${type}`;
	}
	const name = readCodeModePayloadToolName(tool);
	return typeof name === "string" && isCodeModeModelVisibleToolName(name, visibleToolNames) ? `client:${name}` : void 0;
}
function readCodeModePayloadToolIdentities(payload) {
	if (!isRecord(payload)) return [];
	const tools = readToolPayloadField(payload, "tools");
	if (!Array.isArray(tools)) return [];
	return tools.flatMap((tool) => {
		if (!isRecord(tool)) return [];
		const identities = [];
		const name = readCodeModePayloadToolName(tool);
		if (name) identities.push(`client:${name}`);
		for (const key of ["functionDeclarations", "function_declarations"]) {
			const declarations = readToolPayloadField(tool, key);
			if (!Array.isArray(declarations)) continue;
			for (const declaration of declarations) {
				const declarationName = readCodeModePayloadToolName(declaration);
				if (declarationName) identities.push(`client:${declarationName}`);
			}
		}
		const type = readToolPayloadField(tool, "type");
		if (typeof type === "string" && type !== "function") identities.push(`hosted:${type}`);
		return identities;
	});
}
function filterCodeModePayloadTools(payload, visibleToolNames, allowedHostedToolTypes, observer) {
	if (!isRecord(payload)) return;
	const tools = readToolPayloadField(payload, "tools");
	if (!Array.isArray(tools)) return;
	const beforeToolIdentities = observer ? readCodeModePayloadToolIdentities(payload) : void 0;
	payload.tools = tools.flatMap((tool) => {
		const identity = readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes);
		if (identity) return [tool];
		if (identity === false) return [];
		if (!isRecord(tool)) return [];
		const filteredGroups = {};
		for (const key of ["functionDeclarations", "function_declarations"]) {
			const declarations = readToolPayloadField(tool, key);
			if (!Array.isArray(declarations)) continue;
			const filtered = declarations.filter((declaration) => {
				const declarationName = readCodeModePayloadToolName(declaration);
				return typeof declarationName === "string" && isCodeModeModelVisibleToolName(declarationName, visibleToolNames);
			});
			if (filtered.length > 0) filteredGroups[key] = filtered;
		}
		return Object.keys(filteredGroups).length > 0 ? [filteredGroups] : [];
	});
	if (beforeToolIdentities) observer?.({
		beforeToolIdentities,
		afterToolIdentities: readCodeModePayloadToolIdentities(payload)
	});
}
function resolveCodeModeResponsesVisibleToolNames(context) {
	return new Set((context.tools ?? []).map(readCodeModePayloadToolName).filter((name) => typeof name === "string"));
}
function enforceCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes, observer) {
	if (!isRecord(payload)) return;
	const tools = readToolPayloadField(payload, "tools");
	if (!Array.isArray(tools)) return;
	const beforeToolIdentities = observer ? readCodeModePayloadToolIdentities(payload) : void 0;
	payload.tools = tools.filter((tool) => Boolean(readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes)));
	if (beforeToolIdentities) observer?.({
		beforeToolIdentities,
		afterToolIdentities: readCodeModePayloadToolIdentities(payload)
	});
}
function assertCodeModeResponsesToolSurface(payload, visibleToolNames, allowedHostedToolTypes) {
	const tools = isRecord(payload) ? readToolPayloadField(payload, "tools") : void 0;
	if (!Array.isArray(tools)) throw new Error("Code mode payload tool surface violation: expected exec,wait; got no tools");
	const identities = tools.map((tool) => readCodeModePayloadToolIdentity(tool, visibleToolNames, allowedHostedToolTypes));
	const names = identities.flatMap((identity) => typeof identity === "string" && identity.startsWith("client:") ? [identity.slice(7)] : []).toSorted((left, right) => left.localeCompare(right));
	if (names.length >= 2 && identities.every((identity) => typeof identity === "string") && new Set(identities).size === identities.length && names.includes("exec") && names.includes("wait")) return;
	throw new Error(`Code mode payload tool surface violation: expected exec,wait plus direct-only tools; got ${names.length > 0 ? names.join(",") : "none"}`);
}
function buildOpenAIStrictToolDowngradeDiagnosticKey(diagnostics, context) {
	return sha256Hex(JSON.stringify({
		transport: context.transport,
		provider: context.model.provider ?? null,
		model: context.model.id ?? null,
		diagnostics: diagnostics.map((entry) => ({
			toolIndex: entry.toolIndex,
			toolName: entry.toolName ?? null,
			violations: entry.violations
		}))
	}));
}
function shouldLogOpenAIStrictToolDowngradeDiagnostic(diagnostics, context) {
	const key = buildOpenAIStrictToolDowngradeDiagnosticKey(diagnostics, context);
	if (loggedOpenAIStrictToolDowngradeDiagnosticKeys.has(key)) return false;
	if (loggedOpenAIStrictToolDowngradeDiagnosticKeys.size >= MAX_OPENAI_STRICT_TOOL_DOWNGRADE_DIAGNOSTIC_KEYS) loggedOpenAIStrictToolDowngradeDiagnosticKeys.clear();
	loggedOpenAIStrictToolDowngradeDiagnosticKeys.add(key);
	return true;
}
function resolveOpenAIStrictToolFlagWithDiagnostics(projection, strictSetting, context) {
	const strict = resolveOpenAIProjectedToolsStrictToolFlag(projection, strictSetting);
	if (strictSetting === true && strict === false) {
		const diagnostics = findOpenAIStrictToolProjectionDiagnostics(projection);
		getAiTransportHost().logDebug("openai-transport", () => {
			if (!shouldLogOpenAIStrictToolDowngradeDiagnostic(diagnostics, context)) return null;
			const sample = diagnostics.slice(0, 5).map((entry) => ({
				tool: entry.toolName ?? `tool[${entry.toolIndex}]`,
				violations: entry.violations.slice(0, 8)
			}));
			return {
				message: `OpenAI ${context.transport} tool schema strict mode downgraded to strict=false for ${context.model.provider ?? "unknown"}/${context.model.id ?? "unknown"} because ${diagnostics.length} tool schema(s) are not strict-compatible`,
				data: {
					transport: context.transport,
					provider: context.model.provider,
					model: context.model.id,
					incompatibleToolCount: diagnostics.length,
					sample
				}
			};
		});
	}
	return strict;
}
function isOpenAICodexResponsesModel(model) {
	return OPENAI_CODEX_RESPONSES_PROVIDERS.has(model.provider) && (model.api === "openai-chatgpt-responses" || model.api === "openclaw-openai-chatgpt-responses-transport");
}
function isNativeOpenAICodexResponsesBaseUrl(baseUrl) {
	const trimmed = typeof baseUrl === "string" ? baseUrl.trim() : "";
	if (!trimmed) return false;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (url.hostname.toLowerCase() !== "chatgpt.com") return false;
		const pathname = url.pathname.replace(/\/+$/u, "").toLowerCase();
		return [
			"/backend-api",
			"/backend-api/v1",
			"/backend-api/codex",
			"/backend-api/codex/v1"
		].includes(pathname);
	} catch {
		return false;
	}
}
function usesNativeOpenAICodexResponsesBackend(model) {
	return isOpenAICodexResponsesModel(model) && isNativeOpenAICodexResponsesBaseUrl(model.baseUrl);
}
function buildOpenAIClientHeaders(model, context, optionHeaders, turnHeaders, sessionId) {
	const providerHeaders = { ...model.headers };
	if (model.provider === "github-copilot") Object.assign(providerHeaders, getAiTransportHost().buildCopilotDynamicHeaders(context.messages));
	const callerHeaders = {
		...optionHeaders,
		...turnHeaders
	};
	const resolvedHeaders = resolveProviderRequestPolicyConfig(model, {
		provider: model.provider,
		api: model.api,
		baseUrl: model.baseUrl,
		capability: "llm",
		transport: "stream",
		providerHeaders,
		callerHeaders: Object.keys(callerHeaders).length > 0 ? callerHeaders : void 0,
		precedence: "caller-wins"
	}).headers ?? {};
	if (sessionId && !Object.keys(resolvedHeaders).some((key) => normalizeLowercaseStringOrEmpty(key) === "session_id") && usesNativeOpenAICodexResponsesBackend(model)) resolvedHeaders.session_id = clampOpenAIPromptCacheKey(sessionId) ?? sessionId;
	return resolvedHeaders;
}
function resolveOpenAISdkTimeoutMs(model, timeoutMs) {
	return resolveModelRequestTimeoutMs(model, timeoutMs);
}
function buildOpenAISdkClientOptions(model) {
	const timeout = resolveOpenAISdkTimeoutMs(model);
	return {
		...timeout === void 0 ? {} : { timeout },
		maxRetries: 0
	};
}
function buildOpenAISdkRequestOptions(model, signal, options) {
	const timeout = resolveOpenAISdkTimeoutMs(model, options?.timeoutMs);
	const headers = options?.stream === true && usesNativeOpenAICodexResponsesBackend(model) ? { Accept: "text/event-stream" } : void 0;
	if (timeout === void 0 && !signal && !headers) return;
	return {
		...headers ? { headers } : {},
		...signal ? { signal } : {},
		...timeout !== void 0 ? { timeout } : {},
		maxRetries: 0
	};
}
function getCompat(model) {
	const resolved = resolveOpenAICompletionsCompat(model);
	const compat = model.compat ?? {};
	return {
		...resolved,
		cacheControlFormat: resolved.cacheControlFormat,
		reasoningEffortMap: resolveOpenAIReasoningEffortMap(model, {}),
		openRouterRouting: resolved.openRouterRouting ?? {},
		vercelGatewayRouting: resolved.vercelGatewayRouting,
		requiresStringContent: compat.requiresStringContent ?? false,
		strictMessageKeys: compat.strictMessageKeys === true
	};
}
//#endregion
//#region packages/ai/src/transports/openai-completions-dsml.ts
const DEEPSEEK_DSML_TOOL_KINDS = [
	"tool_calls",
	"tool_call",
	"function_calls"
];
const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_SHARED_TOOL_OPEN_TOKENS; // dsml-spaced-calls-v1
const DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES = DEEPSEEK_DSML_MARKERS.map((marker) => `<${marker}invoke`);
const DEEPSEEK_DSML_INVOKE_OPEN_TAG = new RegExp(`^<${DEEPSEEK_DSML_MARKER_PATTERN}invoke\\b[^<>]*>$`);
const DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN = Math.max(...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length));
const DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN = Math.max(...DEEPSEEK_DSML_TOOL_OPEN_TOKENS.map((token) => token.length + 1), ...DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES.map((token) => token.length + 2));
const MAX_DSML_RECOVERY_BUFFER_BYTES = 256e3;
const DEEPSEEK_DSML_SCAN_BATCH_CHARS = 65536;
function createDsmlRecoverer() {
	let buffer = "";
	let bufferBytes = 0;
	let bufferEndsWithHighSurrogate = false;
	let pendingScanChars = 0;
	let activeOpenToken = null;
	let blockScanState = { offset: 0 };
	const resetBlockScan = () => {
		activeOpenToken = null;
		pendingScanChars = 0;
		blockScanState = { offset: 0 };
	};
	const consume = (final) => {
		const output = [];
		while (buffer) {
			const open = activeOpenToken ? {
				index: 0,
				token: activeOpenToken
			} : findEarliestStringToken(buffer, DEEPSEEK_DSML_TOOL_OPEN_TOKENS);
			if (!open) {
				resetBlockScan();
				if (final) {
					output.push({
						kind: "text",
						text: buffer
					});
					buffer = "";
					bufferBytes = 0;
					bufferEndsWithHighSurrogate = false;
					return output;
				}
				const keep = longestDeepSeekDsmlToolOpenPrefixSuffixLength(buffer);
				const emitLength = buffer.length - keep;
				if (emitLength > 0) {
					const emitted = buffer.slice(0, emitLength);
					output.push({
						kind: "text",
						text: emitted
					});
					bufferBytes -= Buffer.byteLength(emitted, "utf8");
					buffer = buffer.slice(emitted.length);
					if (!buffer) bufferEndsWithHighSurrogate = false;
				}
				return output;
			}
			if (open.index > 0) {
				const prefix = buffer.slice(0, open.index);
				output.push({
					kind: "text",
					text: prefix
				});
				bufferBytes -= Buffer.byteLength(prefix, "utf8");
				buffer = buffer.slice(prefix.length);
				resetBlockScan();
			}
			activeOpenToken = open.token;
			if (blockScanState.offset === 0) blockScanState.offset = open.token.length;
			const blockScan = scanDeepSeekDsmlToolBlock(buffer, open.token.replace("<", "</"), open.token.length, blockScanState);
			if (blockScan.kind === "nested-open") throw new Error("Nested DeepSeek DSML recovery wrappers are not supported");
			const close = blockScan.kind === "close" ? blockScan : null;
			if (!close) {
				if (final) {
					output.push({
						kind: "text",
						text: buffer
					});
					buffer = "";
					bufferBytes = 0;
					bufferEndsWithHighSurrogate = false;
					return output;
				}
				if (bufferBytes > MAX_DSML_RECOVERY_BUFFER_BYTES) throw new Error("Exceeded DeepSeek DSML recovery buffer limit");
				return output;
			}
			resetBlockScan();
			const body = buffer.slice(open.token.length, close.index);
			const blockText = buffer.slice(0, close.index + close.token.length);
			if (Buffer.byteLength(blockText, "utf8") > MAX_DSML_RECOVERY_BUFFER_BYTES) throw new Error("Exceeded DeepSeek DSML recovery buffer limit");
			const recoveredToolCalls = parseDeepSeekDsmlToolCallBlock(body);
			if (recoveredToolCalls.length > 0) output.push(...recoveredToolCalls);
			else output.push({
				kind: "text",
				text: blockText
			});
			bufferBytes -= Buffer.byteLength(blockText, "utf8");
			buffer = buffer.slice(blockText.length);
			if (!buffer) bufferEndsWithHighSurrogate = false;
		}
		return output;
	};
	return {
		push(chunk) {
			const append = measureUtf8AppendBytes(bufferEndsWithHighSurrogate, chunk);
			bufferBytes += append.bytes;
			bufferEndsWithHighSurrogate = append.endsWithHighSurrogate;
			buffer += chunk;
			pendingScanChars += chunk.length;
			if (activeOpenToken && pendingScanChars < DEEPSEEK_DSML_SCAN_BATCH_CHARS && !chunk.includes("<") && !chunk.includes(">") && bufferBytes <= MAX_DSML_RECOVERY_BUFFER_BYTES) return [];
			pendingScanChars = 0;
			return consume(false);
		},
		flush() {
			return consume(true);
		}
	};
}
function parseDeepSeekDsmlToolCallBlock(body) {
	const toolCalls = [];
	const invokeOpenRegex = new RegExp(`<${DEEPSEEK_DSML_MARKER_PATTERN}invoke\\b([^<>]*)>`, "g");
	let openMatch;
	while ((openMatch = invokeOpenRegex.exec(body)) !== null) {
		const invokeBodyStart = openMatch.index + openMatch[0].length;
		const invokeCloseToken = `</${openMatch[1]}invoke>`;
		const invokeCloseIndex = body.indexOf(invokeCloseToken, invokeBodyStart);
		if (invokeCloseIndex === -1) break;
		const invokeBody = body.slice(invokeBodyStart, invokeCloseIndex);
		invokeOpenRegex.lastIndex = invokeCloseIndex + invokeCloseToken.length;
		const invokeName = parseXmlAttribute(openMatch[2] ?? "", "name");
		if (!invokeName) continue;
		const parsedArguments = parseDeepSeekDsmlInvokeArguments(invokeBody);
		if (!parsedArguments) continue;
		toolCalls.push({
			kind: "toolCall",
			name: invokeName,
			arguments: parsedArguments,
			partialArgs: JSON.stringify(parsedArguments)
		});
	}
	return toolCalls;
}
function parseDeepSeekDsmlInvokeArguments(body) {
	const args = {};
	const parameterRegex = new RegExp(`<${DEEPSEEK_DSML_MARKER_PATTERN}parameter\\b([^>]*)>([\\s\\S]*?)</\\1parameter>`, "g");
	let parameterMatch;
	while ((parameterMatch = parameterRegex.exec(body)) !== null) {
		const name = parseXmlAttribute(parameterMatch[2] ?? "", "name");
		if (!name) continue;
		const rawValue = parameterMatch[3] ?? "";
		if (rawValue.length === 0) continue;
		args[name] = decodeDeepSeekDsmlText(rawValue);
	}
	if (Object.keys(args).length > 0) return args;
	const trimmed = body.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (isRecord(parsed) && Object.keys(parsed).length > 0) return parsed;
	} catch {
		return null;
	}
	return null;
}
const xmlAttributeRegexCache = /* @__PURE__ */ new Map();
function xmlAttributeRegex(name) {
	const cached = xmlAttributeRegexCache.get(name);
	if (cached) return cached;
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(`\\b${escaped}=("([^"]*)"|'([^']*)'|([^\\s>]+))`);
	xmlAttributeRegexCache.set(name, pattern);
	return pattern;
}
function parseXmlAttribute(attributes, name) {
	const match = xmlAttributeRegex(name).exec(attributes);
	const value = match?.[2] ?? match?.[3] ?? match?.[4];
	return value ? decodeDeepSeekDsmlText(value) : null;
}
function decodeDeepSeekDsmlText(value) {
	return value.replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}
function findEarliestStringToken(text, tokens, fromIndex = 0) {
	let best = null;
	for (const token of tokens) {
		const index = text.indexOf(token, fromIndex);
		if (index !== -1 && (!best || index < best.index)) best = {
			index,
			token
		};
	}
	return best;
}
function scanDeepSeekDsmlToolBlock(text, closeToken, contentStartIndex, state) {
	while (state.offset < text.length) {
		if (state.invoke?.kind === "open") {
			const nextOpen = text.indexOf("<", state.offset);
			const nextClose = text.indexOf(">", state.offset);
			if (nextClose === -1 && nextOpen === -1) {
				state.offset = text.length;
				return { kind: "incomplete" };
			}
			if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
				state.invoke = void 0;
				state.offset = nextOpen;
				continue;
			}
			const invokeOpenTag = text.slice(state.invoke.start, nextClose + 1);
			const open = DEEPSEEK_DSML_INVOKE_OPEN_TAG.exec(invokeOpenTag);
			if (!open) {
				state.offset = state.invoke.start + 1;
				state.invoke = void 0;
				continue;
			}
			state.invoke = {
				kind: "body",
				closeToken: `</${open[1]}invoke>`
			};
			state.offset = nextClose + 1;
			continue;
		}
		if (state.invoke?.kind === "body") {
			const invokeCloseIndex = text.indexOf(state.invoke.closeToken, state.offset);
			if (invokeCloseIndex === -1) {
				state.offset = Math.max(0, text.length - DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN + 1);
				return { kind: "incomplete" };
			}
			state.offset = invokeCloseIndex + state.invoke.closeToken.length;
			state.invoke = void 0;
			continue;
		}
		const toolOpen = findEarliestStringToken(text, DEEPSEEK_DSML_TOOL_OPEN_TOKENS, state.offset);
		const toolCloseIndex = text.indexOf(closeToken, state.offset);
		const invokeOpen = findEarliestStringToken(text, DEEPSEEK_DSML_INVOKE_OPEN_PREFIXES, state.offset);
		const next = [
			toolOpen ? {
				kind: "nested-open",
				...toolOpen
			} : null,
			toolCloseIndex === -1 ? null : {
				kind: "close",
				index: toolCloseIndex,
				token: closeToken
			},
			invokeOpen ? {
				kind: "invoke-open",
				...invokeOpen
			} : null
		].filter((candidate) => candidate !== null).toSorted((left, right) => left.index - right.index)[0];
		if (!next) {
			state.offset = Math.max(contentStartIndex, text.length - DEEPSEEK_DSML_RECOVERY_MAX_BOUNDARY_LEN + 1);
			return { kind: "incomplete" };
		}
		if (next.kind === "invoke-open") {
			state.invoke = {
				kind: "open",
				start: next.index
			};
			state.offset = next.index + next.token.length;
			continue;
		}
		return next;
	}
	return { kind: "incomplete" };
}
function longestDeepSeekDsmlToolOpenPrefixSuffixLength(text) {
	const maxLength = Math.min(text.length, DEEPSEEK_DSML_TOOL_MAX_OPEN_TOKEN_LEN - 1);
	for (let length = maxLength; length > 0; length -= 1) {
		const suffix = text.slice(text.length - length);
		if (DEEPSEEK_DSML_TOOL_OPEN_TOKENS.some((token) => token.startsWith(suffix))) return length;
	}
	return 0;
}
//#endregion
//#region packages/ai/src/transports/openai-completions-stream.ts
function extractToolCallThoughtSignature(toolCall) {
	const tc = toolCall;
	if (!tc) return;
	const fromExtra = (tc.extra_content?.google)?.thought_signature;
	if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
	const fromFunction = tc.function?.thought_signature;
	if (typeof fromFunction === "string" && fromFunction.length > 0) return fromFunction;
	const fromToolCall = tc.thought_signature;
	return typeof fromToolCall === "string" && fromToolCall.length > 0 ? fromToolCall : void 0;
}
async function processCompletionsStream(responseStream, output, model, stream, options) {
	const MAX_POST_TOOL_CALL_BUFFER_BYTES = 256e3;
	const directMode = options?.mode === "direct";
	const emitReasoning = options?.emitReasoning ?? true;
	const compat = getCompat(model);
	const visibleReasoningDetailTypes = new Set(compat.visibleReasoningDetailTypes);
	// dsml-spaced-calls-v1: direct calls hide DSML text too, but never recover tools from it
	const shouldFilterDeepSeekDsmlText = compat.thinkingFormat === "deepseek";
	const deepSeekTextFilter = shouldFilterDeepSeekDsmlText ? createDeepSeekTextFilter() : null;
	const deepSeekToolCallRecoverer = !directMode && shouldFilterDeepSeekDsmlText ? createDsmlRecoverer() : null;
	const reasoningTagTextPartitioner = createReasoningTagTextPartitioner();
	if (options?.strictReasoningTags) reasoningTagTextPartitioner.markStrict();
	let currentBlock = null;
	let directTextBlock = null;
	let directThinkingBlock = null;
	let currentTextSource;
	let pendingInterruptedTextBlock = null;
	let confirmedInterruptedTextBlock = null;
	let pendingPostToolCallDeltas = [];
	let pendingPostToolCallBytes = 0;
	let isFlushingPendingPostToolCallDeltas = false;
	const toolCallBlocksByIndex = /* @__PURE__ */ new Map();
	const toolCallBlocksById = /* @__PURE__ */ new Map();
	const encryptedReasoning = directMode ? createOpenAIEncryptedToolCallReasoningTracker() : void 0;
	const toolArgumentPreviewSchedules = /* @__PURE__ */ new WeakMap();
	const provisionalCommentaryTags = directMode ? options.provisionalCommentaryTags : /* @__PURE__ */ new Map();
	const contentBlockIndices = /* @__PURE__ */ new WeakMap();
	const toolCallBlockIndices = /* @__PURE__ */ new WeakMap();
	let explicitVisibleTextBlocks;
	const normalizeToolCallDeltas = createOpenAICompletionsToolCallDeltaNormalizer();
	let finishReason;
	let sawNativeToolCallDelta = false;
	const blockIndex = () => directMode && currentBlock && currentBlock.type !== "toolCall" ? contentBlockIndices.get(currentBlock) ?? output.content.length - 1 : output.content.length - 1;
	const measureUtf8Bytes = (text) => Buffer.byteLength(text, "utf8");
	let chunkPushedEvent = false;
	const pushStreamEvent = (event) => {
		chunkPushedEvent = true;
		stream.push(event);
	};
	const queuePostToolCallDelta = (next) => {
		const nextBytes = measureUtf8Bytes(next.text);
		if (pendingPostToolCallBytes + nextBytes > MAX_POST_TOOL_CALL_BUFFER_BYTES) throw new Error("Exceeded post-tool-call delta buffer limit");
		pendingPostToolCallBytes += nextBytes;
		const previous = pendingPostToolCallDeltas[pendingPostToolCallDeltas.length - 1];
		if (!previous || previous.kind !== next.kind || previous.kind === "text" && next.kind === "text" && previous.source !== next.source) {
			pendingPostToolCallDeltas.push(next);
			return;
		}
		if (next.kind === "thinking" && previous.kind === "thinking") {
			if (previous.signature !== next.signature) {
				pendingPostToolCallDeltas.push(next);
				return;
			}
			previous.text += next.text;
			return;
		}
		previous.text += next.text;
	};
	const appendThinkingDeltaInternal = (reasoningDelta) => {
		if (directMode && directThinkingBlock) currentBlock = directThinkingBlock;
		if (!currentBlock || currentBlock.type !== "thinking") {
			options?.beforeContentBlock?.("thinking");
			const thinkingSignature = reasoningDelta.signature;
			currentBlock = {
				type: "thinking",
				thinking: "",
				...thinkingSignature ? { thinkingSignature } : {}
			};
			if (directMode) {
				directTextBlock = null;
				directThinkingBlock = currentBlock;
			}
			output.content.push(currentBlock);
			contentBlockIndices.set(currentBlock, output.content.length - 1);
			pushStreamEvent({
				type: "thinking_start",
				contentIndex: blockIndex(),
				partial: output
			});
		}
		currentBlock.thinking += reasoningDelta.text;
		pushStreamEvent({
			type: "thinking_delta",
			contentIndex: blockIndex(),
			delta: reasoningDelta.text,
			partial: output
		});
	};
	const appendTextDeltaInternal = (text, source) => {
		if (directMode && directTextBlock) currentBlock = directTextBlock;
		if (currentBlock?.type === "text" && currentTextSource !== source) currentBlock = null;
		if (!currentBlock || currentBlock.type !== "text") {
			options?.beforeContentBlock?.("text");
			currentBlock = {
				type: "text",
				text: ""
			};
			currentTextSource = source;
			if (directMode) {
				directTextBlock = currentBlock;
				directThinkingBlock = null;
			}
			if (source === "reasoning_detail") (explicitVisibleTextBlocks ??= /* @__PURE__ */ new Set()).add(currentBlock);
			output.content.push(currentBlock);
			contentBlockIndices.set(currentBlock, output.content.length - 1);
			pushStreamEvent({
				type: "text_start",
				contentIndex: blockIndex(),
				partial: output
			});
		}
		currentBlock.text += text;
		if (pendingInterruptedTextBlock && text.trim()) {
			confirmedInterruptedTextBlock = pendingInterruptedTextBlock;
			pendingInterruptedTextBlock = null;
		}
		pushStreamEvent({
			type: "text_delta",
			contentIndex: blockIndex(),
			delta: text,
			...directMode ? { partial: output } : {}
		});
	};
	const flushPendingPostToolCallDeltas = () => {
		if (isFlushingPendingPostToolCallDeltas || currentBlock?.type === "toolCall" || pendingPostToolCallDeltas.length === 0) return;
		isFlushingPendingPostToolCallDeltas = true;
		const bufferedDeltas = pendingPostToolCallDeltas;
		pendingPostToolCallDeltas = [];
		pendingPostToolCallBytes = 0;
		for (const delta of bufferedDeltas) if (delta.kind === "text") appendTextDeltaInternal(delta.text, delta.source);
		else if (emitReasoning) appendThinkingDeltaInternal(delta);
		isFlushingPendingPostToolCallDeltas = false;
	};
	const appendThinkingDelta = (reasoningDelta) => {
		flushPendingPostToolCallDeltas();
		appendThinkingDeltaInternal(reasoningDelta);
	};
	const appendTextDelta = (text, source) => {
		flushPendingPostToolCallDeltas();
		appendTextDeltaInternal(text, source);
	};
	const appendVisibleTextDelta = (text) => {
		if (!text) return;
		if (currentBlock?.type === "toolCall" && !directMode) queuePostToolCallDelta({
			kind: "text",
			text
		});
		else appendTextDelta(text);
	};
	const appendReasoningDeltas = (reasoningDeltas) => {
		for (const reasoningDelta of reasoningDeltas) {
			if (reasoningDelta.kind === "thinking" && !emitReasoning) continue;
			if (currentBlock?.type === "toolCall" && !directMode) {
				queuePostToolCallDelta({ ...reasoningDelta });
				continue;
			}
			if (reasoningDelta.kind === "text") appendTextDelta(reasoningDelta.text, reasoningDelta.source);
			else if (emitReasoning) appendThinkingDelta(directMode && model.provider === "opencode-go" && reasoningDelta.signature === "reasoning" ? {
				...reasoningDelta,
				signature: "reasoning_content"
			} : reasoningDelta);
		}
	};
	// dsml-prefaced-calls-v1: DSML calls recovered from text, which always arrive with finish_reason "stop"
	const recoveredDsmlToolCalls = new WeakSet();
	const appendRecoveredToolCall = (toolCall) => {
		if (currentBlock?.type === "toolCall") {
			currentBlock = null;
			flushPendingPostToolCallDeltas();
		}
		rememberPendingCommentaryTags(provisionalCommentaryTags, tagPendingCommentaryText(output.content));
		const block = {
			type: "toolCall",
			id: `call_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
			name: toolCall.name,
			arguments: toolCall.arguments,
			partialArgs: toolCall.partialArgs
		};
		toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
		recoveredDsmlToolCalls.add(block); // dsml-prefaced-calls-v1
		currentBlock = block;
		output.content.push(block);
		toolCallBlockIndices.set(block, output.content.length - 1);
		pushStreamEvent({
			type: "toolcall_start",
			contentIndex: toolCallBlockIndices.get(block) ?? -1,
			partial: output
		});
		pushStreamEvent({
			type: "toolcall_delta",
			contentIndex: toolCallBlockIndices.get(block) ?? -1,
			delta: toolCall.partialArgs,
			partial: output
		});
	};
	const appendFilteredVisibleTextDelta = (text) => {
		const recoveredParts = deepSeekToolCallRecoverer?.push(text) ?? [{
			kind: "text",
			text
		}];
		for (const recoveredPart of recoveredParts) {
			if (recoveredPart.kind === "toolCall") {
				appendRecoveredToolCall(recoveredPart);
				continue;
			}
			const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
			for (const part of parts) appendVisibleTextDelta(part);
		}
	};
	const flushDeepSeekToolCallRecovererAtEnd = () => {
		const recoveredParts = deepSeekToolCallRecoverer?.flush();
		if (!recoveredParts) return;
		for (const recoveredPart of recoveredParts) {
			if (recoveredPart.kind === "toolCall") {
				appendRecoveredToolCall(recoveredPart);
				continue;
			}
			const parts = deepSeekTextFilter?.push(recoveredPart.text) ?? [recoveredPart.text];
			for (const part of parts) appendVisibleTextDelta(part);
		}
	};
	const flushDeepSeekTextFilterAtEnd = () => {
		const parts = deepSeekTextFilter?.flush();
		if (!parts) return;
		for (const part of parts) appendVisibleTextDelta(part);
	};
	const appendRoutedContentDelta = (delta) => {
		if (delta.kind === "text") {
			appendFilteredVisibleTextDelta(delta.text);
			return;
		}
		if (!emitReasoning) return;
		if (currentBlock?.type === "toolCall" && !directMode) queuePostToolCallDelta(delta);
		else appendThinkingDelta(delta);
	};
	const appendPartitionedVisibleDelta = (delta) => {
		if (delta.kind === "text") appendFilteredVisibleTextDelta(delta.text);
	};
	const emitReasoningUsageActivity = (hasReasoningUsageActivity) => {
		if (directMode || !hasReasoningUsageActivity || chunkPushedEvent || !emitReasoning) return;
		const latestBlock = output.content[output.content.length - 1];
		if (currentBlock?.type === "text" || currentBlock?.type === "toolCall") return;
		if (latestBlock?.type === "text" || latestBlock?.type === "toolCall") return;
		appendThinkingDelta({ text: "" });
	};
	const flushReasoningTagTextPartitioner = () => {
		for (const delta of reasoningTagTextPartitioner.flush()) appendPartitionedVisibleDelta(delta);
	};
	const sealTextBeforeReasoning = () => {
		if (currentBlock?.type !== "text" && !reasoningTagTextPartitioner.hasPending()) return;
		flushReasoningTagTextPartitioner();
		if (currentBlock?.type !== "text") return;
		if (currentTextSource !== "reasoning_detail" && currentBlock.text.trim()) pendingInterruptedTextBlock = currentBlock;
		currentBlock = null;
		if (directMode) directTextBlock = null;
		currentTextSource = void 0;
	};
	const beginReasoning = (hasFollowingVisibleText, forceStrict = false) => {
		if (!output.openclawDelivery?.textPhaseRequiresTerminal) output.openclawDelivery = {
			...output.openclawDelivery,
			textPhaseRequiresTerminal: true
		};
		if (forceStrict || reasoningTagTextPartitioner.hasPending()) reasoningTagTextPartitioner.markStrict();
		if (!hasFollowingVisibleText || !reasoningTagTextPartitioner.hasPendingSyntax()) sealTextBeforeReasoning();
	};
	const cooperativeScheduler = directMode ? void 0 : createModelStreamCooperativeScheduler(options?.signal);
	const guardedStream = withFirstStreamEventTimeout(responseStream, {
		provider: model.provider,
		api: model.api,
		model: model.id,
		timeoutMs: options?.firstEventTimeoutMs ?? 0,
		stage: "completions",
		abort: options?.abortFirstEventStream,
		onTimeout: options?.onFirstEventTimeout,
		hint: "The provider may be stalled while parsing the tool payload; retry with a smaller tool surface or enable OPENCLAW_DEBUG_MODEL_PAYLOAD=tools to inspect exposed tools."
	});
	for await (const rawChunk of guardedStream) {
		throwIfModelStreamAborted(options?.signal);
		chunkPushedEvent = false;
		if (!rawChunk || typeof rawChunk !== "object") {
			if (cooperativeScheduler) await cooperativeScheduler.afterEvent();
			continue;
		}
		notifyLlmRequestActivity(options?.signal);
		const chunk = rawChunk;
		output.responseId ||= chunk.id;
		if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) output.responseModel ||= chunk.model;
		let hasReasoningUsageActivity = false;
		if (chunk.usage) {
			output.usage = parseOpenAICompletionsUsage(chunk.usage, model, { includeReasoningTokens: !directMode });
			hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(chunk.usage);
		}
		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : void 0;
		if (!choice) {
			emitReasoningUsageActivity(hasReasoningUsageActivity);
			if (cooperativeScheduler) await cooperativeScheduler.afterEvent();
			continue;
		}
		const choiceUsage = choice.usage;
		if (!chunk.usage && choiceUsage) {
			output.usage = parseOpenAICompletionsUsage(choiceUsage, model, { includeReasoningTokens: !directMode });
			hasReasoningUsageActivity = hasOpenAICompletionsReasoningUsageActivity(choiceUsage);
		}
		if (choice.finish_reason) {
			const finishReasonResult = mapOpenAIStopReason(choice.finish_reason, { allowSingularToolCall: true });
			output.stopReason = finishReasonResult.stopReason;
			finishReason = finishReasonResult.stopReason;
			if (finishReasonResult.errorMessage) output.errorMessage = finishReasonResult.errorMessage;
		}
		const rawChoiceDelta = choice.delta ?? choice.message;
		if (!rawChoiceDelta) {
			emitReasoningUsageActivity(hasReasoningUsageActivity);
			if (cooperativeScheduler) await cooperativeScheduler.afterEvent();
			continue;
		}
		for (const normalizedDelta of normalizeToolCallDeltas(rawChoiceDelta, choice.finish_reason)) {
			const choiceDelta = normalizedDelta.delta;
			const deltaFields = choiceDelta;
			const reasoningBatch = readOpenAICompletionsReasoningBatch(deltaFields, visibleReasoningDetailTypes);
			const reasoningDeltas = reasoningBatch.deltas;
			const hasReasoningThinking = reasoningBatch.hasThinking;
			const contentDeltas = readOpenAICompletionsContentDeltas(choiceDelta.content, choiceDelta.refusal, reasoningBatch.mirroredThinking);
			const lastVisibleTextIndex = contentDeltas.findLastIndex((delta) => delta.kind === "text");
			const hasSameChunkVisibleText = reasoningBatch.hasVisibleText || lastVisibleTextIndex !== -1;
			if (hasReasoningThinking) {
				beginReasoning(hasSameChunkVisibleText, true);
				appendReasoningDeltas(reasoningDeltas);
			}
			for (const [contentDeltaIndex, contentDelta] of contentDeltas.entries()) if (contentDelta.kind === "text") {
				const routedDeltas = hasReasoningThinking ? reasoningTagTextPartitioner.push(contentDelta.text) : reasoningTagTextPartitioner.pushVisible(contentDelta.text);
				for (const routedDelta of routedDeltas) appendPartitionedVisibleDelta(routedDelta);
			} else {
				beginReasoning(contentDeltaIndex < lastVisibleTextIndex);
				appendRoutedContentDelta(contentDelta);
			}
			if (!hasReasoningThinking) appendReasoningDeltas(reasoningDeltas);
			const toolCallDeltas = normalizedDelta.toolCalls;
			if (toolCallDeltas.length > 0) {
				sawNativeToolCallDelta = true;
				flushReasoningTagTextPartitioner();
				rememberPendingCommentaryTags(provisionalCommentaryTags, tagPendingCommentaryText(output.content));
				for (const toolCall of toolCallDeltas) {
					const streamIndex = typeof toolCall.index === "number" ? toolCall.index : void 0;
					let block = streamIndex !== void 0 ? toolCallBlocksByIndex.get(streamIndex) : void 0;
					if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
					if (!block) {
						if (currentBlock?.type === "toolCall") {
							currentBlock = null;
							flushPendingPostToolCallDeltas();
						}
						const initialSig = directMode ? void 0 : extractToolCallThoughtSignature(toolCall);
						options?.beforeContentBlock?.("toolCall");
						if (directMode) directThinkingBlock = null;
						block = {
							type: "toolCall",
							id: toolCall.id || "",
							name: toolCall.function?.name || "",
							arguments: {},
							partialArgs: "",
							...initialSig ? { thoughtSignature: initialSig } : {}
						};
						encryptedReasoning?.rememberToolCall(block.id, block);
						toolArgumentPreviewSchedules.set(block, createToolArgumentPreviewSchedule());
						output.content.push(block);
						toolCallBlockIndices.set(block, output.content.length - 1);
						pushStreamEvent({
							type: "toolcall_start",
							contentIndex: toolCallBlockIndices.get(block) ?? -1,
							partial: output
						});
					}
					if (streamIndex !== void 0 && !toolCallBlocksByIndex.has(streamIndex)) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) {
						if (!directMode || !block.id) block.id = toolCall.id;
						toolCallBlocksById.set(toolCall.id, block);
						if (block.id === toolCall.id) encryptedReasoning?.rememberToolCall(toolCall.id, block);
					}
					currentBlock = block;
					const conflictingId = directMode && block.id && toolCall.id && block.id !== toolCall.id;
					if (toolCall.function?.name && !conflictingId) block.name = toolCall.function.name;
					const deltaSig = directMode ? void 0 : extractToolCallThoughtSignature(toolCall);
					if (deltaSig) block.thoughtSignature = deltaSig;
					const toolArgumentsDelta = toolCall.function?.arguments;
					if (toolArgumentsDelta) {
						block.partialArgs += toolArgumentsDelta;
						if (toolArgumentPreviewSchedules.get(block)?.(block.partialArgs.length)) block.arguments = parseStreamingJson(block.partialArgs);
					}
					if (toolArgumentsDelta || directMode) pushStreamEvent({
						type: "toolcall_delta",
						contentIndex: toolCallBlockIndices.get(block) ?? -1,
						delta: toolArgumentsDelta ?? "",
						partial: output
					});
				}
			}
			encryptedReasoning?.consumeDetails(deltaFields.reasoning_details);
		}
		flushPendingPostToolCallDeltas();
		emitReasoningUsageActivity(hasReasoningUsageActivity);
		if (cooperativeScheduler) await cooperativeScheduler.afterEvent();
	}
	if (!finishReason && (directMode || options?.sawStreamDONE?.() === false)) throw new Error("Stream ended without finish_reason");
	flushReasoningTagTextPartitioner();
	flushDeepSeekToolCallRecovererAtEnd();
	flushDeepSeekTextFilterAtEnd();
	currentBlock = null;
	flushPendingPostToolCallDeltas();
	// dsml-prefaced-calls-v1: a closed DSML call after a preface sentence is a tool turn
	if (output.stopReason === "stop" && finishReason === "stop") {
		const lastToolCallIndex = output.content.findLastIndex((block) => block.type === "toolCall");
		if (lastToolCallIndex >= 0 && output.content.every((block) => block.type !== "toolCall" || recoveredDsmlToolCalls.has(block)) && !output.content.slice(lastToolCallIndex + 1).some((block) => block.type === "text" && block.text.trim().length > 0)) output.stopReason = "toolUse";
	}
	finalizeOpenAICompletionsToolCalls(output, {
		allowSilentToolCallPromotion: finishReason === "stop" || sawNativeToolCallDelta && (options?.sawStreamDONE?.() ?? false),
		onConfirmedToolCall(block, contentIndex) {
			if (directMode || block.type !== "toolCall") return;
			pushStreamEvent({
				type: "toolcall_end",
				contentIndex,
				toolCall: block,
				partial: output
			});
		}
	});
	if (confirmedInterruptedTextBlock && output.stopReason !== "toolUse" && output.stopReason !== "error" && output.stopReason !== "aborted") tagInterruptedTextPhases(output.content, confirmedInterruptedTextBlock, explicitVisibleTextBlocks);
	if (output.stopReason !== "toolUse") clearPendingCommentaryText(provisionalCommentaryTags);
	if (output.stopReason === "error" || output.stopReason === "aborted") tagUnresolvedTextAsCommentary(output);
	if (output.stopReason === "toolUse") tagPendingCommentaryText(output.content);
}
function resolveOpenAICompletionsReasoningEffort(options) {
	return options?.reasoningEffort ?? options?.reasoning ?? "high";
}
function shouldEmitOpenAICompletionsReasoning(model, options) {
	if (!model.reasoning) return false;
	const effort = resolveOpenAICompletionsReasoningEffort(options);
	if (!effort || !isOpenAICompletionsThinkingEnabled(effort)) return false;
	return true;
}
function hasOpenAICompletionsReasoningUsageActivity(rawUsage) {
	const reasoningTokens = rawUsage.completion_tokens_details?.reasoning_tokens;
	return typeof reasoningTokens === "number" && Number.isFinite(reasoningTokens) && reasoningTokens > 0;
}
//#endregion
export { createDeepSeekTextFilter as C, tagUnresolvedTextAsCommentary as E, shouldOmitOllamaCompatResponseFormat as S, tagPendingCommentaryText as T, hasToolCallHistory as _, buildOpenAISdkClientOptions as a, resolveOpenAICompletionsCompat as b, filterCodeModePayloadTools as c, readCodeModePayloadToolName as d, resolveCodeModeResponsesVisibleToolNames as f, convertMessages as g, resolveOpenAIReasoningEffortMap as h, buildOpenAIClientHeaders as i, getCompat as l, usesNativeOpenAICodexResponsesBackend as m, shouldEmitOpenAICompletionsReasoning as n, buildOpenAISdkRequestOptions as o, resolveOpenAIStrictToolFlagWithDiagnostics as p, assertCodeModeResponsesToolSurface as r, enforceCodeModeResponsesToolSurface as s, processCompletionsStream as t, isOpenAICodexResponsesModel as u, finalizeOpenAICompletionsToolCalls as v, clearPendingCommentaryText as w, resolveOpenAICompletionsResponseFormat as x, detectOpenAICompletionsCompat as y };
