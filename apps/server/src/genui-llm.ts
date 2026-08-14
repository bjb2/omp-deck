/**
 * Thin adapter for the GenUI LLM completion.
 *
 * Worker D owns the actual `gholamDeckLLM` surface in `llm-registry.ts`. While
 * that file isn't committed yet, this adapter exports a deterministic mock
 * so `genui-stream.ts` / `routes-preview.ts` can compile and produce valid
 * frames end-to-end. Once Worker D's `llm-registry.ts` lands, swap the
 * default export here to delegate to `gholamDeckLLM.complete` and remove
 * the mock. The export shape is stable so callers don't change.
 */

import { GENUI_ALLOWLIST_VERSION, genuiNodeVocabulary } from "./genui-allowlist.ts";
import type { GenNode } from "@omp-deck/protocol";

export interface GenuiLlmRequest {
	route: string;
	vocabulary: ReturnType<typeof genuiNodeVocabulary>;
	allowlistVersion: string;
	signal?: AbortSignal;
}

export interface GenuiLlmResult {
	frames: GenNode[];
}

/** Mock LLM: emit one GenStack with a greeting so the route always yields
 *  at least one frame. Pure / deterministic — no network. */
const mockProvider: GenuiProvider = {
	async complete(req: GenuiLlmRequest): Promise<GenuiLlmResult> {
		void req;
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

/** Registry holder — Worker D's `llm-registry.ts` can call
 *  `setGenuiProvider(...)` to install `gholamDeckLLM.complete` once that
 *  module is committed. Until then the mock provider serves all calls. */
export interface GenuiProvider {
	complete: (req: GenuiLlmRequest) => Promise<GenuiLlmResult>;
}

let activeProvider: GenuiProvider = mockProvider;

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
		vocabulary: req.vocabulary ?? genuiNodeVocabulary(),
	});
}