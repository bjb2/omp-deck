/**
 * Managed repo CRUD. Mirrors `git-service.ts` patterns: child_process via
 * `Bun.spawn`, errors carry stderr, timeouts are bounded, no interactive
 * auth (`GIT_TERMINAL_PROMPT=0`). All managed repos live under
 * `~/omp-repos/<owner>/<repo>.git` (bare clone) with worktrees under the
 * matching `<repo>.worktrees/` directory.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { RepoEntry } from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("repo-service");

const GIT_TIMEOUT_MS = 120_000;

export class RepoError extends Error {}
export class RepoAlreadyExistsError extends RepoError {}
export class RepoNotFoundError extends RepoError {}

const GH_NAME = /^[A-Za-z0-9._-]+$/;

function reposRoot(): string {
	return path.join(os.homedir(), "omp-repos");
}

function bareClonePath(owner: string, repo: string): string {
	return path.join(reposRoot(), owner, `${repo}.git`);
}
export { bareClonePath };

/**
 * Create a default worktree for `<owner>/<repo>` if one doesn't exist.
 * The bare clone isn't directly usable for edits — users want a checkout.
 * Returns the path to the worktree on success. Errors are non-fatal: the
 * caller can still register the bare clone path itself as a workspace.
 */
async function ensureDefaultWorktree(owner: string, repo: string, branch: string): Promise<string | null> {
	const wtDir = worktreePath(owner, repo, branch);
	try {
		await fs.mkdir(path.dirname(wtDir), { recursive: true });
	} catch {
		return null;
	}
	if (existsSync(wtDir)) return wtDir;
	try {
		await run(["worktree", "add", wtDir, branch], {
			cwd: bareClonePath(owner, repo),
			timeoutMs: GIT_TIMEOUT_MS,
		});
		log.info(`created default worktree ${wtDir}`);
		return wtDir;
	} catch (err) {
		log.warn(`ensureDefaultWorktree failed for ${owner}/${repo}@${branch}`, err);
		return null;
	}
}

export { ensureDefaultWorktree };

function worktreesRoot(owner: string, repo: string): string {
	return path.join(reposRoot(), owner, `${repo}.worktrees`);
}

function worktreePath(owner: string, repo: string, branch: string): string {
	return path.join(worktreesRoot(owner, repo), branch);
}

function assertValidName(field: string, value: string): void {
	if (!GH_NAME.test(value) || value.length > 100) {
		throw new RepoError(`invalid ${field}: ${JSON.stringify(value)}`);
	}
}

async function run(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd: opts.cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? GIT_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timeout);
	if (exitCode !== 0) {
		throw new RepoError(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return stdout;
}

async function listLocalBranches(cloneDir: string): Promise<string[]> {
	try {
		const raw = await run(["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
			cwd: cloneDir,
		});
		return raw
			.split("\n")
			.map((b) => b.trim())
			.filter(Boolean);
	} catch (err) {
		log.warn(`listLocalBranches(${cloneDir}) failed`, err);
		return [];
	}
}

async function detectDefaultBranch(cloneDir: string): Promise<string> {
	try {
		const raw = (await run(["symbolic-ref", "--short", "HEAD"], { cwd: cloneDir })).trim();
		if (raw) return raw;
	} catch {
		// fall through
	}
	try {
		const raw = (await run(["config", "init.defaultBranch"], { cwd: cloneDir })).trim();
		if (raw) return raw;
	} catch {
		// fall through
	}
	return "main";
}

async function listWorktreeDirs(owner: string, repo: string): Promise<string[]> {
	const root = worktreesRoot(owner, repo);
	try {
		const entries = await fs.readdir(root, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch {
		return [];
	}
}

async function buildRepoEntry(cloneDir: string, owner: string, repo: string): Promise<RepoEntry> {
	const [defaultBranch, branches] = await Promise.all([
		detectDefaultBranch(cloneDir),
		listLocalBranches(cloneDir),
	]);
	const wtDirs = await listWorktreeDirs(owner, repo);
	const worktrees = wtDirs.map((branch) => ({
		owner,
		repo,
		branch,
		path: worktreePath(owner, repo, branch),
		isCurrent: branch === defaultBranch,
		createdAt: "",
	}));
	const stat = await fs.stat(cloneDir);
	return {
		owner,
		repo,
		cloneUrl: `https://github.com/${owner}/${repo}.git`,
		clonePath: cloneDir,
		defaultBranch,
		branches: branches.slice(0, 50),
		worktrees,
		lastClonedAt: stat.mtime.toISOString(),
	};
}

/**
 * Clone `<owner>/<repo>` as a bare repo under `~/omp-repos/<owner>/<repo>.git`.
 * `token` overrides the global GitHub token for this one clone (private repos).
 * Throws `RepoAlreadyExistsError` if a clone is already present; callers should
 * surface 409. Other git errors surface as `RepoError`.
 */
export async function cloneRepo(opts: {
	owner: string;
	repo: string;
	token?: string;
}): Promise<RepoEntry> {
	assertValidName("owner", opts.owner);
	assertValidName("repo", opts.repo);

	const cloneDir = bareClonePath(opts.owner, opts.repo);
	if (existsSync(cloneDir)) {
		throw new RepoAlreadyExistsError(`repo already cloned at ${cloneDir}`);
	}

	await fs.mkdir(path.dirname(cloneDir), { recursive: true });

	const baseUrl = `https://github.com/${opts.owner}/${opts.repo}.git`;
	const url = opts.token
		? `https://x-access-token:${opts.token}@github.com/${opts.owner}/${opts.repo}.git`
		: baseUrl;

	try {
		await run(["clone", "--bare", url, cloneDir], { timeoutMs: GIT_TIMEOUT_MS });
	} catch (err) {
		// Best-effort cleanup: remove the partial directory if clone bailed.
		await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
		throw err;
	}

	log.info(`cloned ${opts.owner}/${opts.repo} -> ${cloneDir}`);
	return await buildRepoEntry(cloneDir, opts.owner, opts.repo);
}

export async function getRepo(owner: string, repo: string): Promise<RepoEntry | null> {
	assertValidName("owner", owner);
	assertValidName("repo", repo);
	const cloneDir = bareClonePath(owner, repo);
	if (!existsSync(cloneDir)) return null;
	return await buildRepoEntry(cloneDir, owner, repo);
}

export async function listRepos(): Promise<RepoEntry[]> {
	const root = reposRoot();
	if (!existsSync(root)) return [];
	const out: RepoEntry[] = [];
	const ownerEntries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
	for (const ownerEntry of ownerEntries) {
		if (!ownerEntry.isDirectory()) continue;
		const owner = ownerEntry.name;
		if (!GH_NAME.test(owner)) continue;
		const entries = await fs.readdir(path.join(root, owner), { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const m = /^(.+)\.git$/.exec(entry.name);
			if (!m) continue;
			const repo = m[1]!;
			if (!GH_NAME.test(repo)) continue;
			const cloneDir = path.join(root, owner, entry.name);
			try {
				out.push(await buildRepoEntry(cloneDir, owner, repo));
			} catch (err) {
				log.warn(`listRepos: failed to read ${cloneDir}`, err);
			}
		}
	}
	out.sort((a, b) => b.lastClonedAt.localeCompare(a.lastClonedAt));
	return out;
}

export async function deleteRepo(owner: string, repo: string): Promise<void> {
	assertValidName("owner", owner);
	assertValidName("repo", repo);
	const cloneDir = bareClonePath(owner, repo);
	if (!existsSync(cloneDir)) {
		throw new RepoNotFoundError(`no repo at ${cloneDir}`);
	}
	// Removing the bare clone auto-removes its worktree records. We then
	// wipe the matching `<repo>.worktrees/` directory for any stragglers.
	await fs.rm(cloneDir, { recursive: true, force: true });
	await fs.rm(worktreesRoot(owner, repo), { recursive: true, force: true }).catch(() => undefined);
	log.info(`deleted repo ${owner}/${repo}`);
}

export function getWorktreePath(owner: string, repo: string, branch: string): string {
	return worktreePath(owner, repo, branch);
}
