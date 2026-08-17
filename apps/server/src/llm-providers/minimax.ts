/**
 * MiniMax provider adapter (§2 of docs/GENERATIVE.md).
 *
 * MiniMax's wire protocol is OpenAI-compatible (`/v1/chat/completions`,
 * `stream: true`, JSON-line deltas). The SDK's `api: openai-completions`
 * provider dispatches to it natively once `registerProvider` is wired in —
 * no separate streaming code path required.
 *
 * The match-prefix `minimax` keeps the adapter next to the (recommended)
 * `models.yml.tmpl` stanza. The custom-providers registry hot-reloads this
 * entry at boot (`models.yml` → `~/.omp/agent/models.yml`); the registry
 * (`llm-registry.ts`) overlays any baseUrl / api discrepancies on top of the
 * SDK's built-in model list.
 *
 * This module re-exports a tiny adapter object so future work can plug in
 * provider-specific quirks (a MiniMax-only `cost` table, a custom headers
 * hook, etc.) without restructuring `llm-registry.ts`.
 */
import type { CustomProvider } from "../custom-providers.ts";
import type { DeckLLMApi, DeckLLMCapabilities, DeckLLMModel, DeckLLMProvider } from "../llm-registry.ts";

export const MINIMAX_PROVIDER_ID = "minimax";
export const MINIMAX_DEFAULT_BASE_URL = "https://api.minimax.io/v1";
export const MINIMAX_DEFAULT_API: DeckLLMApi = "openai-completions";
/** Env var the SDK's per-provider resolver consults at runtime. */
export const MINIMAX_API_KEY_ENV = "OMP_PROVIDER_MINIMAX_API_KEY";

export const MINIMAX_MODELS: readonly { id: string; displayName: string; contextWindow: number; capabilities: DeckLLMCapabilities }[] = [
	{
		id: "MiniMax-M3",
		displayName: "MiniMax M3",
		contextWindow: 200_000,
		capabilities: { tools: true, vision: false, json: true, thinking: true },
	},
	{
		id: "MiniMax-M3:medium",
		displayName: "MiniMax M3 (medium)",
		contextWindow: 200_000,
		capabilities: { tools: true, vision: false, json: true, thinking: true },
	},
	{
		id: "MiniMax-M3:low",
		displayName: "MiniMax M3 (low)",
		contextWindow: 200_000,
		capabilities: { tools: true, vision: false, json: true, thinking: true },
	},
] as const;

/** Build a `CustomProvider` payload compatible with `CustomProvidersRegistry.upsertProvider`.
 *  Consumed by future Settings UI flows that want to provision MiniMax from the
 *  routes (the `models.yml.tmpl` is the documented extension point for v1). */
export function buildMiniMaxCustomProvider(opts?: { apiKey?: string; baseUrl?: string }): CustomProvider {
	return {
		id: MINIMAX_PROVIDER_ID,
		label: "MiniMax",
		api: MINIMAX_DEFAULT_API,
		baseUrl: opts?.baseUrl ?? MINIMAX_DEFAULT_BASE_URL,
		apiKey: opts?.apiKey ?? process.env[MINIMAX_API_KEY_ENV] ?? "",
		apiKeyEnv: MINIMAX_API_KEY_ENV,
		authHeader: true,
		models: MINIMAX_MODELS.map((m) => ({
			id: m.id,
			displayName: m.displayName,
			contextWindow: m.contextWindow,
			supportsTools: m.capabilities.tools,
			supportsReasoning: m.capabilities.thinking,
		})),
	};
}

/** Project a MiniMax provider view (used by `llm-registry.ts` when the SDK
 *  registry hasn't yet observed the YAML stanza). */
export function buildMiniMaxDeckProvider(opts?: { baseUrl?: string }): DeckLLMProvider {
	const models: DeckLLMModel[] = MINIMAX_MODELS.map((m) => ({
		id: m.id,
		displayName: m.displayName,
		contextWindow: m.contextWindow,
		pricing: { inputMicrocents: 0, outputMicrocents: 0 },
		capabilities: m.capabilities,
	}));
	const out: DeckLLMProvider = {
		id: MINIMAX_PROVIDER_ID,
		displayName: "MiniMax",
		api: MINIMAX_DEFAULT_API,
		models,
	};
	if (opts?.baseUrl ?? MINIMAX_DEFAULT_BASE_URL) out.baseUrl = opts?.baseUrl ?? MINIMAX_DEFAULT_BASE_URL;
	return out;
}
