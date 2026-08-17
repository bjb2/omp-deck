/**
 * Tasks + task-states queries.
 *
 * All ordering uses `order_in_state`, an integer that we renumber with a
 * 1000-step gap on every move to keep the column stable without floating-point
 * tricks. A move == one transaction that renumbers the destination column.
 */

import type { Task, TaskDispatch, TaskState } from "@omp-deck/protocol";

import { getDb, id, nowIso } from "./index.ts";

interface TaskRow {
	id: string;
	display_id: number;
	title: string;
	body: string;
	state_id: string;
	order_in_state: number;
	cwd: string | null;
	created_at: string;
	updated_at: string;
	state_entered_at: string;
	archived_at: string | null;
	dispatch_json: string | null;
	energy_tag: "low" | "medium" | "high" | null;
}

interface StateRow {
	id: string;
	name: string;
	color: string;
	position: number;
	is_default: number;
}

function rowToTask(r: TaskRow): Task {
	const t: Task = {
		id: r.id,
		displayId: r.display_id,
		title: r.title,
		body: r.body,
		stateId: r.state_id,
		orderInState: r.order_in_state,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		stateEnteredAt: r.state_entered_at,
	};
	if (r.cwd !== null) t.cwd = r.cwd;
	if (r.archived_at !== null) t.archivedAt = r.archived_at;
	if (r.energy_tag !== null) t.energyTag = r.energy_tag;
	if (r.dispatch_json !== null) {
		t.dispatchJson = r.dispatch_json;
		try {
			t.dispatch = JSON.parse(r.dispatch_json) as TaskDispatch;
		} catch {
			// ignore malformed JSON
		}
	}
	return t;
}

function rowToState(r: StateRow): TaskState {
	return {
		id: r.id,
		name: r.name,
		color: r.color,
		position: r.position,
		isDefault: r.is_default === 1,
	};
}

// ─── States ────────────────────────────────────────────────────────────────

export function listStates(): TaskState[] {
	const rows = getDb()
		.query<StateRow, []>("SELECT id, name, color, position, is_default FROM task_states ORDER BY position ASC")
		.all() as StateRow[];
	return rows.map(rowToState);
}

export function getState(stateId: string): TaskState | undefined {
	const row = getDb()
		.query<StateRow, [string]>(
			"SELECT id, name, color, position, is_default FROM task_states WHERE id = ?",
		)
		.get(stateId) as StateRow | null;
	return row ? rowToState(row) : undefined;
}

export function getDefaultState(): TaskState {
	const row = getDb()
		.query<StateRow, []>(
			"SELECT id, name, color, position, is_default FROM task_states WHERE is_default = 1 ORDER BY position ASC LIMIT 1",
		)
		.get() as StateRow | null;
	if (!row) {
		// Fallback to the lowest-position state, or throw if none.
		const any = getDb()
			.query<StateRow, []>(
				"SELECT id, name, color, position, is_default FROM task_states ORDER BY position ASC LIMIT 1",
			)
			.get() as StateRow | null;
		if (!any) throw new Error("no task states configured");
		return rowToState(any);
	}
	return rowToState(row);
}

export function createState(input: {
	name: string;
	color?: string;
	position?: number;
}): TaskState {
	const db = getDb();
	const nextPos =
		input.position ??
		((db.query<{ max: number | null }, []>("SELECT MAX(position) AS max FROM task_states").get() as
			| { max: number | null }
			| null)?.max ?? 0) + 100;
	const stateId = `s_${id().toLowerCase().slice(0, 12)}`;
	db.prepare<unknown, [string, string, string, number]>(
		"INSERT INTO task_states (id, name, color, position) VALUES (?, ?, ?, ?)",
	).run(stateId, input.name, input.color ?? "#6e6a62", nextPos);
	const out = getState(stateId);
	if (!out) throw new Error("createState failed");
	return out;
}

export function updateState(
	stateId: string,
	patch: { name?: string; color?: string; position?: number },
): TaskState | undefined {
	const existing = getState(stateId);
	if (!existing) return undefined;
	const next = { ...existing, ...patch };
	getDb()
		.prepare<unknown, [string, string, number, string]>(
			"UPDATE task_states SET name = ?, color = ?, position = ? WHERE id = ?",
		)
		.run(next.name, next.color, next.position, stateId);
	return getState(stateId);
}

/**
 * Atomically renumber `task_states.position` to match `orderedIds`. Used by
 * the kanban column drag-reorder. `orderedIds` must be a permutation of the
 * current `task_states.id` set — missing, extra, or duplicate ids throw
 * before any UPDATE runs, so the column ordering is never left half-applied.
 *
 * Renumbering uses 100-unit gaps so an ad-hoc `position` insert (e.g. a
 * `createState({ position })` call) can still slot between two columns
 * without re-running this whole reorder.
 */
export function reorderStates(orderedIds: string[]): TaskState[] {
	const db = getDb();
	const current = listStates();
	const knownIds = new Set(current.map((s) => s.id));

	if (orderedIds.length !== current.length) {
		throw new Error(
			`reorderStates: expected ${current.length} ids, got ${orderedIds.length}`,
		);
	}
	const seen = new Set<string>();
	for (const sid of orderedIds) {
		if (!knownIds.has(sid)) throw new Error(`reorderStates: unknown state id "${sid}"`);
		if (seen.has(sid)) throw new Error(`reorderStates: duplicate state id "${sid}"`);
		seen.add(sid);
	}

	db.transaction(() => {
		const update = db.prepare<unknown, [number, string]>(
			"UPDATE task_states SET position = ? WHERE id = ?",
		);
		for (let i = 0; i < orderedIds.length; i++) {
			update.run((i + 1) * 100, orderedIds[i]!);
		}
	})();

	return listStates();
}

/**
 * Delete a state. Reassigns any tasks in that state to the default state.
 * Refuses to delete the default state.
 */
export function deleteState(stateId: string): { reassigned: number } {
	const db = getDb();
	const target = getState(stateId);
	if (!target) return { reassigned: 0 };
	if (target.isDefault) throw new Error("cannot delete the default state");
	const fallback = getDefaultState();

	let reassigned = 0;
	db.transaction(() => {
		const result = db
			.prepare<unknown, [string, string, string]>(
				"UPDATE tasks SET state_id = ?, updated_at = ? WHERE state_id = ?",
			)
			.run(fallback.id, nowIso(), stateId);
		reassigned = Number(result.changes ?? 0);
		// Renumber the fallback column to keep ordering stable.
		renumberColumn(fallback.id);
		db.prepare<unknown, [string]>("DELETE FROM task_states WHERE id = ?").run(stateId);
	})();
	return { reassigned };
}

// ─── Tasks ─────────────────────────────────────────────────────────────────

export function listTasks(opts: { includeArchived?: boolean } = {}): Task[] {
	const where = opts.includeArchived ? "" : "WHERE archived_at IS NULL";
	const rows = getDb()
		.query<TaskRow, []>(
			`SELECT id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at, state_entered_at, archived_at, dispatch_json, energy_tag
			 FROM tasks
			 ${where}
			 ORDER BY state_id, state_entered_at DESC, order_in_state ASC`,
		)
		.all() as TaskRow[];
	return rows.map(rowToTask);
}

export function getTask(taskId: string): Task | undefined {
	const row = getDb()
		.query<TaskRow, [string]>(
			`SELECT id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at, state_entered_at, archived_at, dispatch_json, energy_tag
			 FROM tasks WHERE id = ?`,
		)
		.get(taskId) as TaskRow | null;
	return row ? rowToTask(row) : undefined;
}

export function createTask(input: {
	title: string;
	body?: string;
	stateId?: string;
	cwd?: string;
	energyTag?: "low" | "medium" | "high";
	dispatchJson?: string;
}): Task {
	const db = getDb();
	const state = input.stateId ? getState(input.stateId) : getDefaultState();
	if (!state) throw new Error(`unknown state: ${input.stateId}`);

	const maxOrder = (db
		.query<{ max: number | null }, [string]>(
			"SELECT MAX(order_in_state) AS max FROM tasks WHERE state_id = ?",
		)
		.get(state.id) as { max: number | null } | null)?.max ?? 0;

	const taskId = `t_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	let displayId = 0;
	db.transaction(() => {
		const seqRow = db
			.query<{ value: number }, []>(
				"UPDATE sequences SET value = value + 1 WHERE name = 'tasks' RETURNING value",
			)
			.get() as { value: number } | null;
		if (!seqRow) throw new Error("tasks sequence missing — migration 002 not applied");
		displayId = seqRow.value;
		db.prepare<
			unknown,
			[
				string,
				number,
				string,
				string,
				string,
				number,
				string | null,
				string,
				string,
				string,
				string | null,
				string | null,
			]
		>(
			`INSERT INTO tasks (id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at, state_entered_at, dispatch_json, energy_tag)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			taskId,
			displayId,
			input.title,
			input.body ?? "",
			state.id,
			maxOrder + 1000,
			input.cwd ?? null,
			now,
			now,
			now,
			input.dispatchJson ?? null,
			input.energyTag ?? null,
		);
	})();
	const out = getTask(taskId);
	if (!out) throw new Error("createTask failed");
	return out;
}

export function updateTask(
	taskId: string,
	patch: {
		title?: string;
		body?: string;
		stateId?: string;
		orderInState?: number;
		cwd?: string;
		archived?: boolean;
		energyTag?: "low" | "medium" | "high" | null;
		dispatchJson?: string | null;
	},
): Task | undefined {
	const existing = getTask(taskId);
	if (!existing) return undefined;
	const db = getDb();
	const next = { ...existing, ...patch };
	const archivedAt =
		patch.archived === true ? nowIso() : patch.archived === false ? null : existing.archivedAt ?? null;
	// State change via patch (rare — UI normally uses moveTask) is the only
	// case where updateTask should bump state_entered_at. Title / body / cwd
	// edits must NOT reset the per-column recency sort.
	const stateChanged = patch.stateId !== undefined && patch.stateId !== existing.stateId;
	const stateEnteredAt = stateChanged ? nowIso() : existing.stateEnteredAt;
	const dispatchJson =
		patch.dispatchJson !== undefined ? patch.dispatchJson : (existing.dispatchJson ?? null);
	const energyTag =
		patch.energyTag !== undefined ? patch.energyTag : (existing.energyTag ?? null);
	db.prepare<
		unknown,
		[
			string,
			string,
			string,
			number,
			string | null,
			string,
			string,
			string | null,
			string | null,
			string | null,
			string,
		]
	>(
		`UPDATE tasks
		   SET title = ?, body = ?, state_id = ?, order_in_state = ?, cwd = ?,
		       updated_at = ?, state_entered_at = ?, archived_at = ?,
		       dispatch_json = ?, energy_tag = ?
		 WHERE id = ?`,
	).run(
		next.title,
		next.body,
		next.stateId,
		next.orderInState,
		next.cwd ?? null,
		nowIso(),
		stateEnteredAt,
		archivedAt,
		dispatchJson,
		energyTag,
		taskId,
	);
	return getTask(taskId);
}

export function deleteTask(taskId: string): boolean {
	const r = getDb().prepare<unknown, [string]>("DELETE FROM tasks WHERE id = ?").run(taskId);
	return Number(r.changes ?? 0) > 0;
}

/**
 * Move a task to a new state at a target index. Renumbers the destination
 * column with 1000-unit gaps for stable future inserts.
 *
 * Bumps `state_entered_at` for the moved row only when it actually changed
 * columns. Peers — and same-column reorders — keep their entry timestamps so
 * the per-column recency sort remains stable.
 */
export function moveTask(taskId: string, stateId: string, index: number): Task | undefined {
	const db = getDb();
	const existing = getTask(taskId);
	if (!existing) return undefined;
	const targetState = getState(stateId);
	if (!targetState) throw new Error(`unknown state: ${stateId}`);

	const crossColumn = existing.stateId !== stateId;

	db.transaction(() => {
		// Pull current ordering of destination column, excluding the task being moved.
		const peers = db
			.query<{ id: string }, [string, string]>(
				"SELECT id FROM tasks WHERE state_id = ? AND id != ? ORDER BY order_in_state ASC",
			)
			.all(stateId, taskId) as { id: string }[];

		const ids: string[] = peers.map((p) => p.id);
		const clampedIndex = Math.max(0, Math.min(index, ids.length));
		ids.splice(clampedIndex, 0, taskId);

		// Renumber with 1000-unit gaps.
		const update = db.prepare<unknown, [string, number, string, string]>(
			"UPDATE tasks SET state_id = ?, order_in_state = ?, updated_at = ? WHERE id = ?",
		);
		const now = nowIso();
		for (let i = 0; i < ids.length; i++) {
			update.run(stateId, (i + 1) * 1000, now, ids[i]!);
		}

		if (crossColumn) {
			db.prepare<unknown, [string, string]>(
				"UPDATE tasks SET state_entered_at = ? WHERE id = ?",
			).run(now, taskId);
		}
	})();

	return getTask(taskId);
}

function renumberColumn(stateId: string): void {
	const db = getDb();
	const peers = db
		.query<{ id: string }, [string]>(
			"SELECT id FROM tasks WHERE state_id = ? ORDER BY order_in_state ASC",
		)
		.all(stateId) as { id: string }[];
	const update = db.prepare<unknown, [number, string]>(
		"UPDATE tasks SET order_in_state = ? WHERE id = ?",
	);
	for (let i = 0; i < peers.length; i++) {
		update.run((i + 1) * 1000, peers[i]!.id);
	}
}

/**
 * Resolve `T-32` or `t_01...` to the canonical task row. Display ids are
 * exact-match; ULIDs allow case-insensitive comparison since they are filed
 * lowercased internally. Returns undefined when neither shape resolves.
 */
export function findTaskByDisplayOrId(ref: string): Task | undefined {
	const trimmed = ref.trim();
	const displayMatch = /^[Tt]-?(\d+)$/.exec(trimmed);
	if (displayMatch) {
		const num = Number.parseInt(displayMatch[1]!, 10);
		if (!Number.isFinite(num)) return undefined;
		const row = getDb()
			.query<TaskRow, [number]>(
				`SELECT id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at, archived_at
				 FROM tasks WHERE display_id = ?`,
			)
			.get(num) as TaskRow | null;
		return row ? rowToTask(row) : undefined;
	}
	return getTask(trimmed.toLowerCase());
}

/**
 * Case-insensitive substring match against `task_states.name`. Returns
 * undefined when no state matches; throws when multiple match (ambiguous
 * caller input — better to refuse than silently pick one).
 */
export function findStateByName(needle: string): TaskState | undefined {
	const trimmed = needle.trim().toLowerCase();
	if (!trimmed) return undefined;
	const all = listStates();
	const exact = all.find((s) => s.name.toLowerCase() === trimmed);
	if (exact) return exact;
	const matches = all.filter((s) => s.name.toLowerCase().includes(trimmed));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const names = matches.map((m) => m.name).join(", ");
		throw new Error(`ambiguous state "${needle}" — matches: ${names}`);
	}
	return undefined;
}
