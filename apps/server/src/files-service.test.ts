import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { GuardError, deletePath, listDir, makeDir, readFile, renamePath, writeFile } from "./files-service.ts";

let home: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-files-"));
	fs.mkdirSync(path.join(home, "project"));
	fs.writeFileSync(path.join(home, "project", "readme.md"), "# hello");
	savedEnv = { HOME: process.env.HOME, OMP_DECK_DEFAULT_CWD: process.env.OMP_DECK_DEFAULT_CWD };
	process.env.HOME = home;
	process.env.OMP_DECK_DEFAULT_CWD = home;
});

afterEach(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(home, { recursive: true, force: true });
});

test("listDir returns sorted entries, dirs first", async () => {
	fs.mkdirSync(path.join(home, "project", "zzz-dir"));
	fs.writeFileSync(path.join(home, "project", "aaa.txt"), "x");
	const result = await listDir(path.join(home, "project"));
	expect(result.entries.map((e) => e.name)).toEqual(["zzz-dir", "aaa.txt", "readme.md"]);
	expect(result.entries[0]!.kind).toBe("dir");
});

test("listDir skips node_modules and .git", async () => {
	fs.mkdirSync(path.join(home, "project", "node_modules"));
	fs.mkdirSync(path.join(home, "project", ".git"));
	const result = await listDir(path.join(home, "project"));
	expect(result.entries.map((e) => e.name)).not.toContain("node_modules");
	expect(result.entries.map((e) => e.name)).not.toContain(".git");
});

test("listDir rejects a path outside allowed roots", async () => {
	await expect(listDir("/etc")).rejects.toThrow(GuardError);
});

test("readFile round-trips text content", async () => {
	const target = path.join(home, "project", "readme.md");
	const result = await readFile(target);
	expect(result.content).toBe("# hello");
});

test("readFile rejects a directory", async () => {
	await expect(readFile(path.join(home, "project"))).rejects.toThrow(GuardError);
});

test("readFile rejects binary content", async () => {
	const target = path.join(home, "project", "blob.bin");
	fs.writeFileSync(target, Buffer.from([0, 1, 2, 3, 0, 0]));
	await expect(readFile(target)).rejects.toThrow();
});

test("writeFile creates a new file and intermediate directories", async () => {
	const target = path.join(home, "project", "nested", "new.md");
	await writeFile(target, "content");
	expect(fs.readFileSync(target, "utf8")).toBe("content");
});

test("writeFile rejects a path outside allowed roots", async () => {
	await expect(writeFile("/tmp/definitely-outside-omp-deck-test.txt", "x")).rejects.toThrow(GuardError);
});

test("makeDir creates nested directories", async () => {
	const target = path.join(home, "project", "a", "b", "c");
	await makeDir(target);
	expect(fs.statSync(target).isDirectory()).toBe(true);
});

test("renamePath moves a file within allowed roots", async () => {
	const from = path.join(home, "project", "readme.md");
	const to = path.join(home, "project", "renamed.md");
	await renamePath(from, to);
	expect(fs.existsSync(from)).toBe(false);
	expect(fs.readFileSync(to, "utf8")).toBe("# hello");
});

test("deletePath removes a file", async () => {
	const target = path.join(home, "project", "readme.md");
	await deletePath(target);
	expect(fs.existsSync(target)).toBe(false);
});

test("deletePath refuses to remove a workspace root", async () => {
	await expect(deletePath(home)).rejects.toThrow(GuardError);
});

test("deletePath without recursive fails on a non-empty directory", async () => {
	await expect(deletePath(path.join(home, "project"))).rejects.toThrow();
});

test("deletePath with recursive removes a non-empty directory", async () => {
	await deletePath(path.join(home, "project"), { recursive: true });
	expect(fs.existsSync(path.join(home, "project"))).toBe(false);
});
