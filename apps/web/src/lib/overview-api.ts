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

export interface ReceiptEntry {
	filename: string;
	sessionId: string;
	goal: string;
	createdAt: string;
}

export interface OverviewResponse {
	generatedAt: string;
	window: OverviewWindow;
	stats: OverviewStat[];
	focus: OverviewFocus;
	news: OverviewNewsItem[];
	trending: OverviewRepo[];
	events: OverviewEvent[];
	receiptsTodayCount?: number;
	sharpHours?: Array<{ hour: number; count: number }>;
	/** Daily spend totals in USD microcents, oldest first. Trailing window may be < 30 days when fresh. */
	costByDay?: Array<{ date: string; costMicrocents: number }>;
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
	/**
	 * Build a GitHub-style contributions grid from the overview event list.
	 * `weeks` controls the visible window (default 26 — half a year). The
	 * returned shape is `{ cells: ActivityCell[], totals, monthLabels }`
	 * where each cell is one day keyed by ISO `YYYY-MM-DD`, with the cell's
	 * `colIndex`/`rowIndex` (0..6) describing its position inside the
	 * column-major grid (Sun..Sat). `monthLabels` is one label per
	 * visible column, used to render the month axis above the grid.
	 *
	 * Empty/zero events produce a valid empty grid plus `totals.activeDays =
	 * 0`, so the UI can render a useful empty-state without branching on
	 * data shape.
	 */
	activityTracker(events: OverviewEvent[], weeks = 26): ActivityTracker {
		return buildActivityTracker(events, weeks);
	},
	news(refresh = false): Promise<{ items: OverviewNewsItem[]; stale?: boolean }> {
		return safe({ items: [], stale: true }, () =>
			req<{ items: OverviewNewsItem[]; stale?: boolean }>(`/overview/news${refresh ? "?refresh=1" : ""}`),
		);
	},
	receipts(date?: string): Promise<{ receipts: ReceiptEntry[] }> {
		const url = date ? `/receipts?date=${encodeURIComponent(date)}` : "/receipts";
		return safe({ receipts: [] }, () => req<{ receipts: ReceiptEntry[] }>(url));
	},
};

export interface ActivityCell {
	date: string;
	count: number;
	level: 0 | 1 | 2 | 3 | 4;
	colIndex: number;
	rowIndex: number;
	weekStart: string;
}

export interface ActivityTracker {
	cells: ActivityCell[];
	totals: { totalEvents: number; activeDays: number; longestStreak: number; currentStreak: number };
	monthLabels: Array<{ colIndex: number; label: string }>;
	weeks: number;
	empty: boolean;
}

/**
 * Pure derivation — kept out of the component so it can be reused and unit
 * tested without React. Bucket events into ISO-day keys, then walk the
 * trailing N weeks (column-major, Sun-first) producing one cell per day.
 * `level` is a 5-bucket quantize (0=none, 4=busy) so a 200-event day
 * saturates to 4 instead of flooding the color scale.
 */
function buildActivityTracker(events: OverviewEvent[], weeks: number): ActivityTracker {
	const safeWeeks = Math.max(1, Math.min(weeks | 0 || 26, 104));
	const counts = new Map<string, number>();
	for (const e of events) {
		const d = new Date(e.at);
		if (Number.isNaN(d.getTime())) continue;
		const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}

	const today = new Date();
	const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
	// Snap end-of-window to Saturday so the right-most column is complete.
	const end = new Date(today);
	end.setHours(0, 0, 0, 0);
	const endDow = end.getDay(); // 0=Sun..6=Sat
	end.setDate(end.getDate() + (6 - endDow));

	const start = new Date(end);
	start.setDate(start.getDate() - safeWeeks * 7 + 1);

	const cells: ActivityCell[] = [];
	const monthLabels: ActivityTracker["monthLabels"] = [];
	let lastMonth = -1;
	let totalEvents = 0;
	let activeDays = 0;
	let longestStreak = 0;
	let currentStreak = 0;
	let prevActiveKey: string | null = null;

	for (let col = 0; col < safeWeeks; col += 1) {
		const colStart = new Date(start);
		colStart.setDate(colStart.getDate() + col * 7);
		for (let row = 0; row < 7; row += 1) {
			const cellDate = new Date(colStart);
			cellDate.setDate(cellDate.getDate() + row);
			const key = `${cellDate.getFullYear()}-${String(cellDate.getMonth() + 1).padStart(2, "0")}-${String(cellDate.getDate()).padStart(2, "0")}`;
			const count = counts.get(key) ?? 0;
			totalEvents += count;
			if (count > 0) activeDays += 1;
			// Future cells (after today) stay at 0 to keep the grid honest.
			const inRange = key <= todayKey;
			const visible = inRange ? count : 0;
			const level =
				visible <= 0 ? 0
					: visible === 1 ? 1
					: visible <= 3 ? 2
					: visible <= 6 ? 3
					: 4;
			if (visible > 0) {
				const prevTime = prevActiveKey ? Date.parse(`${prevActiveKey}T00:00:00Z`) : NaN;
				const curTime = Date.parse(`${key}T00:00:00Z`);
				currentStreak = prevActiveKey && Number.isFinite(prevTime) && curTime - prevTime === 86_400_000
					? currentStreak + 1
					: 1;
				if (currentStreak > longestStreak) longestStreak = currentStreak;
				prevActiveKey = key;
			}
			cells.push({
				date: key,
				count: visible,
				level,
				colIndex: col,
				rowIndex: row,
				weekStart: `${colStart.getFullYear()}-${String(colStart.getMonth() + 1).padStart(2, "0")}-${String(colStart.getDate()).padStart(2, "0")}`,
			});

			// Month axis label: stamp the first day of each new month.
			if (row === 0) {
				const month = cellDate.getMonth();
				if (month !== lastMonth) {
					monthLabels.push({ colIndex: col, label: MONTH_LABELS[cellDate.getMonth()] ?? "" });
					lastMonth = month;
				}
			}
		}
	}

	// Recompute current streak from the right-most end (today backward) so a
	// long streak that started before today isn't cut short.
	currentStreak = 0;
	for (let i = cells.length - 1; i >= 0; i -= 1) {
		const c = cells[i]!;
		if (c.count > 0) {
			currentStreak += 1;
			if (i > 0) {
				const prev = cells[i - 1]!;
				const prevTime = Date.parse(`${prev.date}T00:00:00Z`);
				const curTime = Date.parse(`${c.date}T00:00:00Z`);
				if (curTime - prevTime !== 86_400_000) break;
			}
		} else if (c.date === todayKey || c.date < todayKey) {
			// Today or older with zero → end of streak
			break;
		}
	}

	return {
		cells,
		totals: { totalEvents, activeDays, longestStreak, currentStreak },
		monthLabels,
		weeks: safeWeeks,
		empty: totalEvents === 0,
	};
}

const MONTH_LABELS: Record<number, string> = {
	0: "Jan", 1: "Feb", 2: "Mar", 3: "Apr", 4: "May", 5: "Jun",
	6: "Jul", 7: "Aug", 8: "Sep", 9: "Oct", 10: "Nov", 11: "Dec",
};
