/**
 * Disk-backed cache for the discovery service.
 *
 * Stores per-provider results under `~/.omp-deck/discovery-cache.json` with
 * a per-entry TTL (24h for web, 6h for GitHub, 30s for local catalog
 * debounce). Prunes oldest entries first when the file exceeds 10MB so
 * the deck's storage never grows unbounded.
 *
 * `~/.omp-deck/discovery-usage.json` tracks per-provider call counts for
 * the day so the UI can show "parallel 12/100" without re-reading the
 * provider's own dashboard.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MAX_CACHE_BYTES = 10 * 1024 * 1024;

export type DiscoverySection = "plugins" | "mcps" | "skills" | "prompts" | "kb" | "all";

export interface DiscoveryCacheEntry {
	key: string;
	hits: unknown[];
	cachedAt: string;
	expiresAt: string;
}

interface DiscoveryCacheFile {
	entries: DiscoveryCacheEntry[];
}

export interface ProviderCounterSnapshot {
	parallel: number;
	exa: number;
	tavily: number;
	grep: number;
	date: string;
}

export class DiscoveryCache {
	private readonly cachePath: string;
	private readonly usagePath: string;
	private memory = new Map<string, DiscoveryCacheEntry>();
	private loaded = false;

	constructor(opts?: { homeDir?: string }) {
		const root = path.join(opts?.homeDir ?? os.homedir(), ".omp-deck");
		this.cachePath = path.join(root, "discovery-cache.json");
		this.usagePath = path.join(root, "discovery-usage.json");
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = await fs.readFile(this.cachePath, "utf-8");
			const parsed = JSON.parse(raw) as DiscoveryCacheFile;
			if (Array.isArray(parsed.entries)) {
				const now = Date.now();
				for (const entry of parsed.entries) {
					if (new Date(entry.expiresAt).getTime() < now) continue;
					this.memory.set(entry.key, entry);
				}
			}
		} catch {
			// Missing or corrupt — start fresh.
		}
	}

	async get(key: string): Promise<unknown[] | undefined> {
		await this.load();
		const entry = this.memory.get(key);
		if (!entry) return undefined;
		if (new Date(entry.expiresAt).getTime() < Date.now()) {
			this.memory.delete(key);
			return undefined;
		}
		return entry.hits;
	}

	async set(key: string, hits: unknown[], ttlMs: number): Promise<void> {
		await this.load();
		const now = new Date();
		const entry: DiscoveryCacheEntry = {
			key,
			hits,
			cachedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
		};
		this.memory.set(key, entry);
		await this.scheduleFlush();
	}

	async purge(): Promise<void> {
		this.memory.clear();
		try {
			await fs.rm(this.cachePath, { force: true });
		} catch {}
	}

	async recordProviderCall(provider: "parallel" | "exa" | "tavily" | "grep"): Promise<ProviderCounterSnapshot> {
		let snap: ProviderCounterSnapshot;
		try {
			const raw = await fs.readFile(this.usagePath, "utf-8");
			snap = JSON.parse(raw) as ProviderCounterSnapshot;
		} catch {
			snap = { parallel: 0, exa: 0, tavily: 0, grep: 0, date: todayKey() };
		}
		if (snap.date !== todayKey()) {
			snap = { parallel: 0, exa: 0, tavily: 0, grep: 0, date: todayKey() };
		}
		snap[provider] = (snap[provider] ?? 0) + 1;
		try {
			await fs.mkdir(path.dirname(this.usagePath), { recursive: true });
			await fs.writeFile(this.usagePath, JSON.stringify(snap, null, 2), "utf-8");
		} catch {}
		return snap;
	}

	async readUsage(): Promise<ProviderCounterSnapshot> {
		try {
			const raw = await fs.readFile(this.usagePath, "utf-8");
			const parsed = JSON.parse(raw) as ProviderCounterSnapshot;
			if (parsed.date === todayKey()) return parsed;
		} catch {}
		return { parallel: 0, exa: 0, tavily: 0, grep: 0, date: todayKey() };
	}

	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private scheduleFlush(): Promise<void> {
		if (this.flushTimer) return Promise.resolve();
		return new Promise<void>((resolve) => {
			this.flushTimer = setTimeout(async () => {
				this.flushTimer = null;
				try {
					await this.flushNow();
				} catch {}
				resolve();
			}, 250);
			this.flushTimer.unref?.();
		});
	}

	private async flushNow(): Promise<void> {
		const entries = Array.from(this.memory.values());
		// Size-based prune: drop oldest until under cap. Approximation
		// (stringify each entry to measure) — not done on every call so
		// the hot path stays cheap.
		const file: DiscoveryCacheFile = { entries };
		let serialized = JSON.stringify(file);
		if (serialized.length > MAX_CACHE_BYTES) {
			entries.sort((a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime());
			while (entries.length > 0 && serialized.length > MAX_CACHE_BYTES) {
				entries.shift();
				serialized = JSON.stringify({ entries });
			}
			this.memory = new Map(entries.map((e) => [e.key, e]));
		}
		try {
			await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
			await fs.writeFile(this.cachePath, serialized, "utf-8");
		} catch {}
	}
}

function todayKey(): string {
	return new Date().toISOString().slice(0, 10);
}

let _instance: DiscoveryCache | undefined;
export function getDiscoveryCache(): DiscoveryCache {
	if (!_instance) _instance = new DiscoveryCache();
	return _instance;
}
