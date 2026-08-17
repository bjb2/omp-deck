/**
 * Tasks + task-states REST surface.
 *
 * Mounted on the main router at `/api/tasks` and `/api/task-states`. All
 * payloads use the protocol types verbatim. Validation is intentionally light
 * — the schema enforces shape (FK, CHECK constraints), we surface DB errors
 * back as 400/500.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import type {
	CreateTaskRequest,
	CreateTaskStateRequest,
	ListTasksResponse,
	MoveTaskRequest,
	TaskDispatch,
	TaskDispatchBranch,
	UpdateTaskRequest,
	UpdateTaskStateRequest,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { id } from "./db/index.ts";
import {
	createState,
	createTask,
	deleteState,
	deleteTask,
	getState,
	getTask,
	listStates,
	listTasks,
	moveTask,
	reorderStates,
	updateState,
	updateTask,
} from "./db/tasks.ts";
import { createWorktree, GitError, mergeBranch, removeWorktree } from "./git-service.ts";

const log = logger("routes:tasks");

function notifyTasksChanged(): void {
	broadcastBus.broadcast({ type: "tasks_changed" });
}

export function buildTasksRouter(bridge?: AgentBridge): Hono {
	const app = new Hono();

	// ─── Tasks ─────────────────────────────────────────────────────────────

	app.get("/tasks", (c) => {
		const includeArchived = c.req.query("includeArchived") === "1";
		const tasks = listTasks({ includeArchived });
		const states = listStates();
		const body: ListTasksResponse = { tasks, states };
		return c.json(body);
	});

	app.post("/tasks", async (c) => {
		let body: CreateTaskRequest;
		try {
			body = (await c.req.json()) as CreateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.title || typeof body.title !== "string") {
			return c.json({ error: "title is required" }, 400);
		}
		try {
			const task = createTask(body);
			notifyTasksChanged();
			return c.json(task, 201);
		} catch (err) {
			log.error(`createTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/tasks/:id", (c) => {
		const task = getTask(c.req.param("id"));
		if (!task) return c.json({ error: "not found" }, 404);
		return c.json(task);
	});

	app.patch("/tasks/:id", async (c) => {
		let body: UpdateTaskRequest;
		try {
			body = (await c.req.json()) as UpdateTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			const updated = updateTask(c.req.param("id"), body);
			if (!updated) return c.json({ error: "not found" }, 404);
			notifyTasksChanged();
			return c.json(updated);
		} catch (err) {
			log.error(`updateTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.delete("/tasks/:id", (c) => {
		const ok = deleteTask(c.req.param("id"));
		if (ok) notifyTasksChanged();
		return c.json({ ok });
	});

	app.post("/tasks/:id/move", async (c) => {
		let body: MoveTaskRequest;
		try {
			body = (await c.req.json()) as MoveTaskRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.stateId || typeof body.index !== "number") {
			return c.json({ error: "stateId and numeric index required" }, 400);
		}
		try {
			const moved = moveTask(c.req.param("id"), body.stateId, body.index);
			if (!moved) return c.json({ error: "task not found" }, 404);
			notifyTasksChanged();
			return c.json(moved);
		} catch (err) {
			log.error(`moveTask failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	// ─── Dispatch ──────────────────────────────────────────────────────────

	app.post("/tasks/:id/dispatch", async (c) => {
		const taskId = c.req.param("id");
		const task = getTask(taskId);
		if (!task) return c.json({ error: "task not found" }, 404);

		let body: { branches?: number; prompt?: string };
		try {
			body = (await c.req.json()) as { branches?: number; prompt?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}

		const branchesCount = body.branches;
		if (
			typeof branchesCount !== "number" ||
			!Number.isInteger(branchesCount) ||
			branchesCount < 2 ||
			branchesCount > 5
		) {
			return c.json({ error: "branches must be between 2 and 5" }, 400);
		}

		if (!task.cwd) {
			return c.json({ error: "task has no cwd" }, 400);
		}

		if (!existsSync(task.cwd)) {
			return c.json({ error: "task cwd does not exist" }, 400);
		}

		if (task.dispatch?.branches.some((b) => b.status === "running")) {
			return c.json({ error: "task already has an active dispatch" }, 409);
		}

		const createdBranches: TaskDispatchBranch[] = [];

		try {
			for (let i = 0; i < branchesCount; i++) {
				const branchId = id().toLowerCase().slice(0, 10);
				const branchName = `dispatch/${taskId}/${branchId}`;
				const worktreePath = join(task.cwd, ".omp-deck-worktrees", taskId, branchId);

				await createWorktree(task.cwd, branchName, worktreePath);

				let sessionId: string | null = null;
				if (bridge) {
					const session = await bridge.createSession({ cwd: worktreePath });
					sessionId = session.sessionId;
					if (body.prompt) {
						const handle = bridge.getSession(sessionId);
						if (handle) {
							handle.prompt(body.prompt).catch((err) => {
								log.error(`failed to send initial prompt to dispatch session ${sessionId}`, err);
							});
						}
					}
				}

				createdBranches.push({
					id: branchId,
					worktreePath,
					branchName,
					sessionId,
					status: "running",
					createdAt: new Date().toISOString(),
				});
			}

			const dispatch: TaskDispatch = { branches: createdBranches };
			const dispatchJson = JSON.stringify(dispatch);
			const updated = updateTask(taskId, { dispatchJson });
			notifyTasksChanged();
			return c.json(updated);
		} catch (err) {
			log.error(`dispatch failed for task ${taskId}`, err);
			// Rollback any worktrees created during this attempt
			for (const b of createdBranches) {
				try {
					await removeWorktree(task.cwd, b.worktreePath, { force: true });
				} catch {
					// best-effort cleanup
				}
				if (bridge && b.sessionId) {
					try {
						const handle = bridge.getSession(b.sessionId);
						if (handle) {
							await handle.abort();
							await handle.dispose();
						}
					} catch {
						// best-effort cleanup
					}
				}
			}
			return c.json({ error: err instanceof GitError ? err.stderr || err.message : String(err) }, 500);
		}
	});

	app.post("/tasks/:id/dispatch/:branchId/merge", async (c) => {
		const taskId = c.req.param("id");
		const branchId = c.req.param("branchId");
		const task = getTask(taskId);
		if (!task) return c.json({ error: "task not found" }, 404);

		if (!task.cwd || !existsSync(task.cwd)) {
			return c.json({ error: "task cwd does not exist" }, 400);
		}

		const branches = task.dispatch?.branches ?? [];
		const branch = branches.find((b) => b.id === branchId);
		if (!branch) {
			return c.json({ error: "branch not found" }, 404);
		}

		if (branch.status !== "running") {
			return c.json({ error: "branch is not running" }, 409);
		}

		try {
			await mergeBranch(task.cwd, branch.branchName, { noFf: true });
		} catch (err) {
			if (err instanceof GitError) {
				return c.json({ error: err.stderr || err.message }, 409);
			}
			return c.json({ error: String(err) }, 500);
		}

		try {
			await removeWorktree(task.cwd, branch.worktreePath, { force: true });
		} catch (err) {
			log.warn(`failed to remove worktree at ${branch.worktreePath} after merge`, err);
		}

		branch.status = "merged";
		const dispatchJson = JSON.stringify({ branches });
		const updated = updateTask(taskId, { dispatchJson });
		notifyTasksChanged();
		return c.json(updated);
	});

	app.post("/tasks/:id/dispatch/:branchId/discard", async (c) => {
		const taskId = c.req.param("id");
		const branchId = c.req.param("branchId");
		const task = getTask(taskId);
		if (!task) return c.json({ error: "task not found" }, 404);

		if (!task.cwd || !existsSync(task.cwd)) {
			return c.json({ error: "task cwd does not exist" }, 400);
		}

		const branches = task.dispatch?.branches ?? [];
		const branch = branches.find((b) => b.id === branchId);
		if (!branch) {
			return c.json({ error: "branch not found" }, 404);
		}

		if (branch.status !== "running") {
			return c.json({ error: "branch is not running" }, 409);
		}

		try {
			await removeWorktree(task.cwd, branch.worktreePath, { force: true });
		} catch (err) {
			log.warn(`failed to remove worktree at ${branch.worktreePath} during discard`, err);
		}

		if (bridge && branch.sessionId) {
			try {
				const handle = bridge.getSession(branch.sessionId);
				if (handle) {
					await handle.abort();
					await handle.dispose();
				}
			} catch (err) {
				log.warn(`failed to dispose session ${branch.sessionId} during discard`, err);
			}
		}

		branch.status = "discarded";
		const dispatchJson = JSON.stringify({ branches });
		const updated = updateTask(taskId, { dispatchJson });
		notifyTasksChanged();
		return c.json(updated);
	});

	// ─── States ────────────────────────────────────────────────────────────

	app.get("/task-states", (c) => c.json({ states: listStates() }));

	app.post("/task-states", async (c) => {
		let body: CreateTaskStateRequest;
		try {
			body = (await c.req.json()) as CreateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name) return c.json({ error: "name required" }, 400);
		try {
			const state = createState(body);
			return c.json(state, 201);
		} catch (err) {
			log.error(`createState failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.post("/task-states/reorder", async (c) => {
		let body: { orderedIds?: unknown };
		try {
			body = (await c.req.json()) as { orderedIds?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!Array.isArray(body.orderedIds) || body.orderedIds.some((x) => typeof x !== "string")) {
			return c.json({ error: "orderedIds must be string[]" }, 400);
		}
		try {
			const states = reorderStates(body.orderedIds as string[]);
			notifyTasksChanged();
			return c.json({ states });
		} catch (err) {
			log.error(`reorderStates failed`, err);
			return c.json({ error: String(err) }, 400);
		}
	});

	app.patch("/task-states/:id", async (c) => {
		let body: UpdateTaskStateRequest;
		try {
			body = (await c.req.json()) as UpdateTaskStateRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const updated = updateState(c.req.param("id"), body);
		if (!updated) return c.json({ error: "not found" }, 404);
		return c.json(updated);
	});

	app.delete("/task-states/:id", (c) => {
		try {
			const result = deleteState(c.req.param("id"));
			return c.json(result);
		} catch (err) {
			return c.json({ error: String(err) }, 400);
		}
	});

	app.get("/task-states/:id", (c) => {
		const state = getState(c.req.param("id"));
		if (!state) return c.json({ error: "not found" }, 404);
		return c.json(state);
	});

	return app;
}
