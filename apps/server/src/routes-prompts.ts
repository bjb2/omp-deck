/**
 * Prompt library + recommendation + share REST surface (§4 of
 * docs/STOREFRONT.md). Mounted under `/prompts` and `/prompts/share` by
 * `buildPromptsRouter()`. CRUD lives in `prompts-library.ts`; the
 * recommendation engine lives in `prompts-recommend.ts`.
 */

import { Hono } from "hono";

import type {
	CreatePromptRequest,
	ImportPromptRequest,
	ListPromptRecommendationsResponse,
	ListPromptsResponse,
	UpdatePromptRequest,
} from "@omp-deck/protocol";

import type { Prompt } from "@omp-deck/protocol";

import {
	extractVariables,
	promptsLibrary,
} from "./prompts-library.ts";
import {
	decayedUsage,
	emptySignals,
	recommendPrompts,
} from "./prompts-recommend.ts";

import { logger } from "./log.ts";

const log = logger("routes:prompts");

/** Build a usage-weights map for the recommendation engine. */
async function buildUsageWeights(prompts: Prompt[]): Promise<Map<string, number>> {
	const m = new Map<string, number>();
	for (const p of prompts) {
		const w = decayedUsage(p);
		if (w > 0) m.set(p.id, w);
	}
	return m;
}

async function fetchGist(url: string): Promise<{ title: string; body: string; tags: string[] }> {
	const m = /^https?:\/\/gist\.github\.com\/(?:[^/]+\/)?([0-9a-f]+)/i.exec(url);
	if (!m) throw new Error("unsupported gist URL");
	const id = m[1];
	const res = await fetch(`https://api.github.com/gists/${id}`, {
		headers: { accept: "application/vnd.github+json", "user-agent": "omp-deck" },
	});
	if (!res.ok) throw new Error(`gist fetch failed: HTTP ${res.status}`);
	const data = (await res.json()) as {
		description?: string;
		files?: Record<string, { filename?: string; content?: string }>;
	};
	const first = data.files ? Object.values(data.files)[0] : undefined;
	if (!first?.content) throw new Error("gist has no files");
	const title = data.description || first.filename || "Imported prompt";
	return { title, body: first.content, tags: ["gist"] };
}

export function buildPromptsRouter(): Hono {
	const app = new Hono();

	// ─── Library CRUD ────────────────────────────────────────────────────

	app.get("/prompts/library", async (c) => {
		try {
			const prompts = await promptsLibrary.list();
			const body: ListPromptsResponse = { prompts };
			return c.json(body);
		} catch (err) {
			log.error("list prompts failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/prompts/library/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const p = await promptsLibrary.get(id);
			if (!p) return c.json({ error: "not found" }, 404);
			return c.json(p);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("invalid")) {
				return c.json({ error: err.message }, 400);
			}
			log.error(`get prompt ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/prompts/library/:id/variables", async (c) => {
		const id = c.req.param("id");
		try {
			const p = await promptsLibrary.get(id);
			if (!p) return c.json({ error: "not found" }, 404);
			return c.json({ variables: extractVariables(p.body) });
		} catch (err) {
			log.error(`get variables for ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/prompts/library", async (c) => {
		let body: CreatePromptRequest;
		try {
			body = (await c.req.json()) as CreatePromptRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const created = await promptsLibrary.create({
				title: body.title,
				body: body.body,
				category: body.category,
				tags: body.tags,
				share: body.share,
				source: body.source,
			});
			return c.json(created, 201);
		} catch (err) {
			log.error("create prompt failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 400);
		}
	});

	app.put("/prompts/library/:id", async (c) => {
		const id = c.req.param("id");
		let body: UpdatePromptRequest;
		try {
			body = (await c.req.json()) as UpdatePromptRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const updated = await promptsLibrary.update(id, body);
			return c.json(updated);
		} catch (err) {
			if (err instanceof Error && err.message === `prompt not found: ${id}`) {
				return c.json({ error: "not found" }, 404);
			}
			if (err instanceof Error && err.message.startsWith("invalid")) {
				return c.json({ error: err.message }, 400);
			}
			log.error(`update prompt ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.delete("/prompts/library/:id", async (c) => {
		const id = c.req.param("id");
		try {
			const ok = await promptsLibrary.delete(id);
			if (!ok) return c.json({ error: "not found" }, 404);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`delete prompt ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/prompts/library/:id/use", async (c) => {
		const id = c.req.param("id");
		try {
			const updated = await promptsLibrary.bumpUsage(id);
			if (!updated) return c.json({ error: "not found" }, 404);
			return c.json(updated);
		} catch (err) {
			log.error(`bump usage ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Import / export ─────────────────────────────────────────────────

	app.post("/prompts/library/import", async (c) => {
		let body: ImportPromptRequest;
		try {
			body = (await c.req.json()) as ImportPromptRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			let payload: unknown;
			if (body.prompt) {
				payload = body.prompt;
			} else if (body.rawJson) {
				payload = JSON.parse(body.rawJson);
			} else if (body.url) {
				const gist = await fetchGist(body.url);
				payload = { title: gist.title, body: gist.body, tags: gist.tags };
			} else {
				return c.json({ error: "prompt | rawJson | url required" }, 400);
			}
			const created = await promptsLibrary.importPrompt(payload);
			return c.json({ id: created.id, prompt: created }, 201);
		} catch (err) {
			log.error("import prompt failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 400);
		}
	});

	app.get("/prompts/library/:id/export", async (c) => {
		const id = c.req.param("id");
		try {
			const p = await promptsLibrary.exportPrompt(id);
			return c.json(p);
		} catch (err) {
			if (err instanceof Error && err.message.startsWith("invalid")) {
				return c.json({ error: err.message }, 400);
			}
			log.error(`export ${id} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Share (read-only by slug) ───────────────────────────────────────

	app.get("/prompts/share/:slug", async (c) => {
		const slug = c.req.param("slug");
		try {
			const p = await promptsLibrary.getBySlug(slug);
			if (!p) return c.json({ error: "not found" }, 404);
			return c.json(p);
		} catch (err) {
			log.error(`share ${slug} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// ─── Recommendation ──────────────────────────────────────────────────
	//
	// No rich project-signal feed exists yet (Worker B owns the discovery
	// plumbing); for v0 the engine operates on the prompt text alone plus
	// usage decay. `historyTerms` and `projectTerms` are accepted via the
	// request body so the client can layer its own context in. Empty signal
	// shapes return library entries sorted by usage recency.

	app.get("/prompts/recommend", async (c) => {
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Math.max(1, Math.min(20, Number.parseInt(limitRaw, 10) || 5)) : 5;
		const projectTerms = parseCsv(c.req.query("projectTerms"));
		const historyTerms = parseCsv(c.req.query("historyTerms"));
		try {
			const prompts = await promptsLibrary.list();
			const usageWeights = await buildUsageWeights(prompts);
			const recs = recommendPrompts(prompts, {
				signals: {
					projectTerms,
					historyTerms,
					usageWeights,
				},
				limit,
			});
			// Fallback: if the engine returned nothing (empty signals, no
			// matches) surface the most-recently-used prompts so the panel
			// isn't blank when the user opens the composer.
			if (recs.length === 0 && prompts.length > 0) {
				const fallback = prompts
					.filter((p) => p.lastUsedAt !== null)
					.slice(0, limit);
				const fallbackBody: ListPromptRecommendationsResponse = {
					recommendations: fallback.map((prompt) => ({
						prompt,
						score: 0,
						why: "recently used",
						matchedSignals: ["usage"],
					})),
				};
				return c.json(fallbackBody);
			}
			const body: ListPromptRecommendationsResponse = { recommendations: recs };
			return c.json(body);
		} catch (err) {
			log.error("recommend failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/prompts/recommend", async (c) => {
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Math.max(1, Math.min(20, Number.parseInt(limitRaw, 10) || 5)) : 5;
		let body: { projectTerms?: string[]; historyTerms?: string[]; cwd?: string } = {};
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw);
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const prompts = await promptsLibrary.list();
			const usageWeights = await buildUsageWeights(prompts);
			const recs = recommendPrompts(prompts, {
				signals: {
					projectTerms: body.projectTerms ?? [],
					historyTerms: body.historyTerms ?? [],
					usageWeights,
				},
				limit,
			});
			const resp: ListPromptRecommendationsResponse = { recommendations: recs };
			return c.json(resp);
		} catch (err) {
			log.error("recommend failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// Silence the unused-import warning for `emptySignals`; it's exported for
	// future tests and callers that want a safe starter signal set.
	void emptySignals;

	return app;
}

function parseCsv(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}