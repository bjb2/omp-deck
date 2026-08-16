/**
 * Worktree CRUD: list / create / delete the git worktrees attached to a
 * managed repo. Mounted under `/repos/:owner/:repo/worktrees`.
 */
import { Hono } from "hono";
import type {
	CreateWorktreeRequest,
	CreateWorktreeResponse,
	ListWorktreesResponse,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import {
	createWorktree,
	deleteWorktree,
	listWorktrees,
	WorktreeAlreadyExistsError,
	WorktreeError,
	WorktreeNotFoundError,
} from "./worktree-service.ts";
import { getRepo, RepoNotFoundError } from "./repo-service.ts";

const log = logger("routes-worktrees");

const GH_NAME = /^[A-Za-z0-9._-]+$/;
const GH_BRANCH = /^[A-Za-z0-9._/-]+$/;

function validateGhName(value: string, field: string): string | null {
	if (!GH_NAME.test(value) || value.length === 0 || value.length > 100) {
		return `${field} must match [A-Za-z0-9._-]+ and be 1..100 chars`;
	}
	return null;
}

export function buildWorktreesRouter(): Hono {
	const app = new Hono();

	app.get("/repos/:owner/:repo/worktrees", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const ownerErr = validateGhName(owner, "owner");
		if (ownerErr) return c.json({ error: ownerErr }, 400);
		const repoErr = validateGhName(repo, "repo");
		if (repoErr) return c.json({ error: repoErr }, 400);
		try {
			const worktrees = await listWorktrees(owner, repo);
			const body: ListWorktreesResponse = { worktrees };
			return c.json(body);
		} catch (err) {
			if (err instanceof WorktreeNotFoundError) {
				return c.json({ error: "repo not found" }, 404);
			}
			log.error("listWorktrees failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/repos/:owner/:repo/worktrees", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const ownerErr = validateGhName(owner, "owner");
		if (ownerErr) return c.json({ error: ownerErr }, 400);
		const repoErr = validateGhName(repo, "repo");
		if (repoErr) return c.json({ error: repoErr }, 400);
		let body: CreateWorktreeRequest;
		try {
			body = (await c.req.json()) as CreateWorktreeRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (typeof body.branch !== "string" || !GH_BRANCH.test(body.branch) || body.branch.length === 0 || body.branch.length > 200) {
			return c.json({ error: "branch must match [A-Za-z0-9._/-]+ and be 1..200 chars" }, 400);
		}
		if (body.base !== undefined && (typeof body.base !== "string" || !GH_BRANCH.test(body.base) || body.base.length > 200)) {
			return c.json({ error: "base must be a valid ref when provided" }, 400);
		}

		// Fail fast with 404 when the underlying bare clone is missing so the
		// UI can prompt the operator to clone the repo first.
		try {
			await getRepo(owner, repo);
		} catch (err) {
			if (err instanceof RepoNotFoundError) {
				return c.json({ error: "repo not found — clone it first" }, 404);
			}
			throw err;
		}

		try {
			const worktree = await createWorktree({
				owner,
				repo,
				branch: body.branch,
				...(typeof body.base === "string" ? { base: body.base } : {}),
			});
			const resp: CreateWorktreeResponse = { worktree };
			return c.json(resp);
		} catch (err) {
			if (err instanceof WorktreeNotFoundError) {
				return c.json({ error: "repo not found" }, 404);
			}
			if (err instanceof WorktreeAlreadyExistsError) {
				return c.json({ error: err.message }, 409);
			}
			if (err instanceof WorktreeError) {
				return c.json({ error: err.message }, 400);
			}
			log.error("createWorktree failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/repos/:owner/:repo/worktrees/:branch", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const branch = c.req.param("branch");
		const ownerErr = validateGhName(owner, "owner");
		if (ownerErr) return c.json({ error: ownerErr }, 400);
		const repoErr = validateGhName(repo, "repo");
		if (repoErr) return c.json({ error: repoErr }, 400);
		if (!GH_BRANCH.test(branch) || branch.length === 0 || branch.length > 200) {
			return c.json({ error: "branch must match [A-Za-z0-9._/-]+ and be 1..200 chars" }, 400);
		}
		try {
			await deleteWorktree(owner, repo, branch);
			return c.body(null, 204);
		} catch (err) {
			if (err instanceof WorktreeNotFoundError) {
				return c.json({ error: "worktree not found" }, 404);
			}
			log.error("deleteWorktree failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	return app;
}
