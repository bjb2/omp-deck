/**
 * Overview dashboard surface — §dashboard. Mounted under `/overview` by
 * `buildRoutesOverview()`. Aggregates real local data (tasks, routine runs,
 * inbox, prompts library, skills, deploy state) and merges external news +
 * trending repos served by `NewsService` with a 30-minute disk cache.
 *
 * Hard rule: every aggregate field on the wire maps to a real store. Stats
 * come from SQLite, focus from tasks, events from tasks + routine runs +
 * deploy state, news from cache-backed external feeds.
 */
import * as path from "node:path";

import { promises as fs } from "node:fs";

import { Hono } from "hono";

import type { Task, TaskState } from "@omp-deck/protocol";
import type { Context } from "hono";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { listTasks, listStates } from "./db/tasks.ts";
import { listRoutines, listRuns } from "./db/routines.ts";
import { listInbox } from "./db/inbox.ts";
import { promptsLibrary } from "./prompts-library.ts";
import { NewsService } from "./news-service.ts";
import { getLatestDeployState } from "./deploy-state.ts";
import { getDb } from "./db/index.ts";

const log = logger("routes:overview");

const WINDOW_DAYS: Readonly<Record<Window, number>> = { "24h": 1, "7d": 7, "30d": 30 };
const ACTIVE_TASK_LIMIT = 5;
const EVENT_LIMIT = 20;
const STREAK_LOOKBACK_DAYS = 90;
const SHARP_HOURS_WINDOW_DAYS = 30;
const SHARP_HOURS_MIN_COUNT = 3;
const RECEIPTS_DIR = "sessions";

const DONE_STATE_ALIAS: ReadonlySet<string> = new Set([
	"s_done",
	"done",
	"completed",
	"complete",
	"closed",
	"resolved",
]);

type Window = "24h" | "7d" | "30d";

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
	window: Window;
	stats: OverviewStat[];
	focus: OverviewFocus;
	news: OverviewNewsItem[];
	trending: OverviewRepo[];
	events: OverviewEvent[];
	receiptsTodayCount: number;
	sharpHours: OverviewSharpHour[];
	costByDay: CostByDayPoint[];
	stale?: boolean;
}

/** Slice of the overview payload the GenUI LLM prompt consumes. Cheaper
 *  than the full `OverviewResponse` (no receipts count) and explicitly
 *  typed so the prompt template can render it without a structural cast. */
export interface OverviewPromptInput {
	generatedAt: string;
	window: Window;
	news: OverviewNewsItem[];
	trending: OverviewRepo[];
	events: OverviewEvent[];
	focus: OverviewFocus;
	stats: OverviewStat[];
	costByDay: CostByDayPoint[];
	sharpHours: OverviewSharpHour[];
	stale?: boolean;
}

/** Minimal overview shape the GenUI LLM prompt needs. Wraps
 *  `buildOverview()` and trims the receipts-today field — the prompt
 *  never needs it. Called from `genui-llm.ts`. */
export async function loadOverviewForPrompt(opts: {
	config: Config;
	refresh?: boolean;
}): Promise<OverviewPromptInput> {
	const dataDir = path.dirname(opts.config.dbPath);
	const news = new NewsService(dataDir);
	const window: Window = "7d";
	const inputs = {
		window,
		refresh: opts.refresh === true,
		news,
		config: opts.config,
		allTasks: listTasks(),
		allStates: listStates(),
	};
	const full = await buildOverview({ inputs });
	const out: OverviewPromptInput = {
		generatedAt: full.generatedAt,
		window: full.window,
		news: full.news,
		trending: full.trending,
		events: full.events,
		focus: full.focus,
		stats: full.stats,
		costByDay: full.costByDay,
		sharpHours: full.sharpHours,
	};
	if (full.stale) out.stale = true;
	return out;
}

export interface OverviewSharpHour {
	hour: number;
	count: number;
}

export interface ReceiptEntry {
	filename: string;
	sessionId: string;
	goal: string;
	createdAt: string;
}

export interface ReceiptsResponse {
	receipts: ReceiptEntry[];
}

export interface SkillsListProvider {
	listSkills: (cwd?: string) => Promise<{ skills: Array<{ id: string }> }>;
}

export interface BuildOpts {
	config: Config;
	skills?: SkillsListProvider;
}

interface OverviewInputs {
	window: Window;
	refresh: boolean;
	news: NewsService;
	config: Config;
	skills?: SkillsListProvider;
	allTasks: Task[];
	allStates: TaskState[];
}

export function buildRoutesOverview(opts: BuildOpts): Hono {
	const app = new Hono();
	// Cache lives next to the DB so a single OMP_DECK_DB_PATH override also
	// relocates the news/trending caches without separate env wiring.
	const dataDir = path.dirname(opts.config.dbPath);
	const news = new NewsService(dataDir);
	const windowFromQuery = (raw: string | undefined): Window =>
		raw === "24h" || raw === "30d" ? raw : "7d";

	const handleReceipts = async (c: Context) => {
		try {
			const date = c.req.query("date") ?? todayLocalDate();
			const body = await listReceipts({ dataDir, date });
			return c.json(body);
		} catch (err) {
			log.error("receipts list failed", err);
			return c.json({ error: String(err) }, 500);
		}
	};

	app.get("/receipts", handleReceipts);
	app.get("/api/receipts", handleReceipts);

	app.get("/overview", async (c) => {
		const window = windowFromQuery(c.req.query("window"));
		const refresh = c.req.query("refresh") === "1";
		try {
			const payload = await buildOverview({
				inputs: {
					window,
					refresh,
					news,
					config: opts.config,
					skills: opts.skills,
					allTasks: listTasks(),
					allStates: listStates(),
				},
			});
			return c.json(payload);
		} catch (err) {
			log.error("overview build failed", err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/overview/news", async (c) => {
		const refresh = c.req.query("refresh") === "1";
		try {
			const result = await news.getNews({ refresh });
			return c.json({ items: result.items, stale: result.stale });
		} catch (err) {
			log.error("news refresh failed", err);
			return c.json({ items: [], stale: true }, 500);
		}
	});

	return app;
}

async function buildOverview({ inputs }: { inputs: OverviewInputs }): Promise<OverviewResponse> {
	const days = WINDOW_DAYS[inputs.window];
	const now = new Date();
	const sinceMs = now.getTime() - days * 24 * 60 * 60_000;

	const doneStateIds = new Set(
		inputs.allStates
			.filter((s) => DONE_STATE_ALIAS.has(s.name.toLowerCase()))
			.map((s) => s.id),
	);
	const activeTasks = inputs.allTasks
		.filter((t) => !doneStateIds.has(t.stateId) && !t.archivedAt)
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	const recentActive = activeTasks.slice(0, ACTIVE_TASK_LIMIT);
	const top = recentActive[0];
	const focus: OverviewFocus = {
		activeTasks: recentActive.map((t) => ({
			id: t.id,
			title: t.title,
			stateId: t.stateId,
			updatedAt: t.updatedAt,
		})),
		nextAction: top ? top.title : null,
		streakDays: computeStreakDays(inputs.allTasks),
	};

	const stats = await buildStats({ days, sinceMs, tasks: inputs.allTasks, skills: inputs.skills });
	const events = buildEvents({ limit: EVENT_LIMIT });
	const [newsResult, trendingResult] = await Promise.all([
		inputs.news.getNews({ refresh: inputs.refresh }),
		inputs.news.getTrending({ refresh: inputs.refresh }),
	]);
	const [receiptsToday] = await Promise.all([
		listReceipts({ dataDir: path.dirname(inputs.config.dbPath), date: todayLocalDate() }),
	]);
	const sharpHours = computeSharpHours({ doneStateIds, tasks: inputs.allTasks });
	const costByDay = buildCostByDay();

	const stale = newsResult.stale || trendingResult.stale;
	const out: OverviewResponse = {
		generatedAt: now.toISOString(),
		window: inputs.window,
		stats,
		focus,
		news: newsResult.items,
		trending: trendingResult.items,
		events,
		receiptsTodayCount: receiptsToday.receipts.length,
		sharpHours,
		costByDay,
	};
	if (stale) out.stale = true;
	return out;
}

async function buildStats(input: {
	days: number;
	sinceMs: number;
	tasks: Task[];
	skills?: SkillsListProvider;
}): Promise<OverviewStat[]> {
	const openTasks = input.tasks.filter((t) => !t.archivedAt).length;
	const recentlyActiveTasks = input.tasks.filter((t) => Date.parse(t.updatedAt) >= input.sinceMs).length;
	const routines = listRoutines();
	const enabledRoutines = routines.filter((r) => r.enabled).length;
	const recentRuns = routines
		.flatMap((r) => listRuns(r.id, 20))
		.filter((run) => Date.parse(run.startedAt) >= input.sinceMs);
	const failedRuns = recentRuns.filter((r) => Number(r.exitCode ?? 0) !== 0).length;
	const inbox = listInbox({ includeProcessed: false });
	let prompts = 0;
	try {
		prompts = (await promptsLibrary.list()).length;
	} catch (err) {
		log.warn("prompts list failed for stats", err);
	}
	let skills = 0;
	if (input.skills) {
		try {
			skills = (await input.skills.listSkills()).skills.length;
		} catch (err) {
			log.warn("skills list failed for stats", err);
		}
	}

	const stats: OverviewStat[] = [
		{ label: "Open tasks", value: openTasks, hint: `${recentlyActiveTasks} updated in last ${input.days}d` },
		{ label: "Enabled routines", value: enabledRoutines, hint: `${recentRuns.length} runs in window` },
		...(failedRuns > 0 ? [{ label: "Failed runs", value: failedRuns, hint: "non-zero exit" }] : []),
		{ label: "Inbox", value: inbox.length, hint: "unprocessed" },
		{ label: "Prompts", value: prompts },
	];
	if (input.skills) stats.push({ label: "Skills", value: skills });
	return stats;
}

interface RoutineRunRow {
	id: string;
	routine_id: string;
	started_at: string;
	ended_at: string | null;
	exit_code: number | null;
	error: string | null;
}

interface RecentTaskRow {
	id: string;
	title: string;
	updated_at: string;
	state_id: string;
}

function buildEvents(input: { limit: number }): OverviewEvent[] {
	const events: OverviewEvent[] = [];

	const routineRows = getDb()
		.query<RoutineRunRow, [number]>(
			`SELECT id, routine_id, started_at, ended_at, exit_code, error
			 FROM routine_runs
			 ORDER BY started_at DESC
			 LIMIT ?`,
		)
		.all(input.limit * 2) as RoutineRunRow[];
	const routinesById = new Map(listRoutines().map((r) => [r.id, r]));
	for (const run of routineRows) {
		const at = run.ended_at ?? run.started_at;
		const ok = run.exit_code === 0;
		const name = routinesById.get(run.routine_id)?.name ?? run.routine_id;
		events.push({
			id: `run_${run.id}`,
			kind: ok ? "routine.ok" : "routine.failed",
			title: `${name} ${ok ? "finished" : run.error ? `failed: ${run.error}` : "exited non-zero"}`,
			at,
			href: `/routines/${run.routine_id}/runs/${run.id}`,
		});
	}

	const recentTasks = getDb()
		.query<RecentTaskRow, [number]>(
			`SELECT id, title, updated_at, state_id FROM tasks
			 WHERE archived_at IS NULL
			 ORDER BY updated_at DESC
			 LIMIT ?`,
		)
		.all(input.limit) as RecentTaskRow[];
	const statesById = new Map(listStates().map((s) => [s.id, s]));
	for (const t of recentTasks) {
		events.push({
			id: `task_${t.id}_${t.updated_at}`,
			kind: "task.updated",
			title: `${t.title} → ${statesById.get(t.state_id)?.name ?? t.state_id}`,
			at: t.updated_at,
			href: `/tasks/${t.id}`,
		});
	}

	const deploy = getLatestDeployState();
	if (deploy.updatedAt && deploy.updatedAt !== new Date(0).toISOString()) {
		events.push({
			id: `deploy_${deploy.updatedAt}`,
			kind: `deploy.${deploy.phase}`,
			title: `Deploy ${deploy.phase}${deploy.error ? `: ${deploy.error}` : ""}`,
			at: deploy.updatedAt,
		});
	}

	events.sort((a, b) => b.at.localeCompare(a.at));
	return events.slice(0, input.limit);
}

function computeStreakDays(tasks: Task[]): number {
	// A streak day is a day with at least one task update OR routine run.
	// Walk back from today; stop at the first day with no activity.
	const days = new Set<string>();
	for (const t of tasks) {
		const d = Date.parse(t.updatedAt);
		if (Number.isFinite(d)) days.add(dayKey(d));
	}
	const routines = listRoutines();
	for (const r of routines) {
		for (const run of listRuns(r.id, 50)) {
			const d = Date.parse(run.startedAt);
			if (Number.isFinite(d)) days.add(dayKey(d));
		}
	}
	if (days.size === 0) return 0;
	const today = new Date();
	let streak = 0;
	for (let i = 0; i < STREAK_LOOKBACK_DAYS; i++) {
		const d = new Date(today.getTime() - i * 24 * 60 * 60_000);
		if (!days.has(dayKey(d.getTime()))) break;
		streak++;
	}
	return streak;
}

function dayKey(ms: number): string {
	const d = new Date(ms);
	const y = d.getUTCFullYear();
	const m = `${d.getUTCMonth() + 1}`.padStart(2, "0");
	const day = `${d.getUTCDate()}`.padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function todayLocalDate(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = `${d.getMonth() + 1}`.padStart(2, "0");
	const day = `${d.getDate()}`.padStart(2, "0");
	return `${y}-${m}-${day}`;
}

interface SharpHourRow {
	hour: string | null;
	count: number;
}

export interface CostByDayPoint {
	date: string;
	costMicrocents: number;
}

interface CostByDayRow {
	date: string;
	costMicrocents: number;
}

const COST_BY_DAY_LOOKBACK_DAYS = 30;

function buildCostByDay(): CostByDayPoint[] {
	const sinceUtc = new Date(Date.now() - COST_BY_DAY_LOOKBACK_DAYS * 24 * 60 * 60_000);
	const sinceIso = sinceUtc.toISOString();
	const rows = getDb()
		.query<CostByDayRow, [string, string]>(
			`SELECT date, SUM(cost_microcents) AS costMicrocents FROM (
			        SELECT strftime('%Y-%m-%d', created_at) AS date,
			               COALESCE(json_extract(usage_json, '$.costMicrocents'), 0) AS cost_microcents
			          FROM gholam_chats
			         WHERE created_at >= ?
			           AND json_extract(usage_json, '$.costMicrocents') IS NOT NULL
			        UNION ALL
			        SELECT strftime('%Y-%m-%d', started_at) AS date,
			               COALESCE(total_llm_cost_micros, 0) AS cost_microcents
			          FROM routine_runs
			         WHERE started_at >= ?
			           AND total_llm_cost_micros IS NOT NULL
			       )
			 GROUP BY date
			 ORDER BY date ASC`,
		)
		.all(sinceIso, sinceIso) as CostByDayRow[];
	const byDate = new Map(rows.map((r) => [r.date, r.costMicrocents]));
	const points: CostByDayPoint[] = [];
	const today = new Date();
	for (let i = COST_BY_DAY_LOOKBACK_DAYS - 1; i >= 0; i--) {
		const d = new Date(today.getTime() - i * 24 * 60 * 60_000);
		const date = dayKey(d.getTime());
		points.push({ date, costMicrocents: byDate.get(date) ?? 0 });
	}
	return points;
}
/**
 * Bucket tasks that crossed into a "done" state within the last 30 days
 * (using `state_entered_at`) by the hour-of-day they finished. Only hours
 * that crossed the threshold (`SHARP_HOURS_MIN_COUNT`) make the cut — the
 * leaderboard is meant to surface where the user's focus has actually
 * landed, not every partial hour.
 */
function computeSharpHours(input: {
	doneStateIds: Set<string>;
	tasks: Task[];
}): OverviewSharpHour[] {
	if (input.doneStateIds.size === 0) return [];
	const sinceMs = Date.now() - SHARP_HOURS_WINDOW_DAYS * 24 * 60 * 60_000;
	const sinceIso = new Date(sinceMs).toISOString();
	const ids = [...input.doneStateIds];
	const placeholders = ids.map(() => "?").join(",");
	const rows = getDb()
		.query<SharpHourRow, string[]>(
			`SELECT CAST(strftime('%H', state_entered_at) AS TEXT) AS hour,
			        COUNT(*) AS count
			 FROM tasks
			 WHERE state_id IN (${placeholders})
			   AND energy_tag IS NOT NULL
			   AND state_entered_at >= ?
			 GROUP BY hour
			 ORDER BY hour ASC`,
		)
		.all(...ids, sinceIso) as SharpHourRow[];
	return rows
		.map((r) => ({ hour: Number.parseInt(r.hour ?? "", 10), count: r.count }))
		.filter((r) => Number.isInteger(r.hour) && r.hour >= 0 && r.hour <= 23)
		.filter((r) => r.count >= SHARP_HOURS_MIN_COUNT);
}

async function listReceipts(input: {
	dataDir: string;
	date: string;
}): Promise<ReceiptsResponse> {
	const dir = path.join(input.dataDir, RECEIPTS_DIR);
	let entries: string[];
	try {
		entries = await fs.readdir(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { receipts: [] };
		throw err;
	}
	const prefix = `${input.date}-`;
	const matches = entries.filter((name) => name.startsWith(prefix) && name.endsWith(".md"));
	const receipts: ReceiptEntry[] = [];
	for (const filename of matches) {
		const sessionId = filename.slice(prefix.length, -".md".length).replace(/^\d{4}-/, "");
		const filePath = path.join(dir, filename);
		const goal = await readGoalFromReceipt(filePath);
		const createdAt = await receiptCreatedAt(filePath);
		receipts.push({ filename, sessionId, goal, createdAt });
	}
	receipts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	return { receipts };
}

async function readGoalFromReceipt(filePath: string): Promise<string> {
	let raw: string;
	try {
		raw = await fs.readFile(filePath, "utf-8");
	} catch {
		return "";
	}
	const lines = raw.split(/\r?\n/);
	const idx = lines.findIndex((l) => l.trim() === "# Goal");
	if (idx < 0) return "";
	const collected: string[] = [];
	for (let i = idx + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/^#\s/.test(line)) break;
		collected.push(line);
	}
	return collected.join("\n").trim();
}

async function receiptCreatedAt(filePath: string): Promise<string> {
	try {
		const stat = await fs.stat(filePath);
		return stat.mtime.toISOString();
	} catch {
		return new Date(0).toISOString();
	}
}
