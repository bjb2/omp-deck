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

import { Hono } from "hono";

import type { Task, TaskState } from "@omp-deck/protocol";

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
	stale?: boolean;
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

	app.get("/overview", async (c) => {
		const window = windowFromQuery(c.req.query("window"));
		const refresh = c.req.query("refresh") === "1";
		try {
			const payload = await buildOverview({
				inputs: {
					window,
					refresh,
					news,
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

	const stale = newsResult.stale || trendingResult.stale;
	const out: OverviewResponse = {
		generatedAt: now.toISOString(),
		window: inputs.window,
		stats,
		focus,
		news: newsResult.items,
		trending: trendingResult.items,
		events,
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
