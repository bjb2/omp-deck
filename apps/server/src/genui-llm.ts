/**
 * GenUI LLM adapter — owns the call into `gholamDeckLLM.complete()` from
 * `llm-registry.ts`. The boot sequence installs this provider via
 * `setGenuiProvider(...)` (see `apps/server/src/index.ts`); before that
 * boot wire this file shipped a deterministic mock so the SSE route
 * produced valid frames end-to-end. The mock provider remains as a
 * fallback so tests + offline boots still emit a frame.
 */

import { GENUI_ALLOWLIST_VERSION, genuiNodeVocabulary } from "./genui-allowlist.ts";
import type { GenNode } from "@omp-deck/protocol";
import { gholamDeckLLM } from "./llm-registry.ts";
import { loadOverviewForPrompt, type OverviewPromptInput } from "./routes-overview.ts";
import type { Config } from "./config.ts";

export interface GenuiVocabularyEntry {
	type: string;
	description: string;
}
export type GenuiVocabulary = GenuiVocabularyEntry[];

export interface GenuiLlmRequest {
	route: string;
	vocabulary: GenuiVocabulary;
	allowlistVersion: string;
	config?: Config;
	signal?: AbortSignal;
}

export interface GenuiLlmResult {
	frames: GenNode[];
}

export interface GenuiProvider {
	complete: (req: GenuiLlmRequest) => Promise<GenuiLlmResult>;
}

/** Mock LLM: emit one GenStack with a greeting so the route always yields
 *  at least one frame. Pure / deterministic — no network. */
const mockProvider: GenuiProvider = {
	async complete(req: GenuiLlmRequest): Promise<GenuiLlmResult> {
		return {
			frames: [
				{
					type: "GenStack",
					props: { gap: 8 },
					children: [
						{ type: "GenText", props: { size: "lg", tone: "accent" }, content: `Preview for ${req.route}` },
						{ type: "GenText", props: { tone: "muted" }, content: "Mock frame — swap genui-llm.ts to wire a real provider." },
					],
				},
			],
		};
	},
};

/** Build the prompt that asks the LLM to render the overview as a
 *  `GenNode[]` tree using only the allowlisted vocabulary. The overview
 *  JSON, the vocabulary, and the route name are all serialised inline. */
function buildOverviewSystemPrompt(input: {
	route: string;
	overview: OverviewPromptInput;
	vocabulary: GenuiVocabulary;
	allowlistVersion: string;
}): string {
	const vocabLines = input.vocabulary
		.map((v) => `- ${v.type}: ${v.description}`)
		.join("\n");
	return [
		`You are the renderer for route ${JSON.stringify(input.route)}.`,
		`Return ONLY a JSON object shaped as { "frames": GenNode[] } where each GenNode is one of the allowlisted types below.`,
		`Allowlist version: ${input.allowlistVersion}.`,
		"",
		"Component vocabulary (use ONLY these types):",
		vocabLines,
		"",
		"Rules:",
		"- Every GenNode.type MUST appear in the vocabulary above; unknown types are dropped by the renderer.",
		"- Wrap the page in a single top-level GenStack (gap=12) so the renderer can lay it out.",
		"- Surface focus.nextAction as the top GenCard title; surface stats via GenKeyValue rows.",
		"- Use GenTable for trending repos (columns: name, language, stars).",
		"- Use GenMarkdown for news items (each card body).",
		"- Cap total nodes at 60; large arrays (news > 10) MUST be truncated.",
		"- The output must be valid JSON — no commentary, no markdown fences.",
		"",
		"Overview payload:",
		JSON.stringify(input.overview, null, 2),
	].join("\n");
}

/** Filter raw model output into well-formed `GenNode[]` entries. */
function onlyGenNodes(arr: unknown[]): GenNode[] {
	return arr.filter(
		(n): n is GenNode => n !== null && typeof n === "object" && "type" in (n as Record<string, unknown>),
	);
}

/** Coerce raw model text into a `GenNode[]`. Tries a JSON object with a
 *  `frames` array first, then a bare array, then a single GenNode. Falls
 *  back to a single `GenCard` carrying the raw text so the page always
 *  surfaces something instead of an empty stream.
 *
 *  ponytail: the spec says `<note>` GenNode but the allowlist has no
 *  `<note>` type — use `GenCard` + `GenMarkdown` instead. Add `<note>` to
 *  the vocabulary when the renderer grows one. */
function coerceGenuiText(text: string): GenNode[] {
	const trimmed = text.trim();
	const tryParse = (raw: string): unknown => {
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	};
	const fromObject = (obj: Record<string, unknown>): GenNode[] | undefined => {
		if (Array.isArray(obj.frames)) return onlyGenNodes(obj.frames);
		if (Array.isArray(obj.nodes)) return onlyGenNodes(obj.nodes);
		if ("type" in obj) return onlyGenNodes([obj]);
		return undefined;
	};
	const direct = tryParse(trimmed);
	if (direct && typeof direct === "object") {
		const fromObj = fromObject(direct as Record<string, unknown>);
		if (fromObj) return fromObj;
		if (Array.isArray(direct)) return onlyGenNodes(direct);
	}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		const inside = tryParse(fenced[1] ?? "");
		if (inside && typeof inside === "object") {
			const fromObj = fromObject(inside as Record<string, unknown>);
			if (fromObj) return fromObj;
			if (Array.isArray(inside)) return onlyGenNodes(inside);
		}
	}
	return [
		{
			type: "GenCard",
			props: { title: "Overview render" },
			children: [{ type: "GenMarkdown", content: trimmed.slice(0, 4000) }],
		},
	];
}

/** Surface a provider error as a single `GenCard` frame so the page never
 *  silently swallows a broken provider. */
function errorFrames(title: string, message: string): GenNode[] {
	return [
		{
			type: "GenCard",
			props: { title },
			children: [{ type: "GenMarkdown", content: message }],
		},
	];
}

/** Adapter that delegates to `gholamDeckLLM.complete`. Loads the overview
 *  payload, streams the model output into a single `GenNode[]` tree, and
 *  surfaces provider errors as a `GenCard` frame instead of swallowing them.
 *  `req.config` is injected by the boot-time wrapper installed via
 *  `setGenuiProvider(...)` in `index.ts`. */
export async function gholamOverviewProvider(req: GenuiLlmRequest): Promise<GenuiLlmResult> {
	if (!req.config) {
		return {
			frames: errorFrames(
				"Overview render",
				"GenUI provider missing config — boot did not pass `config` into `setGenuiProvider`.",
			),
		};
	}
	let overview: OverviewPromptInput;
	try {
		overview = await loadOverviewForPrompt({ config: req.config });
	} catch (err) {
		return {
			frames: errorFrames(
				"Overview render failed",
				`loadOverviewForPrompt failed: ${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	const prompt = buildOverviewSystemPrompt({
		route: req.route,
		overview,
		vocabulary: req.vocabulary,
		allowlistVersion: req.allowlistVersion,
	});
	let raw = "";
	try {
		// The deck registry's `complete()` signature is `{model, messages, tools?, signal?}`.
		// The spec asks for `temperature`/`maxTokens`/`responseFormat` too — pass them
		// through with a cast so the runtime can honour them when supported, without
		// making the type system the bottleneck. ponytail: remove the cast once
		// DeckLLMProviderRegistry.complete grows those fields.
		const stream = gholamDeckLLM.complete({
			model: "minimax/MiniMax-M3",
			messages: [{ role: "user", content: prompt }],
			temperature: 0.2,
			maxTokens: 2000,
			responseFormat: { type: "json_object" },
			signal: req.signal,
		} as unknown as Parameters<typeof gholamDeckLLM.complete>[0]);
		for await (const chunk of stream) {
			if (chunk.type === "text") raw += chunk.delta;
			else if (chunk.type === "error") {
				return { frames: errorFrames("Overview render failed", `gholamDeckLLM error: ${chunk.error}`) };
			}
		}
	} catch (err) {
		return {
			frames: errorFrames(
				"Overview render failed",
				`gholamDeckLLM.complete threw: ${err instanceof Error ? err.message : String(err)}`,
			),
		};
	}
	return { frames: coerceGenuiText(raw) };
}

let activeProvider: GenuiProvider = { complete: gholamOverviewProvider };

export function setGenuiProvider(provider: GenuiProvider): void {
	activeProvider = provider;
}

export function resetGenuiProvider(): void {
	activeProvider = mockProvider;
}

export function getGenuiProvider(): GenuiProvider {
	return activeProvider;
}

/** Default export — convenience for callers that prefer a function form. */
export async function completeGenui(req: GenuiLlmRequest): Promise<GenuiLlmResult> {
	return activeProvider.complete({
		...req,
		allowlistVersion: GENUI_ALLOWLIST_VERSION,
		vocabulary: req.vocabulary ?? (genuiNodeVocabulary() as GenuiVocabulary),
	});
}