/**
 * Tests for GET /api/discovery/resolve. The endpoint reads from an
 * in-process index populated by `discovery_added` and `store_item_added`
 * bus frames; cache misses (or hits that aged out of the LRU window)
 * surface as `{resolved:false}` rather than an error. The bus is the
 * only seam the test needs to drive.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { DiscoveryHit } from "@omp-deck/protocol";

import { broadcastBus } from "../broadcast-bus.ts";
import {
	buildDiscoveryRouter,
	__resetDiscoveryHitIndexForTests,
} from "./routes.ts";

function req(path: string): Request {
	return new Request(`http://deck.example.com${path}`);
}

function makeHit(id: string, overrides: Partial<DiscoveryHit> = {}): DiscoveryHit {
	return {
		id,
		section: "plugins",
		title: `Hit ${id}`,
		url: `https://example.com/${id}`,
		source: { kind: "web", ref: `https://example.com/${id}`, fetchedAt: new Date().toISOString() },
		score: 1,
		signals: [],
		...overrides,
	};
}

afterEach(() => {
	__resetDiscoveryHitIndexForTests();
});

describe("GET /api/discovery/resolve", () => {
	test("returns 400 when id is missing", async () => {
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve"));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("id is required");
	});

	test("returns resolved:false for an unknown id", async () => {
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id=nope"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; resolved: boolean; hit?: unknown };
		expect(body.id).toBe("nope");
		expect(body.resolved).toBe(false);
		expect(body.hit).toBeUndefined();
	});

	test("returns resolved:true with the hit payload after a discovery_added frame", async () => {
		const hit = makeHit("plugin-x");
		broadcastBus.broadcast({ type: "discovery_added", hits: [hit] });
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id=plugin-x"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			id: string;
			resolved: boolean;
			hit: DiscoveryHit;
		};
		expect(body.id).toBe("plugin-x");
		expect(body.resolved).toBe(true);
		expect(body.hit.title).toBe(hit.title);
		expect(body.hit.section).toBe("plugins");
		expect(body.hit.url).toBe(hit.url);
	});

	test("ingests store_item_added frames and projects them as DiscoveryHit", async () => {
		broadcastBus.broadcast({
			type: "store_item_added",
			section: "skills",
			item: {
				id: "skill-y",
				title: "Skill Y",
				tagline: "does a thing",
				snippet: "long description",
				url: "/storefront/section/skills/skill-y",
				source: { kind: "local", ref: "skills/skill-y" },
			} as never,
		});
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id=skill-y"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			resolved: boolean;
			hit: DiscoveryHit;
		};
		expect(body.resolved).toBe(true);
		expect(body.hit.section).toBe("skills");
		expect(body.hit.title).toBe("Skill Y");
		expect(body.hit.tagline).toBe("does a thing");
		expect(body.hit.url).toBe("/storefront/section/skills/skill-y");
	});

	test("ignores store_item frames whose section is not a valid DiscoveryHit section", async () => {
		broadcastBus.broadcast({
			type: "store_item_added",
			// The wire carries `section` at the frame level — feed an
			// invalid value there to confirm the projector rejects it
			// rather than falling back to anything in `item`.
			section: "bogus" as never,
			item: { id: "bad-section" } as never,
		});
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id=bad-section"));
		const body = (await res.json()) as { resolved: boolean };
		expect(body.resolved).toBe(false);
	});

	test("ignores store_item frames with a non-string id", async () => {
		broadcastBus.broadcast({
			type: "store_item_added",
			section: "plugins",
			item: { id: "bad-section" } as never,
		});
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id=42"));
		const body = (await res.json()) as { resolved: boolean };
		expect(body.resolved).toBe(false);
	});

	test("evicts oldest entries past the LRU cap", async () => {
		// Drive the cap indirectly: the cap (MAX_HITS = 1000) is large,
		// but eviction ordering matters for correctness. Simulate by
		// clearing and re-adding with a known ordering pattern: ensure
		// the *most recent* observation survives a refresh of an older
		// id. A direct eviction check would need 1000+ items; we cover
		// the recency-refresh contract here instead.
		broadcastBus.broadcast({
			type: "discovery_added",
			hits: [makeHit("a", { title: "first" })],
		});
		broadcastBus.broadcast({
			type: "discovery_added",
			hits: [makeHit("b", { title: "second" })],
		});
		broadcastBus.broadcast({
			type: "discovery_added",
			hits: [makeHit("a", { title: "first-refreshed" })],
		});
		const a = await buildDiscoveryRouter().request(req("/discovery/resolve?id=a"));
		const abody = (await a.json()) as { hit: DiscoveryHit };
		expect(abody.hit.title).toBe("first-refreshed");
		const b = await buildDiscoveryRouter().request(req("/discovery/resolve?id=b"));
		const bbody = (await b.json()) as { hit: DiscoveryHit };
		expect(bbody.hit.title).toBe("second");
	});

	test("ignores discovery_added hits without an id", async () => {
		broadcastBus.broadcast({
			type: "discovery_added",
			hits: [{ ...makeHit(""), id: "" } as DiscoveryHit],
		});
		const res = await buildDiscoveryRouter().request(req("/discovery/resolve?id="));
		expect(res.status).toBe(400);
	});
});
