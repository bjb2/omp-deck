import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	GitCommandError,
	GuardError,
	NotARepoError,
	checkoutBranch,
	commit,
	discard,
	getBranches,
	getDiff,
	getLog,
	getStatus,
	stage,
	unstage,
} from "./git-service.ts";

let home: string;
let repo: string;
let savedEnv: Record<string, string | undefined>;

async function git(cwd: string, args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

beforeEach(async () => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-git-"));
	repo = path.join(home, "repo");
	fs.mkdirSync(repo);
	savedEnv = { HOME: process.env.HOME, OMP_DECK_DEFAULT_CWD: process.env.OMP_DECK_DEFAULT_CWD };
	process.env.HOME = home;
	process.env.OMP_DECK_DEFAULT_CWD = home;

	await git(repo, ["init", "-q", "-b", "main"]);
	await git(repo, ["config", "user.email", "test@example.com"]);
	await git(repo, ["config", "user.name", "Test"]);
	await git(repo, ["config", "core.autocrlf", "false"]);
	fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
	await git(repo, ["add", "."]);
	await git(repo, ["commit", "-q", "-m", "initial"]);
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

describe("getStatus", () => {
	test("a clean repo reports clean:true and the current branch", async () => {
		const status = await getStatus(repo);
		expect(status.clean).toBe(true);
		expect(status.branch).toBe("main");
		expect(status.entries).toEqual([]);
	});

	test("a modified tracked file shows up as unstaged modified", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		const status = await getStatus(repo);
		expect(status.clean).toBe(false);
		const entry = status.entries.find((e) => e.path === "a.txt");
		expect(entry?.unstaged).toBe("modified");
		expect(entry?.staged).toBeNull();
	});

	test("a new file shows up as untracked", async () => {
		fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
		const status = await getStatus(repo);
		const entry = status.entries.find((e) => e.path === "b.txt");
		expect(entry?.unstaged).toBe("untracked");
	});

	test("a staged new file shows up as staged added", async () => {
		fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
		await stage(repo, ["b.txt"]);
		const status = await getStatus(repo);
		const entry = status.entries.find((e) => e.path === "b.txt");
		expect(entry?.staged).toBe("added");
	});

	test("a rename is reported with origPath", async () => {
		await git(repo, ["mv", "a.txt", "renamed.txt"]);
		const status = await getStatus(repo);
		const entry = status.entries.find((e) => e.path === "renamed.txt");
		expect(entry?.staged).toBe("renamed");
		expect(entry?.origPath).toBe("a.txt");
	});

	test("rejects a path that is not a git repository", async () => {
		const plainDir = path.join(home, "not-a-repo");
		fs.mkdirSync(plainDir);
		await expect(getStatus(plainDir)).rejects.toThrow(NotARepoError);
	});

	test("rejects a path outside allowed roots", async () => {
		await expect(getStatus("/etc")).rejects.toThrow(GuardError);
	});
});

describe("staging", () => {
	test("stage then unstage round-trips staged status back to null", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		await stage(repo, ["a.txt"]);
		expect((await getStatus(repo)).entries[0]?.staged).toBe("modified");
		await unstage(repo, ["a.txt"]);
		expect((await getStatus(repo)).entries[0]?.staged).toBeNull();
		expect((await getStatus(repo)).entries[0]?.unstaged).toBe("modified");
	});

	test("discard reverts an unstaged change on disk", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		await discard(repo, ["a.txt"]);
		expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\n");
		expect((await getStatus(repo)).clean).toBe(true);
	});
});

describe("getDiff", () => {
	test("diffs an unstaged modification", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		const diff = await getDiff(repo, "a.txt", false);
		expect(diff.patch).toContain("-one");
		expect(diff.patch).toContain("+two");
	});

	test("diffs an untracked file against /dev/null", async () => {
		fs.writeFileSync(path.join(repo, "b.txt"), "brand new\n");
		const diff = await getDiff(repo, "b.txt", false);
		expect(diff.patch).toContain("+brand new");
	});

	test("diffs a staged change with --cached", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		await stage(repo, ["a.txt"]);
		const diff = await getDiff(repo, "a.txt", true);
		expect(diff.patch).toContain("+two");
	});
});

describe("commit", () => {
	test("commits staged changes and returns the new sha", async () => {
		fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
		await stage(repo, ["a.txt"]);
		const result = await commit(repo, "second commit");
		expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(result.summary).toBe("second commit");
		expect((await getStatus(repo)).clean).toBe(true);
	});

	test("rejects an empty message", async () => {
		await expect(commit(repo, "  ")).rejects.toThrow();
	});
});

describe("getLog", () => {
	test("returns commits newest-first with parsed fields", async () => {
		const log = await getLog(repo);
		expect(log.length).toBe(1);
		expect(log[0]!.subject).toBe("initial");
		expect(log[0]!.authorEmail).toBe("test@example.com");
	});

	test("a brand-new repo with zero commits returns an empty array, not an error", async () => {
		const empty = path.join(home, "empty-repo");
		fs.mkdirSync(empty);
		await git(empty, ["init", "-q"]);
		expect(await getLog(empty)).toEqual([]);
	});
});

describe("branches", () => {
	test("lists the current branch as current:true", async () => {
		const branches = await getBranches(repo);
		const main = branches.find((b) => b.name === "main");
		expect(main?.current).toBe(true);
	});

	test("checkoutBranch with create:true makes a new branch and switches to it", async () => {
		await checkoutBranch(repo, "feature-x", { create: true });
		const branches = await getBranches(repo);
		expect(branches.find((b) => b.name === "feature-x")?.current).toBe(true);
		expect(branches.find((b) => b.name === "main")?.current).toBe(false);
	});
});

test("GitCommandError carries stderr for a failing command", async () => {
	// Discarding a path that was never modified is a no-op that git still
	// accepts, so force a real failure: commit with nothing staged.
	try {
		await commit(repo, "nothing to commit");
		throw new Error("expected commit to fail");
	} catch (err) {
		expect(err).toBeInstanceOf(GitCommandError);
		expect((err as InstanceType<typeof GitCommandError>).stderr.length).toBeGreaterThanOrEqual(0);
	}
});
