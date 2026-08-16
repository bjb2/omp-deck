/**
 * Git cockpit backend: status, diffs, staging, commits, branches, and
 * remote sync — shelling out to the system `git` binary via `Bun.spawn`.
 *
 * No git library dependency on purpose. `git` itself is the single most
 * battle-tested implementation of git there is; porcelain output is parsed
 * with the flags that make it script-stable (`--porcelain=v1`, `-z` where it
 * matters) rather than reaching for a JS reimplementation that will always be
 * a step behind edge cases the real binary already handles.
 *
 * Every operation takes a `cwd` and resolves it through `guardWorkspacePath`
 * first — this module has no notion of "the current project," only "the
 * directory the caller named," which the route layer must confine.
 */
import { guardWorkspacePath } from "./path-guard.ts";
import { tryGetToken } from "./github-service.ts";
import { logger } from "./log.ts";

const log = logger("git-service");

export class GuardError extends Error {}
export class GitError extends Error {
	constructor(
		message: string,
		public readonly stderr: string,
		public readonly exitCode: number,
	) {
		super(message);
	}
}
export class NotARepoError extends Error {}

const GIT_TIMEOUT_MS = 30_000;

async function run(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdin: opts.input !== undefined ? "pipe" : "ignore",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // never hang waiting for interactive auth
	});
	if (opts.input !== undefined && proc.stdin) {
		proc.stdin.write(opts.input);
		proc.stdin.end();
	}
	const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? GIT_TIMEOUT_MS);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(timeout);
	if (exitCode !== 0) {
		throw new GitError(`git ${args[0]} failed (exit ${exitCode})`, stderr.trim(), exitCode);
	}
	return stdout;
}

function resolveRepo(cwd: string): string {
	const guard = guardWorkspacePath(cwd, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	return guard.resolved;
}

async function assertRepo(repo: string): Promise<void> {
	try {
		const out = await run(repo, ["rev-parse", "--is-inside-work-tree"]);
		if (out.trim() !== "true") throw new NotARepoError(`${repo} is not a git work tree`);
	} catch (err) {
		if (err instanceof GitError) throw new NotARepoError(`${repo} is not a git repository`);
		throw err;
	}
}

// ─── Status ─────────────────────────────────────────────────────────────────

export type FileStatus =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "copied"
	| "untracked"
	| "ignored"
	| "unmerged"
	| "typechange";

export interface StatusEntry {
	path: string;
	/** Present for renames/copies. */
	origPath?: string;
	staged: FileStatus | null;
	unstaged: FileStatus | null;
}

export interface RepoStatus {
	cwd: string;
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	detached: boolean;
	entries: StatusEntry[];
	clean: boolean;
}

const STATUS_CODE_MAP: Record<string, FileStatus> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	U: "unmerged",
	T: "typechange",
};

function decodeCode(code: string): FileStatus | null {
	if (code === " " || code === "") return null;
	if (code === "?") return "untracked";
	if (code === "!") return "ignored";
	return STATUS_CODE_MAP[code] ?? null;
}

export async function getStatus(cwd: string): Promise<RepoStatus> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);

	// `-z` NUL-terminates records and never quotes paths — the only safe way
	// to parse filenames containing spaces, newlines, or unicode.
	const raw = await run(repo, ["status", "--porcelain=v1", "-z", "--branch"]);
	const records = raw.split("\0").filter(Boolean);

	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	let detached = false;
	const entries: StatusEntry[] = [];

	for (let i = 0; i < records.length; i++) {
		const record = records[i]!;
		if (record.startsWith("##")) {
			const header = record.slice(2).trim();
			if (header.startsWith("No commits yet on ")) {
				branch = header.slice("No commits yet on ".length);
			} else if (header.startsWith("HEAD (no branch)") || header.includes("(no branch)")) {
				detached = true;
			} else {
				const m = /^([^.\s]+)(?:\.\.\.([^\s]+))?(?:\s+\[(.+)\])?/.exec(header);
				if (m) {
					branch = m[1] ?? null;
					upstream = m[2] ?? null;
					if (m[3]) {
						const aheadMatch = /ahead (\d+)/.exec(m[3]);
						const behindMatch = /behind (\d+)/.exec(m[3]);
						if (aheadMatch) ahead = Number(aheadMatch[1]);
						if (behindMatch) behind = Number(behindMatch[1]);
					}
				}
			}
			continue;
		}
		const stagedCode = record[0]!;
		const unstagedCode = record[1]!;
		const finalPath = record.slice(3);
		let origPath: string | undefined;
		// Renames/copies: porcelain -z emits "<code>  <new-path>\0<old-path>\0"
		// — the NEW path is the record's own field; the OLD path is the next
		// NUL-separated field. (Easy to get backwards — verified against real
		// `git status --porcelain=v1 -z` output, not just the docs.)
		if ((stagedCode === "R" || stagedCode === "C") && i + 1 < records.length) {
			origPath = records[++i]!;
		}
		entries.push({
			path: finalPath,
			...(origPath ? { origPath } : {}),
			staged: decodeCode(stagedCode),
			unstaged: decodeCode(unstagedCode),
		});
	}

	return { cwd: repo, branch, upstream, ahead, behind, detached, entries, clean: entries.length === 0 };
}

// ─── Diff ───────────────────────────────────────────────────────────────────

export interface DiffResult {
	path: string;
	/** Unified diff text, empty for a binary file. */
	patch: string;
	binary: boolean;
}

/**
 * Diff a single path. `staged: true` reads the index-vs-HEAD diff (what a
 * commit would contain); `staged: false` reads the working-tree-vs-index
 * diff. An untracked file has no index entry to diff against, so it is
 * rendered as an add-diff against `/dev/null` via `--no-index`.
 */
export async function getDiff(cwd: string, filePath: string, staged: boolean): Promise<DiffResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);

	const status = await getStatus(repo);
	const entry = status.entries.find((e) => e.path === filePath);
	if (entry?.unstaged === "untracked" && !staged) {
		// --no-index exits 1 on "files differ," which is the expected case here,
		// not an error — git-diff's normal 0/1 convention is inverted from every
		// other porcelain command this module calls.
		const patch = await runAllowingExit1(repo, ["diff", "--no-index", "--", "/dev/null", filePath]);
		return { path: filePath, patch, binary: patch.includes("Binary files") };
	}

	const args = staged ? ["diff", "--cached", "--", filePath] : ["diff", "--", filePath];
	const patch = await run(repo, args);
	return { path: filePath, patch, binary: patch.includes("Binary files") };
}

async function runAllowingExit1(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0 && exitCode !== 1) throw new GitError(`git ${args[0]} failed`, stderr.trim(), exitCode);
	return stdout;
}

// ─── Staging ────────────────────────────────────────────────────────────────

export async function stage(cwd: string, paths: string[]): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	if (paths.length === 0) return;
	await run(repo, ["add", "--", ...paths]);
}

export async function unstage(cwd: string, paths: string[]): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	if (paths.length === 0) return;
	await run(repo, ["restore", "--staged", "--", ...paths]);
}

/** Discard unstaged changes to the given paths. Destructive — the route must confirm intent. */
export async function discard(cwd: string, paths: string[]): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	if (paths.length === 0) return;
	await run(repo, ["checkout", "--", ...paths]);
}

// ─── Commit ─────────────────────────────────────────────────────────────────

export interface CommitResult {
	sha: string;
	summary: string;
}

export async function commit(cwd: string, message: string, opts: { amend?: boolean } = {}): Promise<CommitResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	if (!message.trim()) throw new GitError("commit message is required", "", 1);
	const args = ["commit", "-m", message];
	if (opts.amend) args.push("--amend");
	await run(repo, args);
	const sha = (await run(repo, ["rev-parse", "HEAD"])).trim();
	const summary = (await run(repo, ["log", "-1", "--format=%s"])).trim();
	return { sha, summary };
}

// ─── Log ────────────────────────────────────────────────────────────────────

export interface CommitLogEntry {
	sha: string;
	shortSha: string;
	author: string;
	authorEmail: string;
	date: string;
	subject: string;
}

const LOG_FORMAT = "%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%s\x1e";

export async function getLog(cwd: string, opts: { limit?: number; path?: string } = {}): Promise<CommitLogEntry[]> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const args = ["log", `--format=${LOG_FORMAT}`, `-n`, String(opts.limit ?? 50)];
	if (opts.path) args.push("--", opts.path);
	let raw: string;
	try {
		raw = await run(repo, args);
	} catch (err) {
		// A brand-new repo with zero commits fails `git log` with a specific
		// message rather than returning empty — treat that as "no history".
		if (err instanceof GitError && /does not have any commits yet/i.test(err.stderr)) return [];
		throw err;
	}
	return raw
		.split("\x1e")
		.map((r) => r.trim())
		.filter(Boolean)
		.map((record) => {
			const [sha, shortSha, author, authorEmail, date, subject] = record.split("\x1f");
			return { sha: sha!, shortSha: shortSha!, author: author!, authorEmail: authorEmail!, date: date!, subject: subject ?? "" };
		});
}

// ─── Branches ───────────────────────────────────────────────────────────────

export interface BranchInfo {
	name: string;
	current: boolean;
	remote: boolean;
	upstream: string | null;
}

export async function getBranches(cwd: string): Promise<BranchInfo[]> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const raw = await run(repo, [
		"for-each-ref",
		"--format=%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(objecttype)",
		"refs/heads",
		"refs/remotes",
	]);
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [name, head, upstream] = line.split("\x1f");
			return {
				name: name!,
				current: head === "*",
				remote: name!.includes("/") && !name!.startsWith("HEAD"),
				upstream: upstream || null,
			};
		})
		.filter((b) => b.name !== "" && !b.name.endsWith("/HEAD"));
}

export async function checkoutBranch(cwd: string, branch: string, opts: { create?: boolean } = {}): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const args = opts.create ? ["checkout", "-b", branch] : ["checkout", branch];
	await run(repo, args);
}

// ─── Worktrees ──────────────────────────────────────────────────────────────

export async function createWorktree(cwd: string, branchName: string, worktreePath: string): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	await run(repo, ["worktree", "add", "-b", branchName, worktreePath]);
}

export async function removeWorktree(cwd: string, worktreePath: string, opts: { force?: boolean } = {}): Promise<void> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const args = opts.force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath];
	await run(repo, args);
}

export interface WorktreeInfo {
	path: string;
	branch: string;
	head: string;
}

export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const raw = await run(repo, ["worktree", "list", "--porcelain"]);
	const blocks = raw.split("\n\n").filter(Boolean);
	const worktrees: WorktreeInfo[] = [];
	for (const block of blocks) {
		let path = "";
		let head = "";
		let branch = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) {
				path = line.slice("worktree ".length).trim();
			} else if (line.startsWith("HEAD ")) {
				head = line.slice("HEAD ".length).trim();
			} else if (line.startsWith("branch refs/heads/")) {
				branch = line.slice("branch refs/heads/".length).trim();
			}
		}
		if (path) {
			worktrees.push({ path, branch, head });
		}
	}
	return worktrees;
}

export async function mergeBranch(
	cwd: string,
	branchName: string,
	opts: { noFf?: boolean } = {},
): Promise<CommitResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const args = opts.noFf ? ["merge", "--no-ff", branchName] : ["merge", branchName];
	await run(repo, args);
	const sha = (await run(repo, ["rev-parse", "HEAD"])).trim();
	const summary = (await run(repo, ["log", "-1", "--format=%s"])).trim();
	return { sha, summary };
}

// ─── Remote sync ────────────────────────────────────────────────────────────

export interface SyncResult {
	ok: true;
	summary: string;
}

/**
 * `push`/`pull`/`fetch` inherit the process environment, so an
 * `askpass`-free credential helper (SSH agent, `git credential` cache) is
 * normally what makes these succeed non-interactively. For an `origin` that
 * points at `github.com` over HTTPS, a configured GitHub token is injected as
 * a single-invocation `-c http.extraheader` — never written to `.git/config`
 * — so cloning a repo through the deck's own GitHub integration is enough to
 * push and pull without the user separately wiring up git credentials.
 * `GIT_TERMINAL_PROMPT=0` in `run()` guarantees a missing credential fails
 * fast with a clear error instead of hanging.
 */
async function githubAuthArgs(repo: string): Promise<string[]> {
	const token = tryGetToken();
	if (!token) return [];
	let remoteUrl: string;
	try {
		remoteUrl = (await run(repo, ["remote", "get-url", "origin"])).trim();
	} catch {
		return []; // no origin configured — nothing to authenticate
	}
	if (!/^https:\/\/(www\.)?github\.com\//i.test(remoteUrl)) return [];
	const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
	return ["-c", `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
}

export async function push(cwd: string, opts: { setUpstream?: boolean; force?: boolean } = {}): Promise<SyncResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const auth = await githubAuthArgs(repo);
	const args = [...auth, "push"];
	if (opts.setUpstream) {
		const status = await getStatus(repo);
		if (!status.branch) throw new GitError("cannot push: not on a branch", "", 1);
		args.push("--set-upstream", "origin", status.branch);
	}
	if (opts.force) args.push("--force-with-lease");
	const out = await run(repo, args, { timeoutMs: 60_000 });
	return { ok: true, summary: out.trim() || "pushed" };
}

export async function pull(cwd: string): Promise<SyncResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const auth = await githubAuthArgs(repo);
	const out = await run(repo, [...auth, "pull", "--ff-only"], { timeoutMs: 60_000 });
	return { ok: true, summary: out.trim() || "up to date" };
}

export async function fetchRemote(cwd: string): Promise<SyncResult> {
	const repo = resolveRepo(cwd);
	await assertRepo(repo);
	const auth = await githubAuthArgs(repo);
	const out = await run(repo, [...auth, "fetch", "--prune"], { timeoutMs: 60_000 });
	return { ok: true, summary: out.trim() || "fetched" };
}

export { GitError as GitCommandError };
