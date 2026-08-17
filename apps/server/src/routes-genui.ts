/**
 * REST surface for the GenUI stream (§3 of docs/GENERATIVE.md). Mounted at
 * `/api/genui/*` from `apps/server/src/routes.ts`.
 *
 *   GET  /api/genui/stream?route=<path>   — NDJSON SSE stream of GenFrame
 *                                           events. Emits one line per
 *                                           frame plus a terminal `done`.
 *   GET  /api/genui/allowlist             — JSON of the vocabulary the
 *                                           LLM has been told about, plus
 *                                           the current version stamp.
 *
 * The LLM is called via `genui-llm.ts` (Worker D wires `gholamDeckLLM`
 * in there when their `llm-registry.ts` lands). Until then the mock
 * provider serves a deterministic greeting frame so the route produces
 * valid output end-to-end.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { logger } from "./log.ts";
import { GENUI_ALLOWLIST_VERSION, genuiNodeVocabulary } from "./genui-allowlist.ts";
import { buildGenuiFrames, genuiCompleteRoute } from "./genui-stream.ts";

const log = logger("routes:genui");

function parseRoute(value: string | undefined): string {
	if (!value) return "/";
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return `/${trimmed}`;
	if (trimmed.length > 256) return trimmed.slice(0, 256);
	return trimmed;
}

export function buildGenuiRouter(): Hono {
	const app = new Hono();

	app.get("/genui/stream", (c) => {
		const route = parseRoute(c.req.query("route"));
		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			stream.onAbort(() => abort.abort());

			let frames: Awaited<ReturnType<typeof genuiCompleteRoute>> = [];
			try {
				frames = await genuiCompleteRoute(route, abort.signal);
			} catch (err) {
				log.error(`genui stream failed for route=${route}`, err);
				await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String(err) }) }).catch(() => {});
				return;
			}

			const payload = buildGenuiFrames(frames);
			for (const f of payload) {
				await stream.writeSSE({ event: f.type, data: JSON.stringify(f) }).catch(() => {
					// Client disconnected mid-write; the loop ends.
				});
				if (abort.signal.aborted) return;
			}
		});
	});

	app.get("/genui/allowlist", (c) => {
		return c.json({
			allowlistVersion: GENUI_ALLOWLIST_VERSION,
			types: genuiNodeVocabulary(),
		});
	});

	return app;
}