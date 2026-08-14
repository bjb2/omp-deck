/**
 * GitHub-native REST surface: "your repos, one click to work on them."
 */
import { Hono } from "hono";

import {
	GitHubApiError,
	GitHubAuthError,
	GuardError,
	listBranches,
	listCommits,
	createRepo,
	createPullRequest,
	listPullRequests,
	getPullRequest,
	mergePullRequest,
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

/**
 * GitHub owner / repo / branch / username segment validator. GitHub's rules
 * for these names allow `[A-Za-z0-9]`, `.`, `_`, and `-`; nothing else.
 * We reject anything else at the route boundary so a stray `/`, `\`, `..`,
 * `:`, whitespace, or URL-encoded junk never reaches `api()` and either
 * breaks Hono routing or shows up upstream as a confusing 4xx.
 */
const GH_NAME = /^[A-Za-z0-9._-]+$/;
const GH_NAME_MAX = 100;

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
		const [owner, repo] = body.fullName.split("/", 2);
		if (!owner || !repo || owner === "." || owner === ".." || repo === "." || repo === ".." || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo)) {
			return c.json({ error: "invalid owner/repo in fullName" }, 400);
		}
		try {
			return c.json(await cloneRepo(body.fullName, { intoRoot: body.intoRoot }));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/github/branches", async (c) => {
		const owner = c.req.query("owner");
		const repo = c.req.query("repo");
		if (!owner || !repo || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo)) {
			return c.json({ error: "owner and repo are required and must be valid GitHub names" }, 400);
		}
		try {
			return c.json(await listBranches(owner, repo));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/github/commits", async (c) => {
		const owner = c.req.query("owner");
		const repo = c.req.query("repo");
		const ref = c.req.query("ref");
		if (!owner || !repo || !ref || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || ref.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo) || !GH_NAME.test(ref)) {
			return c.json({ error: "owner, repo, and ref are required and must be valid GitHub names" }, 400);
		}
		try {
			return c.json(await listCommits(owner, repo, ref));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/github/repos", async (c) => {
		let body: { name?: string; private?: boolean };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.name || body.name.length > GH_NAME_MAX || body.name === "." || body.name === ".." || !GH_NAME.test(body.name)) {
			return c.json({ error: `invalid name: must match [A-Za-z0-9._-]+ (got ${JSON.stringify(body.name)})` }, 400);
		}
		try {
			return c.json(await createRepo(body.name, body.private ?? false));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/github/pulls", async (c) => {
		const owner = c.req.query("owner");
		const repo = c.req.query("repo");
		const state = (c.req.query("state") ?? "open") as "open" | "closed" | "all";
		if (!owner || !repo || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo)) {
			return c.json({ error: "owner and repo are required and must be valid GitHub names" }, 400);
		}
		if (state !== "open" && state !== "closed" && state !== "all") {
			return c.json({ error: `invalid state: must be open, closed, or all (got ${JSON.stringify(state)})` }, 400);
		}
		try {
			return c.json(await listPullRequests(owner, repo, state));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/github/pulls/:owner/:repo/:number", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const rawNumber = c.req.param("number");
		const number = Number(rawNumber);
		if (!owner || !repo || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo)) {
			return c.json({ error: "owner and repo path segments must be valid GitHub names" }, 400);
		}
		if (!Number.isInteger(number) || number <= 0) {
			return c.json({ error: `number must be a positive integer (got ${JSON.stringify(rawNumber)})` }, 400);
		}
		try {
			return c.json(await getPullRequest(owner, repo, number));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/github/pulls", async (c) => {
		let body: { owner?: string; repo?: string; title?: string; head?: string; base?: string; body?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.owner || !body.repo || body.owner.length > GH_NAME_MAX || body.repo.length > GH_NAME_MAX || !GH_NAME.test(body.owner) || !GH_NAME.test(body.repo)) {
			return c.json({ error: `invalid owner/repo: must match [A-Za-z0-9._-]+ (got ${JSON.stringify(body.owner ?? body.repo)})` }, 400);
		}
		if (!body.title || !body.head || !body.base) return c.json({ error: "title, head, and base are required" }, 400);
		try {
			return c.json(await createPullRequest(body.owner, body.repo, {
				title: body.title,
				head: body.head,
				base: body.base,
				body: body.body,
			}));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.put("/github/pulls/:owner/:repo/:number/merge", async (c) => {
		const owner = c.req.param("owner");
		const repo = c.req.param("repo");
		const rawNumber = c.req.param("number");
		const number = Number(rawNumber);
		if (!owner || !repo || owner.length > GH_NAME_MAX || repo.length > GH_NAME_MAX || !GH_NAME.test(owner) || !GH_NAME.test(repo)) {
			return c.json({ error: "owner and repo path segments must be valid GitHub names" }, 400);
		}
		if (!Number.isInteger(number) || number <= 0) {
			return c.json({ error: `number must be a positive integer (got ${JSON.stringify(rawNumber)})` }, 400);
		}
		let body: { method?: "merge" | "squash" | "rebase" } = {};
		try {
			body = await c.req.json();
		} catch {
			body = {};
		}
		const method = body.method ?? "merge";
		if (method !== "merge" && method !== "squash" && method !== "rebase") {
			return c.json({ error: `invalid method: must be merge, squash, or rebase (got ${JSON.stringify(method)})` }, 400);
		}
		try {
			return c.json(await mergePullRequest(owner, repo, number, method));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	return app;
}
