/**
 * Discovery providers — each one wraps an upstream search surface and
 * returns a flat `DiscoveryHit[]` list. The orchestrator (§discovery/index.ts)
 * falls through them in priority order: parallel → exa → tavily → grep.
 *
 * Each provider is a thin shim around the relevant HTTP API. The deck
 * already has the API tokens in env (`MCP_PARALLEL_TOKEN`, `EXA_API_KEY`,
 * `TAVILY_TOKEN`) — we just read them and POST. No SDK; the providers
 * here are intentionally hand-rolled because the existing gholam-side
 * MCP transports are stdio-wrapping MCP servers, and we want discovery
 * to be independently callable from REST without standing up a child.
 */
import type { DiscoveryHit } from "@omp-deck/protocol";

import { getDiscoveryCache, type DiscoveryCache } from "./cache.ts";

export type ProviderName = "parallel" | "exa" | "tavily" | "grep";

export interface ProviderSearchOpts {
	q: string;
	section: DiscoverySection;
	limit: number;
}

type DiscoverySection = "plugins" | "mcps" | "skills" | "prompts" | "kb" | "all";

export interface ProviderSearchResult {
	hits: DiscoveryHit[];
	raw: unknown;
}

export interface DiscoveryProvider {
	readonly name: ProviderName;
	search(opts: ProviderSearchOpts): Promise<ProviderSearchResult>;
	available(): boolean;
}

const PARALLEL_URL = "https://search.parallel.ai/v1/search";
const EXA_URL = "https://api.exa.ai/search";
const TAVILY_URL = "https://api.tavily.com/search";

const USER_AGENT = "omp-deck/discovery";

function providerHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		"user-agent": USER_AGENT,
		accept: "application/json",
	};
}

function envKey(name: string): string | undefined {
	const v = process.env[name]?.trim();
	return v && v.length > 0 ? v : undefined;
}

function makeId(section: string, kind: string, ref: string): string {
	return `${section}:${kind}:${ref}`.toLowerCase();
}

function normalizeQ(q: string): string {
	return q.trim();
}

function sectionToCapability(section: DiscoverySection): string {
	if (section === "all") return "code";
	return section.replace(/s$/, "");
}

class ParallelProvider implements DiscoveryProvider {
	readonly name = "parallel" as const;
	private readonly cache: DiscoveryCache;
	constructor(cache: DiscoveryCache) {
		this.cache = cache;
	}
	available(): boolean {
		return Boolean(envKey("MCP_PARALLEL_TOKEN"));
	}
	async search(opts: ProviderSearchOpts): Promise<ProviderSearchResult> {
		const cacheKey = `web:parallel:${normalizeQ(opts.q)}:${opts.section}:${opts.limit}`;
		const cached = await this.cache.get(cacheKey);
		if (cached) return { hits: cached as DiscoveryHit[], raw: { cached: true } };
		const token = envKey("MCP_PARALLEL_TOKEN");
		if (!token) return { hits: [], raw: null };
		const res = await fetch(PARALLEL_URL, {
			method: "POST",
			headers: { ...providerHeaders(), authorization: `Bearer ${token}` },
			body: JSON.stringify({
				query: `${opts.q} omp ${sectionToCapability(opts.section)}`,
				max_results: opts.limit,
			}),
		});
		if (!res.ok) return { hits: [], raw: { status: res.status } };
		const body = (await res.json().catch(() => null)) as { results?: Array<{ url?: string; title?: string; text?: string; excerpt?: string }> } | null;
		const fetchedAt = new Date().toISOString();
		const hits: DiscoveryHit[] = (body?.results ?? []).map((r, i) => {
			const url = r.url ?? "";
			return {
				id: makeId(opts.section, "web", `${url}#${i}`),
				section: opts.section === "all" ? "kb" : opts.section,
				title: r.title ?? url,
				tagline: (r.excerpt ?? r.text ?? "").slice(0, 140),
				description: (r.text ?? r.excerpt ?? "").slice(0, 600),
				url,
				source: { kind: "web", ref: url, fetchedAt },
				snippet: (r.text ?? r.excerpt ?? "").slice(0, 2048),
				score: 0.5,
				signals: ["provider:parallel"],
			} satisfies DiscoveryHit;
		});
		await this.cache.set(cacheKey, hits, 24 * 60 * 60 * 1000);
		await this.cache.recordProviderCall("parallel");
		return { hits, raw: body };
	}
}

class ExaProvider implements DiscoveryProvider {
	readonly name = "exa" as const;
	private readonly cache: DiscoveryCache;
	constructor(cache: DiscoveryCache) {
		this.cache = cache;
	}
	available(): boolean {
		return Boolean(envKey("EXA_API_KEY"));
	}
	async search(opts: ProviderSearchOpts): Promise<ProviderSearchResult> {
		const cacheKey = `web:exa:${normalizeQ(opts.q)}:${opts.section}:${opts.limit}`;
		const cached = await this.cache.get(cacheKey);
		if (cached) return { hits: cached as DiscoveryHit[], raw: { cached: true } };
		const key = envKey("EXA_API_KEY");
		if (!key) return { hits: [], raw: null };
		const res = await fetch(EXA_URL, {
			method: "POST",
			headers: { ...providerHeaders(), "x-api-key": key },
			body: JSON.stringify({
				query: opts.q,
				numResults: opts.limit,
				useAutoprompt: false,
			}),
		});
		if (!res.ok) return { hits: [], raw: { status: res.status } };
		const body = (await res.json().catch(() => null)) as { results?: Array<{ url?: string; title?: string; text?: string }> } | null;
		const fetchedAt = new Date().toISOString();
		const hits: DiscoveryHit[] = (body?.results ?? []).map((r, i) => {
			const url = r.url ?? "";
			return {
				id: makeId(opts.section, "web", `${url}#${i}`),
				section: opts.section === "all" ? "kb" : opts.section,
				title: r.title ?? url,
				tagline: (r.text ?? "").slice(0, 140),
				description: (r.text ?? "").slice(0, 600),
				url,
				source: { kind: "web", ref: url, fetchedAt },
				snippet: (r.text ?? "").slice(0, 2048),
				score: 0.5,
				signals: ["provider:exa"],
			} satisfies DiscoveryHit;
		});
		await this.cache.set(cacheKey, hits, 24 * 60 * 60 * 1000);
		await this.cache.recordProviderCall("exa");
		return { hits, raw: body };
	}
}

class TavilyProvider implements DiscoveryProvider {
	readonly name = "tavily" as const;
	private readonly cache: DiscoveryCache;
	constructor(cache: DiscoveryCache) {
		this.cache = cache;
	}
	available(): boolean {
		return Boolean(envKey("TAVILY_TOKEN") || envKey("TAVILY_API_KEY"));
	}
	async search(opts: ProviderSearchOpts): Promise<ProviderSearchResult> {
		const cacheKey = `web:tavily:${normalizeQ(opts.q)}:${opts.section}:${opts.limit}`;
		const cached = await this.cache.get(cacheKey);
		if (cached) return { hits: cached as DiscoveryHit[], raw: { cached: true } };
		const key = envKey("TAVILY_TOKEN") ?? envKey("TAVILY_API_KEY");
		if (!key) return { hits: [], raw: null };
		const res = await fetch(TAVILY_URL, {
			method: "POST",
			headers: { ...providerHeaders(), authorization: `Bearer ${key}` },
			body: JSON.stringify({
				query: opts.q,
				max_results: opts.limit,
				search_depth: "basic",
			}),
		});
		if (!res.ok) return { hits: [], raw: { status: res.status } };
		const body = (await res.json().catch(() => null)) as { results?: Array<{ url?: string; title?: string; content?: string }> } | null;
		const fetchedAt = new Date().toISOString();
		const hits: DiscoveryHit[] = (body?.results ?? []).map((r, i) => {
			const url = r.url ?? "";
			return {
				id: makeId(opts.section, "web", `${url}#${i}`),
				section: opts.section === "all" ? "kb" : opts.section,
				title: r.title ?? url,
				tagline: (r.content ?? "").slice(0, 140),
				description: (r.content ?? "").slice(0, 600),
				url,
				source: { kind: "web", ref: url, fetchedAt },
				snippet: (r.content ?? "").slice(0, 2048),
				score: 0.5,
				signals: ["provider:tavily"],
			} satisfies DiscoveryHit;
		});
		await this.cache.set(cacheKey, hits, 24 * 60 * 60 * 1000);
		await this.cache.recordProviderCall("tavily");
		return { hits, raw: body };
	}
}

class GrepProvider implements DiscoveryProvider {
	readonly name = "grep" as const;
	private readonly cache: DiscoveryCache;
	constructor(cache: DiscoveryCache) {
		this.cache = cache;
	}
	available(): boolean {
		// Grep's MCP service is at mcp.grep.app — no key required for the
		// public API. If the upstream is down, search() returns empty
		// rather than throwing.
		return true;
	}
	async search(opts: ProviderSearchOpts): Promise<ProviderSearchResult> {
		const cacheKey = `web:grep:${normalizeQ(opts.q)}:${opts.section}:${opts.limit}`;
		const cached = await this.cache.get(cacheKey);
		if (cached) return { hits: cached as DiscoveryHit[], raw: { cached: true } };
		const url = new URL("https://mcp.grep.app/api/search");
		url.searchParams.set("q", opts.q);
		url.searchParams.set("limit", String(opts.limit));
		try {
			const res = await fetch(url.toString(), {
				method: "GET",
				headers: providerHeaders(),
			});
			if (!res.ok) return { hits: [], raw: { status: res.status } };
			const body = (await res.json().catch(() => null)) as { hits?: Array<{ repo?: { raw?: string }; path?: { raw?: string }; content?: { snippet?: string } }> } | null;
			const fetchedAt = new Date().toISOString();
			const hits: DiscoveryHit[] = (body?.hits ?? []).map((h, i) => {
				const repo = h.repo?.raw ?? "unknown";
				const filePath = h.path?.raw ?? "";
				const ghUrl = `https://github.com/${repo}/blob/HEAD/${filePath}`;
				return {
					id: makeId(opts.section, "github", `${repo}/${filePath}#${i}`),
					section: opts.section === "all" ? "kb" : opts.section,
					title: `${repo}/${filePath}`,
					tagline: (h.content?.snippet ?? "").slice(0, 140),
					description: (h.content?.snippet ?? "").slice(0, 600),
					url: ghUrl,
					source: { kind: "github", ref: `${repo}/${filePath}`, fetchedAt },
					snippet: (h.content?.snippet ?? "").slice(0, 2048),
					score: 0.4,
					signals: ["provider:grep"],
				} satisfies DiscoveryHit;
			});
			await this.cache.set(cacheKey, hits, 24 * 60 * 60 * 1000);
			await this.cache.recordProviderCall("grep");
			return { hits, raw: body };
		} catch {
			return { hits: [], raw: null };
		}
	}
}

export function buildProviders(): DiscoveryProvider[] {
	const cache = getDiscoveryCache();
	return [new ParallelProvider(cache), new ExaProvider(cache), new TavilyProvider(cache), new GrepProvider(cache)];
}
