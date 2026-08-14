import type { DiscoveryHit, McpHealthResponse, StoreItem, StoreSection } from "@omp-deck/protocol";

/**
 * Typed fetch wrapper for the `/storefront/*`, `/api/discovery/*`, and
 * `/api/mcp/health` endpoints. All calls are best-effort: if the server is
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
		return await fn();
	} catch {
		return fallback;
	}
}

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
	installed(): Promise<StorefrontInstalledResponse> {
		return safe(
			{ installed: { plugins: [], skills: [], mcps: [] } },
			() => req<StorefrontInstalledResponse>("/storefront/installed"),
		);
	},
};
