/**
 * REST surface for pre-update previews (§4 of docs/GENERATIVE.md).
 * Mounted at `/api/preview/*` from `apps/server/src/routes.ts`.
 *
 *   POST /api/preview/render            — body { path, content, route,
 *                                          model? }; server constructs an
 *                                          intent prompt for the LLM and
 *                                          streams GenFrame events back
 *                                          as NDJSON over SSE.
 *   GET  /api/preview/diff?path=<path>   — lists in-flight `gholam.edit`
 *                                          invocations the preview should
 *                                          be aware of. For v1 this is a
 *                                          stub that returns an empty list;
 *                                          the sidecar's edit log lives in
 *                                          `apps/server/src/gholam.ts` and
 *                                          a future patch will surface it
 *                                          here without changing the wire.
 *
 * The LLM call goes through `genui-llm.ts` (mock by default; Worker D wires
 * the real provider when their `llm-registry.ts` lands).
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { logger } from "./log.ts";
import { buildGenuiFrames, genuiCompleteRoute } from "./genui-stream.ts";

const log = logger("routes:preview");

interface PreviewRenderRequest {
	path?: unknown;
	content?: unknown;
	route?: unknown;
	model?: unknown;
}

function parsePreviewBody(raw: unknown): { path: string; content: string; route: string; model?: string } | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (!("path" in raw) || !("content" in raw) || !("route" in raw)) return null;
	const path = raw.path;
	const content = raw.content;
	const route = raw.route;
	const model = "model" in raw ? raw.model : undefined;
	if (typeof path !== "string" || typeof content !== "string" || typeof route !== "string") return null;
	const out: { path: string; content: string; route: string; model?: string } = {
		path: path.slice(0, 512),
		content: content.slice(0, 64 * 1024),
		route: route.startsWith("/") ? route.slice(0, 256) : `/${route.slice(0, 256)}`,
	};
	if (typeof model === "string" && model.length > 0 && model.length < 128) {
		out.model = model;
	}
	return out;
}

/** Routes whose preview can be served as a static `<iframe>` without an
 *  LLM round-trip. Server picks `iframe` when the route is on this list
 *  and the client can render an iframe target URL for it. */
const STATIC_PREVIEW_ROUTES: Readonly<Record<string, true>> = Object.freeze({
	// empty in v1; populate as pure-render-component routes are migrated.
});

function parseRouteParam(value: string | undefined): string {
	if (!value) return "/";
	const trimmed = value.trim();
	if (!trimmed.startsWith("/")) return `/${trimmed}`;
	return trimmed.length > 256 ? trimmed.slice(0, 256) : trimmed;
}

export function buildPreviewRouter(): Hono {
	const app = new Hono();

	app.post("/preview/render", async (c) => {
		let raw: unknown;
		try {
			raw = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const parsed = parsePreviewBody(raw);
		if (!parsed) return c.json({ error: "path, content, route required" }, 400);

		const mode: "iframe" | "genui" = parsed.route in STATIC_PREVIEW_ROUTES ? "iframe" : "genui";

		return streamSSE(c, async (stream) => {
			const abort = new AbortController();
			stream.onAbort(() => abort.abort());

			// Static fast path — emit a single terminal frame pointing the
			// client at an iframe target. The target URL is derived from
			// the route and the in-flight path so a future static-bundle
			// hot-reload can serve it.
			if (mode === "iframe") {
				const target = `/preview/iframe?path=${encodeURIComponent(parsed.path)}`;
				await stream
					.writeSSE({
						event: "static",
						data: JSON.stringify({ kind: "iframe", target, route: parsed.route }),
					})
					.catch(() => {});
				return;
			}

			// LLM path. We currently delegate to the same genui-stream LLM
			// the chat uses — Worker D wires `gholamDeckLLM` via
			// `setGenuiProvider` from `genui-llm.ts`. The intent prompt
			// (file → route tree) is folded into the LLM call by the
			// provider; for the mock this is a no-op.
			let frames: Awaited<ReturnType<typeof genuiCompleteRoute>> = [];
			try {
				frames = await genuiCompleteRoute(parsed.route, abort.signal);
			} catch (err) {
				log.error(`preview render failed for route=${parsed.route}`, err);
				await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String(err) }) }).catch(() => {});
				return;
			}
			const payload = buildGenuiFrames(frames);
			for (const f of payload) {
				await stream.writeSSE({ event: f.type, data: JSON.stringify(f) }).catch(() => {});
				if (abort.signal.aborted) return;
			}
		});
	});

	app.get("/preview/diff", (c) => {
		const path = parseRouteParam(c.req.query("path"));
		// v1 stub: empty diff list. The sidecar's edit-log lives in
		// `apps/server/src/gholam.ts` and a future patch will surface it
		// here without changing the wire. Returning `[]` keeps the client
		// flow functional today.
		void path;
		return c.json({ diffs: [] });
	});

	return app;
}