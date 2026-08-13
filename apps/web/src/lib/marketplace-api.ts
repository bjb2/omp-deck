import type {
	AddMarketplaceRequest,
	InstallPluginRequest,
	InstallPluginResponse,
	ListMarketplaceResponse,
	MarketplaceSource,
	UninstallPluginRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const marketplaceApi = {
	list(): Promise<ListMarketplaceResponse> {
		return req<ListMarketplaceResponse>("/marketplace");
	},
	install(body: InstallPluginRequest): Promise<InstallPluginResponse> {
		return req<InstallPluginResponse>("/marketplace/install", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	uninstall(body: UninstallPluginRequest): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>("/marketplace/uninstall", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	refresh(): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>("/marketplace/refresh", { method: "POST" });
	},
	addMarketplace(source: string): Promise<{ ok: boolean; marketplace: MarketplaceSource }> {
		const body: AddMarketplaceRequest = { source };
		return req<{ ok: boolean; marketplace: MarketplaceSource }>("/marketplaces", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	removeMarketplace(name: string): Promise<{ ok: boolean }> {
		return req<{ ok: boolean }>(`/marketplaces/${encodeURIComponent(name)}`, { method: "DELETE" });
	},
};


export interface ScoredMarketplaceEntry {
	id: string;
	name: string;
	marketplace: string;
	description?: string;
	category?: string;
	tags?: string[];
	featured?: boolean;
	popularity?: number;
	score?: number;
	installed?: boolean;
	version?: string;
}

export const marketplaceExtrasApi = {
	async search(opts: { query: string; featured?: boolean; limit?: number }): Promise<{ results: ScoredMarketplaceEntry[] }> {
		const params = new URLSearchParams();
		if (opts.query) params.set("q", opts.query);
		if (opts.featured) params.set("featured", "1");
		if (opts.limit) params.set("limit", String(opts.limit));
		const res = await fetch(`/api/marketplace/search?${params.toString()}`);
		if (!res.ok) throw new Error(`marketplace search failed: ${res.status}`);
		return res.json() as Promise<{ results: ScoredMarketplaceEntry[] }>;
	},
	async featured(limit = 12): Promise<{ results: ScoredMarketplaceEntry[] }> {
		const res = await fetch(`/api/marketplace/featured?limit=${limit}`);
		if (!res.ok) throw new Error(`marketplace featured failed: ${res.status}`);
		return res.json() as Promise<{ results: ScoredMarketplaceEntry[] }>;
	},
	async popular(limit = 20): Promise<{ results: ScoredMarketplaceEntry[] }> {
		const res = await fetch(`/api/marketplace/popular?limit=${limit}`);
		if (!res.ok) throw new Error(`marketplace popular failed: ${res.status}`);
		return res.json() as Promise<{ results: ScoredMarketplaceEntry[] }>;
	},
	async refresh(): Promise<void> {
		await fetch("/api/marketplace/refresh", { method: "POST" });
	},
};
