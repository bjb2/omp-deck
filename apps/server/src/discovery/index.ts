/**
 * DiscoveryService — orchestrator. Fans a single query out across the
 * configured providers in the priority order
 * `parallel → exa → tavily → grep` and merges/dedupes the results. The
 * UI shows "12 results · 3 from marketplace, 6 from GitHub, 3 from web
 * (parallel)" via the `{ providersUsed, cacheHits, tookMs }` envelope.
 *
 * Dedup key is `(section, source.kind, ref)` so the same marketplace
 * plugin and the same GitHub repo don't double-count.
 */
import { broadcastBus } from "../broadcast-bus.ts";
import type { DiscoveryHit, DiscoverySearchResponse } from "@omp-deck/protocol";

import { getDiscoveryCache } from "./cache.ts";
import { buildProviders, type DiscoveryProvider, type ProviderName } from "./providers.ts";

export interface SearchRequest {
	q: string;
	section: DiscoverySection;
	limit?: number;
}

type DiscoverySection = "plugins" | "mcps" | "skills" | "prompts" | "kb" | "all";

interface SearchMeta {
	providersUsed: ProviderName[];
	cacheHits: number;
	tookMs: number;
}

export class DiscoveryService {
	private readonly providers: DiscoveryProvider[];

	constructor(opts?: { providers?: DiscoveryProvider[] }) {
		this.providers = opts?.providers ?? buildProviders();
	}

	async search(req: SearchRequest): Promise<DiscoverySearchResponse & SearchMeta> {
		const start = Date.now();
		const limit = Math.max(1, Math.min(50, req.limit ?? 10));
		const dedup = new Map<string, DiscoveryHit>();
		const providersUsed: ProviderName[] = [];
		let cacheHits = 0;
		let missing = limit;
		for (const provider of this.providers) {
			if (missing <= 0) break;
			if (!provider.available()) continue;
			let result: { hits: DiscoveryHit[]; raw: unknown };
			try {
				result = await provider.search({ q: req.q, section: req.section, limit: missing });
			} catch {
				continue;
			}
			providersUsed.push(provider.name);
			if (result.raw && typeof result.raw === "object" && (result.raw as { cached?: boolean }).cached) {
				cacheHits += result.hits.length;
			}
			for (const hit of result.hits) {
				const key = `${hit.section}:${hit.source.kind}:${hit.source.ref}`;
				if (dedup.has(key)) continue;
				dedup.set(key, hit);
				missing--;
				if (missing <= 0) break;
			}
		}
		const hits = Array.from(dedup.values()).slice(0, limit);
		const tookMs = Date.now() - start;
		// Fan the result batch over the broadcast bus so any subscriber
		// (the storefront SSE stream, a connected WS client) sees the
		// new hits without polling.
		if (hits.length > 0) {
			broadcastBus.broadcast({ type: "discovery_added", hits });
		}
		// Best-effort: touch the usage snapshot so the counter file
		// advances for any UI that reads it later. Failures are silent.
		await getDiscoveryCache().readUsage();
		return { hits, providersUsed, cacheHits, tookMs };
	}
}

let _instance: DiscoveryService | undefined;
export function getDiscoveryService(): DiscoveryService {
	if (!_instance) _instance = new DiscoveryService();
	return _instance;
}
