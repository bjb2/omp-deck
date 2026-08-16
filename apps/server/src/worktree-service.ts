/**
 * Worktree manager over the bare clones owned by `repo-service.ts`.
 *
 * Worktrees attach to a bare clone via `git worktree add <path>` and live at
 * `~/omp-repos/<owner>/<repo>.worktrees/<branch>`. The branch name doubles as
 * the directory name and as the worktree's primary ref — the contract is
 * enforced by the routes, not by git itself.
 */
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { WorktreeEntry } from "@omp-deck/protocol";

import { countSessionsForWorktree } from "./worktree-session-bind.ts";
import { logger } from "./log.ts";
import { bareClonePath, getWorktreePath as repoWorktreePath } from "./repo-service.ts";

const log = logger("worktree-service");

export class WorktreeError extends Error {}
export class WorktreeNotFoundError extends WorktreeError {}
export class WorktreeAlreadyExistsError extends WorktreeError {}

const GH_BRANCH = /^[A-Za-z0-9._/-]+$/;

function assertValidBranch(branch: string): void {
	if (!GH_BRANCH.test(branch) || branch.length > 200) {
		throw new WorktreeError(`invalid branch name: ${JSON.stringify(branch)}`);
	}
}

async function runGit(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new WorktreeError(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
	}
	return stdout;
}

async function assertBareClone(cloneDir: string): Promise<void> {
	if (!existsSync(cloneDir)) {
		throw new WorktreeNotFoundError(`no bare clone at ${cloneDir}`);
	}
}

interface PorcelainWorktree {
	path: string;
	branch: string;
}

async function readPorcelainWorktrees(cloneDir: string): Promise<PorcelainWorktree[]> {
	const raw = await runGit(cloneDir, ["worktree", "list", "--porcelain"]);
	const blocks = raw.split("\n\n").filter(Boolean);
	const out: PorcelainWorktree[] = [];
	for (const block of blocks) {
		let path = "";
		let branch = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length).trim();
			} else if (line.startsWith("branch refs/heads/")) {
				branch = line.slice("branch refs/heads/".length).trim();
			}
		}
		if (path) out.push({ path, branch });
	}
	return out;
}

async function currentBranch(cloneDir: string): Promise<string | null> {
	try {
		const raw = (await runGit(cloneDir, ["symbolic-ref", "--short", "HEAD"])).trim();
		return raw || null;
	} catch {
		return null;
	}
}

async function branchExists(cloneDir: string, branch: string): Promise<boolean> {
	try {
		await runGit(cloneDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

async function buildWorktreeEntry(
	owner: string,
	repo: string,
	branch: string,
	dir: string,
	createdAt: string,
	isCurrent: boolean,
): Promise<WorktreeEntry> {
	const sessionCount = countSessionsForWorktree(owner, repo, branch);
	return {
		owner,
		repo,
		branch,
		path: dir,
		isCurrent,
		createdAt,
		sessionCount,
	};
}

export async function listWorktrees(owner: string, repo: string): Promise<WorktreeEntry[]> {
	const cloneDir = bareClonePath(owner, repo);
	await assertBareClone(cloneDir);
	const [rows, head] = await Promise.all([readPorcelainWorktrees(cloneDir), currentBranch(cloneDir)]);
	// The first entry is the bare clone itself; skip it. The contract keeps
	// worktree directories at `<repo>.worktrees/<branch>` so we filter on that.
	const managedRoot = path.join(path.dirname(cloneDir), `${repo}.worktrees`) + path.sep;
	const out: WorktreeEntry[] = [];
	for (const row of rows) {
		if (!row.path.startsWith(managedRoot)) continue;
		if (!row.branch) continue;
		let createdAt = "";
		try {
			const stat = await fs.stat(row.path);
			createdAt = stat.mtime.toISOString();
		} catch {
			// path vanished between read & stat; skip rather than 500
			continue;
		}
		out.push(
			await buildWorktreeEntry(owner, repo, row.branch, row.path, createdAt, row.branch === head),
		);
	}
	out.sort((a, b) => a.branch.localeCompare(b.branch));
	return out;
}

export async function createWorktree(opts: {
	owner: string;
	repo: string;
	branch: string;
	base?: string;
}): Promise<WorktreeEntry> {
	assertValidBranch(opts.branch);
	const cloneDir = bareClonePath(opts.owner, opts.repo);
	await assertBareClone(cloneDir);

	const targetDir = repoWorktreePath(opts.owner, opts.repo, opts.branch);
	if (existsSync(targetDir)) {
		throw new WorktreeAlreadyExistsError(`worktree already exists at ${targetDir}`);
	}

	await fs.mkdir(path.dirname(targetDir), { recursive: true });

	const exists = await branchExists(cloneDir, opts.branch);
	let args: string[];
	if (exists) {
		// Branch already exists on the bare clone — attach a worktree to it.
		args = ["worktree", "add", targetDir, opts.branch];
	} else {
		// New branch: `git worktree add <path> -b <branch> [<base>]`
		args = ["worktree", "add", targetDir, "-b", opts.branch];
		if (opts.base) args.push(opts.base);
	}

	try {
		await runGit(cloneDir, args);
	} catch (err) {
		await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
		throw err;
	}

	const head = await currentBranch(cloneDir);
	const stat = await fs.stat(targetDir);
	const entry = await buildWorktreeEntry(
		opts.owner,
		opts.repo,
		opts.branch,
		targetDir,
		stat.mtime.toISOString(),
		opts.branch === head,
	);
	log.info(`created worktree ${opts.owner}/${opts.repo}@${opts.branch} -> ${targetDir}`);
	return entry;
}

export async function deleteWorktree(owner: string, repo: string, branch: string): Promise<void> {
	assertValidBranch(branch);
	const cloneDir = bareClonePath(owner, repo);
	await assertBareClone(cloneDir);

	const targetDir = repoWorktreePath(owner, repo, branch);
	if (!existsSync(targetDir)) {
		throw new WorktreeNotFoundError(`no worktree at ${targetDir}`);
	}

	try {
		await runGit(cloneDir, ["worktree", "remove", "--force", targetDir]);
	} catch (err) {
		// Fall back to rm -rf + prune in case git's record is stale.
		log.warn(`git worktree remove failed for ${targetDir}, falling back to rm`, err);
		await fs.rm(targetDir, { recursive: true, force: true });
		try {
			await runGit(cloneDir, ["worktree", "prune"]);
		} catch {
			// ignore — the next list will surface any inconsistency
		}
	}
	log.info(`deleted worktree ${owner}/${repo}@${branch}`);
}

export function resolveWorktreeDir(owner: string, repo: string, branch: string): string {
	return repoWorktreePath(owner, repo, branch);
}
