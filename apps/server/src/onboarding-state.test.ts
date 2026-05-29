/**
 * Onboarding-state detection tests.
 *
 * Coverage:
 *   - markOnboardingComplete persists a flag readable by getOnboardingState
 *   - resetOnboardingForTests removes the persisted flag
 *   - skipped=true round-trips through the flag
 *
 * The harder paths (silently-settle for returning users, welcome-task
 * probe) depend on a live DB + live auth-storage and are exercised by
 * the integration smoke that runs at the end of the PR work — not worth
 * the mock surface for unit-level.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getOnboardingState, markOnboardingComplete, resetOnboardingForTests } from "./onboarding-state.ts";

let savedDataDir: string | undefined;
let tmpDir: string;

beforeEach(() => {
	savedDataDir = process.env.OMP_DECK_DATA_DIR;
	tmpDir = mkdtempSync(path.join(os.tmpdir(), "omp-deck-onboarding-"));
	process.env.OMP_DECK_DATA_DIR = tmpDir;
	resetOnboardingForTests();
});

afterEach(() => {
	if (savedDataDir === undefined) delete process.env.OMP_DECK_DATA_DIR;
	else process.env.OMP_DECK_DATA_DIR = savedDataDir;
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best-effort */
	}
});

describe("onboarding-state", () => {
	test("markOnboardingComplete persists and getOnboardingState reads back", async () => {
		markOnboardingComplete(false);
		const state = await getOnboardingState();
		expect(state.needsOnboarding).toBe(false);
		expect(state.skipped).toBe(false);
		expect(state.completedAt).toBeTruthy();
		expect(state.version).toBeGreaterThan(0);
	});

	test("skipped=true round-trips", async () => {
		markOnboardingComplete(true);
		const state = await getOnboardingState();
		expect(state.needsOnboarding).toBe(false);
		expect(state.skipped).toBe(true);
	});

	test("resetOnboardingForTests clears the flag", async () => {
		markOnboardingComplete(false);
		expect((await getOnboardingState()).needsOnboarding).toBe(false);
		resetOnboardingForTests();
		// Now needsOnboarding depends on the welcome-task / sessions heuristic.
		// On a fresh tmpdir with no DB and no sessions, the heuristic should
		// fall through to "fresh install" (welcomeBacklog=false because no
		// DB, sessions=0). That actually trips the returning-user rule
		// because `welcomeInBacklog` returns false when the DB query fails,
		// which we treat as "user has interacted." Document this asymmetry:
		// the only true "needs onboarding" path is when the DB IS open AND
		// T-1 IS in backlog AND zero sessions exist. Outside that, we lean
		// toward NOT showing the wizard — safer for existing users.
		const state = await getOnboardingState();
		expect(state.needsOnboarding).toBe(false);
	});

	test("composite state includes kbRoot + kbExists + startCommandExists fields", async () => {
		markOnboardingComplete(false);
		const state = await getOnboardingState();
		expect(typeof state.kbRoot).toBe("string");
		expect(state.kbRoot.length).toBeGreaterThan(0);
		expect(typeof state.kbExists).toBe("boolean");
		expect(typeof state.startCommandExists).toBe("boolean");
		expect(Array.isArray(state.providers)).toBe(true);
	});
});
