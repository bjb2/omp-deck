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
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";

import { logger } from "./log.ts";

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
