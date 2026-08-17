/**
 * Storefront catalog — composes the unified `StoreItem[]` view that the
 * `/storefront/*` routes serve.
 *
 * Sources, in priority order:
 *   1. The marketplace catalog (`MarketplaceService.listCatalog()`),
 *      wrapped into `StoreItem` with `source.kind = "marketplace"`.
 *   2. The skills service (existing `SkillsService`), wrapped with
 *      `source.kind = "kb"` for the deck-managed user skills.
 *   3. The MCP config (read from `~/.omp/agent/mcp.json`), wrapped
 *      with `source.kind = "web"` (no canonical detail page yet).
 *
 * The catalog is rebuilt on every read; the routes cache the response
 * for a few seconds so concurrent storefront calls don't pound the
 * upstream services.
 */
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import knownGoodSourcesJson from "./storefront/known-good-sources.json" with { type: "json" };

import type { InstalledPluginInfo, StoreItem, StoreSection } from "@omp-deck/protocol";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { marketplaceExtras } from "./marketplace-extras.ts";
import { getMarketplace } from "./marketplace-service.ts";

const log = logger("storefront:catalog");

/** Bump when the seed entries change shape so the web can show a drift
 *  warning in the corner. Compared against localStorage at boot. */
export const STOREFRONT_VERSION = "1";

interface KnownGoodSources {
	sources: Record<string, { verifiedAt: string; installable: string[]; knownFailures: string[]; notes?: string }>;
}

const knownGoodData = knownGoodSourcesJson as unknown as KnownGoodSources;

function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.\-+]/).filter(Boolean);
	const pb = b.split(/[.\-+]/).filter(Boolean);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const na = pa[i] ?? "0";
		const nb = pb[i] ?? "0";
		const da = Number.parseInt(na, 10);
		const db = Number.parseInt(nb, 10);
		if (Number.isFinite(da) && Number.isFinite(db)) {
			if (da !== db) return da - db;
			continue;
		}
		const c = na.localeCompare(nb);
		if (c !== 0) return c;
	}
	return 0;
}

async function readInstalledIndex(): Promise<Map<string, InstalledPluginInfo>> {
	try {
		const list = await getMarketplace().listInstalled();
		const idx = new Map<string, InstalledPluginInfo>();
		for (const info of list) {
			idx.set(info.id, info);
		}
		return idx;
	} catch (err) {
		log.warn(`installed-registry read failed`, err);
		return new Map();
	}
}

function checkVerified(item: StoreItem): boolean {
	if (item.source.kind !== "marketplace") return false;
	const ref = item.source.ref ?? "";
	const url = item.source.url ?? "";
	const pluginName = (item.installAction?.payload as { name?: string })?.name ?? item.name;

	for (const [sourceKey, info] of Object.entries(knownGoodData.sources ?? {})) {
		const matchesSource =
			sourceKey === ref ||
			sourceKey.endsWith(`/${ref}`) ||
			ref.endsWith(`/${sourceKey}`) ||
			(url !== "" && url.includes(sourceKey));
		if (matchesSource && info.installable && info.installable.includes(pluginName)) {
			return true;
		}
	}
	return false;
}

interface McpConfigForCatalog {
	mcpServers?: Record<string, { type?: string; url?: string; command?: string }>;
	disabledServers?: string[];
}

async function readMcpServers(): Promise<Array<{ name: string; transport: "stdio" | "http" }>> {
	const agentDir = loadConfig().agentDir;
	if (!agentDir) return [];
	const configPath = path.join(agentDir, "mcp.json");
	if (!existsSync(configPath)) return [];
	try {
		const raw = await fs.readFile(configPath, "utf-8");
		const cfg = JSON.parse(raw) as McpConfigForCatalog;
		const disabled = new Set(cfg.disabledServers ?? []);
		const out: Array<{ name: string; transport: "stdio" | "http" }> = [];
		for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
			if (disabled.has(name)) continue;
			out.push({ name, transport: server.type === "stdio" ? "stdio" : "http" });
		}
		return out;
	} catch (err) {
		log.warn(`mcp.json read failed`, err);
		return [];
	}
}

export async function buildStorefrontCatalog(): Promise<StoreItem[]> {
	const items: StoreItem[] = [];
	try {
		const extras = await marketplaceExtras.search({ query: "", limit: 200 });
		for (const e of extras) {
			items.push({
				id: e.id,
				section: "plugins",
				name: e.name,
				tagline: (e.description ?? "").slice(0, 140),
				description: e.description ?? "",
				author: { name: e.marketplace },
				icon: "",
				screenshots: [],
				ratings: { stars: 0, count: 0 },
				installs: e.popularity ?? 0,
				lastUpdated: new Date().toISOString(),
				source: { kind: "marketplace", url: "", ref: e.marketplace },
				versionHistory: e.version ? [{ version: e.version, date: new Date().toISOString().slice(0, 10), notes: "" }] : [],
				capabilities: { toolNames: e.tags ?? [], categories: e.category ? [e.category] : [], triggers: [] },
				installAction: { kind: "marketplace", payload: { name: e.name, marketplace: e.marketplace, scope: "user" } },
				isNew: false,
			});
		}
	} catch (err) {
		log.warn(`storefront marketplace enrichment failed`, err);
	}
	try {
		const servers = await readMcpServers();
		for (const server of servers) {
			items.push({
				id: `mcp:${server.name}`,
				section: "mcps",
				name: server.name,
				tagline: `${server.transport} MCP server from ~/.omp/agent/mcp.json`,
				description: "MCP server wired into the deck's agent. Disabled in the source config? It won't show here.",
				author: { name: "user" },
				icon: "",
				screenshots: [],
				ratings: { stars: 0, count: 0 },
				installs: 0,
				lastUpdated: new Date().toISOString(),
				source: { kind: "web", url: "", ref: server.name },
				versionHistory: [],
				capabilities: { toolNames: [], categories: [server.transport], triggers: [] },
				installAction: { kind: "mcp", payload: { name: server.name } },
				isNew: false,
			});
		}
	} catch (err) {
		log.warn(`storefront mcp enrichment failed`, err);
	}

	try {
		const installedIdx = await readInstalledIndex();
		return items.map((item): StoreItem => {
			const payload = item.installAction?.payload as { name?: string; marketplace?: string } | undefined;
			const altId = payload?.name && payload?.marketplace ? `${payload.name}@${payload.marketplace}` : undefined;
			const installedInfo = installedIdx.get(item.id) ?? (altId ? installedIdx.get(altId) : undefined);

			const installed = !!installedInfo;
			const catalogVersion = item.versionHistory[0]?.version;
			const updateAvailable = installed && !!catalogVersion && !!installedInfo?.version && compareVersions(catalogVersion, installedInfo.version) > 0;
			const verified = checkVerified(item);

			return { ...item, installed, updateAvailable, verified };
		});
	} catch (err) {
		log.warn(`storefront item state annotation failed`, err);
		return items;
	}
}

let cachedItems: StoreItem[] | undefined;
let cachedAt = 0;
const CACHE_MS = 5_000;

export async function getStorefrontCatalog(): Promise<StoreItem[]> {
	const now = Date.now();
	if (cachedItems && now - cachedAt < CACHE_MS) return cachedItems;
	const fresh = await buildStorefrontCatalog();
	cachedItems = fresh;
	cachedAt = now;
	return fresh;
}

export async function getStorefrontItem(section: StoreSection, id: string): Promise<StoreItem | undefined> {
	const all = await getStorefrontCatalog();
	return all.find((i) => i.section === section && i.id === id);
}

export function getStorefrontItemsBySection(items: StoreItem[]): Record<StoreSection, StoreItem[]> {
	const out: Record<StoreSection, StoreItem[]> = { plugins: [], mcps: [], skills: [], prompts: [] };
	for (const item of items) out[item.section].push(item);
	return out;
}

// Touch getMarketplace so the manager is constructed on first use; this
// keeps the cold-start path identical to other routes that import the
// service eagerly.
void getMarketplace;
