/**
 * Workspace bookkeeping separate from `routes.ts`'s top-level router.
 *
 * The picker dialog (GET /api/fs/dialog) surfaces subdirectories on demand;
 * when the user picks one and wants it "remembered" for future sessions, the
 * picker calls POST /api/workspaces/register. That writes into the same
 * in-memory list that GET /api/workspaces reads from in routes.ts.
 *
 * Persistence is intentionally NOT done here: the original Config
 * (`loadConfig()`) seeds the list from `OMP_DECK_WORKSPACES` at boot. The
 * picker just mutates that list for the lifetime of the running server.
 * # ponytail: add file persistence when the picker needs to survive restarts.
 */
import { Hono } from "hono";
import * as path from "node:path";

import type {
	RegisterWorkspaceRequest,
	RegisterWorkspaceResponse,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import { isCwdAllowed } from "./routes-fs.ts";

// Module-level mutable list. Initialized empty here; `routes.ts` seeds it
// from Config at startup via `seedExtraWorkspaces()`. Both endpoints read
// and write this same array so a register() takes effect for the next
// GET /api/workspaces immediately.
export const extraWorkspaces: string[] = [];

export function seedExtraWorkspaces(seed: readonly string[]): void {
	extraWorkspaces.length = 0;
	for (const cwd of seed) extraWorkspaces.push(cwd);
}

/** Mirror of routes.ts's private `deriveLabel` — basename, or "(unknown)". */
function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

export function buildWorkspacesRouter(): Hono {
	const app = new Hono();

	app.post("/workspaces/register", async (c) => {
		let body: RegisterWorkspaceRequest;
		try {
			body = (await c.req.json()) as RegisterWorkspaceRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const cwd = body.cwd?.trim();
		if (!cwd || !path.isAbsolute(cwd)) {
			return c.json({ error: "cwd must be an absolute path" }, 400);
		}
		if (!isCwdAllowed(cwd)) {
			return c.json({ error: "cwd is not under an allowed root" }, 403);
		}
		// Already-registered is a no-op (idempotent) rather than 4xx — the
		// picker may retry on flaky WS reconnects.
		if (!extraWorkspaces.includes(cwd)) extraWorkspaces.push(cwd);
		const workspace: WorkspaceEntry = {
			cwd,
			label: deriveLabel(cwd),
			sessionCount: 0,
		};
		const resp: RegisterWorkspaceResponse = { ok: true, workspace };
		return c.json(resp);
	});

	return app;
}