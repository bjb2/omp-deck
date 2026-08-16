import type {
	DiscoveryHit,
	ListMcpToolsResponse,
	McpHealthResponse,
	McpServerEntry,
	StoreItem,
	StoreSection,
	ToggleMcpToolResponse,
} from "@omp-deck/protocol";

/**
 * Typed fetch wrapper for the `/storefront/*`, `/api/discovery/*`, and
 * `/api/mcp/*` endpoints. All calls are best-effort: if the server is
 * down we return the same shape the route would, but with empty arrays —
 * keeps the UI mountable without a network handshake.
 */
const BASE = "/api";

interface StorefrontListResponse {
	items: StoreItem[];
}

interface StorefrontItemResponse {
	item: StoreItem;
}

interface StorefrontInstalledResponse {
	installed: { plugins: string[]; skills: string[]; mcps: string[] };
	errors?: Record<string, string>;
}

interface MarketplaceUpdate {
	id: string;
	installed: string;
	available: string;
}

interface MarketplaceUpdatesResponse {
	updates: MarketplaceUpdate[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) {
		throw new Error(`storefrontApi ${path} failed: ${res.status}`);
	}
	return (await res.json()) as T;
}

async function safe<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
	try {
		const result = await fn();
		lastError = null;
		for (const l of statusListeners) l();
		return result;
	} catch {
		lastError = "Storefront service is unreachable.";
		for (const l of statusListeners) l();
		return fallback;
	}
}

// ─── Reachability side-channel ──────────────────────────────────────────────
// `safe()` swallows every failure so callers always get a mountable shape —
// intentional, most call sites treat "empty" and "offline" the same way.
// Views that want to tell a user "nothing here yet" apart from "can't reach
// the server" subscribe here instead of threading an error through every
// return type.
let lastError: string | null = null;
const statusListeners = new Set<() => void>();

export const storefrontStatus = {
	/** Most recent `safe()` outcome: null when the last call succeeded. */
	getError(): string | null {
		return lastError;
	},
	subscribe(listener: () => void): () => void {
		statusListeners.add(listener);
		return () => statusListeners.delete(listener);
	},
};

export const storefrontApi = {
	featured(limit = 8): Promise<StorefrontListResponse> {
		return safe({ items: [] }, () => req<StorefrontListResponse>(`/storefront/featured?limit=${limit}`));
	},
	trending(limit = 8): Promise<StorefrontListResponse> {
		return safe({ items: [] }, () => req<StorefrontListResponse>(`/storefront/trending?limit=${limit}`));
	},
	new(limit = 8): Promise<StorefrontListResponse> {
		return safe({ items: [] }, () => req<StorefrontListResponse>(`/storefront/new?limit=${limit}`));
	},
	section(section: StoreSection): Promise<StorefrontListResponse> {
		return safe({ items: [] }, () => req<StorefrontListResponse>(`/storefront/section/${section}`));
	},
	item(section: StoreSection, id: string): Promise<StorefrontItemResponse | null> {
		return safe(null, () => req<StorefrontItemResponse>(`/storefront/section/${section}/${encodeURIComponent(id)}`));
	},
	discover(q: string, section: StoreSection | "all" = "all", limit = 20): Promise<{ hits: DiscoveryHit[] }> {
		const params = new URLSearchParams({ q, section, limit: String(limit) });
		return safe({ hits: [] }, () => req<{ hits: DiscoveryHit[] }>(`/discovery/search?${params.toString()}`));
	},
	mcpHealth(): Promise<McpHealthResponse> {
		return safe({ status: [], probedAt: new Date(0).toISOString() }, () => req<McpHealthResponse>("/mcp/health"));
	},
	installMcpServer(
		name: string,
		config: McpServerEntry,
	): Promise<{ ok: boolean; name?: string; error?: string } | null> {
		return safe(null, () =>
			req<{ ok: boolean; name?: string; error?: string }>("/mcp/install", {
				method: "POST",
				body: JSON.stringify({ name, config }),
			}),
		);
	},
	probeMcpServers(): Promise<{ ok: boolean }> {
		return safe({ ok: false }, () => req<{ ok: boolean }>("/mcp/probe-now", { method: "POST" }));
	},
	mcpTools(name: string): Promise<ListMcpToolsResponse | null> {
		return safe(null, () =>
			req<ListMcpToolsResponse>(`/mcp/${encodeURIComponent(name)}/tools`),
		);
	},
	toggleMcpTool(
		name: string,
		tool: string,
		enabled: boolean,
	): Promise<ToggleMcpToolResponse | null> {
		return safe(null, () =>
			req<ToggleMcpToolResponse>(
				`/mcp/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}/toggle`,
				{
					method: "POST",
					body: JSON.stringify({ enabled }),
				},
			),
		);
	},
	installed(): Promise<StorefrontInstalledResponse> {
		return safe(
			{ installed: { plugins: [], skills: [], mcps: [] } },
			() => req<StorefrontInstalledResponse>("/storefront/installed"),
		);
	},
	marketplaceUpgrade(id: string, scope?: "user" | "project"): Promise<{ ok: boolean }> {
		return safe({ ok: false }, () =>
			req<{ ok: boolean }>(`/marketplace/plugins/${encodeURIComponent(id)}/upgrade`, {
				method: "POST",
				body: JSON.stringify(scope ? { scope } : {}),
			}),
		);
	},
	marketplaceUpdates(): Promise<MarketplaceUpdatesResponse> {
		return safe({ updates: [] }, () => req<MarketplaceUpdatesResponse>("/marketplace/updates"));
	},
};