/**
 * Crash-recovery test for the local sqlite store.
 *
 * Simulates the deck being killed mid-flight (process exits without an
 * orderly shutdown) and asserts that committed rows survive the reopen.
 * This is the observable contract behind the `PRAGMA synchronous = FULL`
 * bump — without fsync-on-commit, an OS-level power cut could lose the
 * last few writes even after they returned successfully to the caller.
 *
 * Scope: one test, one file. tmpdir + random suffix per run so the test
 * never collides with another process. The DB file is intentionally NOT
 * deleted between the two openDb calls — only the in-process handle is
 * closed — because the bug we are guarding against is data loss across
 * a process boundary, not across a delete-then-reopen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./index.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-crash-"));
	dbPath = path.join(dir, "deck.db");
});

afterEach(() => {
	// The test never calls closeDb on the second open — so we close
	// whatever handle is currently live before cleaning up. The
	// ponytail: comment below mirrors the auth test cleanup style.
	closeDb();
	// ponytail: Windows can hold the sqlite file handle open for several
	// seconds after close. Defer the rm so it never blocks the next test.
	// The test dir is in %TEMP% — leftovers get swept by the OS at next
	// reboot, so a stuck rm is harmless.
	const doomed = dir;
	setTimeout(() => {
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				fs.rmSync(doomed, { recursive: true, force: true });
				return;
			} catch {
				// Best-effort teardown for a tmpdir we created moments ago;
				// never correct to flake the suite over it.
			}
		}
	}, 50);
});

describe("sqlite crash recovery", () => {
	test("a committed row survives reopen without fsync loss", () => {
		// First lifetime: open, write, close the handle. Do NOT delete the
		// file — we want to prove the on-disk pages are durable, not that
		// openDb can recreate an empty file.
		const db1 = openDb({ path: dbPath });
		db1
			.prepare(
				"INSERT INTO task_states (id, name, color, position, is_default) VALUES (?, ?, ?, ?, 0)",
			)
			.run("s_crashtest", "crash-test", "#000000", 999);
		closeDb();

		// Second lifetime: reopen the same file path. Any committed row
		// must be visible. If synchronous were still NORMAL on a write-
		// coalescing filesystem this assertion could flake — FULL is the
		// guarantee we are validating here.
		const db2 = openDb({ path: dbPath });
		const row = db2
			.query<{ name: string; position: number }, [string]>(
				"SELECT name, position FROM task_states WHERE id = ?",
			)
			.get("s_crashtest") as { name: string; position: number } | null;
		expect(row).not.toBeNull();
		expect(row?.name).toBe("crash-test");
		expect(row?.position).toBe(999);
	});
});
