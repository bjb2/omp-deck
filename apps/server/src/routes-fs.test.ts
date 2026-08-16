/**
 * Smoke test for `GET /api/fs/dialog`, the directory-picker endpoint.
 *
 * Covers:
 *   - lists subdirectories of an allowed cwd, alphabetical
 *   - filters by `q` (case-insensitive substring)
 *   - rejects an absolute cwd outside $HOME
 *   - rejects a relative cwd
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { buildFsRouter } from "./routes-fs.ts";

let home: string;
let outsideDir: string;
let savedHome: string | undefined;
let savedUserProfile: string | undefined;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-fs-dialog-home-"));
	outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-fs-dialog-outside-"));
	fs.mkdirSync(path.join(home, "alpha"), { recursive: true });
	fs.mkdirSync(path.join(home, "beta"), { recursive: true });
	fs.mkdirSync(path.join(home, "Gamma"), { recursive: true });
	fs.writeFileSync(path.join(home, "alpha", "x.txt"), "x");
	fs.writeFileSync(path.join(home, "alpha-only.txt"), "noise");
	savedHome = process.env.HOME;
	savedUserProfile = process.env.USERPROFILE;
	process.env.HOME = home;
	process.env.USERPROFILE = home;
});

afterEach(() => {
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	if (savedUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = savedUserProfile;
	fs.rmSync(home, { recursive: true, force: true });
	fs.rmSync(outsideDir, { recursive: true, force: true });
});

function url(cwd: string, q?: string): string {
	const u = new URL("http://127.0.0.1/fs/dialog");
	u.searchParams.set("cwd", cwd);
	if (q) u.searchParams.set("q", q);
	return u.toString();
}

describe("GET /fs/dialog", () => {
	test("lists subdirectories of an allowed cwd, alphabetical", async () => {
		const res = await buildFsRouter().request(url(home));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			entries: Array<{ name: string; path: string; isDir: true }>;
		};
		// Case-insensitive alphabetical sort: a < b < g.
		expect(body.entries.map((e) => e.name)).toEqual(["alpha", "beta", "Gamma"]);
		for (const e of body.entries) {
			expect(e.isDir).toBe(true);
			expect(e.path).toBe(path.join(home, e.name));
		}
	});

	test("filters by q (case-insensitive substring)", async () => {
		const res = await buildFsRouter().request(url(home, "alp"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			entries: Array<{ name: string }>;
		};
		expect(body.entries.map((e) => e.name)).toEqual(["alpha"]);
	});

	test("rejects an absolute cwd outside $HOME", async () => {
		const res = await buildFsRouter().request(url(outsideDir));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/not under an allowed root/);
	});

	test("rejects a relative cwd", async () => {
		const u = new URL("http://127.0.0.1/fs/dialog");
		u.searchParams.set("cwd", "alpha");
		const res = await buildFsRouter().request(u.toString());
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/absolute path/);
	});

	test("limits results to 200 entries", async () => {
		// Fake a deep tree: synthesize 210 sibling directories under $HOME.
		const dir = path.join(home, "deep");
		fs.mkdirSync(dir, { recursive: true });
		for (let i = 0; i < 210; i++) {
			fs.mkdirSync(path.join(dir, `d${i.toString().padStart(3, "0")}`));
		}
		const res = await buildFsRouter().request(url(dir));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			entries: Array<{ name: string }>;
		};
		expect(body.entries.length).toBe(200);
		expect(body.entries[0]?.name).toBe("d000");
		expect(body.entries[199]?.name).toBe("d199");
	});
});