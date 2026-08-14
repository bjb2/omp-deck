/**
 * Typed fetch wrapper for `/api/overview`. Best-effort like storefront-api:
 * a dead server yields an empty-but-valid response so the dashboard still
 * renders its shell instead of blanking out.
 */
const BASE = "/api";

export type OverviewWindow = "24h" | "7d" | "30d";

export interface OverviewStat {
	label: string;
	value: number;
	delta?: number;
	hint?: string;
}

export interface OverviewTask {
	id: string;
	title: string;
	stateId: string;
	updatedAt: string;
}

export interface OverviewFocus {
	activeTasks: OverviewTask[];
	nextAction: string | null;
	streakDays: number;
}

export interface OverviewNewsItem {
	id: string;
	title: string;
	url: string;
	source: string;
	publishedAt: string;
	summary?: string;
	tags?: string[];
}

export interface OverviewRepo {
	id: string;
	name: string;
	url: string;
	description?: string;
	stars?: number;
	language?: string;
	source: string;
}

export interface OverviewEvent {
	id: string;
	kind: string;
	title: string;
	at: string;
	href?: string;
}

export interface OverviewResponse {
	generatedAt: string;
	window: OverviewWindow;
	stats: OverviewStat[];
	focus: OverviewFocus;
	news: OverviewNewsItem[];
	trending: OverviewRepo[];
	events: OverviewEvent[];
	stale?: boolean;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) {
		throw new Error(`overviewApi ${path} failed: ${res.status}`);
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

export const overviewApi = {
	get(window: OverviewWindow = "7d"): Promise<OverviewResponse> {
		const fallback: OverviewResponse = {
			generatedAt: new Date(0).toISOString(),
			window,
			stats: [],
			focus: { activeTasks: [], nextAction: null, streakDays: 0 },
			news: [],
			trending: [],
			events: [],
			stale: true,
		};
		return safe(fallback, () => req<OverviewResponse>(`/overview?window=${window}`));
	},
	news(refresh = false): Promise<{ items: OverviewNewsItem[]; stale?: boolean }> {
		return safe({ items: [], stale: true }, () =>
			req<{ items: OverviewNewsItem[]; stale?: boolean }>(`/overview/news${refresh ? "?refresh=1" : ""}`),
		);
	},
};
