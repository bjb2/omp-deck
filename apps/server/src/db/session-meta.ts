/**
 * Deck-managed session metadata: archived flag, urgency / importance / status
 * dials, and the optional binding to a managed repo + worktree. Backed by the
 * `session` table created in migration 009.
 *
 * The omp SDK persists transcript data on disk but keeps no UI-shaped flags.
 * The deck UI needs grouping + filtering affordances, so this module is the
 * single writer for that metadata. Sessions that have never been written to
 * here are simply absent from the table; the API layer treats absence as
 * "all defaults" (archived=false, urgency/importance='normal', status='active')
 * so we never have to seed rows proactively.
 */
import { getDb, nowIso } from "./index.ts";
import type { SessionImportance, SessionStatus, SessionUrgency } from "@omp-deck/protocol";

const URGENCY: Record<string, true> = { low: true, normal: true, high: true, critical: true };
const IMPORTANCE: Record<string, true> = { low: true, normal: true, high: true, critical: true };
const STATUS: Record<string, true> = { active: true, idle: true, archived: true, error: true };

export interface SessionMeta {
	id: string;
	archived: boolean;
	urgency: SessionUrgency;
	importance: SessionImportance;
	status: SessionStatus;
	repoId: string | null;
	worktree: string | null;
	updatedAt: string;
	/** AI-generated one-line summary. Empty until `regenerate-meta` runs. */
	aiSummary: string;
	/** AI-generated tags. Serialised JSON array in the row, parsed here. */
	aiTags: string[];
	/** ISO timestamp of the last successful AI regeneration. Empty until set. */
	aiGeneratedAt: string;
}

/** Defaults applied whenever no row exists for a session id. */
export const SESSION_META_DEFAULTS: SessionMeta = {
	id: "",
	archived: false,
	urgency: "normal",
	importance: "normal",
	status: "active",
	repoId: null,
	worktree: null,
	updatedAt: "",
	aiSummary: "",
	aiTags: [],
	aiGeneratedAt: "",
};

interface SessionMetaRow {
	id: string;
	archived: number;
	urgency: string;
	importance: string;
	status: string;
	repo_id: string | null;
	worktree: string | null;
	updated_at: string;
	ai_summary: string | null;
	ai_tags: string | null;
	ai_generated_at: string | null;
}

function parseAiTags(raw: string | null): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((t): t is string => typeof t === "string").slice(0, 5);
	} catch {
		return [];
	}
}

function rowToMeta(r: SessionMetaRow): SessionMeta {
	return {
		id: r.id,
		archived: r.archived !== 0,
		urgency: (URGENCY[r.urgency] ? r.urgency : "normal") as SessionUrgency,
		importance: (IMPORTANCE[r.importance] ? r.importance : "normal") as SessionImportance,
		status: (STATUS[r.status] ? r.status : "active") as SessionStatus,
		repoId: r.repo_id,
		worktree: r.worktree,
		updatedAt: r.updated_at,
		aiSummary: r.ai_summary ?? "",
		aiTags: parseAiTags(r.ai_tags),
		aiGeneratedAt: r.ai_generated_at ?? "",
	};
}

export function getSessionMeta(id: string): SessionMeta | null {
	const row = getDb()
		.query<SessionMetaRow, [string]>(
			"SELECT id, archived, urgency, importance, status, repo_id, worktree, updated_at, ai_summary, ai_tags, ai_generated_at FROM session WHERE id = ?",
		)
		.get(id);
	return row ? rowToMeta(row) : null;
}

/** Bulk read; missing rows are dropped (callers substitute defaults). */
export function listSessionMeta(ids: string[]): Map<string, SessionMeta> {
	if (ids.length === 0) return new Map();
	const placeholders = ids.map(() => "?").join(",");
	const rows = getDb()
		.query<SessionMetaRow, string[]>(
			`SELECT id, archived, urgency, importance, status, repo_id, worktree, updated_at, ai_summary, ai_tags, ai_generated_at
			 FROM session WHERE id IN (${placeholders})`,
		)
		.all(...ids);
	const map = new Map<string, SessionMeta>();
	for (const r of rows) map.set(r.id, rowToMeta(r));
	return map;
}

export interface SessionMetaPatch {
	archived?: boolean;
	urgency?: SessionUrgency;
	importance?: SessionImportance;
	status?: SessionStatus;
	repoId?: string | null;
	worktree?: string | null;
	/** Patch the AI summary column. String, not text-NULLed — pass "" to clear. */
	aiSummary?: string;
	/** Patch the AI tags column. Serialised as JSON in the row. */
	aiTags?: string[];
	/** Patch the AI generated-at column. Pass nowIso() to set. */
	aiGeneratedAt?: string;
}

/** Patch metadata for one session. Creates the row if missing. Returns the
 *  resulting meta; `null` means no field was supplied (no-op). */
export function patchSessionMeta(id: string, patch: SessionMetaPatch): SessionMeta | null {
	if (Object.keys(patch).length === 0) return null;
	const now = nowIso();
	const existing = getSessionMeta(id);
	const next: SessionMeta = {
		id,
		archived: patch.archived ?? existing?.archived ?? false,
		urgency: (patch.urgency ?? existing?.urgency ?? "normal") as SessionUrgency,
		importance: (patch.importance ?? existing?.importance ?? "normal") as SessionImportance,
		status: (patch.status ?? existing?.status ?? "active") as SessionStatus,
		repoId: patch.repoId !== undefined ? patch.repoId : (existing?.repoId ?? null),
		worktree: patch.worktree !== undefined ? patch.worktree : (existing?.worktree ?? null),
		updatedAt: now,
		aiSummary: patch.aiSummary ?? existing?.aiSummary ?? "",
		aiTags: patch.aiTags ?? existing?.aiTags ?? [],
		aiGeneratedAt: patch.aiGeneratedAt ?? existing?.aiGeneratedAt ?? "",
	};
	getDb()
		.prepare<unknown, [string, number, string, string, string, string | null, string | null, string, string, string, string]>(
			`INSERT INTO session (id, archived, urgency, importance, status, repo_id, worktree, updated_at, ai_summary, ai_tags, ai_generated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET
			   archived = excluded.archived,
			   urgency = excluded.urgency,
			   importance = excluded.importance,
			   status = excluded.status,
			   repo_id = excluded.repo_id,
			   worktree = excluded.worktree,
			   updated_at = excluded.updated_at,
			   ai_summary = excluded.ai_summary,
			   ai_tags = excluded.ai_tags,
			   ai_generated_at = excluded.ai_generated_at`,
		)
		.run(
			next.id,
			next.archived ? 1 : 0,
			next.urgency,
			next.importance,
			next.status,
			next.repoId,
			next.worktree,
			next.updatedAt,
			next.aiSummary,
			JSON.stringify(next.aiTags),
			next.aiGeneratedAt,
		);
	return next;
}

export function deleteSessionMeta(id: string): boolean {
	const result = getDb().prepare<unknown, [string]>("DELETE FROM session WHERE id = ?").run(id);
	return result.changes > 0;
}

/**
 * Apply metadata to a list of `SessionSummary`-shaped rows. Missing rows
 * contribute the defaults. Pure projection — does not mutate the input.
 */
export function decorateSessions<
	T extends { id: string; archived?: boolean; urgency?: SessionUrgency; importance?: SessionImportance; status?: SessionStatus; repoId?: string; worktree?: string; aiSummary?: string; aiTags?: string[]; aiGeneratedAt?: string },
>(rows: T[]): T[] {
	if (rows.length === 0) return rows;
	const ids = rows.map((r) => r.id);
	const meta = listSessionMeta(ids);
	return rows.map((row) => {
		const m = meta.get(row.id);
		const archived = row.archived ?? m?.archived ?? false;
		const urgency = row.urgency ?? m?.urgency ?? "normal";
		const importance = row.importance ?? m?.importance ?? "normal";
		const status = row.status ?? m?.status ?? "active";
		const repoId = row.repoId ?? m?.repoId ?? null;
		const worktree = row.worktree ?? m?.worktree ?? null;
		const aiSummary = row.aiSummary ?? m?.aiSummary ?? "";
		const aiTags = row.aiTags ?? m?.aiTags ?? [];
		const aiGeneratedAt = row.aiGeneratedAt ?? m?.aiGeneratedAt ?? "";
		return {
			...row,
			archived,
			urgency,
			importance,
			status,
			...(repoId !== null ? { repoId } : {}),
			...(worktree !== null ? { worktree } : {}),
			aiSummary,
			aiTags,
			aiGeneratedAt,
		};
	});
}

/** Type guards for the inbound PATCH body. */
export function isSessionUrgency(v: unknown): v is SessionUrgency {
	return typeof v === "string" && URGENCY[v] === true;
}
export function isSessionImportance(v: unknown): v is SessionImportance {
	return typeof v === "string" && IMPORTANCE[v] === true;
}
export function isSessionStatus(v: unknown): v is SessionStatus {
	return typeof v === "string" && STATUS[v] === true;
}
