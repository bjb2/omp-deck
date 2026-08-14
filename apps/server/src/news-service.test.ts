/**
 * Tests for the news-service module:
 *  1. parseRss extracts <item>/<entry> titles, links, and dates.
 *  2. NewsService.getNews serves last-good cache + stale:true when the
 *     upstream fetch throws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { NewsService, parseRss } from "./news-service.ts";

let dataDir: string | null = null;

beforeEach(() => {
	dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-news-"));
});

afterEach(() => {
	if (dataDir) {
		try {
			fs.rmSync(dataDir, { recursive: true, force: true });
		} catch {
			// best-effort
		}
		dataDir = null;
	}
});

describe("parseRss", () => {
	test("extracts RSS 2.0 <item> entries with title, link, and pubDate", () => {
		const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>TechCrunch</title>
    <item>
      <title>First post</title>
      <link>https://example.com/first</link>
      <pubDate>Mon, 04 Aug 2025 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Hello &amp; welcome</p>]]></description>
    </item>
    <item>
      <title>Second post</title>
      <link>https://example.com/second</link>
      <pubDate>Tue, 05 Aug 2025 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
		const items = parseRss(xml, "TechCrunch");
		expect(items.length).toBe(2);
		expect(items[0]?.title).toBe("First post");
		expect(items[0]?.url).toBe("https://example.com/first");
		expect(items[0]?.source).toBe("TechCrunch");
		expect(items[0]?.publishedAt).toMatch(/2025-08-04/);
		expect(items[0]?.summary).toContain("Hello & welcome");
		expect(items[1]?.url).toBe("https://example.com/second");
	});

	test("extracts Atom <entry> entries with <link href/>", () => {
		const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Verge</title>
  <entry>
    <id>tag:example.com,2025:1</id>
    <title>Atom one</title>
    <link href="https://example.com/atom-1"/>
    <published>2025-08-04T10:00:00Z</published>
  </entry>
</feed>`;
		const items = parseRss(xml, "The Verge");
		expect(items.length).toBe(1);
		expect(items[0]?.title).toBe("Atom one");
		expect(items[0]?.url).toBe("https://example.com/atom-1");
		expect(items[0]?.source).toBe("The Verge");
		expect(items[0]?.publishedAt).toBe("2025-08-04T10:00:00.000Z");
	});

	test("skips entries with missing title or link", () => {
		const xml = `<rss><channel>
			<item><link>https://a/</link></item>
			<item><title>No link</title></item>
			<item><title>Has both</title><link>https://b/</link><pubDate>2025-08-04T10:00:00Z</pubDate></item>
		</channel></rss>`;
		const items = parseRss(xml, "Feed");
		expect(items.length).toBe(1);
		expect(items[0]?.url).toBe("https://b/");
	});
});

describe("NewsService cache fallback", () => {
	test("seeds cache directly and serves stale:true when fetch throws", async () => {
		// Seed the cache file directly so we never hit the network.
		const cacheFile = path.join(dataDir!, "news-cache.json");
		const seeded = [
			{
				id: "n_1",
				title: "Seeded story",
				url: "https://example.com/seeded",
				source: "Hacker News",
				publishedAt: "2025-08-04T10:00:00Z",
			},
		];
		fs.writeFileSync(cacheFile, JSON.stringify({ savedAt: new Date().toISOString(), items: seeded }), "utf8");

		// Stubbed fetch — every URL throws. The TTL check will treat the
		// seed as stale (we just wrote it, but we'll force refresh).
		const throwingFetch = (() => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const service = new NewsService(dataDir!, { fetch: throwingFetch });

		const result = await service.getNews({ refresh: true });
		expect(result.items).toEqual(seeded);
		expect(result.stale).toBe(true);
	});

	test("returns stale:true when no cache exists and fetch throws", async () => {
		const throwingFetch = (() => {
			throw new Error("offline");
		}) as unknown as typeof fetch;
		const service = new NewsService(dataDir!, { fetch: throwingFetch });

		const result = await service.getNews({ refresh: true });
		expect(result.items).toEqual([]);
		expect(result.stale).toBe(true);
	});
});
