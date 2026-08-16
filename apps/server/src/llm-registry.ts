/**
 * Typed view over the SDK's `ModelRegistry` + `CustomProvidersRegistry`
 * (§2 of docs/GENERATIVE.md).
 *
 * Why a thin wrapper rather than reusing `ModelInfo` from `routes.ts`? The
 * UI surface here is richer than the session-list picker:
 *
 *   - We expose `pricing` (the SDK populates `cost.input/output/cacheRead/cacheWrite`,
 *     currently in USD per token — the wrapper re-projects to microcents so the
 *     chat-usage telemetry can accumulate without floating-point drift).
 *   - We expose `capabilities.{tools, vision, json, thinking}` instead of the
 *     SDK's lower-level `input: ("text" | "image")[] + reasoning: boolean`.
 *   - We expose `baseUrl` and `api` for the registry surface (the SDK already
 *     exposes these per-model via `getProviderBaseUrl`).
 *
 * The wrapper is additive: `CustomProvidersRegistry` (which already writes the
 * user-managed providers into the SDK registry) and the in-process bridge (which
 * reads model lists via `registry.getAll()`) keep working unchanged.
 *
 * `complete()` is the deck's uniform streaming entrypoint: it resolves the
 * model through the same `ModelRegistry` the in-process bridge uses, then
 * forwards to `pi-ai.streamSimple(model, context, opts)` and re-projects the
 * SDK's `AssistantMessageEvent` stream onto the deck's `LlmChunk` union.
 * Provider routing + auth reuse what `bridge/in-process.ts` already set up.
 */
import type { ChatUsage } from "@omp-deck/protocol";
import {
	streamSimple,
	type Api,
	type AssistantMessageEventStream,
	type AssistantMessageEvent,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@oh-my-pi/pi-ai";

import { getCustomProviders } from "./custom-providers.ts";
import { getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

const log = logger("llm-registry");

export type DeckLLMApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface DeckLLMProvider {
	id: string;
	displayName: string;
	baseUrl?: string;
	api: DeckLLMApi;
	models: DeckLLMModel[];
}

export interface DeckLLMPricing {
	inputMicrocents: number;
	outputMicrocents: number;
}

export interface DeckLLMCapabilities {
	tools: boolean;
	vision: boolean;
	json: boolean;
	thinking: boolean;
}

export interface DeckLLMModel {
	id: string;
	displayName: string;
	contextWindow: number;
	pricing: DeckLLMPricing;
	capabilities: DeckLLMCapabilities;
}

/** A single token delta or terminal frame yielded by `complete()`. */
export type LlmChunk =
	| { type: "text"; delta: string }
	| { type: "thinking"; delta: string }
	| {
			type: "tool_call";
			id: string;
			tool: string;
			args: Record<string, unknown>;
			requiredPermissions?: string[];
	  }
	| { type: "usage"; usage: ChatUsage }
	| { type: "error"; error: string }
	| { type: "done" };

export interface LlmMessage {
	role: "user" | "assistant" | "system" | "tool" | "tool_call" | "tool_result";
	content: string;
	/** Tool call rows carry this; tools consume `content` only. */
	toolCall?: {
		id: string;
		tool: string;
		args: Record<string, unknown>;
		requiredPermissions?: string[];
	};
	/**
	 * Optional typed pairing key for `tool_result` rows. When the SDK's
	 * `AssistantMessage` carries a `ToolCall` we forward its id here so the
	 * provider can re-pair the result with the originating call regardless
	 * of the wire shape (Anthropic, OpenAI Responses, Gemini all key off
	 * tool-call id). Falls back to `name` for legacy rows — gholam-chat
	 * used to write the id into `name`, that pairing is preserved.
	 */
	toolCallId?: string;
	name?: string;
}

export interface LlmToolSpec {
	name: string;
	description: string;
	schema: Record<string, unknown>;
}

export interface DeckLLMProviderRegistry {
	list(): Promise<DeckLLMProvider[]>;
	resolve(modelRef: { provider: string; id: string }): Promise<ResolvedDeckModel | null>;
	complete(opts: {
		model: string;
		messages: LlmMessage[];
		tools?: LlmToolSpec[];
		signal?: AbortSignal;
	}): AsyncIterable<LlmChunk>;
}

/** Provider + model lookup result. Exported so callers don't reach for
 *  `Awaited<ReturnType<...>>` to express this shape. */
export interface ResolvedDeckModel {
	provider: DeckLLMProvider;
	model: DeckLLMModel;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const USD_DOLLAR_MICROCENTS = 100_000_000;

function toMicrocents(usd: number | undefined): number {
	if (typeof usd !== "number" || !Number.isFinite(usd)) return 0;
	return Math.round(usd * USD_DOLLAR_MICROCENTS);
}

function isVisionEnabled(input: unknown): boolean {
	if (!Array.isArray(input)) return false;
	return input.some((m) => m === "image");
}

/** Cheap test: does the model's API kind support structured JSON out of the box?
 *  For v1 we say yes for the OpenAI family + anthropic-messages; the SDK wires
 *  tool-call JSON so this is well-supported in practice. */
function supportsJson(api: DeckLLMApi): boolean {
	return api !== "google-generative-ai";
}

interface SdkModelLike {
	id: string;
	provider: string;
	name?: string;
	contextWindow?: number;
	input?: unknown;
	reasoning?: boolean;
	reasoningEfforts?: string[];
	supportsTools?: boolean;
	cost?: { input?: number; output?: number };
}

function mapApi(api: string | undefined): DeckLLMApi {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "anthropic-messages":
		case "google-generative-ai":
			return api;
		default:
			return "openai-completions";
	}
}

function modelToView(providerBaseUrl: string | undefined, providerApi: DeckLLMApi, m: SdkModelLike): DeckLLMModel {
	return {
		id: m.id,
		displayName: m.name ?? m.id,
		contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 0,
		pricing: {
			inputMicrocents: toMicrocents(m.cost?.input),
			outputMicrocents: toMicrocents(m.cost?.output),
		},
		capabilities: {
			tools: m.supportsTools ?? true,
			vision: isVisionEnabled(m.input),
			json: supportsJson(providerApi),
			thinking: m.reasoning === true || (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 0),
		},
	};
}

// ─── Adapter bridge ──────────────────────────────────────────────────────

/**
 * Compose providers from two sources: the SDK's `ModelRegistry.getAll()`
 * (built-in + dynamically-registered providers, including the live
 * `CustomProvidersRegistry` mirror) AND any custom providers the SDK doesn't
 * know about yet (first-load before the watcher syncs). For v1 the SDK source
 * is canonical; the custom-providers file is sourced for display only.
 */
export class DeckLLMRegistry implements DeckLLMProviderRegistry {
	private cache?: { fetchedAt: number; providers: DeckLLMProvider[] };
	private readonly cacheMs = 5_000;

	async list(): Promise<DeckLLMProvider[]> {
		const cached = this.cache;
		if (cached && Date.now() - cached.fetchedAt < this.cacheMs) return cached.providers;
		const providers = await this.computeList();
		this.cache = { fetchedAt: Date.now(), providers };
		return providers;
	}

	private async computeList(): Promise<DeckLLMProvider[]> {
		const byProvider = new Map<string, DeckLLMProvider>();
		try {
			const registry = await getDeckModelRegistry();
			const all = registry.getAll() as unknown as SdkModelLike[];
			for (const m of all) {
				const providerId = m.provider;
				if (!providerId) continue;
				const baseUrl = registry.getProviderBaseUrl(providerId);
				// SDK doesn't expose a per-provider `api` lookup; default family
				// comes from well-known provider ids. Real mapping would come
				// from the provider-config registry which isn't exported — the
				// custom-providers registry below fills in the gaps.
				const api: DeckLLMApi = mapApi(undefined);
				const existing = byProvider.get(providerId);
				const view = modelToView(baseUrl, api, m);
				if (existing) {
					existing.models.push(view);
					continue;
				}
				byProvider.set(providerId, {
					id: providerId,
					displayName: providerId,
					models: [view],
					api,
					...(baseUrl ? { baseUrl } : {}),
				});
			}
		} catch (err) {
			// Registry boot can fail on first launch (no auth yet, missing
			// models.yml). Surface as empty list rather than 500 the route.
			log.warn("registry.snapshot failed; falling back to custom-providers only", err);
		}

		// Overlay custom providers — these carry the real `api` + `baseUrl`
		// and so upgrade the placeholder rows the SDK populated above.
		try {
			const customs = await getCustomProviders().snapshot();
			for (const cp of customs) {
				const api = mapApi(cp.api);
				const baseUrl = cp.baseUrl;
				const existing = byProvider.get(cp.id);
				const displayName = cp.label || cp.id;
				if (existing) {
					existing.api = api;
					existing.displayName = displayName;
					if (baseUrl) existing.baseUrl = baseUrl;
					// Layer in any custom model entries that aren't already there.
					const seen = new Set(existing.models.map((mm) => mm.id));
					for (const cm of cp.models) {
						if (seen.has(cm.id)) continue;
						existing.models.push({
							id: cm.id,
							displayName: cm.displayName ?? cm.id,
							contextWindow: cm.contextWindow ?? 0,
							pricing: { inputMicrocents: 0, outputMicrocents: 0 },
							capabilities: {
								tools: cm.supportsTools ?? true,
								vision: false,
								json: supportsJson(api),
								thinking: cm.supportsReasoning === true,
							},
						});
					}
					continue;
				}
				byProvider.set(cp.id, {
					id: cp.id,
					displayName,
					api,
					...(baseUrl ? { baseUrl } : {}),
					models: cp.models.map((cm) => ({
						id: cm.id,
						displayName: cm.displayName ?? cm.id,
						contextWindow: cm.contextWindow ?? 0,
						pricing: { inputMicrocents: 0, outputMicrocents: 0 },
						capabilities: {
							tools: cm.supportsTools ?? true,
							vision: false,
							json: supportsJson(api),
							thinking: cm.supportsReasoning === true,
						},
					})),
				});
			}
		} catch (err) {
			log.warn("custom-providers snapshot failed", err);
		}

		// Always make sure "minimax" is present even when the custom provider
		// hasn't loaded yet. Stanza from `agent-defaults/models.yml.tmpl` is
		// the documented extension point; the SDK picks it up via the hot-
		// reload watcher, but a cold-boot request may race the watcher.
		if (!byProvider.has("minimax")) {
			byProvider.set("minimax", {
				id: "minimax",
				displayName: "MiniMax",
				api: "openai-completions",
				baseUrl: "https://api.minimax.io/v1",
				models: [
					{
						id: "MiniMax-M3",
						displayName: "MiniMax M3",
						contextWindow: 200_000,
						pricing: { inputMicrocents: 0, outputMicrocents: 0 },
						capabilities: {
							tools: true,
							vision: false,
							json: true,
							thinking: true,
						},
					},
				],
			});
		}

		return Array.from(byProvider.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
	}

	async resolve(ref: { provider: string; id: string }): Promise<{ provider: DeckLLMProvider; model: DeckLLMModel } | null> {
		const providers = await this.list();
		for (const p of providers) {
			if (p.id !== ref.provider) continue;
			const model = p.models.find((m) => m.id === ref.id);
			if (model) return { provider: p, model };
		}
		return null;
	}

	/** Real streaming round-trip via `pi-ai`'s `streamSimple()`. Mirrors the
	 *  call shape used by the in-process bridge (`bridge/in-process.ts`) so the
	 *  same `ModelRegistry` resolves auth + baseUrl — this method only adapts
	 *  the deck's compact `LlmMessage`/`LlmToolSpec` shapes onto pi-ai's
	 *  `Context.messages`/`Context.tools` and re-projects pi-ai's
	 *  `AssistantMessageEvent` stream onto the deck's `LlmChunk` union.
	 *
	 *  `opts.model` is the canonical `provider/modelId` string. Split on the
	 *  first `/`; resolve via `ModelRegistry.find(provider, modelId)`. An
	 *  unresolvable model yields a single `error` chunk and closes.
	 *
	 *  Aborts: `opts.signal` is forwarded to `streamSimple`; the consumer's
	 *  `for await` loop will surface the resulting `error` event. We do NOT
	 *  preempt-check `signal.aborted` — pi-ai does that itself on stream
	 *  construction and emits an `error` event with reason `"aborted"`. */
	async *complete(opts: {
		model: string;
		messages: LlmMessage[];
		tools?: LlmToolSpec[];
		signal?: AbortSignal;
	}): AsyncIterable<LlmChunk> {
		const { provider, modelId } = parseModelRef(opts.model);
		const registry = await getDeckModelRegistry();
		const sdkModel = registry.find(provider, modelId) as Model<Api> | undefined;
		if (!sdkModel) {
			yield { type: "error", error: `unknown model: ${opts.model}` };
			return;
		}

		const context: Context = {
		messages: llmMessagesToSdk(opts.messages, { provider, modelId }),
			systemPrompt: buildSystemPrompt(opts.messages),
			tools: opts.tools?.length ? llmToolsToSdk(opts.tools) : undefined,
		};

		const streamOpts: SimpleStreamOptions = {
			signal: opts.signal,
			// `resolver` implements the central a/b/c auth-retry policy; if no
			// session is in scope we omit `sessionId` so pi-ai treats the call
			// as non-sticky (registry.resolver(model) → resolver(provider, opts)).
			apiKey: registry.resolver(sdkModel),
		};

		let stream: AssistantMessageEventStream;
		try {
			stream = streamSimple(sdkModel, context, streamOpts);
		} catch (err) {
			yield { type: "error", error: err instanceof Error ? err.message : String(err) };
			return;
		}

		let lastUsage: ChatUsage | undefined;
		try {
			for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
				if (opts.signal?.aborted) break;
				const mapped = mapEvent(event);
				if (mapped === null) continue;
				if (mapped.type === "usage") lastUsage = mapped.usage;
				yield mapped;
			}
		} catch (err) {
			yield { type: "error", error: err instanceof Error ? err.message : String(err) };
			return;
		}

		if (lastUsage && !opts.signal?.aborted) {
			yield { type: "usage", usage: lastUsage };
		}
		yield { type: "done" };
	}
}

// ─── Adapter helpers ──────────────────────────────────────────────────────

/** Split `provider/modelId` on the first `/`. Falls back to a no-slash model
 *  string by treating the whole input as `modelId` with `provider = ""` —
 *  `ModelRegistry.find` will return `undefined` and the caller surfaces an
 *  `unknown model` error to the chat. */
function parseModelRef(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	if (slash < 0) return { provider: "", modelId: ref };
	return { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

/** Map deck `LlmMessage` rows onto pi-ai `Message` rows. Each row shape maps
 *  to its closest pi-ai role:
 *  - `user` / `system` → `UserMessage`
 *  - `assistant` → `AssistantMessage` (text or tool-call blocks)
 *  - `tool_call` → `AssistantMessage` carrying the `ToolCall` block (pi-ai
 *    stores tool invocations on assistant turns)
 *  - `tool_result` → `ToolResultMessage`
 *
 *  `timestamp` is required on every `Message`. We use `Date.now()`; pi-ai uses
 *  this only for telemetry, never for wire encoding. */
/**
 * Pi-ai's `Context.systemPrompt` is `string[]` (per
 * `node_modules/@oh-my-pi/pi-ai/dist/types/types.d.ts` — `Context.systemPrompt?: string[]`).
 * Deck has no multi-system-prompt concept; join multiple system rows with
 * `\n\n` to preserve order without inventing a per-row framing. Rows with
 * empty content are skipped (don't pad the wire with whitespace).
 */
function buildSystemPrompt(rows: LlmMessage[]): string[] {
	const parts: string[] = [];
	for (const r of rows) {
		if (r.role !== "system") continue;
		const c = r.content.trim();
		if (c) parts.push(c);
	}
	return parts;
}

/**
 * Map deck `LlmMessage` rows onto pi-ai `Message` rows, dropping `system`
 * rows (those are threaded via `Context.systemPrompt` upstream). Each row
 * shape maps to its closest pi-ai role:
 *  - `user` → `UserMessage`
 *  - `assistant` → `AssistantMessage` (text or tool-call blocks)
 *  - `tool_call` → `AssistantMessage` carrying the `ToolCall` block (pi-ai
 *    stores tool invocations on assistant turns)
 *  - `tool_result` → `ToolResultMessage`, keying off `toolCallId` first then
 *    `name` for backward compatibility with rows that wrote the id to
 *    `name` (the old gholam-chat convention).
 *
 *  `timestamp` is required on every `Message`. We use `Date.now()`; pi-ai
 *  uses this only for telemetry, never for wire encoding.
 */
/** Fields the SDK's `AssistantMessage` carries that we set on synthesised
 *  prior-turn rows so cross-turn replay matches the source provider/model.
 *  `api` stays as the wire-shaped placeholder because the SDK's
 *  `transformMessages` keys off the target model passed at call time, not
 *  the per-row `api` — preserving provider/model is sufficient for replay.
 *  Falls back to the previous `'deck' / 'deck-adapter'` placeholders when
 *  the caller didn't resolve a model (defensive only — `complete()` always
 *  resolves one before this function runs). */
interface AssistantMeta {
	provider: string;
	modelId: string;
}

function llmMessagesToSdk(rows: LlmMessage[], assistant: AssistantMeta): Message[] {
	const out: Message[] = [];
	const ts = Date.now();
	const providerId = assistant.provider || "deck";
	const modelId = assistant.modelId || "deck-adapter";
	for (const r of rows) {
		switch (r.role) {
			case "user":
				out.push({ role: "user", content: r.content, timestamp: ts });
				continue;
			case "system":
				// Stripped — surfaced via `Context.systemPrompt` in `complete()`.
				continue;
			case "assistant": {
				const text: TextContent = { type: "text", text: r.content };
				out.push({
					role: "assistant",
					content: [text],
					api: "openai-completions",
					provider: providerId,
					model: modelId,
					usage: {},
					stopReason: "stop",
					timestamp: ts,
				} as Message);
				continue;
			}
			case "tool_call": {
				const tc = r.toolCall;
				if (!tc) continue;
				const call: ToolCall = {
					type: "toolCall",
					id: tc.id,
					name: tc.tool,
					arguments: tc.args,
				};
				out.push({
					role: "assistant",
					content: [call],
					api: "openai-completions",
					provider: providerId,
					model: modelId,
					usage: {},
					stopReason: "toolUse",
					timestamp: ts,
				} as Message);
				continue;
			}
			case "tool_result": {
				const tr: ToolResultMessage = {
					role: "toolResult",
				// Prefer the typed pairing key; fall back to `name` for legacy rows.
				toolCallId: r.toolCallId ?? r.name ?? "",
					toolName: "",
					content: [{ type: "text", text: r.content }],
					isError: false,
					timestamp: ts,
				};
				out.push(tr);
				continue;
			}
			default:
				continue;
		}
	}
	return out;
}

/** Map deck `LlmToolSpec` rows onto pi-ai `Tool` rows. Pi-ai accepts a plain
 *  JSON Schema object as `parameters` (see `TSchema = Type | TJsonSchema`),
 *  so the deck's `schema: Record<string, unknown>` passes through unchanged. */
function llmToolsToSdk(tools: LlmToolSpec[]): Tool[] {
	return tools.map((t) => ({
		name: t.name,
		description: t.description,
		parameters: t.schema,
	}));
}

/** Re-project a single `AssistantMessageEvent` onto the deck's `LlmChunk`
 *  union. Returns `null` for events the deck doesn't surface (start,
 *  thinking_*, image_*, toolcall_start/delta) — `toolcall_end` carries the
 *  final parsed `ToolCall`, which is the only form `gholam-chat` consumes. */
function mapEvent(event: AssistantMessageEvent): LlmChunk | null {
	switch (event.type) {
		case "text_delta":
			return { type: "text", delta: event.delta };
		case "thinking_delta":
			// Re-project SDK reasoning deltas (the SDK calls this `thinking_delta`,
			// not `reasoning_delta`) onto the deck's `LlmChunk.thinking` variant.
			// gholam-chat concatenates these and writes the joined string into
			// the assistant message's `meta_json.thinking` on terminal state.
			return { type: "thinking", delta: event.delta };
		case "toolcall_end": {
			const tc = event.toolCall;
			return {
				type: "tool_call",
				id: tc.id,
				tool: tc.name,
				args: tc.arguments,
			};
		}
		case "done": {
			// pi-ai's canonical `Usage` (on `AssistantMessage.usage`) uses
			// `input` / `output`; the `input_tokens` / `output_tokens` form is
			// wire-only (Anthropic / OpenAI completion JSON). Cost lives on
			// `usage.cost.{input,output,total}`; we re-project to microcents so
			// the chat-usage telemetry accumulates without floating drift.
			const u = event.message.usage;
			const tokensIn = typeof u.input === "number" ? u.input : 0;
			const tokensOut = typeof u.output === "number" ? u.output : 0;
			const costMicrocents = toMicrocents(u.cost?.total ?? u.cost?.output);
			if (tokensIn > 0 || tokensOut > 0 || costMicrocents > 0) {
				return {
					type: "usage",
					usage: { tokensIn, tokensOut, costMicrocents },
				};
			}
			return { type: "done" };
		}
		case "error": {
			const msg = event.error.errorMessage ?? `stopReason=${event.reason}`;
			return { type: "error", error: msg };
		}
		default:
			return null;
}
}

let _instance: DeckLLMRegistry | undefined;

export type DeckLLMRegistryLike = DeckLLMProviderRegistry;
let _registryOverride: DeckLLMRegistryLike | null = null;
export function __setDeckLLMRegistryForTests(reg: DeckLLMRegistryLike | null): void {
	_registryOverride = reg;
}

/** Process-wide singleton. The registry refreshes its cache on every call
 *  (`cacheMs=5s`); the SDK's own registry hot-reloads via the
 *  CustomProvidersRegistry file watcher, so user edits to `models.yml`
 *  surface within one tick. */
export function getDeckLLMRegistry(): DeckLLMProviderRegistry {
	if (_registryOverride) return _registryOverride;
	if (!_instance) _instance = new DeckLLMRegistry();
	return _instance;
}

/** Convenience export — runtime loop's expected name. */
export const gholamDeckLLM = {
	complete: (opts: Parameters<DeckLLMProviderRegistry["complete"]>[0]): AsyncIterable<LlmChunk> =>
		getDeckLLMRegistry().complete(opts),
};
