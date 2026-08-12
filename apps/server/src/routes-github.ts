/**
 * GitHub-native REST surface: "your repos, one click to work on them."
 */
import { Hono } from "hono";

import {
	GitHubApiError,
	GitHubAuthError,
	GuardError,
	cloneRepo,
	getViewer,
	hasGitHubToken,
	listRepos,
} from "./github-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-github");

function handleError(err: unknown): { status: 400 | 401 | 403 | 500; message: string } {
	if (err instanceof GitHubAuthError) return { status: 401, message: err.message };
	if (err instanceof GuardError) return { status: 403, message: err.message };
	if (err instanceof GitHubApiError) return { status: 400, message: err.message };
	log.error("unexpected error", err);
	return { status: 500, message: "internal error" };
}

export function buildGitHubRouter(): Hono {
	const app = new Hono();

	app.get("/github/status", (c) => c.json({ configured: hasGitHubToken() }));

	app.get("/github/viewer", async (c) => {
		try {
			return c.json(await getViewer());
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/github/repos", async (c) => {
		const perPage = Number(c.req.query("perPage") ?? "50");
		const page = Number(c.req.query("page") ?? "1");
		try {
			const repos = await listRepos({
				perPage: Number.isFinite(perPage) ? perPage : 50,
				page: Number.isFinite(page) ? page : 1,
			});
			return c.json({ repos });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/github/clone", async (c) => {
		let body: { fullName?: string; intoRoot?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.fullName?.includes("/")) return c.json({ error: "fullName must be 'owner/repo'" }, 400);
		try {
			return c.json(await cloneRepo(body.fullName, { intoRoot: body.intoRoot }));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	return app;
}
