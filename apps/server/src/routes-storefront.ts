import { Hono } from "hono";

import type { StoreItem, StoreSection } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { getStorefrontCatalog, getStorefrontItem, getStorefrontItemsBySection } from "./storefront-catalog.ts";

const log = logger("routes:storefront");

const VALID_SECTIONS: ReadonlySet<StoreSection> = new Set([
	"plugins",
	"mcps",
	"skills",
	"prompts",
]);

function parseLimit(value: string | undefined, fallback = 8, max = 50): number {
	if (!value) return fallback;
	const n = Number.parseInt(value, 10);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(max, n);
}

function pick(items: StoreItem[], predicate: (i: StoreItem) => boolean, limit: number): StoreItem[] {
	return items.filter(predicate).slice(0, limit);
}

function sortByRecency(items: StoreItem[]): StoreItem[] {
	return [...items].sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
}

function sortByInstalls(items: StoreItem[]): StoreItem[] {
	return [...items].sort((a, b) => b.installs - a.installs);
}

export function buildStorefrontRouter(): Hono {
	const app = new Hono();
	app.get("/storefront/featured", async (c) => {
		const limit = parseLimit(c.req.query("limit"), 8, 20);
		const all = await getStorefrontCatalog();
		const featured = pick(all, (i) => i.id.endsWith("@anthropic") || i.isNew === true, limit);
		const fallback = featured.length > 0 ? featured : sortByInstalls(all).slice(0, limit);
		return c.json({ items: fallback });
	});

	app.get("/storefront/trending", async (c) => {
		const limit = parseLimit(c.req.query("limit"), 8, 20);
		const all = await getStorefrontCatalog();
		return c.json({ items: sortByInstalls(all).slice(0, limit) });
	});

	app.get("/storefront/new", async (c) => {
		const limit = parseLimit(c.req.query("limit"), 8, 20);
		const all = await getStorefrontCatalog();
		const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
		const fresh = all.filter((i) => new Date(i.lastUpdated).getTime() >= sevenDaysAgo);
		return c.json({ items: sortByRecency(fresh).slice(0, limit) });
	});

	app.get("/storefront/section/:section", async (c) => {
		const section = c.req.param("section") as StoreSection;
		if (!VALID_SECTIONS.has(section)) return c.json({ error: "invalid section" }, 400);
		const all = await getStorefrontCatalog();
		const grouped = getStorefrontItemsBySection(all);
		return c.json({ items: grouped[section] });
	});

	app.get("/storefront/section/:section/:id", async (c) => {
		const section = c.req.param("section") as StoreSection;
		if (!VALID_SECTIONS.has(section)) return c.json({ error: "invalid section" }, 400);
		const id = c.req.param("id");
		try {
			const item = await getStorefrontItem(section, id);
			if (!item) return c.json({ error: "not found" }, 404);
			return c.json({ item });
		} catch (err) {
			log.warn(`storefront detail failed for ${section}/${id}`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}
