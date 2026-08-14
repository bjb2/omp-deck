/**
 * Server-side NDJSON stream for the GenUI surface (§3 of docs/GENERATIVE.md).
 *
 * `GET /api/genui/stream?route=<path>` writes one frame per line to the SSE
 * stream. The LLM is called via the `genui-llm.ts` adapter — Worker D's
 * `llm-registry.ts` (when committed) can call `setGenuiProvider(...)` to
 * wire `gholamDeckLLM.complete` in. Until then a deterministic mock provider
 * serves all calls so the route produces valid frames end-to-end.
 */

import type { GenFrame, GenNode } from "@omp-deck/protocol";
import type { GenComponent } from "@omp-deck/protocol";

import { completeGenui } from "./genui-llm.ts";
import { GENUI_ALLOWLIST_VERSION } from "./genui-allowlist.ts";
import { logger } from "./log.ts";

const log = logger("genui-stream");

/** Run the LLM with the allowlist vocabulary as prompt context. */
export async function genuiCompleteRoute(route: string, signal?: AbortSignal): Promise<GenNode[]> {
	try {
		const { frames } = await completeGenui({
			route,
			vocabulary: [],
			allowlistVersion: GENUI_ALLOWLIST_VERSION,
			...(signal ? { signal } : {}),
		});
		return frames;
	} catch (err) {
		log.error(`genui LLM complete failed for route=${route}; returning empty stream`, err);
		return [];
	}
}

/** Build the NDJSON payload for the SSE stream. Each line is a JSON-encoded
 *  `GenFrame` (a `frame` event with one node, or a `done` event with the
 *  final hash). The hash is a cheap non-crypto digest so the client can
 *  dedupe replays — we use FNV-1a 32-bit which is stdlib-shaped (no deps). */
export function buildGenuiFrames(frames: GenNode[]): GenFrame[] {
	const out: GenFrame[] = [];
	const components: GenComponent[] = [];
	for (const node of frames) {
		if (node === null || typeof node !== "object" || !("type" in node)) continue;
		components.push(node);
	}
	for (const node of components) {
		out.push({ type: "frame", node, allowlistVersion: GENUI_ALLOWLIST_VERSION });
	}
	const finalHash = fnv1a32(JSON.stringify(components));
	out.push({ type: "done", finalHash: finalHash.toString(16), allowlistVersion: GENUI_ALLOWLIST_VERSION });
	return out;
}

/** FNV-1a 32-bit. Tiny, dependency-free; sufficient for dedupe, NOT for
 *  security. https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function */
export function fnv1a32(s: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}