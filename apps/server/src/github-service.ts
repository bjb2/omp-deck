/**
 * GitHub-native backend: list the signed-in user's repos, clone one into a
 * workspace root, and keep a clone in sync — so "work on my GitHub repos" is
 * pick-from-a-list rather than copy-paste a clone URL into a terminal.
 *
 * Auth is a personal access token, read from `GITHUB_TOKEN` or
 * `GITHUB_PERSONAL_ACCESS_TOKEN` (the deck's env editor already manages both;
 * the latter is what `agent-defaults/mcp.json.tmpl`'s github MCP server
 * expects, so one token configured there lights up both surfaces). No OAuth
 * app, no callback route — a token the user already has to create anyway for
 * git push authentication is also enough to drive this API.
 */
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

export interface GitHubUser {
	login: string;
	name: string | null;
	avatarUrl: string;
}

export async function getViewer(): Promise<GitHubUser> {
	const data = await api<{ login: string; name: string | null; avatar_url: string }>("/user");
	return { login: data.login, name: data.name, avatarUrl: data.avatar_url };
}

export interface GitHubRepo {
	id: number;
	fullName: string;
	name: string;
	owner: string;
	private: boolean;
	description: string | null;
	defaultBranch: string;
	pushedAt: string;
	updatedAt: string;
	stargazersCount: number;
	cloneUrl: string;
	sshUrl: string;
	fork: boolean;
	archived: boolean;
	/** Set when a matching workspace clone was found. */
	localPath?: string;
}

/**
 * The repos the token's owner can push to, most-recently-pushed first —
 * "your repos" as understood by the person driving the deck, not every repo
 * they merely have read access to.
 */
export async function listRepos(opts: { perPage?: number; page?: number } = {}): Promise<GitHubRepo[]> {
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
