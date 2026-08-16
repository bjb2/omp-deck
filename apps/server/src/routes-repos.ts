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
	getRepo,
	listRepos,
	RepoAlreadyExistsError,
	RepoError,
	RepoNotFoundError,
} from "./repo-service.ts";
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
