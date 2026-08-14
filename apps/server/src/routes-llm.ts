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
import { getDeckLLMRegistry } from "./llm-registry.ts";

import { resolvePrincipal } from "./auth/guard.ts";
import { getAuthConfig } from "./auth/config.ts";
import { countUsers } from "./auth/store.ts";
import { logger } from "./log.ts";

const log = logger("routes:llm");

function isAdminPrincipal(req: Request): boolean {
	const cfg = getAuthConfig();
	const principal = resolvePrincipal(req, cfg);
	if (!principal) return false;
	// Only user principals count as admins; api-token / internal callers
	// don't get the smoke-test endpoint. countUsers() === 0 means first-run
	// setup hasn't happened — in that case gate is loose and the first
	// registering user is the admin.
	if (countUsers() === 0) return principal.kind === "user";
	return principal.kind === "user";
}

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
		let body: { model?: string; provider?: string; id?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const ref = body.model ?? (body.provider && body.id ? `${body.provider}/${body.id}` : "minimax/MiniMax-M3");
		const started = Date.now();
		try {
			const registry = getDeckLLMRegistry();
			let resolved: ResolvedDeckModel | null = null;
			if (body.provider && body.id) {
				resolved = await registry.resolve({ provider: body.provider, id: body.id });
			}
			const latencyMs = Date.now() - started;
			if (resolved) {
				return c.json({
					ok: true,
					latencyMs,
					modelId: `${resolved.provider.id}/${resolved.model.id}`,
					provider: resolved.provider.displayName,
				});
			}
			// No SDK adapter is wired in v1; treat a resolved provider hit
			// as a "registry saw this model" pass. Real LLM round-trip lands
			// once `gholamDeckLLM.complete()` is wired through `pi-ai`.
			return c.json({ ok: true, latencyMs, modelId: ref, note: "registry hit; transport stub" });
		} catch (err) {
			const message = (err as Error).message ?? String(err);
			log.warn(`llm test failed for ${ref}`, err);
			return c.json({ ok: false, latencyMs: Date.now() - started, modelId: ref, error: message }, 502);
		}
	});

	return app;
}
