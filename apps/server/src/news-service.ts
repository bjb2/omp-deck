/**
 * News + trending repositories service for the overview dashboard.
 *
 * Aggregates multiple no-auth external sources (HN front page, TechCrunch /
 * Verge RSS, GitHub trending search) on a 30-minute disk cache under the
 * server's data dir. Always serves the last-good cached payload when a fetch
 * fails or the box is offline — surfacing `stale:true` so the UI can flag it.
 *
 * Sources are independent failures; `Promise.allSettled` + a 6s `AbortSignal`
 * per source keeps one slow/dead host from blanking the response.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("news");

export const NEWS_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const USER_AGENT = "omp-deck/1.0 (+overview)";

const HN_URL = "https://hn.algolia.com/api/v1/search?tags=front_page";
const RSS_FEEDS: ReadonlyArray<{ url: string; source: string }> = [
	{ url: "https://techcrunch.com/feed/", source: "TechCrunch" },
	{ url: "https://www.theverge.com/rss/index.xml", source: "The Verge" },
];

export interface NewsItem {
	id: string;
	title: string;
	url: string;
	source: string;
	publishedAt: string;
	summary?: string;
	tags?: string[];
}

export interface TrendingRepo {
	id: string;
	name: string;
	url: string;
	description?: string;
	stars?: number;
	language?: string;
	source: string;
}

export interface FetchDeps {
	fetch?: typeof fetch;
	now?: () => Date;
}

interface CacheFile<T> {
	savedAt: string;
	items: T[];
}

export interface NewsResult {
	items: NewsItem[];
	stale: boolean;
}

export interface TrendingResult {
	items: TrendingRepo[];
	stale: boolean;
}

export class NewsService {
	private readonly dataDir: string;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => Date;
	private readonly newsCachePath: string;
	private readonly trendingCachePath: string;

	constructor(dataDir: string, deps: FetchDeps = {}) {
		this.dataDir = dataDir;
		this.fetchFn = deps.fetch ?? globalThis.fetch.bind(globalThis);
		this.now = deps.now ?? (() => new Date());
		this.newsCachePath = path.join(dataDir, "news-cache.json");
		this.trendingCachePath = path.join(dataDir, "trending-cache.json");
	}

	/** Public entry: returns news[] + a `stale` flag. `refresh` bypasses TTL. */
	async getNews(opts: { refresh?: boolean } = {}): Promise<NewsResult> {
		const cached = this.cacheReady<NewsItem>(await this.readCache(this.newsCachePath), opts.refresh);
		// Always read the cache file (even when bypassing TTL) so a refresh
		// that fails upstream can still serve the last-good payload.
		const staleCache = cached ?? (await this.readCache<NewsItem>(this.newsCachePath));
		if (cached) {
			return { items: cached.items, stale: false };
		}
		try {
			const items = await fetchAllNews(this.fetchFn);
			if (items.length > 0) {
				await this.writeCache(this.newsCachePath, items);
				return { items, stale: false };
			}
			// Empty payload from upstream — keep the cache, mark stale.
			if (staleCache) return { items: staleCache.items, stale: true };
			return { items: [], stale: true };
		} catch (err) {
			log.warn("news fetch failed; serving cache", err);
			if (staleCache) return { items: staleCache.items, stale: true };
			return { items: [], stale: true };
		}
	}

	/** Public entry: trending repos. Same cache + stale contract. */
	async getTrending(opts: { refresh?: boolean } = {}): Promise<TrendingResult> {
		const cached = this.cacheReady<TrendingRepo>(await this.readCache(this.trendingCachePath), opts.refresh);
		const staleCache = cached ?? (await this.readCache<TrendingRepo>(this.trendingCachePath));
		if (cached) {
			return { items: cached.items, stale: false };
		}
		try {
			const items = await fetchTrendingRepos(this.fetchFn, this.now());
			if (items.length > 0) {
				await this.writeCache(this.trendingCachePath, items);
				return { items, stale: false };
			}
			if (staleCache) return { items: staleCache.items, stale: true };
			return { items: [], stale: true };
		} catch (err) {
			log.warn("trending fetch failed; serving cache", err);
			if (staleCache) return { items: staleCache.items, stale: true };
			return { items: [], stale: true };
		}
	}

	private cacheReady<T>(file: CacheFile<T> | null, refresh?: boolean): CacheFile<T> | null {
		if (!file || refresh === true) return null;
		return this.isFresh(file.savedAt) ? file : null;
	}

	private isFresh(savedAt: string): boolean {
		const t = Date.parse(savedAt);
		return Number.isFinite(t) && this.now().getTime() - t < NEWS_TTL_MS;
	}

	private async readCache<T>(file: string): Promise<CacheFile<T> | null> {
		try {
			const raw = await fs.readFile(file, "utf8");
			const parsed = JSON.parse(raw) as CacheFile<T>;
			return parsed && Array.isArray(parsed.items) ? parsed : null;
		} catch {
			return null;
		}
	}

	private async writeCache<T>(file: string, items: T[]): Promise<void> {
		try {
			await fs.mkdir(path.dirname(file), { recursive: true });
			const payload: CacheFile<T> = { savedAt: this.now().toISOString(), items };
			await fs.writeFile(file, JSON.stringify(payload), "utf8");
		} catch (err) {
			log.warn(`cache write failed at ${file}`, err);
		}
	}
}

// ─── Source fetchers ───────────────────────────────────────────────────────

async function fetchAllNews(fetchFn: typeof fetch): Promise<NewsItem[]> {
	const settled = await Promise.allSettled([
		fetchHackerNews(fetchFn),
		fetchRssFeeds(fetchFn),
	]);
	const merged: NewsItem[] = [];
	for (const s of settled) {
		if (s.status === "fulfilled") merged.push(...s.value);
	}
	merged.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
	// De-dupe by URL — the same story can appear on HN and in RSS.
	const seen = new Set<string>();
	const out: NewsItem[] = [];
	for (const item of merged) {
		if (seen.has(item.url)) continue;
		seen.add(item.url);
		out.push(item);
	}
	return out.slice(0, 60);
}

async function fetchHackerNews(fetchFn: typeof fetch): Promise<NewsItem[]> {
	const res = await fetchWithTimeout(fetchFn, HN_URL);
	const data = (await res.json()) as { hits?: Array<Record<string, unknown>> };
	if (!Array.isArray(data.hits)) return [];
	const items: NewsItem[] = [];
	for (const h of data.hits) {
		const title = typeof h.title === "string" ? h.title.trim() : "";
		const url = typeof h.url === "string" ? h.url.trim() : "";
		if (!title || !url) continue;
		const id = typeof h.objectID === "string" ? h.objectID : hashId("hn", url);
		const publishedAt = typeof h.created_at === "string" ? h.created_at : new Date().toISOString();
		const item: NewsItem = {
			id,
			title,
			url,
			source: "Hacker News",
			publishedAt,
		};
		const points = typeof h.points === "number" ? h.points : undefined;
		const author = typeof h.author === "string" ? h.author : undefined;
		if (typeof h._tags === "string") item.tags = ["hn", h._tags];
		else if (author || points) item.tags = ["hn"];
		items.push(item);
	}
	return items;
}

async function fetchRssFeeds(fetchFn: typeof fetch): Promise<NewsItem[]> {
	const settled = await Promise.allSettled(
		RSS_FEEDS.map(async (feed) => {
			const res = await fetchWithTimeout(fetchFn, feed.url, { accept: "application/rss+xml, application/atom+xml, text/xml" });
			const xml = await res.text();
			return parseRss(xml, feed.source);
		}),
	);
	const out: NewsItem[] = [];
	for (const s of settled) if (s.status === "fulfilled") out.push(...s.value);
	return out;
}

async function fetchTrendingRepos(fetchFn: typeof fetch, now: Date): Promise<TrendingRepo[]> {
	// 7-day window — matches the dashboard's default `7d` range.
	const created = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
	const url =
		`https://api.github.com/search/repositories?q=created:%3E${created}` +
		`&sort=stars&order=desc&per_page=15`;
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"user-agent": USER_AGENT,
	};
	const token = process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	if (token) headers.authorization = `Bearer ${token}`;
	const res = await fetchWithTimeout(fetchFn, url, headers);
	const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
	if (!Array.isArray(data.items)) return [];
	return data.items.map((r): TrendingRepo => {
		const fullName = typeof r.full_name === "string" ? r.full_name : "";
		const htmlUrl = typeof r.html_url === "string" ? r.html_url : "";
		return {
			id: String(r.id ?? fullName),
			name: fullName,
			url: htmlUrl,
			description: typeof r.description === "string" ? r.description || undefined : undefined,
			stars: typeof r.stargazers_count === "number" ? r.stargazers_count : undefined,
			language: typeof r.language === "string" ? r.language || undefined : undefined,
			source: "GitHub",
		};
	});
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string,
	extraHeaders: Record<string, string> = {},
): Promise<Response> {
	const res = await fetchFn(url, {
		headers: { accept: "application/json", "user-agent": USER_AGENT, ...extraHeaders },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return res;
}

// ─── RSS / Atom parser (no dependency) ─────────────────────────────────────

const CDATA_RE = /^<!\[CDATA\[([\s\S]*?)\]\]>$/;
const HTML_TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

function stripCdata(s: string): string {
	const m = CDATA_RE.exec(s);
	return m ? m[1]! : s;
}

/** Tiny HTML unescape covering the entities RSS feeds actually emit. */
function unescapeHtml(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n: string) => {
			const code = Number.parseInt(n, 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : "";
		});
}

function cleanText(s: string): string {
	return stripCdata(unescapeHtml(s)).replace(HTML_TAG_RE, " ").replace(WHITESPACE_RE, " ").trim();
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Pull the inner text of the first <foo>…</foo> block at this level. */
function extractTag(xml: string, tag: string): string | null {
	const re = new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)</${escapeRegex(tag)}>`, "i");
	const m = re.exec(xml);
	return m ? m[1] ?? null : null;
}

/** Atom <link href="..."/> — returns the first href. */
function extractAtomLink(xml: string): string | null {
	const re = /<link\b[^>]*?href=["']([^"']+)["'][^>]*\/?>/i;
	const m = re.exec(xml);
	return m ? m[1] ?? null : null;
}

/** Normalize RFC 822 / ISO date strings to ISO; returns now() on parse failure. */
function normalizeDate(raw: string | null): string {
	if (!raw) return new Date().toISOString();
	const cleaned = raw.trim();
	const t = Date.parse(cleaned);
	if (Number.isFinite(t)) return new Date(t).toISOString();
	return new Date().toISOString();
}

/**
 * Parse RSS 2.0 / Atom 1.0 XML into NewsItem[]. Handles both <item> and
 * <entry> with a small set of regexes — good enough for the two feeds we
 * actually consume and intentionally dependency-free.
 */
export function parseRss(xml: string, source: string): NewsItem[] {
	const items: NewsItem[] = [];
	const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>|<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
	let m: RegExpExecArray | null;
	while ((m = itemRe.exec(xml)) !== null) {
		const block = (m[1] ?? m[2] ?? "").trim();
		if (!block) continue;
		const rawTitle = extractTag(block, "title");
		const title = rawTitle ? cleanText(rawTitle) : "";
		if (!title) continue;
		let url = extractTag(block, "link");
		if (!url) url = extractAtomLink(block);
		if (!url) {
			const guid = extractTag(block, "guid");
			if (guid && /^https?:\/\//i.test(guid.trim())) url = guid.trim();
		}
		if (!url) continue;
		const summaryRaw = extractTag(block, "description") ?? extractTag(block, "summary") ?? extractTag(block, "content");
		const summary = summaryRaw ? cleanText(summaryRaw).slice(0, 280) : undefined;
		const publishedAt = normalizeDate(
			extractTag(block, "pubDate") ?? extractTag(block, "published") ?? extractTag(block, "updated"),
		);
		const idRaw = extractTag(block, "guid") ?? extractTag(block, "id");
		items.push({
			id: idRaw ? cleanText(idRaw) || hashId(source, url) : hashId(source, url),
			title,
			url,
			source,
			publishedAt,
			...(summary ? { summary } : {}),
		});
	}
	return items;
}

function hashId(source: string, url: string): string {
	// Deterministic short id — no crypto dep, just a fold to keep it stable.
	let h = 5381;
	const s = `${source}|${url}`;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return `n_${(h >>> 0).toString(36)}`;
}
