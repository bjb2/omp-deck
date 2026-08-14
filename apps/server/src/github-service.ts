/**
 * GitHub-native backend: list the signed-in user's repos, clone one into a
 * workspace, and derive temporary auth URLs for push/pull without storing
 * the token in `.git/config`.
 *
 * Requires GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN in the environment.
 * Tokens are never persisted or logged; always redacted before output.
 */
import { $ } from "bun";

import type { GitHubBranch, GitHubCommit, GitHubPullRequest, GitHubRepoSummary, GitHubViewer } from "@omp-deck/protocol";
import { guardWorkspacePath, workspaceRoots } from "./path-guard.ts";
import { logger } from "./log.ts";

const log = logger("github-service");

export class GitHubAuthError extends Error {}
export class GitHubApiError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
	}
}
export class GuardError extends Error {}

function getToken(): string {
	const token = process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim();
	if (!token) {
		throw new GitHubAuthError(
			"No GitHub token configured. Set GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN in Settings → Env.",
		);
	}
	return token;
}

async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
	const token = getToken();
	const res = await fetch(`https://api.github.com${path}`, {
		method: opts.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "omp-deck",
			...(opts.body ? { "content-type": "application/json" } : {}),
		},
		body: opts.body ? JSON.stringify(opts.body) : undefined,
		signal: AbortSignal.timeout(20_000),
	});
	if (res.status === 401 || res.status === 403) {
		const body = await res.text();
		throw new GitHubAuthError(`GitHub rejected the token (${res.status}): ${body.slice(0, 200)}`);
	}
	if (!res.ok) {
		const body = await res.text();
		throw new GitHubApiError(`GitHub API ${path} failed (${res.status}): ${body.slice(0, 300)}`, res.status);
	}
	return (await res.json()) as T;
}

export async function getViewer(): Promise<GitHubViewer> {
	const user = await api<{ login: string; name: string | null; avatar_url: string }>("/user");
	return { login: user.login, name: user.name, avatarUrl: user.avatar_url };
}

/**
 * The repos the token's owner can push to, most-recently-pushed first —
 * "your repos" as understood by the person driving the deck, not every repo
 * they merely have read access to.
 */
export async function listRepos(opts: { perPage?: number; page?: number } = {}): Promise<GitHubRepoSummary[]> {
	const perPage = Math.min(opts.perPage ?? 50, 100);
	const page = opts.page ?? 1;
	const data = await api<
		Array<{
			id: number;
			full_name: string;
			name: string;
			owner: { login: string };
			private: boolean;
			description: string | null;
			default_branch: string;
			pushed_at: string;
			updated_at: string;
			stargazers_count: number;
			clone_url: string;
			ssh_url: string;
			fork: boolean;
			archived: boolean;
			permissions?: { push?: boolean };
		}>
	>(`/user/repos?per_page=${perPage}&page=${page}&sort=pushed&affiliation=owner,collaborator`);

	return data
		.filter((r) => r.permissions?.push !== false)
		.map((r) => ({
			id: r.id,
			fullName: r.full_name,
			name: r.name,
			owner: r.owner.login,
			private: r.private,
			description: r.description,
			defaultBranch: r.default_branch,
			pushedAt: r.pushed_at,
			updatedAt: r.updated_at,
			stargazersCount: r.stargazers_count,
			cloneUrl: r.clone_url,
			sshUrl: r.ssh_url,
			fork: r.fork,
			archived: r.archived,
		}));
}

/**
 * Build an authenticated HTTPS clone URL by embedding the token as the
 * username. This is the standard non-interactive git-over-HTTPS auth form and
 * is what lets `clone`/`pull`/`push` run without a credential helper prompt.
 * The token never touches the resulting `.git/config` remote entry unless the
 * caller explicitly re-derives the URL with it — `git remote -v` after clone
 * shows the token in the URL, same as any HTTPS-with-embedded-credential
 * setup, so this is a known and accepted tradeoff, not an oversight.
 */
function authenticatedCloneUrl(cloneUrl: string, token: string): string {
	const url = new URL(cloneUrl);
	url.username = "x-access-token";
	url.password = token;
	return url.toString();
}

export interface CloneResult {
	path: string;
	alreadyExisted: boolean;
}

/** List branches for a repository. */
export async function listBranches(owner: string, repo: string): Promise<GitHubBranch[]> {
	if (!owner || !repo) throw new Error("owner and repo are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`);
}

/** List commits for a repository on a given ref. */
export async function listCommits(owner: string, repo: string, ref: string): Promise<GitHubCommit[]> {
	if (!owner || !repo || !ref) throw new Error("owner, repo, and ref are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(ref)}`);
}

/** Create a new repository. */
export async function createRepo(name: string, isPrivate: boolean): Promise<GitHubRepoSummary> {
	if (!name) throw new Error("name is required");
	const user = await getViewer();
	return api(`/user/repos`, {
		method: "POST",
		body: { name, private: isPrivate },
	});
}

/** List pull requests for a repository. */
export async function listPullRequests(owner: string, repo: string, state: "open" | "closed" | "all" = "open"): Promise<GitHubPullRequest[]> {
	if (!owner || !repo) throw new Error("owner and repo are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${encodeURIComponent(state)}`);
}

/** Get a single pull request. */
export async function getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
	if (!owner || !repo || !Number.isFinite(number)) throw new Error("owner, repo, and number are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`);
}

/** Create a pull request. */
export async function createPullRequest(
	owner: string,
	repo: string,
	body: { title: string; head: string; base: string; body?: string },
): Promise<GitHubPullRequest> {
	if (!owner || !repo) throw new Error("owner and repo are required");
	if (!body.title || !body.head || !body.base) throw new Error("title, head, and base are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, {
		method: "POST",
		body: {
			title: body.title,
			head: body.head,
			base: body.base,
			body: body.body ?? null,
		},
	});
}

/** Merge a pull request. */
export async function mergePullRequest(owner: string, repo: string, number: number, method: "merge" | "squash" | "rebase" = "merge"): Promise<{ message: string }> {
	if (!owner || !repo || !Number.isFinite(number)) throw new Error("owner, repo, and number are required");
	return api(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/merge`, {
		method: "PUT",
		body: { merge_method: method },
	});
}

/**
 * Clone `fullName` (`owner/repo`) into the first available workspace root,
 * or update it in place if already cloned there under the same name.
 */
export async function cloneRepo(fullName: string, opts: { intoRoot?: string } = {}): Promise<CloneResult> {
	const token = getToken();
	const repo = await api<{ clone_url: string; name: string; default_branch: string }>(`/repos/${fullName}`);

	const roots = workspaceRoots();
	const targetRoot = opts.intoRoot
		? (() => {
				const guard = guardWorkspacePath(opts.intoRoot!, { mustExist: true });
				if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "intoRoot is not allowed");
				return guard.resolved;
			})()
		: roots[0];
	if (!targetRoot) throw new GuardError("no workspace root available to clone into");

	const dest = `${targetRoot}/${repo.name}`;
	const guard = guardWorkspacePath(dest, { mustExist: false });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "destination path not allowed");

	if (await Bun.file(`${guard.resolved}/.git/config`).exists()) {
		log.info(`${fullName} already cloned at ${guard.resolved}; skipping clone`);
		return { path: guard.resolved, alreadyExisted: true };
	}

	const authedUrl = authenticatedCloneUrl(repo.clone_url, token);
	const proc = Bun.spawn(["git", "clone", "--depth", "1", authedUrl, guard.resolved], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) {
		throw new GitHubApiError(`clone failed: ${redactToken(stderr, token)}`, 500);
	}
	// Strip the embedded token from the resulting remote URL immediately —
	// the clone needed it once; leaving it in .git/config means every `git
	// remote -v` or accidental `cat .git/config` leaks it afterward.
	await Bun.spawn(["git", "remote", "set-url", "origin", repo.clone_url], { cwd: guard.resolved }).exited;
	log.info(`cloned ${fullName} -> ${guard.resolved}`);
	return { path: guard.resolved, alreadyExisted: false };
}


function redactToken(text: string, token: string): string {
	return token ? text.split(token).join("***") : text;
}

/**
 * Push/pull credential helper: re-derive an authenticated remote URL for a
 * clone whose token has since been stripped (see `cloneRepo`), used only for
 * the single push/pull invocation and never persisted.
 */
export function withTokenRemote(cloneUrl: string): string {
	return authenticatedCloneUrl(cloneUrl, getToken());
}

export function hasGitHubToken(): boolean {
	return Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim());
}

/** Non-throwing token accessor for callers that want to no-op when unconfigured. */
export function tryGetToken(): string | undefined {
	return process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PERSONAL_ACCESS_TOKEN?.trim() || undefined;
}
