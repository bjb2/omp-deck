/**
 * Onboarding state — detects whether a brand-new user should see the
 * first-run wizard, and persists the "they're done" flag so it never
 * re-triggers.
 *
 * Three signals feed the decision:
 *
 *   1. `<dataDir>/onboarding.json` — explicit completion flag. Once
 *      written, onboarding is settled regardless of everything else.
 *   2. The welcome task (T-1, seeded on first DB boot). If a user
 *      moved it to `done` or `archived`, they're a returning user.
 *   3. Persisted sessions on disk. Any non-zero count means they've
 *      used the deck before.
 *
 * The combination matters for the returning-user case: existing
 * installs predate this module, so the flag won't exist. We must NOT
 * dump existing users into the wizard. The rule is:
 *
 *   - flag exists                            → settled (never show)
 *   - flag missing + welcome done            → silently mark settled
 *   - flag missing + any session             → silently mark settled
 *   - flag missing + welcome backlog + no    → show wizard
 *     sessions
 *
 * "Silently mark settled" writes the flag so the detection only runs
 * once per install. The flag carries a `version` so future versions of
 * the wizard can re-trigger when there are new must-show steps.
 *
 * Composite read also enumerates whether the user has any provider
 * credentials, a kb root that exists, and a `/start` command — the
 * wizard uses these to tick each step's "already done" state, so a
 * user who set things up out-of-band doesn't have to redo them.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { OnboardingState, OnboardingStateProvider } from "@omp-deck/protocol";

import { getDeckAuthStorage } from "./auth-singleton.ts";
import { getDataDir } from "./env-store.ts";
import { resolveKbRoot } from "./kb-service.ts";
import { logger } from "./log.ts";
import { readStartCommand } from "./orientation-store.ts";
import { getDb } from "./db/index.ts";

const log = logger("onboarding");

const ONBOARDING_FILE = "onboarding.json";
const CURRENT_VERSION = 1;

interface OnboardingFlagFile {
	version: number;
	completedAt: string;
	skipped?: boolean;
}

function getFlagPath(): string {
	return path.join(getDataDir(), ONBOARDING_FILE);
}

/** Read the persisted flag, or undefined if not yet set. */
function readFlag(): OnboardingFlagFile | undefined {
	const p = getFlagPath();
	if (!existsSync(p)) return undefined;
	try {
		const raw = readFileSync(p, "utf8");
		const parsed = JSON.parse(raw) as OnboardingFlagFile;
		if (typeof parsed.version !== "number" || typeof parsed.completedAt !== "string") {
			log.warn(`onboarding flag at ${p} is malformed; treating as unset`);
			return undefined;
		}
		return parsed;
	} catch (err) {
		log.warn(`onboarding flag read failed (${p})`, err);
		return undefined;
	}
}

/** Persist the flag. Idempotent. */
function writeFlag(flag: OnboardingFlagFile): void {
	const p = getFlagPath();
	mkdirSync(path.dirname(p), { recursive: true });
	writeFileSync(p, `${JSON.stringify(flag, null, "\t")}\n`, "utf8");
}

/**
 * Returns true when the seed welcome task (T-1) exists AND is sitting
 * in `s_backlog`. Anything else (moved, done, archived, or absent
 * entirely) is treated as "user has interacted with the kanban."
 */
function welcomeTaskIsInBacklog(): boolean {
	try {
		const row = getDb()
			.query<{ state_id: string; archived_at: string | null }, [number]>(
				"SELECT state_id, archived_at FROM tasks WHERE display_id = ? LIMIT 1",
			)
			.get(1) as { state_id: string; archived_at: string | null } | null;
		if (!row) return false; // No T-1 at all = not a fresh install (or older than the seed feature)
		if (row.archived_at) return false;
		return row.state_id === "s_backlog";
	} catch (err) {
		log.warn("welcome-task probe failed", err);
		return false;
	}
}

/**
 * Persisted-session count — "has the user ever opened a chat on this
 * machine." Counts session JSONL files on disk.
 */
async function persistedSessionCount(): Promise<number> {
	try {
		const sessionsDir = path.join(
			process.env.OMP_AGENT_DIR?.trim() || path.join(os.homedir(), ".omp", "agent"),
			"sessions",
		);
		if (!existsSync(sessionsDir)) return 0;
		let count = 0;
		for (const entry of readdirSync(sessionsDir)) {
			try {
				const stat = statSync(path.join(sessionsDir, entry));
				if (stat.isFile() && entry.endsWith(".jsonl")) count += 1;
			} catch {
				// ignore stat failure on individual entries
			}
		}
		return count;
	} catch (err) {
		log.warn("session-count probe failed", err);
		return 0;
	}
}



/**
 * Inspect provider credentials. Returns the deck-relevant subset that
 * the wizard's "Connect provider" step needs to render tick marks.
 */
async function readProviders(): Promise<OnboardingStateProvider[]> {
	try {
		const auth = await getDeckAuthStorage();
		const all = auth.getAll() as Record<string, unknown>;
		const providers: OnboardingStateProvider[] = [];
		for (const [id, entry] of Object.entries(all)) {
			if (!entry) continue;
			const arr = Array.isArray(entry) ? entry : [entry];
			if (arr.length === 0) continue;
			const first = arr[0] as { type?: string } | undefined;
			const kind = first?.type === "oauth" ? "oauth" : "api-key";
			providers.push({ id, kind });
		}
		return providers;
	} catch (err) {
		log.warn("provider probe failed", err);
		return [];
	}
}

/**
 * Compose the full state object the wizard consumes on mount and after
 * each step. Also applies the silent-settle rule for returning users:
 * if there's no flag but the user has clearly used the deck before, we
 * write the flag here so subsequent reads short-circuit.
 */
export async function getOnboardingState(): Promise<OnboardingState> {
	const existingFlag = readFlag();
	if (existingFlag) {
		return {
			needsOnboarding: false,
			completedAt: existingFlag.completedAt,
			skipped: existingFlag.skipped ?? false,
			version: existingFlag.version,
			providers: await readProviders(),
			kbRoot: resolveKbRoot(),
			kbExists: existsSync(resolveKbRoot()),
			startCommandExists: readStartCommand().exists,
		};
	}

	// No flag — apply the returning-user heuristic.
	const sessions = await persistedSessionCount();
	const welcomeBacklog = welcomeTaskIsInBacklog();
	const returningUser = sessions > 0 || !welcomeBacklog;

	if (returningUser) {
		const flag: OnboardingFlagFile = {
			version: CURRENT_VERSION,
			completedAt: new Date().toISOString(),
			skipped: false,
		};
		writeFlag(flag);
		log.info(
			`onboarding silently settled for returning user (sessions=${sessions}, welcomeInBacklog=${welcomeBacklog})`,
		);
		return {
			needsOnboarding: false,
			completedAt: flag.completedAt,
			skipped: false,
			version: flag.version,
			providers: await readProviders(),
			kbRoot: resolveKbRoot(),
			kbExists: existsSync(resolveKbRoot()),
			startCommandExists: readStartCommand().exists,
		};
	}

	// Genuine first-run.
	return {
		needsOnboarding: true,
		completedAt: null,
		skipped: false,
		version: CURRENT_VERSION,
		providers: await readProviders(),
		kbRoot: resolveKbRoot(),
		kbExists: existsSync(resolveKbRoot()),
		startCommandExists: readStartCommand().exists,
	};
}

/**
 * Mark onboarding complete. `skipped` distinguishes "user walked
 * through and finished" from "user clicked Skip" — surfaced in the
 * state so the web layer can render the one-time "you can re-run
 * onboarding from Settings" toast for the skip case.
 */
export function markOnboardingComplete(skipped: boolean): void {
	writeFlag({
		version: CURRENT_VERSION,
		completedAt: new Date().toISOString(),
		skipped,
	});
	log.info(`onboarding marked complete (skipped=${skipped})`);
}

/** Test-only: nuke the flag so a test can simulate a fresh user. */
export function resetOnboardingForTests(): void {
	const p = getFlagPath();
	if (existsSync(p)) {
		unlinkSync(p);
	}
}
