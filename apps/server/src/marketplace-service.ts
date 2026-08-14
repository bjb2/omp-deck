import type {
	InstalledPluginInfo,
	ListMarketplaceResponse,
	MarketplaceCatalogEntry,
	MarketplaceSource,
} from "@omp-deck/protocol";
import {
	MarketplaceManager,
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	parsePluginId,
	resolvePluginSource,
	parseMarketplaceCatalog,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { readMarketplacesRegistry, getMarketplaceEntry } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/registry";

import { logger } from "./log.ts";
import { marketplaceExtras } from "./marketplace-extras.ts";
import type { DryRunInstallResponse } from "@omp-deck/protocol";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const log = logger("marketplace");

/**
 * Lazy singleton wrapper around the SDK's `MarketplaceManager`. Built on first
 * request so the deck boot stays fast (no disk reads, no network discovery).
 * Routes share this instance so cached catalog reads are reused.
 */
export class MarketplaceService {
	private manager: MarketplaceManager | undefined;

	private getManager(): MarketplaceManager {
		if (this.manager) return this.manager;
		this.manager = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
		});
		return this.manager;
	}

	/**
	 * Cheap variant of {@link listCatalog} that returns only the installed-plugin
	 * inventory. Skips `listAvailablePlugins` for each marketplace source (which
	 * can hit the cache layer / refresh), so this is safe to call frequently
	 * from SkillsService and watcher fan-outs.
	 */
	async listInstalled(): Promise<InstalledPluginInfo[]> {
		const mgr = this.getManager();
		const summaries = await mgr.listInstalledPlugins();
		const installed: InstalledPluginInfo[] = [];
		for (const summary of summaries) {
			const parsed = parsePluginId(summary.id);
			if (!parsed) continue;
			for (const entry of summary.entries) {
				installed.push({
					id: summary.id,
					name: parsed.name,
					marketplace: parsed.marketplace,
					scope: entry.scope,
					version: entry.version,
					installedAt: entry.installedAt,
					installPath: entry.installPath,
					...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
					...(summary.shadowedBy ? { shadowedBy: summary.shadowedBy } : {}),
				});
			}
		}
		return installed;
	}

	async listCatalog(): Promise<ListMarketplaceResponse> {
		const mgr = this.getManager();
		const [sources, installedSummaries] = await Promise.all([
			mgr.listMarketplaces(),
			mgr.listInstalledPlugins(),
		]);

		const installed: InstalledPluginInfo[] = [];
		for (const summary of installedSummaries) {
			const parsed = parsePluginId(summary.id);
			if (!parsed) continue;
			for (const entry of summary.entries) {
				installed.push({
					id: summary.id,
					name: parsed.name,
					marketplace: parsed.marketplace,
					scope: entry.scope,
					version: entry.version,
					installedAt: entry.installedAt,
					installPath: entry.installPath,
					...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
					...(summary.shadowedBy ? { shadowedBy: summary.shadowedBy } : {}),
				});
			}
		}

		// Index installed plugins by `name@marketplace` so catalog entries can
		// surface a `installed` marker without a second pass through the array.
		const installedIndex = new Map<string, InstalledPluginInfo>();
		for (const i of installed) {
			// Prefer project-scoped entry when both exist for the same plugin id.
			const prev = installedIndex.get(i.id);
			if (!prev || (prev.scope === "user" && i.scope === "project")) {
				installedIndex.set(i.id, i);
			}
		}

		const catalog: MarketplaceCatalogEntry[] = [];
		for (const source of sources) {
			let plugins;
			try {
				plugins = await mgr.listAvailablePlugins(source.name);
			} catch (err) {
				log.warn(`listAvailablePlugins(${source.name}) failed`, err);
				continue;
			}
			for (const plugin of plugins) {
				const id = `${plugin.name}@${source.name}`;
				const installedEntry = installedIndex.get(id);
				const entry: MarketplaceCatalogEntry = {
					id,
					name: plugin.name,
					marketplace: source.name,
					capabilities: {
						commands: plugin.commands !== undefined,
						agents: plugin.agents !== undefined,
						hooks: plugin.hooks !== undefined,
						mcpServers: plugin.mcpServers !== undefined,
						lspServers: plugin.lspServers !== undefined,
					},
				};
				if (plugin.description) entry.description = plugin.description;
				if (plugin.version) entry.version = plugin.version;
				if (plugin.author?.name) entry.author = plugin.author.name;
				if (plugin.homepage) entry.homepage = plugin.homepage;
				if (plugin.keywords && plugin.keywords.length > 0) entry.keywords = [...plugin.keywords];
				if (plugin.category) entry.category = plugin.category;
				if (plugin.tags && plugin.tags.length > 0) entry.tags = [...plugin.tags];
				if (installedEntry) {
					entry.installed = {
						scope: installedEntry.scope,
						version: installedEntry.version,
						installedAt: installedEntry.installedAt,
						...(installedEntry.enabled !== undefined ? { enabled: installedEntry.enabled } : {}),
					};
				}
				catalog.push(entry);
			}
		}

		const sourceList: MarketplaceSource[] = sources.map((s) => ({
			name: s.name,
			sourceType: s.sourceType,
			sourceUri: s.sourceUri,
			updatedAt: s.updatedAt,
		}));

		return { sources: sourceList, catalog, installed };
	}

	async install(opts: { name: string; marketplace: string; scope?: "user" | "project"; force?: boolean }): Promise<InstalledPluginInfo> {
		// Per-call re-check; the boot-time SSL fix can drift if a child
		// process clears GIT_SSL_CAINFO (rare but observed on Windows when
		// the bundled git path differs between boot and the first install).
		marketplaceExtras.ensureSslFix();
		const mgr = this.getManager();
		const entry = await mgr.installPlugin(opts.name, opts.marketplace, {
			...(opts.force ? { force: true } : {}),
			...(opts.scope ? { scope: opts.scope } : {}),
		});
		return {
			id: `${opts.name}@${opts.marketplace}`,
			name: opts.name,
			marketplace: opts.marketplace,
			scope: entry.scope,
			version: entry.version,
			installedAt: entry.installedAt,
			installPath: entry.installPath,
			...(entry.enabled !== undefined ? { enabled: entry.enabled } : {}),
		};
	}

	/**
	 * Validates a marketplace plugin install without mutating any caches or
	 * registries. Resolves the source to a temp dir, reads the plugin
	 * manifest, and reports what would have been installed. Cleanup
	 * happens in `finally` so a failure during manifest read still frees
	 * the temp clone.
	 */
	async dryRun(opts: { name: string; marketplace: string; scope?: "user" | "project" }): Promise<DryRunInstallResponse> {
		marketplaceExtras.ensureSslFix();
		const mgr = this.getManager();
		const reg = await readMarketplacesRegistry(getMarketplacesRegistryPath());
		const mktEntry = getMarketplaceEntry(reg, opts.marketplace);
		if (!mktEntry) {
			throw new Error(`Marketplace "${opts.marketplace}" not found`);
		}
		const catalogRaw = await fs.readFile(mktEntry.catalogPath, "utf-8");
		const catalog = parseMarketplaceCatalog(catalogRaw, mktEntry.catalogPath);
		const pluginEntry = catalog.plugins.find((p) => p.name === opts.name);
		if (!pluginEntry) {
			throw new Error(`Plugin "${opts.name}" not found in marketplace "${opts.marketplace}"`);
		}
		const marketplaceClonePath = this.resolveMarketplaceRoot(mktEntry);
		const { dir: sourcePath, tempCloneRoot } = await resolvePluginSource(pluginEntry, {
			marketplaceClonePath,
			catalogMetadata: catalog.metadata,
			tmpDir: path.join(getMarketplacesCacheDir(), ".dryrun"),
		});
		try {
			const manifest = await readPluginManifest(sourcePath);
			const version = pluginEntry.version ?? manifest.version ?? "0.0.0";
			const cloneUrl = deriveCloneUrl(pluginEntry.source);
			const scope = opts.scope ?? "user";
			return {
				ok: true,
				manifest: {
					name: pluginEntry.name,
					version,
					entrypoints: manifest.entrypoints,
				},
				cloneUrl,
				...(pluginEntry.source && typeof pluginEntry.source === "object" && "ref" in pluginEntry.source && pluginEntry.source.ref
					? { ref: pluginEntry.source.ref as string }
					: {}),
				...(pluginEntry.source && typeof pluginEntry.source === "object" && "sha" in pluginEntry.source && pluginEntry.source.sha
					? { sha: (pluginEntry.source.sha as string).slice(0, 7) }
					: {}),
				wouldCacheTo: path.join(getPluginsCacheDir(), opts.marketplace, `${opts.name}-${version}`),
			};
		} finally {
			if (tempCloneRoot) {
				await fs.rm(tempCloneRoot, { recursive: true, force: true }).catch(() => {});
			}
		}
	}

	/**
	 * Mirror of the SDK manager's `#resolveMarketplaceRoot` (private).
	 * For `local`-type entries, expands `~` and resolves to an absolute
	 * path; for git-sourced marketplaces, returns the parent directory of
	 * the cached `marketplace.json` so relative string sources resolve
	 * correctly against the clone.
	 */
	private resolveMarketplaceRoot(entry: { sourceType: string; sourceUri: string; catalogPath: string }): string {
		if (entry.sourceType === "local") {
			const expanded = entry.sourceUri.startsWith("~/")
				? path.join(process.env.HOME ?? process.env.USERPROFILE ?? "", entry.sourceUri.slice(2))
				: entry.sourceUri;
			return path.resolve(expanded);
		}
		return path.dirname(entry.catalogPath);
	}

	async uninstall(opts: { id: string; scope?: "user" | "project" }): Promise<void> {
		const mgr = this.getManager();
		await mgr.uninstallPlugin(opts.id, opts.scope);
	}

	async addMarketplace(source: string): Promise<MarketplaceSource> {
		const mgr = this.getManager();
		const entry = await mgr.addMarketplace(source);
		return {
			name: entry.name,
			sourceType: entry.sourceType,
			sourceUri: entry.sourceUri,
			updatedAt: entry.updatedAt,
		};
	}

	async removeMarketplace(name: string): Promise<void> {
		const mgr = this.getManager();
		await mgr.removeMarketplace(name);
	}

	async refresh(): Promise<void> {
		const mgr = this.getManager();
		await mgr.updateAllMarketplaces();
	}

	async setEnabled(id: string, enabled: boolean, scope?: "user" | "project"): Promise<void> {
		const mgr = this.getManager();
		await mgr.setPluginEnabled(id, enabled, scope);
	}
}

let _instance: MarketplaceService | undefined;
export function getMarketplace(): MarketplaceService {
	if (!_instance) _instance = new MarketplaceService();
	return _instance;
}

interface PluginManifest {
	version?: string;
	entrypoints: {
		commands?: string[];
		agents?: string[];
		hooks?: string[];
		mcpServers?: string[];
		lspServers?: string[];
	};
}

/**
 * Read the plugin manifest from a resolved source path. Tries the same
 * three locations the SDK's `#resolvePluginVersion` checks, in order.
 * Returns an empty manifest (no entrypoints) when none of the candidates
 * parse — the dry-run caller still gets version + cloneUrl so the
 * install readiness is visible.
 */
async function readPluginManifest(sourcePath: string): Promise<PluginManifest> {
	const candidates = [
		path.join(sourcePath, ".claude-plugin", "plugin.json"),
		path.join(sourcePath, "plugin.json"),
		path.join(sourcePath, "package.json"),
	];
	let version: string | undefined;
	for (const candidate of candidates) {
		try {
			const content = (await fs.readFile(candidate, "utf-8")) as unknown as {
				version?: unknown;
			} | null;
			if (content && typeof content === "object" && typeof content.version === "string") {
				version = content.version;
				break;
			}
		} catch {
			// try next
		}
	}
	const entrypoints: PluginManifest["entrypoints"] = {};
	// Surface file presence as entrypoint hints — the dry-run consumer can
	// decide whether to show a "what you'd get" pill. We don't parse the
	// commands/agents json; that's the SDK's job at install time.
	const probes: Array<keyof PluginManifest["entrypoints"]> = [
		"commands",
		"agents",
		"hooks",
		"mcpServers",
		"lspServers",
	];
	await Promise.all(
		probes.map(async (kind) => {
			const dir = path.join(sourcePath, kind);
			try {
				const dirents = await fs.readdir(dir);
				if (dirents.length > 0) {
					entrypoints[kind] = dirents.filter((n) => !n.startsWith("."));
				}
			} catch {
				// dir missing is normal — no entrypoint of this kind.
			}
		}),
	);
	const result: PluginManifest = { entrypoints };
	if (version) result.version = version;
	return result;
}

function deriveCloneUrl(source: unknown): string {
	if (typeof source === "string") return source;
	if (!source || typeof source !== "object") return "<unknown>";
	const s = source as { source?: string; repo?: string; url?: string };
	if (s.source === "github" && s.repo) return `https://github.com/${s.repo}.git`;
	if (s.source === "url" && s.url) return s.url;
	if (s.source === "git-subdir" && s.url) return s.url;
	if (s.source === "npm" && s.url) return s.url;
	return "<unknown>";
}
