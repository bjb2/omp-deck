/**
 * Auto-kanban HTTP surface + AGENTS.md loader.
 *
 * Mounted under `/` by `buildRouter()`. Two endpoints:
 *   - `POST /api/tasks/from-message` — manual client-side trigger, used
 *     as belt-and-braces next to the WS-side hook. Gated by
 *     `resolvePrincipal` like every other state-mutating route.
 *   - `GET  /api/agents-md` — returns the repo-root AGENTS.md verbatim.
 *     Client caches for 60s; no gating because AGENTS.md is a
 *     workspace-readable directive (no secrets).
 *
 * Heavy lifting lives in `auto-kanban.ts`. This file stays thin — Hono
 * glue + auth gate.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Hono } from "hono";

import type { Task } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { resolvePrincipal } from "./auth/guard.ts";
import { getAuthConfig } from "./auth/config.ts";
import { createAutoTasks, parseTaskCues } from "./auto-kanban.ts";

const log = logger("routes:auto-kanban");

/**
 * Resolve the repo root for the AGENTS.md serve. We prefer the
 * `OMP_DECK_REPO_ROOT` env var (explicit), fall back to the project
 * root detection by walking up from this file.
 */
function repoRootCandidates(): string[] {
	const env = process.env.OMP_DECK_REPO_ROOT;
	const out: string[] = [];
	if (env) out.push(env);
	// apps/server/src/routes-auto-kanban.ts → 4 levels up = repo root.
	const here = resolve(import.meta.dir);
	out.push(resolve(here, "..", "..", ".."));
	return out;
}

function findAgentsMd(): string | null {
	for (const candidate of repoRootCandidates()) {
		const path = join(candidate, "AGENTS.md");
		if (existsSync(path)) return path;
	}
	return null;
}

function principalFromReq(req: Request): boolean {
	const cfg = getAuthConfig();
	if (!cfg.enabled) return true;
	return resolvePrincipal(req, cfg) !== null;
}

interface FromMessageBody {
	text?: unknown;
	cwd?: unknown;
	project?: unknown;
}

export function buildAutoKanbanRouter(): Hono {
	const app = new Hono();

	app.post("/tasks/from-message", async (c) => {
		if (!principalFromReq(c.req.raw)) {
			return c.json({ error: "unauthorized" }, 401);
		}
		let body: FromMessageBody;
		try {
			body = (await c.req.json()) as FromMessageBody;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const text = typeof body.text === "string" ? body.text : "";
		const cwd = typeof body.cwd === "string" ? body.cwd : "";
		const project = typeof body.project === "string" && body.project.trim().length > 0
			? body.project.trim()
			: "default";
		if (!text.trim()) {
			return c.json({ tasks: [] as Task[] });
		}
		try {
			const cues = parseTaskCues(text);
			const tasks = await createAutoTasks(cues, cwd, project);
			return c.json({ tasks });
		} catch (err) {
			log.error(`auto-kanban route failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	// Read-only AGENTS.md serve. No auth gate — the directive file is
	// workspace-readable by design. Returns 404 when no AGENTS.md is
	// present so the loader falls back to empty defaults.
	app.get("/agents-md", (c) => {
		const path = findAgentsMd();
		if (!path) return c.json({ error: "not found" }, 404);
		try {
			const stat = statSync(path);
			const body = readFileSync(path, "utf8");
			return c.json(
				{ path, size: stat.size, mtimeMs: stat.mtimeMs, body },
				200,
				{ "cache-control": "no-cache" },
			);
		} catch (err) {
			log.warn(`failed to read AGENTS.md at ${path}`, err);
			return c.json({ error: "unreadable" }, 500);
		}
	});

	return app;
}
