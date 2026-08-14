import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { broadcastBus } from "../broadcast-bus.ts";
import { logger } from "../log.ts";
import { getDiscoveryCache } from "./cache.ts";
import { getDiscoveryService } from "./index.ts";

type DiscoverySection = "plugins" | "mcps" | "skills" | "prompts" | "kb" | "all";

const log = logger("discovery");

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
		// v0 stub: returns the cache-keyed payload unchanged. The store's
		// `livePulseIds` and the bus already route live updates; a full
		// resolve flow (drill into a single hit) is a future iteration.
		const id = c.req.query("id");
		if (!id) return c.json({ error: "id is required" }, 400);
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
