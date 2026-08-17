import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { guardAgentDirPath, guardWorkspacePath } from "./path-guard.ts";

let home: string;
let outsideDir: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-guard-home-"));
	outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-guard-outside-"));
	fs.mkdirSync(path.join(home, "project", "src"), { recursive: true });
	fs.writeFileSync(path.join(home, "project", "src", "index.ts"), "1");

	savedEnv = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		OMP_DECK_DEFAULT_CWD: process.env.OMP_DECK_DEFAULT_CWD,
		OMP_DECK_WORKSPACES: process.env.OMP_DECK_WORKSPACES,
		OMP_AGENT_DIR: process.env.OMP_AGENT_DIR,
	};
	process.env.HOME = home;
	process.env.OMP_DECK_DEFAULT_CWD = home;
	delete process.env.OMP_DECK_WORKSPACES;
	delete process.env.OMP_AGENT_DIR;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe("guardWorkspacePath", () => {
	test("allows a path under home", () => {
		const result = guardWorkspacePath(path.join(home, "project", "src", "index.ts"), { mustExist: true });
		expect(result.ok).toBe(true);
	});

	test("allows home itself", () => {
		expect(guardWorkspacePath(home, { mustExist: true }).ok).toBe(true);
	});

	test("rejects a path outside every root", () => {
		const result = guardWorkspacePath(path.join(outsideDir, "secret.txt"), { mustExist: false });
		expect(result.ok).toBe(false);
	});

	test("rejects a relative path", () => {
		expect(guardWorkspacePath("project/src/index.ts").ok).toBe(false);
	});

	test("rejects a literal .. escape", () => {
		const result = guardWorkspacePath(path.join(home, "project", "..", "..", "etc", "passwd"));
		expect(result.ok).toBe(false);
	});

	test("rejects a symlink that escapes an allowed root", () => {
		// fs.symlinkSync("dir") needs elevated privileges on Windows; skip
		// rather than fail. The non-symlink rejection paths above already
		// exercise the same escape logic.
		if (process.platform === "win32") return;
		const linkPath = path.join(home, "escape-link");
		fs.symlinkSync(outsideDir, linkPath, "dir");
		const result = guardWorkspacePath(path.join(linkPath, "whatever.txt"), { mustExist: false });
		expect(result.ok).toBe(false);
	});

	test("mustExist:true rejects a path that doesn't exist yet", () => {
		const result = guardWorkspacePath(path.join(home, "project", "new-file.ts"), { mustExist: true });
		expect(result.ok).toBe(false);
	});

	test("mustExist:false allows a not-yet-created path under an allowed root", () => {
		const result = guardWorkspacePath(path.join(home, "project", "new-file.ts"), { mustExist: false });
		expect(result.ok).toBe(true);
	});

	test("extra workspace roots via OMP_DECK_WORKSPACES are honored", () => {
		const extra = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-guard-extra-"));
		try {
			process.env.OMP_DECK_WORKSPACES = extra;
			const result = guardWorkspacePath(path.join(extra, "readme.md"), { mustExist: false });
			expect(result.ok).toBe(true);
		} finally {
			fs.rmSync(extra, { recursive: true, force: true });
		}
	});
});

describe("guardAgentDirPath", () => {
	test("fails closed when OMP_AGENT_DIR is unset", () => {
		expect(guardAgentDirPath("/anything").ok).toBe(false);
	});

	test("confines strictly to OMP_AGENT_DIR, separate from workspace roots", () => {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-guard-agent-"));
		try {
			process.env.OMP_AGENT_DIR = agentDir;
			fs.writeFileSync(path.join(agentDir, "config.yml"), "x");
			expect(guardAgentDirPath(path.join(agentDir, "config.yml"), { mustExist: true }).ok).toBe(true);
			// A workspace path is NOT automatically an agent-dir path.
			expect(guardAgentDirPath(path.join(home, "project"), { mustExist: true }).ok).toBe(false);
		} finally {
			fs.rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
