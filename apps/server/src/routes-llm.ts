/**
 * Deck LLM registry REST surface (§2 of docs/GENERATIVE.md).
 *
 * Two routes:
 *  - GET  /api/llm/providers   — typed view of every registered provider
 *                                 and its models. Boot-races the SDK
 *                                 registry so cold-boot requests still
 *                                 see built-in providers (anthropic, etc.)
 *                                 and the YAML-declared ones (minimax,
 *                                 9router, omni, …).
 *  - POST /api/llm/test         — admin-only smoke test; 1-token prompt,
 *                                 returns {ok, latencyMs, modelId} so the
 *                                 Settings → Providers UI can drive
 *                                 "test key" affordances from a single
 *                                 shared endpoint.
 */
import { Hono } from "hono";

import type { DeckLLMProvider } from "./llm-registry.ts";
import type { ResolvedDeckModel } from "./llm-registry.ts";
import { getDeckLLMRegistry, gholamDeckLLM, type LlmChunk } from "./llm-registry.ts";

import { resolvePrincipal } from "./auth/guard.ts";
import { isAdminPrincipal } from "./auth/guard.ts";
import { getAuthConfig } from "./auth/config.ts";
import { countUsers } from "./auth/store.ts";
import { logger } from "./log.ts";

const log = logger("routes:llm");

/** Test seam — replaces the process-wide LLM registry so the route layer can
 *  be exercised without a live SDK boot. Production paths go through the
 *  singleton, never this. */
export type CompleteStream = (opts: {
	model: string;
	messages: { role: "user" | "system" | "assistant"; content: string }[];
	signal?: AbortSignal;
}) => AsyncIterable<LlmChunk>;
let _completeStream: CompleteStream | null = null;
export function __setCompleteStreamForTests(fn: CompleteStream | null): void {
	_completeStream = fn;
}

const TEST_TIMEOUT_MS = 8_000;
const PROBE_PROMPT = "ping";

// isAdminPrincipal now lives in ./auth/guard.ts so /api/settings/env can
// share the same gate (SECURITY-004). Local copy removed.

function unauthorized(): Response {
	return Response.json({ error: "admin required" }, { status: 403 });
}

export function buildLLMRouter(): Hono {
	const app = new Hono();

	app.get("/llm/providers", async (c) => {
		try {
			const providers: DeckLLMProvider[] = await getDeckLLMRegistry().list();
			return c.json({ providers });
		} catch (err) {
			log.error("list providers failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/llm/test", async (c) => {
		const access = isAdminPrincipal(c.req.raw);
		if (!access) return unauthorized();

		// Body shape is enforced at runtime. `c.req.json()` happily returns
		// any JSON value (null, strings, arrays, numbers), so an unchecked
		// cast would let `body.model` throw a TypeError on null and bypass
		// validation entirely for primitives. Coerce fields to strings so a
		// non-string payload (e.g. `{"model": 42}`) can't crash template
		// literals or `.split("/")` later.
		const raw: unknown = await c.req.json().catch(() => null);
		if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
			return c.json({ error: "invalid json" }, 400);
		}
		const r = raw as Record<string, unknown>;
		const modelRaw = typeof r.model === "string" ? r.model.trim() : undefined;
		const providerRaw = typeof r.provider === "string" ? r.provider.trim() : undefined;
		const idRaw = typeof r.id === "string" ? r.id.trim() : undefined;
		const timeoutRaw = typeof r.timeoutMs === "number" ? r.timeoutMs : undefined;

		// Resolve precedence: explicit provider+id > body.model as "provider/id"
		// > baked default. body.model without a "/" is unresolvable and is
		// rejected up front so the caller knows their payload is malformed
		// rather than silently falling back to the default model.
		let provider: string;
		let id: string;
		if (providerRaw && idRaw) {
			provider = providerRaw;
			id = idRaw;
		} else if (modelRaw && modelRaw.includes("/")) {
			const idx = modelRaw.indexOf("/");
			provider = modelRaw.slice(0, idx);
			id = modelRaw.slice(idx + 1);
			if (!provider || !id) {
				return c.json({ error: `invalid model ref: ${modelRaw}` }, 400);
			}
		} else if (modelRaw) {
			return c.json({ error: `invalid model ref: ${modelRaw} (expected "provider/id")` }, 400);
		} else {
			provider = "minimax";
			id = "MiniMax-M3";
		}
		const ref = `${provider}/${id}`;
		const timeoutMs = Math.max(100, Math.min(TEST_TIMEOUT_MS, Number(timeoutRaw) || TEST_TIMEOUT_MS));
		const started = Date.now();
		const ac = new AbortController();
		const timer = setTimeout(() => ac.abort(new Error("probe timed out")), timeoutMs);
		try {
			const registry = getDeckLLMRegistry();
			const resolved: ResolvedDeckModel | null = await registry.resolve({ provider, id });
			if (!resolved) {
				return c.json(
					{ ok: false, latencyMs: Date.now() - started, modelId: ref, error: `unknown model: ${ref}` },
					404,
				);
			}
			const stream = _completeStream
				? _completeStream({
						model: `${resolved.provider.id}/${resolved.model.id}`,
						messages: [{ role: "user", content: PROBE_PROMPT }],
						signal: ac.signal,
					})
				: gholamDeckLLM.complete({
						model: `${resolved.provider.id}/${resolved.model.id}`,
						messages: [{ role: "user", content: PROBE_PROMPT }],
						signal: ac.signal,
					});
			let firstChunk: LlmChunk | null = null;
			let textBytes = 0;
			for await (const chunk of stream) {
				if (!firstChunk) firstChunk = chunk;
				if (chunk.type === "text") textBytes += chunk.delta.length;
				if (chunk.type === "done" || chunk.type === "error") break;
				if (ac.signal.aborted) break;
			}
			const latencyMs = Date.now() - started;
			if (!firstChunk) {
				return c.json(
					{ ok: false, latencyMs, modelId: `${resolved.provider.id}/${resolved.model.id}`, error: "no response" },
					502,
				);
			}
			if (firstChunk.type === "error") {
				return c.json(
					{
						ok: false,
						latencyMs,
						modelId: `${resolved.provider.id}/${resolved.model.id}`,
						error: firstChunk.error,
					},
					502,
				);
			}
			return c.json({
				ok: true,
				latencyMs,
				modelId: `${resolved.provider.id}/${resolved.model.id}`,
				provider: resolved.provider.displayName,
				note: textBytes > 0 ? "streamed" : "responded",
			});
		} catch (err) {
			const message = (err as Error).message ?? String(err);
			log.warn(`llm test failed for ${ref}`, err);
			return c.json({ ok: false, latencyMs: Date.now() - started, modelId: ref, error: message }, 502);
		} finally {
			// Single cleanup point — every return path (404, 502, success,
			// thrown) previously had to remember to clearTimeout or it leaked
			// until process exit and held the AbortController alive.
			clearTimeout(timer);
		}
	});

	return app;
}
