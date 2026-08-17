import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { broadcastBus } from "../broadcast-bus.ts";
import { logger } from "../log.ts";
import type { DiscoveryHit } from "@omp-deck/protocol";
import { getDiscoveryCache } from "./cache.ts";
import { getDiscoveryService } from "./index.ts";

type DiscoverySection = "plugins" | "mcps" | "skills" | "prompts" | "kb" | "all";

const log = logger("discovery");

// Bounded in-process index of discovery + storefront hits keyed by id.
// Populated by `discovery_added` / `store_item_added` / `store_item_updated`
// bus frames and evicted LRU at MAX_HITS so long-lived sessions don't
// grow without bound. `resolve` looks up by id; cache misses are an
// expected outcome (the hit was never observed, or it fell out of the
// LRU window) and surface as `resolved: false`.
const MAX_HITS = 1_000;
const hitIndex = new Map<string, DiscoveryHit>();
let indexSubscription: (() => void) | null = null;

function ingestHit(hit: DiscoveryHit): void {
	if (!hit?.id) return;
	if (hitIndex.has(hit.id)) {
		// Refresh recency: delete + set so insertion order reflects the
		// latest observation, not the first.
		hitIndex.delete(hit.id);
	} else if (hitIndex.size >= MAX_HITS) {
		// Evict oldest entry (Map iteration order = insertion order).
		const oldest = hitIndex.keys().next().value;
		if (oldest !== undefined) hitIndex.delete(oldest);
	}
	hitIndex.set(hit.id, hit);
}

function ingestStoreItem(section: unknown, item: {
	id?: unknown;
	source?: { kind?: unknown; ref?: unknown };
	title?: unknown;
	tagline?: unknown;
	snippet?: unknown;
	url?: unknown;
}): void {
	if (typeof item?.id !== "string" || !item.id) return;
	if (section !== "plugins" && section !== "mcps" && section !== "skills" && section !== "prompts" && section !== "kb") {
		return;
	}
	// Project the wire shape onto the DiscoveryHit contract so the same
	// resolve path serves both providers and storefront cards.
	ingestHit({
		id: item.id,
		section,
		title: typeof item.title === "string" ? item.title : item.id,
		tagline: typeof item.tagline === "string" ? item.tagline : undefined,
		description: typeof item.snippet === "string" ? item.snippet : undefined,
		url: typeof item.url === "string" ? item.url : "",
		source: {
			kind: "local",
			ref: typeof item.source?.ref === "string" ? item.source.ref : "",
			fetchedAt: new Date().toISOString(),
		},
		score: 0,
		signals: [],
	});
}

function ensureIndexSubscription(): void {
	if (indexSubscription) return;
	indexSubscription = broadcastBus.subscribe((frame) => {
		if (frame.type === "discovery_added") {
			for (const hit of frame.hits) ingestHit(hit);
		} else if (frame.type === "store_item_added" || frame.type === "store_item_updated") {
			// `section` lives at the frame level (BroadcastFrame union),
			// not inside `item`. Forward both so the projector can use
			// the canonical section and the item's display fields.
			ingestStoreItem(frame.section, frame.item as Parameters<typeof ingestStoreItem>[1]);
		}
	});
}

/** Test seam — clears the in-process index between runs. Production never
 *  calls this; the index is meant to outlive the request lifecycle. */
export function __resetDiscoveryHitIndexForTests(): void {
	hitIndex.clear();
}

const VALID_SECTIONS: ReadonlySet<DiscoverySection> = new Set([
	"plugins",
	"mcps",
	"skills",
	"prompts",
	"kb",
	"all",
]);

function parseSection(value: string | undefined): DiscoverySection {
	if (!value) return "all";
	return VALID_SECTIONS.has(value as DiscoverySection) ? (value as DiscoverySection) : "all";
}

function parseLimit(value: string | undefined): number {
	if (!value) return 10;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1) return 10;
	return Math.min(50, n);
}

export function buildDiscoveryRouter(): Hono {
	const app = new Hono();
	app.get("/discovery/search", async (c) => {
		const q = c.req.query("q")?.trim() ?? "";
		if (!q) return c.json({ hits: [], providersUsed: [], cacheHits: 0, tookMs: 0 }, 400);
		const section = parseSection(c.req.query("section"));
		const limit = parseLimit(c.req.query("limit"));
		const service = getDiscoveryService();
		try {
			const result = await service.search({ q, section, limit });
			return c.json(result);
		} catch (err) {
			log.error(`discovery search failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/discovery/resolve", async (c) => {
		// Real lookup against the in-process hit index, populated by
		// `discovery_added` / `store_item_added` / `store_item_updated`
		// bus frames (see `ensureIndexSubscription` above). Cache misses
		// return `resolved: false` — the hit was never observed or fell
		// out of the LRU window, not a server error.
		ensureIndexSubscription();
		const id = c.req.query("id");
		if (!id) return c.json({ error: "id is required" }, 400);
		const hit = hitIndex.get(id);
		if (hit) return c.json({ id, resolved: true, hit });
		return c.json({ id, resolved: false });
	});

	app.get("/discovery/stream", (c) => {
		return streamSSE(c, async (stream) => {
			const unsub = broadcastBus.subscribe((frame) => {
				if (frame.type !== "discovery_added" && frame.type !== "store_item_added" && frame.type !== "store_item_updated" && frame.type !== "store_item_removed") {
					return;
				}
				void stream.writeSSE({
					event: frame.type,
					data: JSON.stringify(frame),
				}).catch(() => {
					// Client disconnected mid-write; the outer async scope
					// will catch it on the next iteration and the bus
					// listener will be unsubscribed.
				});
			});
			stream.onAbort(() => unsub());
			// Keep the stream open; emit a keep-alive every 25s so
			// proxies don't drop the connection. 25s sits below typical
			// 30s idle timeouts.
			const keepAlive = setInterval(() => {
				void stream.writeSSE({ event: "ping", data: "{}" }).catch(() => {
					clearInterval(keepAlive);
				});
			}, 25_000);
			keepAlive.unref?.();
			// Park until the client disconnects.
			await new Promise<void>((resolve) => {
				stream.onAbort(() => {
					clearInterval(keepAlive);
					resolve();
				});
			});
			unsub();
		});
	});

	app.post("/discovery/cache/purge", async (c) => {
		await getDiscoveryCache().purge();
		return c.json({ ok: true });
	});

	return app;
}
