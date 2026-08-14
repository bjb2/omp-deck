/**
 * New-feature routers for the v0.7 harness overhaul. Mounted from `routes.ts`
 * alongside the existing legacy routers. Each router is small, single-purpose,
 * and uses the existing service singletons (bridge, marketplace, kb, etc).
 *
 * The new surfaces added here:
 *
 *   • `/api/providers/custom`           — CRUD over `models.yml` custom providers.
 *   • `/api/marketplace/*` (extended)   — search, featured, popular, refresh, SSL-bypass.
 *   • `/api/skills/marketplace/*`       — SkillsMP-backed skill discovery + install.
 *   • `/api/system/lifecycle`           — start/stop/restart the harness.
 *   • `/api/sessions/:id/{kill,archive,pin,title}` — instance management.
 *   • `/api/sessions/auto-title`        — AI-generated session naming.
 *   • `/api/workflows/*`                — multi-agent workflowz / orchestrate dispatch.
 *   • `/api/gholam/*`                   — Gholam twin sidecar control.
 *   • `/api/auth/login`                 — provider subscription-key login (MiniMax/OmniRoute).
 *
 * Each endpoint is intentionally thin — the heavy lifting lives in the service
 * modules. The shared pattern: parse JSON, validate, dispatch, return JSON,
 * surface errors as `{ error: string }` with the right status code.
 */
import type { AgentBridge } from "./bridge/types.ts";
import { Hono } from "hono";

import { type CustomProvider, getCustomProviders } from "./custom-providers.ts";
import { getDeckAuthStorage, getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";
import { marketplaceExtras } from "./marketplace-extras.ts";
import { getMarketplace } from "./marketplace-service.ts";
import { skillsMP } from "./skillsmp.ts";
import { gholam, parseRemoteOwnerRepo } from "./gholam.ts";
import { getLatestDeployState } from "./deploy-state.ts";
import { lifecycle } from "./lifecycle.ts";
import { workflowz } from "./workflowz.ts";
import { titleService } from "./session-title.ts";
import { sessionLifecycle } from "./session-lifecycle.ts";

const log = logger("routes:harness");

export function buildHarnessRouter(bridge: AgentBridge): Hono {
	const app = new Hono();

	// ── Custom providers (models.yml CRUD) ────────────────────────────────────
	app.get("/providers/custom", async (c) => {
		const snapshot = await getCustomProviders().snapshot();
		return c.json({ providers: snapshot });
	});

	app.put("/providers/custom/:id", async (c) => {
		const id = c.req.param("id");
		let body: CustomProvider;
		try {
			body = (await c.req.json()) as CustomProvider;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (body.id !== id) return c.json({ error: "id mismatch" }, 400);
		if (!body.baseUrl || !body.api || !Array.isArray(body.models) || body.models.length === 0) {
			return c.json({ error: "missing baseUrl, api, or models[]" }, 400);
		}
		try {
			await getCustomProviders().upsertProvider(body);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`upsertProvider(${id}) failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.delete("/providers/custom/:id", async (c) => {
		const id = c.req.param("id");
		try {
			await getCustomProviders().removeProvider(id);
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/providers/custom/reload", async (c) => {
		const { changed } = await getCustomProviders().reloadFromDisk();
		return c.json({ ok: true, changed });
	});

	// ── Provider subscription-key login (MiniMax / OmniRoute / etc) ───────────
	app.post("/auth/login", async (c) => {
		let body: { provider: string; apiKey?: string; subscriptionKey?: string; baseUrl?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const { provider, apiKey, subscriptionKey, baseUrl } = body;
		if (!provider) return c.json({ error: "provider required" }, 400);
		const secret = subscriptionKey ?? apiKey;
		if (!secret) return c.json({ error: "apiKey or subscriptionKey required" }, 400);

		// Two paths: (a) known SDK provider (e.g. "anthropic", "openai"), (b)
		// custom provider entry that we materialize into models.yml on the fly.
		const knownProviders = new Set(["anthropic", "openai", "google", "groq", "xai", "openrouter"]);
		try {
			const auth = await getDeckAuthStorage();
			if (knownProviders.has(provider)) {
				await auth.set(provider, {
					type: "api_key",
					key: secret,
					...(baseUrl ? { baseUrl } : {}),
				});
			} else if (provider === "omniroute" || provider === "minimax" || provider === "custom") {
				// Register as a custom provider on the fly. The SDK doesn't know
				// about OmniRoute natively, so we synthesize one through
				// `registerProvider` and persist it for next boot.
				const cp = provider === "omniroute"
					? {
							id: "omniroute",
							label: "OmniRoute",
							api: "openai-completions" as const,
							baseUrl: baseUrl ?? process.env.OMNIROUTE_BASE_URL ?? "https://api.omniroute.ai/v1",
							apiKey: secret,
							apiKeyEnv: "OMNIROUTE_API_KEY",
							authHeader: true,
							models: [
								{
									id: "auto",
									displayName: "OmniRoute Auto",
									contextWindow: 200_000,
									maxTokens: 16_384,
									supportsTools: true,
									supportsReasoning: true,
								},
							],
						}
					: {
							id: provider,
							label: provider,
							api: "openai-completions" as const,
							baseUrl: baseUrl ?? "https://example.invalid/v1",
							apiKey: secret,
							apiKeyEnv: `${provider.toUpperCase()}_API_KEY`,
							authHeader: true,
							models: [
								{
									id: "default",
									displayName: `${provider} default`,
									contextWindow: 128_000,
									maxTokens: 16_384,
									supportsTools: true,
									supportsReasoning: true,
								},
							],
						};
				await getCustomProviders().upsertProvider(cp);
			}
			// Refresh the registry so the new key/model surfaces immediately.
			const registry = await getDeckModelRegistry();
			await registry.refresh("offline");
			return c.json({ ok: true, provider });
		} catch (err) {
			log.error(`login(${provider}) failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	// ── Marketplace extensions ─────────────────────────────────────────────────
	app.get("/marketplace/search", async (c) => {
		const q = c.req.query("q") ?? "";
		const featured = c.req.query("featured") === "1";
		const limit = Number.parseInt(c.req.query("limit") ?? "50", 10);
		try {
			const results = await marketplaceExtras.search({ query: q, featured, limit });
			return c.json({ results });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/marketplace/featured", async (c) => {
		const limit = Number.parseInt(c.req.query("limit") ?? "12", 10);
		const list = await marketplaceExtras.featured(limit);
		return c.json({ results: list });
	});

	app.get("/marketplace/popular", async (c) => {
		const limit = Number.parseInt(c.req.query("limit") ?? "20", 10);
		const list = await marketplaceExtras.popular(limit);
		return c.json({ results: list });
	});

	app.post("/marketplace/refresh", async (c) => {
		try {
			const mgr = getMarketplace();
			await mgr.refresh();
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// ── SkillsMP-backed skill marketplace ─────────────────────────────────────
	app.get("/skills/marketplace/search", async (c) => {
		const q = c.req.query("q") ?? "";
		const limit = Number.parseInt(c.req.query("limit") ?? "30", 10);
		const results = await skillsMP.search(q, limit);
		return c.json({ results });
	});

	app.get("/skills/marketplace/featured", async (c) => {
		const limit = Number.parseInt(c.req.query("limit") ?? "12", 10);
		return c.json({ results: await skillsMP.featured(limit) });
	});

	app.post("/skills/marketplace/install", async (c) => {
		let body: { slug: string; scope?: "user" | "project" };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.slug) return c.json({ error: "slug required" }, 400);
		const result = await skillsMP.install(body.slug, body.scope ?? "user");
		return c.json(result);
	});

	// ── System lifecycle (start/stop/restart) ──────────────────────────────────
	app.get("/system/lifecycle", (c) => lifecycle.status().then((s) => c.json(s)));
	app.post("/system/lifecycle", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { action?: string };
		const result = await lifecycle.dispatch(body.action ?? "status");
		return c.json(result);
	});

	// ── Session lifecycle (kill / archive / pin / title) ───────────────────────
	app.post("/sessions/:id/kill", async (c) => {
		const id = c.req.param("id");
		try {
			await sessionLifecycle.kill(bridge, id);
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/archive", async (c) => {
		const id = c.req.param("id");
		try {
			await sessionLifecycle.archive(bridge, id);
			return c.json({ ok: true });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/pin", async (c) => {
		const id = c.req.param("id");
		try {
			const pinned = await sessionLifecycle.pin(bridge, id);
			return c.json({ ok: true, pinned });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/title", async (c) => {
		const id = c.req.param("id");
		try {
			const title = await titleService.regenerate(bridge, id);
			return c.json({ ok: true, title });
		} catch (err) {
			return c.json({ error: String(err) }, 500);
		}
	});

	// ── Multi-agent workflowz / orchestrate ────────────────────────────────────
	app.post("/workflows", async (c) => {
		let body: { mode?: string; tasks?: Array<{ prompt: string; model?: string; cwd?: string }> };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const mode = body.mode ?? "parallel";
		const result = await workflowz.dispatch(bridge, mode, body.tasks ?? []);
		return c.json(result);
	});

	app.get("/workflows/:id", (c) => {
		const id = c.req.param("id");
		const status = workflowz.status(id);
		if (!status) return c.json({ error: "not found" }, 404);
		return c.json(status);
	});

	// ── Gholam twin sidecar ────────────────────────────────────────────────────
	app.get("/gholam/status", (c) => c.json(gholam.status()));
	app.post("/gholam/start", async (c) => c.json(await gholam.start()));
	app.post("/gholam/stop", async (c) => c.json(await gholam.stop()));
	app.get("/gholam/priorities", async (c) => {
		const list = await gholam.snapshot();
		return c.json({ priorities: list });
	});
	app.post("/gholam/priorities", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { priorities?: unknown[] };
		gholam.setPriorities(body.priorities ?? []);
		return c.json({ ok: true, count: gholam.status().prioritiesCount });
	});
	app.post("/gholam/heartbeat", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as { intervalMs?: number };
		return c.json(await gholam.setHeartbeat(body.intervalMs ?? 30_000));
	});

	// ── deploy_state snapshot ──────────────────────────────────────────────────
	// Read the latest DeployState. The live channel is the `deploy_state`
	// broadcast over WS; this is the catch-up read for a fresh tab.
	app.get("/deploy/state", async (c) => {
		return c.json(getLatestDeployState());
	});

	// ── gholam edit: push a file change through the sidecar's github MCP ─────
	// Body: { path, content, message?, createPr?, cwd? }. The owner/repo is
	// resolved from `cwd` (default OMP_DECK_DEFAULT_CWD) via git, falling
	// back to OMP_DECK_REPO. Returns { ok, ref, contentSha } on success or
	// { ok: false, error }.
	app.post("/gholam/edit", async (c) => {
		let body: { path?: string; content?: string; message?: string; createPr?: boolean; cwd?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ ok: false, error: "invalid json" }, 400);
		}
		const { path: filePath, content, message } = body;
		if (!filePath || typeof content !== "string") {
			return c.json({ ok: false, error: "path and content required" }, 400);
		}
		const cwd = body.cwd?.trim() || process.env.OMP_DECK_DEFAULT_CWD || process.cwd();
		const repo = await parseRemoteOwnerRepo(cwd);
		if (!repo) {
			return c.json({ ok: false, error: "could not resolve owner/repo (no git remote.origin.url and OMP_DECK_REPO unset)" }, 400);
		}
		const result = await gholam.edit({
			owner: repo.owner,
			repo: repo.repo,
			path: filePath,
			content,
			...(message ? { message } : {}),
		});
		if (!result.ok) {
			return c.json({ ok: false, error: result.error ?? "edit failed" }, 502);
		}
		const out: { ok: true; ref?: string; contentSha?: string; prUrl?: string } = { ok: true };
		if (result.ref !== undefined) out.ref = result.ref;
		if (result.contentSha !== undefined) out.contentSha = result.contentSha;
		return c.json(out);
	});

	return app;
}
