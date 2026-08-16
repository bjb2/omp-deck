/**
 * Repo CRUD: `GET/POST /api/repos`, `DELETE /api/repos/:owner/:repo`.
 * Worktrees live in a sibling router — see `routes-worktrees.ts`.
 */
import { Hono } from "hono";
import type {
	CreateRepoRequest,
	CreateRepoResponse,
	ListReposResponse,
	RepoEntry,
} from "@omp-deck/protocol";

import {
	cloneRepo,
	deleteRepo,
	ensureDefaultWorktree,
	getRepo,
	listRepos,
	bareClonePath,
	RepoAlreadyExistsError,
	RepoError,
	RepoNotFoundError,
} from "./repo-service.ts";
import { extraWorkspaces } from "./routes-workspaces.ts";
import { logger } from "./log.ts";

const log = logger("routes-repos");

const GH_NAME = /^[A-Za-z0-9._-]+$/;

function validateGhName(value: unknown, field: string): string | null {
	if (typeof value !== "string" || !GH_NAME.test(value) || value.length === 0 || value.length > 100) {
		return `${field} must match [A-Za-z0-9._-]+ and be 1..100 chars`;
	}
	return null;
}

export function buildReposRouter(): Hono {
	const app = new Hono();

	app.get("/repos", async (c) => {
		try {
		const repos = await listRepos();
			const body: ListReposResponse = { repos };
			return c.json(body);
		} catch (err) {
			log.error("listRepos failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/repos", async (c) => {
		let body: CreateRepoRequest;
		try {
			body = (await c.req.json()) as CreateRepoRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const ownerErr = validateGhName(body.owner, "owner");
		if (ownerErr) return c.json({ error: ownerErr }, 400);
		const repoErr = validateGhName(body.repo, "repo");
		if (repoErr) return c.json({ error: repoErr }, 400);
		if (body.token !== undefined && typeof body.token !== "string") {
			return c.json({ error: "token must be a string when provided" }, 400);
		}

		try {
			const repo = await cloneRepo({
				owner: body.owner,
				repo: body.repo,
				...(typeof body.token === "string" ? { token: body.token } : {}),
			});
			// Register the bare clone + the default worktree so the workspace
			// picker lists them after navigation/refresh. Without this,
			// GET /api/workspaces only returns seed + session cwds and a
			// freshly cloned repo would be invisible until the user
			// manually registers it.
			try {
				const wt = await ensureDefaultWorktree(body.owner, body.repo, repo.defaultBranch);
				for (const p of [repo.clonePath, ...(wt ? [wt] : [])]) {
					if (!extraWorkspaces.includes(p)) extraWorkspaces.push(p);
				}
			} catch (err) {
				log.warn("failed to ensure default worktree after clone", err);
				if (!extraWorkspaces.includes(repo.clonePath)) extraWorkspaces.push(repo.clonePath);
			}
			const resp: CreateRepoResponse = { repo };
			return c.json(resp);
		} catch (err) {
			if (err instanceof RepoAlreadyExistsError) {
				// Surface a 409 so the UI can offer a "fetch + checkout" path
				// without re-clobbering the user's existing local state.
				const existing = await getRepo(body.owner, body.repo).catch(() => null);
				if (existing) {
					const resp: CreateRepoResponse = { repo: existing };
					return c.json(resp, 409);
				}
				return c.json({ error: err.message }, 409);
			}
			if (err instanceof RepoError) {
				return c.json({ error: err.message }, 400);
			}
			log.error("cloneRepo failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/repos/:owner/:repo", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const ownerErr = validateGhName(owner, "owner");
		if (ownerErr) return c.json({ error: ownerErr }, 400);
		const repoErr = validateGhName(repo, "repo");
		if (repoErr) return c.json({ error: repoErr }, 400);
		try {
			await deleteRepo(owner, repo);
		// Best-effort: also unregister the workspace so the picker drops
		// the entry. The next GET /api/workspaces will skip it cleanly.
		const cloneDir = bareClonePath(owner, repo);
		for (let i = extraWorkspaces.length - 1; i >= 0; i--) {
			if (extraWorkspaces[i] === cloneDir || extraWorkspaces[i]?.startsWith(`${cloneDir.replace(/\.git$/, "")}`)) {
				extraWorkspaces.splice(i, 1);
			}
		}
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof RepoNotFoundError) return c.json({ error: "repo not found" }, 404);
			log.error("deleteRepo failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}

// Helper: expose a quick lookup so other routers (worktrees, session-bind)
// can validate that an owner/repo pair is known to the manager without
// pulling in the full repo-service module path twice.
export async function lookupRepo(owner: string, repo: string): Promise<RepoEntry | null> {
	return getRepo(owner, repo);
}
