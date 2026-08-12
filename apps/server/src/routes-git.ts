/**
 * Git cockpit REST surface. Thin HTTP shaping over `git-service.ts`, which
 * does all path confinement and process execution.
 */
import { Hono } from "hono";

import type {
	CheckoutBranchRequest,
	CommitRequest,
	DiscardRequest,
	StageRequest,
} from "@omp-deck/protocol";

import {
	GitCommandError,
	GuardError,
	NotARepoError,
	checkoutBranch,
	commit,
	discard,
	fetchRemote,
	getBranches,
	getDiff,
	getLog,
	getStatus,
	pull,
	push,
	stage,
	unstage,
} from "./git-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-git");

function handleError(err: unknown): { status: 400 | 403 | 404 | 409 | 500; message: string; stderr?: string } {
	if (err instanceof GuardError) return { status: 403, message: err.message };
	if (err instanceof NotARepoError) return { status: 404, message: err.message };
	if (err instanceof GitCommandError) return { status: 409, message: err.message, stderr: err.stderr };
	log.error("unexpected error", err);
	return { status: 500, message: "internal error" };
}

export function buildGitRouter(): Hono {
	const app = new Hono();

	app.get("/git/status", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		try {
			return c.json(await getStatus(cwd));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.get("/git/diff", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		const path = c.req.query("path")?.trim();
		const staged = c.req.query("staged") === "1" || c.req.query("staged") === "true";
		if (!cwd || !path) return c.json({ error: "cwd and path query params are required" }, 400);
		try {
			return c.json(await getDiff(cwd, path, staged));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/stage", async (c) => {
		let body: StageRequest;
		try {
			body = (await c.req.json()) as StageRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !Array.isArray(body.paths)) return c.json({ error: "cwd and paths are required" }, 400);
		try {
			await stage(body.cwd, body.paths);
			return c.json({ ok: true });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/unstage", async (c) => {
		let body: StageRequest;
		try {
			body = (await c.req.json()) as StageRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !Array.isArray(body.paths)) return c.json({ error: "cwd and paths are required" }, 400);
		try {
			await unstage(body.cwd, body.paths);
			return c.json({ ok: true });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/discard", async (c) => {
		let body: DiscardRequest;
		try {
			body = (await c.req.json()) as DiscardRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !Array.isArray(body.paths) || body.paths.length === 0) {
			return c.json({ error: "cwd and a non-empty paths array are required" }, 400);
		}
		try {
			await discard(body.cwd, body.paths);
			return c.json({ ok: true });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/commit", async (c) => {
		let body: CommitRequest;
		try {
			body = (await c.req.json()) as CommitRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !body.message?.trim()) return c.json({ error: "cwd and message are required" }, 400);
		try {
			return c.json(await commit(body.cwd, body.message, { amend: body.amend }));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.get("/git/log", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		const limit = Number(c.req.query("limit") ?? "50");
		const path = c.req.query("path")?.trim();
		try {
			const commits = await getLog(cwd, { limit: Number.isFinite(limit) ? limit : 50, path });
			return c.json({ commits });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.get("/git/branches", async (c) => {
		const cwd = c.req.query("cwd")?.trim();
		if (!cwd) return c.json({ error: "cwd query param is required" }, 400);
		try {
			const branches = await getBranches(cwd);
			return c.json({ branches });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/checkout", async (c) => {
		let body: CheckoutBranchRequest;
		try {
			body = (await c.req.json()) as CheckoutBranchRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd || !body.branch) return c.json({ error: "cwd and branch are required" }, 400);
		try {
			await checkoutBranch(body.cwd, body.branch, { create: body.create });
			return c.json({ ok: true });
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/push", async (c) => {
		let body: { cwd?: string; setUpstream?: boolean; force?: boolean };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
		try {
			return c.json(await push(body.cwd, { setUpstream: body.setUpstream, force: body.force }));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/pull", async (c) => {
		let body: { cwd?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
		try {
			return c.json(await pull(body.cwd));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	app.post("/git/fetch", async (c) => {
		let body: { cwd?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.cwd) return c.json({ error: "cwd is required" }, 400);
		try {
			return c.json(await fetchRemote(body.cwd));
		} catch (err) {
			const { status, message, stderr } = handleError(err);
			return c.json({ error: message, ...(stderr ? { stderr } : {}) }, status);
		}
	});

	return app;
}
