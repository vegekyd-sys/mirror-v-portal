import { i as formatThrownValue, n as createAssistantMessageDiagnostic, t as appendAssistantMessageDiagnostic } from "./diagnostics-CPeq9F7y.mjs";
import { t as AssistantMessageEventStream } from "./event-stream-uSMZJ3FA.mjs";
import { n as getAiTransportHost, r as resolveAiTransportHeaderSentinels } from "./host-BIaiBURL.mjs";
import { r as toErrorObject } from "./diagnostics-KhXK-QJI.mjs";
import { u as resolveTimerTimeoutMs } from "./base64-CEFBpSkN.mjs";
import { n as clampOpenAIPromptCacheKey } from "./openai-prompt-cache-mZTCdRPo.mjs";
import { d as stripSystemPromptCacheBoundary, n as buildBaseOptions } from "./simple-options-0PLDyJ-d.mjs";
import { c as parseRetryAfterSeconds, t as MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE } from "./transport-utils-CtuS1Upe.mjs";
import { n as getEnvApiKey } from "./env-api-keys-bktO00EJ.mjs";
import { C as headersToRecord, _ as transportAbortError, p as notifyProviderStreamOpened, t as assignTransportErrorDetails, y as withProviderResponseHook } from "./transport-stream-shared-CytPVLIg.mjs";
import { F as commitResponsesEncryptedContentAttempt, L as isInvalidEncryptedContentError, W as buildOpenAIResponsesReasoningReplayMetadata, a as resolveResponsesReasoningEffort, c as processResponsesStream, i as createResponsesAssistantOutput, n as applyResponsesServiceTierPricing, p as ResponsesStreamFailure, q as suppressOpenAIResponsesCompaction, r as convertResponsesMessages, s as convertResponsesToolPayload, z as resolveNextResponsesEncryptedContentAttempt } from "./openai-responses-shared-DiAdpNAM.mjs";
import { C as createOpenAIProviderAcceptanceHook, w as createOpenAIResponseHook } from "./openai-tool-schema-BMiHFH36.mjs";
import { a as withFirstStreamEventTimeout, i as getFirstStreamEventTimeoutMs, r as getFirstStreamEventTimeoutHandler, t as createFirstStreamEventAbortController } from "./stream-first-event-timeout-DcNjoFQE.mjs";
import { A as supportsOpenAITemperature, S as responsesPromptObserver } from "./openai-responses-compaction-window-DO7yV7az.mjs";
import { t as createSseByteGuard } from "./streaming-byte-guard-CC-HMn_u.mjs";
import { n as registerSessionResourceCleanup } from "./session-resources-CkR4WWy1.mjs";
import { t as createResponsesPromptEgressObserver } from "./openai-responses-prompt-observer-internal-C7x4IK7r.mjs";
import { n as resolveOpenAICodexAccountId } from "./openai-chatgpt-jwt-KWcgd0d_.mjs";
//#region packages/ai/src/providers/openai-chatgpt-responses-protocol.ts
const OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES = 16777216;
var CodexProtocolError = class extends Error {
	constructor(message, options) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
};
async function* parseOpenAIChatGptResponsesSse(response) {
	if (!response.body) return;
	const reader = response.body.getReader();
	const guard = createSseByteGuard(reader, {
		maxBytes: OPENAI_CHATGPT_RESPONSES_SUCCESS_BODY_MAX_BYTES,
		onOverflow: ({ size, maxBytes }) => /* @__PURE__ */ new Error(`OpenAI ChatGPT Responses success body exceeded ${maxBytes} bytes (received ${size})`)
	});
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await guard.read();
			if (value) buffer += decoder.decode(value, { stream: true });
			if (done) buffer += decoder.decode();
			while (true) {
				const searchable = !done && buffer.endsWith("\r") && !buffer.endsWith("\r\r") && !buffer.endsWith("\n\r") ? buffer.slice(0, -1) : buffer;
				const boundary = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r(?!\n)|\n)/.exec(searchable);
				if (!boundary) break;
				const chunk = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const dataLines = chunk.split(/\r\n|\r|\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim());
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						let event;
						try {
							event = JSON.parse(data);
						} catch (cause) {
							if (!(cause instanceof SyntaxError)) throw cause;
							throw new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { cause });
						}
						yield event;
					}
				}
			}
			if (done) break;
		}
	} finally {
		try {
			await guard.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}
//#endregion
//#region packages/ai/src/providers/openai-chatgpt-responses.ts
const dynamicImport = (specifier) => import(specifier);
function loadNodeOs() {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return null;
	return process.getBuiltinModule?.("node:os") ?? null;
}
const os = loadNodeOs();
const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_COMPRESSION_ZSTD_LEVEL = 3;
const CODEX_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set(["openai", "opencode"]);
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE = "websocket_connection_limit_reached";
const OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES = 16384;
const CODEX_RESPONSE_STATUSES = /* @__PURE__ */ new Set([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress"
]);
function resolveRequestTimeoutMs(options) {
	const timeoutMs = options?.timeoutMs;
	return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 1) : void 0;
}
function buildRequestSignal(baseSignal, timeoutMs) {
	if (timeoutMs === void 0) return baseSignal;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	if (!baseSignal) return timeoutSignal;
	return AbortSignal.any([baseSignal, timeoutSignal]);
}
function isRequestTimeoutError(error, callerSignal, requestSignal, timeoutMs) {
	if (timeoutMs === void 0 || callerSignal?.aborted || !requestSignal?.aborted) return false;
	if (!(error instanceof Error)) return false;
	return error.name === "AbortError" || error.name === "TimeoutError" || error.message === "Request was aborted";
}
/** Local-only failure category for transport diagnostics; never provider text. */
function classifyStreamFailure(error, signal, requestTimedOut) {
	if (requestTimedOut) return "timeout";
	if (signal?.aborted) return "caller-abort";
	return error instanceof ResponsesStreamFailure || error instanceof CodexApiError ? "provider-failure" : "transport";
}
function formatRequestTimeoutError(timeoutMs, cause) {
	return new Error(`Request timed out after ${timeoutMs}ms`, { cause: cause instanceof Error ? cause : void 0 });
}
function compressRequestBodyZstd(bodyJson) {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) return null;
	const zlib = process.getBuiltinModule?.("node:zlib");
	if (!zlib || typeof zlib.zstdCompressSync !== "function") return null;
	try {
		const compressed = zlib.zstdCompressSync(bodyJson, { params: { [zlib.constants.ZSTD_c_compressionLevel]: REQUEST_COMPRESSION_ZSTD_LEVEL } });
		return Uint8Array.from(compressed);
	} catch {
		return null;
	}
}
const streamOpenAICodexResponses = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const startedAt = Date.now();
		let requestTimeoutMs;
		let requestTimeoutSignal;
		let activeSignal;
		let firstEventAbort;
		const output = createResponsesAssistantOutput(model);
		try {
			const unresolvedApiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!unresolvedApiKey) throw new Error(`No API key for provider: ${model.provider}`);
			const apiKey = getAiTransportHost().resolveSecretSentinel(unresolvedApiKey);
			const modelHeaders = resolveAiTransportHeaderSentinels(model.headers);
			const optionHeaders = resolveAiTransportHeaderSentinels(options?.headers);
			const accountId = extractOpenAICodexAccountId(apiKey);
			const buildBody = async (replayMode) => {
				let body = buildRequestBody(model, context, options, replayMode);
				const nextBody = await options?.onPayload?.(body, model);
				if (nextBody !== void 0) body = nextBody;
				return body;
			};
			let semanticAttempt = {
				kind: "initial",
				request: await buildBody("checkpoint")
			};
			const commitSemanticAttempt = (attempt) => commitResponsesEncryptedContentAttempt(attempt, (checkpoint) => suppressOpenAIResponsesCompaction(output, model, options, checkpoint));
			const observePromptEgress = createResponsesPromptEgressObserver(options, context.systemPrompt);
			const sessionId = clampOpenAIPromptCacheKey(options?.sessionId);
			requestTimeoutMs = resolveRequestTimeoutMs(options);
			requestTimeoutSignal = buildRequestSignal(options?.signal, requestTimeoutMs);
			firstEventAbort = createFirstStreamEventAbortController(requestTimeoutSignal);
			activeSignal = firstEventAbort.signal;
			const requestOptions = activeSignal === options?.signal ? options : {
				...options,
				signal: activeSignal
			};
			const transport = options?.transport || "auto";
			const websocketDisabledForSession = transport === "auto" && isWebSocketSseFallbackActive(options?.sessionId);
			if (transport !== "sse" && !websocketDisabledForSession) {
				const websocketHeaders = buildWebSocketHeaders(modelHeaders, optionHeaders, accountId, apiKey, sessionId || createCodexRequestId());
				let websocketStarted = false;
				let websocketRequestSent = false;
				let retriedWebSocketConnectionLimit = false;
				while (true) {
					const activeAttempt = semanticAttempt;
					websocketStarted = false;
					websocketRequestSent = false;
					try {
						await processWebSocketStream(resolveCodexWebSocketUrl(model.baseUrl), activeAttempt.request, websocketHeaders, output, stream, model, () => {
							websocketStarted = true;
						}, () => {
							commitSemanticAttempt(activeAttempt);
						}, requestOptions, firstEventAbort.abort, observePromptEgress, activeAttempt.kind, () => {
							websocketRequestSent = true;
						});
						if (activeSignal?.aborted) throw transportAbortError(activeSignal);
						if (output.stopReason === "aborted" || output.stopReason === "error") throw new CodexApiError(output.errorMessage ?? "An unknown error occurred");
						stream.push({
							type: "done",
							reason: output.stopReason,
							message: output
						});
						stream.end();
						return;
					} catch (error) {
						const aborted = activeSignal?.aborted;
						const nextSemanticAttempt = !aborted && websocketRequestSent && !websocketStarted && error instanceof CodexApiError && isInvalidEncryptedContentError(error) ? await resolveNextResponsesEncryptedContentAttempt(activeAttempt, error, { buildFullHistoryRequest: () => buildBody("full-history") }) : void 0;
						if (nextSemanticAttempt) {
							semanticAttempt = nextSemanticAttempt;
							retriedWebSocketConnectionLimit = false;
							continue;
						}
						const connectionLimitBeforeStart = !websocketStarted && isWebSocketConnectionLimitReachedError(error);
						if (!aborted && connectionLimitBeforeStart && !retriedWebSocketConnectionLimit) {
							retriedWebSocketConnectionLimit = true;
							continue;
						}
						if (aborted || isCodexNonTransportError(error) && !connectionLimitBeforeStart) throw error;
						appendAssistantMessageDiagnostic(output, createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: transport,
							fallbackTransport: transport === "auto" && !websocketStarted ? "sse" : void 0,
							eventsEmitted: websocketStarted,
							phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
							requestBytes: new TextEncoder().encode(JSON.stringify(activeAttempt.request)).byteLength
						}));
						if (transport === "auto" && options?.sessionId) websocketSseFallbackSessions.add(options.sessionId);
						if (websocketStarted || transport !== "auto") throw error;
						break;
					}
				}
			}
			let response;
			while (true) {
				const activeAttempt = semanticAttempt;
				response = void 0;
				const sseHeaders = buildSSEHeaders(modelHeaders, optionHeaders, accountId, apiKey, sessionId);
				const bodyJson = JSON.stringify(activeAttempt.request);
				const compressedBody = model.provider === "openai" && !sseHeaders.has("content-encoding") ? compressRequestBodyZstd(bodyJson) : null;
				if (compressedBody) sseHeaders.set("content-encoding", "zstd");
				const sseBody = compressedBody ?? bodyJson;
				if (activeSignal?.aborted) throw transportAbortError(activeSignal);
				observePromptEgress?.(activeAttempt.request, {
					egress: "native-codex-sse",
					payloadVariant: activeAttempt.kind
				});
				let attemptResponse;
				try {
					attemptResponse = await fetch(resolveCodexUrl(model.baseUrl), {
						method: "POST",
						headers: sseHeaders,
						body: sseBody,
						signal: activeSignal
					});
				} catch (error) {
					if (error instanceof Error) {
						if (isRequestTimeoutError(error, options?.signal, requestTimeoutSignal, requestTimeoutMs) && requestTimeoutMs !== void 0) throw formatRequestTimeoutError(requestTimeoutMs, error);
						if (error.name === "AbortError" || error.message === "Request was aborted") throw new Error("Request was aborted", { cause: error });
						if (error.name === "TimeoutError" && requestTimeoutMs !== void 0) throw new Error(`Request timed out after ${requestTimeoutMs}ms`, { cause: error });
					}
					throw toErrorObject(error, String(error));
				}
				response = attemptResponse;
				if (attemptResponse.ok) {
					if (!attemptResponse.body) throw new Error("No response body");
					if (activeSignal?.aborted) throw transportAbortError(activeSignal);
					commitSemanticAttempt(activeAttempt);
					break;
				}
				const hookStream = withFirstStreamEventTimeout(withProviderResponseHook({
					signal: firstEventAbort.signal,
					abort: firstEventAbort.abort,
					hook: createOpenAIResponseHook(options?.onResponse, attemptResponse, model)
				}), {
					provider: model.provider,
					api: model.api,
					model: model.id,
					timeoutMs: getFirstStreamEventTimeoutMs(options) ?? 0,
					stage: "responses",
					abort: firstEventAbort.abort,
					onTimeout: getFirstStreamEventTimeoutHandler(options)
				});
				const [errorText] = await Promise.all([readChatGptResponsesErrorTextLimited(attemptResponse, activeSignal), hookStream[Symbol.asyncIterator]().next()]);
				const info = parseErrorResponseText(errorText, attemptResponse.status, attemptResponse.statusText);
				const retryAfterSeconds = parseRetryAfterSeconds(attemptResponse.headers);
				const retryAfterSuffix = Number.isFinite(retryAfterSeconds) ? `; Retry-After: ${Math.ceil(retryAfterSeconds ?? 0)} seconds` : "";
				const terminalResponseError = new CodexApiError(`${info.friendlyMessage || info.message}${retryAfterSuffix}`, { code: info.code });
				if (activeSignal?.aborted) throw transportAbortError(activeSignal);
				const nextSemanticAttempt = await resolveNextResponsesEncryptedContentAttempt(activeAttempt, terminalResponseError, { buildFullHistoryRequest: () => buildBody("full-history") });
				if (!nextSemanticAttempt) throw terminalResponseError;
				semanticAttempt = nextSemanticAttempt;
			}
			const hookedResponseStream = withProviderResponseHook({
				stream: mapCodexEvents(parseOpenAIChatGptResponsesSse(response)),
				signal: firstEventAbort.signal,
				abort: firstEventAbort.abort,
				hook: createOpenAIProviderAcceptanceHook(options, response, model),
				onReady: () => stream.push({
					type: "start",
					partial: output
				})
			});
			await processResponsesStream(hookedResponseStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
				abortFirstEventStream: firstEventAbort.abort,
				onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
				signal: options?.signal,
				reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
					sessionId: options?.sessionId,
					authProfileId: options?.authProfileId
				}),
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyResponsesServiceTierPricing(usage, serviceTier, model)
			});
			if (activeSignal?.aborted) throw transportAbortError(activeSignal);
			if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage ?? "An unknown error occurred");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			const requestTimedOut = isRequestTimeoutError(error, options?.signal, requestTimeoutSignal, requestTimeoutMs) && requestTimeoutMs !== void 0;
			const normalizedError = requestTimedOut && requestTimeoutMs !== void 0 ? formatRequestTimeoutError(requestTimeoutMs, error) : error;
			for (const block of output.content) delete block.partialJson;
			const terminal = assignTransportErrorDetails(output, normalizedError, options?.signal);
			getAiTransportHost().logWarn("openai-transport", "ChatGPT Responses stream terminated", {
				provider: model.provider,
				api: model.api,
				model: model.id,
				transport: options?.transport || "auto",
				elapsedMs: Math.max(0, Date.now() - startedAt),
				stopReason: terminal.stopReason,
				failureKind: classifyStreamFailure(error, options?.signal, requestTimedOut)
			});
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
const streamSimpleOpenAICodexResponses = (model, context, options) => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
	const resolvedOptions = {
		...buildBaseOptions(model, options, apiKey),
 firsttextMetricCallId: options?.requestId,
		authProfileId: options?.authProfileId,
		reasoningEffort: resolveResponsesReasoningEffort(model, options?.reasoning)
	};
	responsesPromptObserver.copy(options, resolvedOptions);
	return streamOpenAICodexResponses(model, context, resolvedOptions);
};
function buildRequestBody(model, context, options, replayMode = "checkpoint") {
	const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {
		includeSystemPrompt: false,
		replayResponsesItemIds: false,
		sessionId: options?.sessionId,
		authProfileId: options?.authProfileId,
		replayMode
	});
	const body = {
		model: model.id,
		store: false,
		stream: true,
		instructions: stripSystemPromptCacheBoundary(context.systemPrompt ?? "") || "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: options?.cacheRetention === "none" ? void 0 : clampOpenAIPromptCacheKey(options?.promptCacheKey ?? options?.sessionId)
	};
	if (options?.temperature !== void 0 && supportsOpenAITemperature(model)) body.temperature = options.temperature;
	if (options?.serviceTier !== void 0) body.service_tier = options.serviceTier;
	if (context.tools) {
		const converted = convertResponsesToolPayload(context.tools, { strict: null });
		if (converted.tools.length > 0) {
			body.tools = converted.tools;
			body.tool_choice = "auto";
			body.parallel_tool_calls = true;
		}
	}
	if (options?.reasoningEffort !== void 0) {
		const effort = options.reasoningEffort === "none" ? model.thinkingLevelMap?.off ?? "none" : model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		if (effort !== null) body.reasoning = {
			effort,
			summary: options.reasoningSummary ?? "auto"
		};
	}
	return body;
}
function resolveCodexServiceTier(responseServiceTier, requestServiceTier) {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) return requestServiceTier;
	return responseServiceTier ?? requestServiceTier;
}
function resolveCodexUrl(baseUrl) {
	const normalized = (baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}
function resolveCodexWebSocketUrl(baseUrl) {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}
var CodexApiError = class extends Error {
	constructor(message, options) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
};
function isCodexNonTransportError(error) {
	return error instanceof CodexApiError || error instanceof CodexProtocolError || error instanceof ResponsesStreamFailure;
}
function isWebSocketConnectionLimitReachedError(error) {
	return error instanceof CodexApiError && error.code === WEBSOCKET_CONNECTION_LIMIT_REACHED_CODE;
}
function extractCodexEventError(event) {
	const nested = event.error && typeof event.error === "object" ? event.error : void 0;
	return {
		code: typeof event.code === "string" ? event.code : typeof nested?.code === "string" ? nested.code : void 0,
		message: typeof event.message === "string" ? event.message : typeof nested?.message === "string" ? nested.message : void 0
	};
}
async function* mapCodexEvents(events) {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : void 0;
		if (!type) continue;
		if (type === "error") {
			const { code, message } = extractCodexEventError(event);
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code,
				payload: event
			});
		}
		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = event.response;
			const normalizedResponse = response ? {
				...response,
				status: normalizeCodexStatus(response.status)
			} : response;
			yield {
				...event,
				type: type === "response.done" ? "response.completed" : type,
				response: normalizedResponse
			};
			return;
		}
		yield event;
	}
}
function normalizeCodexStatus(status) {
	if (typeof status !== "string") return;
	return CODEX_RESPONSE_STATUSES.has(status) ? status : void 0;
}
const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 3e5;
const SESSION_WEBSOCKET_MAX_AGE_MS = 33e5;
const websocketSessionCache = /* @__PURE__ */ new Map();
const websocketSseFallbackSessions = /* @__PURE__ */ new Set();
let cachedWebsocket = null;
function resetOpenAICodexWebSocketStateForTest() {
	cachedWebsocket = null;
	websocketSseFallbackSessions.clear();
}
function closeOpenAICodexWebSocketSessions(sessionId) {
	const closeEntry = (entry) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1e3, "debug_close");
	};
	if (sessionId) {
		websocketSseFallbackSessions.delete(sessionId);
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) closeEntry(entry);
	websocketSessionCache.clear();
	websocketSseFallbackSessions.clear();
}
registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);
function isWebSocketSseFallbackActive(sessionId) {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}
async function getWebSocketConstructor() {
	if (cachedWebsocket) return cachedWebsocket;
	if (process?.versions?.bun && (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)) {
		const getProxyForUrl = (await dynamicImport("proxy-from-env")).getProxyForUrl;
		cachedWebsocket = class extends WebSocket {
			constructor(url, options) {
				let opts;
				if (Array.isArray(options) || typeof options === "string") opts = { protocols: options };
				else opts = { ...options };
				const proxy = getProxyForUrl(url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
				super(url, {
					...opts,
					...proxy ? { proxy } : {}
				});
			}
		};
		return cachedWebsocket;
	}
	const ctor = globalThis.WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor;
}
var WebSocketCloseError = class extends Error {
	constructor(message, options) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
};
function getWebSocketReadyState(socket) {
	const readyState = socket.readyState;
	return typeof readyState === "number" ? readyState : void 0;
}
function isWebSocketReusable(socket) {
	const readyState = getWebSocketReadyState(socket);
	return readyState === void 0 || readyState === 1;
}
function isWebSocketSessionExpired(entry) {
	return Date.now() - entry.createdAt >= SESSION_WEBSOCKET_MAX_AGE_MS;
}
function closeWebSocketSilently(socket, code = 1e3, reason = "done") {
	try {
		socket.close(code, reason);
	} catch {}
}
function deleteOwnedWebSocketSession(sessionId, entry) {
	if (websocketSessionCache.get(sessionId) === entry) websocketSessionCache.delete(sessionId);
}
function setOwnedWebSocketSession(sessionId, entry, expected) {
	if (websocketSessionCache.get(sessionId) === expected) {
		websocketSessionCache.set(sessionId, entry);
		return true;
	}
	return false;
}
function scheduleSessionWebSocketExpiry(sessionId, entry) {
	if (entry.idleTimer) clearTimeout(entry.idleTimer);
	entry.idleTimer = setTimeout(() => {
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1e3, "idle_timeout");
		deleteOwnedWebSocketSession(sessionId, entry);
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
}
async function connectWebSocket(url, headers, signal, metric) {
 metric?.("ws-connect-start");
	const WebSocketCtor = await getWebSocketConstructor();
	if (!WebSocketCtor) throw new Error("WebSocket transport is not available in this runtime");
	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];
	return new Promise((resolve, reject) => {
		let settled = false;
		let socket;
		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
 metric?.("ws-socket-created");
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		const onOpen = () => {
 metric?.("ws-open");
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError = (event) => {
			const error = extractWebSocketError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onClose = (event) => {
			const error = extractWebSocketCloseError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close(1e3, "aborted");
			reject(/* @__PURE__ */ new Error("Request was aborted"));
		};
		const cleanup = () => {
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
	});
}
async function acquireWebSocket(url, headers, sessionId, signal, metric) {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, metric);
		return {
			socket,
			release: ({ keep } = {}) => {
				if (keep === false) {
					closeWebSocketSilently(socket);
					return;
				}
				closeWebSocketSilently(socket);
			}
		};
	}
	const cached = websocketSessionCache.get(sessionId);
 metric?.(!cached ? "ws-cache-miss" : cached.busy ? "ws-cache-busy" : "ws-cache-idle");
	let expectedCacheValue = cached;
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = void 0;
		}
		if (!cached.busy && isWebSocketSessionExpired(cached)) {
			closeWebSocketSilently(cached.socket, 1e3, "connection_age_limit");
			deleteOwnedWebSocketSession(sessionId, cached);
			expectedCacheValue = void 0;
		} else if (!cached.busy && isWebSocketReusable(cached.socket)) {
 metric?.("ws-cache-reused");
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						deleteOwnedWebSocketSession(sessionId, cached);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				}
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, metric);
			return {
				socket,
				release: () => {
					closeWebSocketSilently(socket);
				}
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			deleteOwnedWebSocketSession(sessionId, cached);
			expectedCacheValue = void 0;
		}
	}
	const socket = await connectWebSocket(url, headers, signal, metric);
	const entry = {
		socket,
		busy: true,
		createdAt: Date.now()
	};
	const ownsCache = setOwnedWebSocketSession(sessionId, entry, expectedCacheValue);
	return {
		socket,
		entry: ownsCache ? entry : void 0,
		release: ({ keep } = {}) => {
			if (!ownsCache || !keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				deleteOwnedWebSocketSession(sessionId, entry);
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		}
	};
}
function extractWebSocketError(event) {
	if (event && typeof event === "object") {
		const message = "message" in event ? event.message : void 0;
		if (typeof message === "string" && message.length > 0) return new Error(message);
		const nestedError = "error" in event ? event.error : void 0;
		if (nestedError instanceof Error && nestedError.message.length > 0) return nestedError;
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = nestedError.message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) return new Error(nestedMessage);
		}
	}
	return /* @__PURE__ */ new Error("WebSocket error");
}
function extractWebSocketCloseError(event) {
	if (event && typeof event === "object") {
		const code = "code" in event ? event.code : void 0;
		const reason = "reason" in event ? event.reason : void 0;
		const wasClean = "wasClean" in event ? event.wasClean : void 0;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) reasonText = " message too big";
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : void 0,
			reason: typeof reason === "string" && reason.length > 0 ? reason : void 0,
			wasClean: typeof wasClean === "boolean" ? wasClean : void 0
		});
	}
	return /* @__PURE__ */ new Error("WebSocket closed");
}
async function* parseWebSocket(socket, signal) {
	const queue = [];
	let pending = null;
	let done = false;
	let failed = null;
	let sawCompletion = false;
	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};
	const onMessage = (event) => {
		const data = event && typeof event === "object" && "data" in event ? event.data : void 0;
		if (typeof data !== "string") {
			failed = new CodexProtocolError(MALFORMED_STREAMING_FRAGMENT_ERROR_MESSAGE, { payload: data });
			done = true;
			wake();
			return;
		}
		try {
			const parsed = JSON.parse(data);
			const type = typeof parsed.type === "string" ? parsed.type : "";
			if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
				sawCompletion = true;
				done = true;
			}
			queue.push(parsed);
			wake();
		} catch (cause) {
			failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
				cause,
				payload: data
			});
			done = true;
			wake();
		}
	};
	const onError = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};
	const onClose = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) failed = extractWebSocketCloseError(event);
		done = true;
		wake();
	};
	const onAbort = () => {
		failed = /* @__PURE__ */ new Error("Request was aborted");
		done = true;
		wake();
	};
	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);
	try {
		while (true) {
			if (signal?.aborted) throw transportAbortError(signal);
			const next = queue.shift();
			if (next !== void 0) {
				yield next;
				continue;
			}
			if (done) break;
			await new Promise((resolve) => {
				pending = resolve;
			});
		}
		if (failed) throw toErrorObject(failed, "Non-Error thrown");
		if (!sawCompletion) throw new Error("WebSocket stream closed before response.completed");
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}
function requestBodyWithoutInput(body) {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}
function responseInputsEqual(a, b) {
	return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}
function requestBodiesMatchExceptInput(a, b) {
	return JSON.stringify(requestBodyWithoutInput(a)) === JSON.stringify(requestBodyWithoutInput(b));
}
function getCachedWebSocketInputDelta(body, continuation) {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) return;
	const currentInput = body.input ?? [];
	const baseline = [...continuation.lastRequestBody.input ?? [], ...continuation.lastResponseItems];
	if (currentInput.length < baseline.length) return;
	if (!responseInputsEqual(currentInput.slice(0, baseline.length), baseline)) return;
	return currentInput.slice(baseline.length);
}
function buildCachedWebSocketRequestBody(entry, body) {
	const continuation = entry.continuation;
	if (!continuation) return body;
	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = void 0;
		return body;
	}
	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta
	};
}
async function* startWebSocketOutputOnFirstEvent(events, output, stream, onFirstProviderEvent, reportStreamOpened, onStart) {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onFirstProviderEvent();
			onStart();
			await reportStreamOpened();
			stream.push({
				type: "start",
				partial: output
			});
		}
		yield event;
	}
}
async function processWebSocketStream(url, body, headers, output, stream, model, onFirstProviderEvent, onStart, options, abortFirstEventStream, observePromptEgress, payloadVariant = "initial", onRequestSent) {
	const metric=createFirsttextWsMetric(options);
 metric("ws-acquire-start");
 const { socket, entry, release } = await acquireWebSocket(url, headers, options?.sessionId, options?.signal, metric);
 metric("ws-acquired");
 const firstMessage=() => { metric("ws-first-inbound"); socket.removeEventListener("message", firstMessage); };
 socket.addEventListener("message", firstMessage);
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	const fullBody = body;
	const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
	try {
		if (options?.signal?.aborted) throw transportAbortError(options.signal);
		observePromptEgress?.(requestBody, {
			egress: "native-codex-websocket",
			payloadVariant
		});
		metric("ws-send-start");
 socket.send(JSON.stringify({
			type: "response.create",
			...requestBody
		}));
		metric("ws-send-return");
 onRequestSent?.();
		await processResponsesStream(startWebSocketOutputOnFirstEvent(mapCodexEvents(parseWebSocket(socket, options?.signal)), output, stream, onFirstProviderEvent, () => { metric("ws-first-provider-event"); return notifyProviderStreamOpened({
			options,
			cancelStream: () => {
				keepConnection = false;
				closeWebSocketSilently(socket);
			}
		}); }, onStart), output, stream, model, {
			serviceTier: options?.serviceTier,
			firstEventTimeoutMs: getFirstStreamEventTimeoutMs(options),
			abortFirstEventStream,
			onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),
			signal: options?.signal,
			reasoningReplayMetadata: buildOpenAIResponsesReasoningReplayMetadata(model, {
				sessionId: options?.sessionId,
				authProfileId: options?.authProfileId
			}),
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyResponsesServiceTierPricing(usage, serviceTier, model)
		});
		if (options?.signal?.aborted) keepConnection = false;
		else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(model, { messages: [output] }, CODEX_TOOL_CALL_PROVIDERS, {
				includeSystemPrompt: false,
				replayResponsesItemIds: false,
				sessionId: options?.sessionId,
				authProfileId: options?.authProfileId
			}).filter((item) => item.type !== "function_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems
			};
		}
	} catch (error) {
		if (entry) entry.continuation = void 0;
		keepConnection = false;
		throw error;
	} finally {
		socket.removeEventListener("message", firstMessage);
 metric("ws-release");
 release({ keep: keepConnection });
	}
}
async function readChatGptResponsesErrorTextLimited(response, signal) {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let total = 0;
	let text = "";
	let reachedLimit = false;
	let completed = false;
	let cancelPromise;
	const cancel = () => {
		cancelPromise ??= reader.cancel(signal?.reason).catch(() => {});
		return cancelPromise;
	};
	const onAbort = () => {
		cancel();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				completed = true;
				break;
			}
			if (!value || value.byteLength === 0) continue;
			const remaining = OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES - total;
			if (remaining <= 0) {
				reachedLimit = true;
				break;
			}
			const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
			total += chunk.byteLength;
			text += decoder.decode(chunk, { stream: true });
			if (total >= OPENAI_CHATGPT_RESPONSES_ERROR_BODY_MAX_BYTES) {
				reachedLimit = true;
				break;
			}
		}
		if (!reachedLimit) text += decoder.decode();
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (!completed) await cancel();
		try {
			reader.releaseLock();
		} catch {}
	}
	return text;
}
function parseErrorResponseText(raw, status, statusText) {
	let message = raw || statusText || "Request failed";
	let friendlyMessage;
	let code;
	try {
		const err = JSON.parse(raw)?.error;
		if (err) {
			code = err.code || err.type || void 0;
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code ?? "") || status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at ? Math.max(0, Math.round((err.resets_at * 1e3 - Date.now()) / 6e4)) : void 0;
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${mins !== void 0 ? ` Try again in ~${mins} min.` : ""}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}
	return {
		...code ? { code } : {},
		message,
		friendlyMessage
	};
}
function extractOpenAICodexAccountId(token) {
	const accountId = resolveOpenAICodexAccountId(token);
	if (accountId) return accountId;
	throw new Error("Failed to extract accountId from token");
}
function createCodexRequestId() {
	const crypto = globalThis.crypto;
	if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
	if (typeof crypto?.getRandomValues === "function") {
		const bytes = crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(16));
		return `codex_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
	}
	throw new Error("Secure random request id generation is unavailable");
}
function buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token) {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) headers.set(key, value);
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "openclaw");
	const userAgent = os ? `openclaw (${os.platform()} ${os.release()}; ${os.arch()})` : "openclaw (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}
function buildSSEHeaders(initHeaders, additionalHeaders, accountId, token, sessionId) {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");
	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}
	return headers;
}
function buildWebSocketHeaders(initHeaders, additionalHeaders, accountId, token, requestId) {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session_id", requestId);
	return headers;
}
//#endregion
export { closeOpenAICodexWebSocketSessions, extractOpenAICodexAccountId, resetOpenAICodexWebSocketStateForTest, streamOpenAICodexResponses, streamSimpleOpenAICodexResponses };

// firsttext-ws-metrics-v1: timing-only, one closure per request; no payload/header access.
function createFirsttextWsMetric(options) {
 const id=options?.firsttextMetricCallId ?? options?.requestId;
 const callId=typeof id==='string' && /^[0-9a-f-]{36}:model:[0-9]+$/.test(id) ? id : undefined;
 return (stage) => {
  try { console.error('[firsttext-ws-metrics] '+JSON.stringify({callId,at:Date.now(),pid:process.pid,stage})); } catch {}
 };
}
