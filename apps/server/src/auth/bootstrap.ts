/**
 * Boot-time authentication setup.
 *
 * Runs once, after the database is open and before the server starts listening:
 *
 *  1. Materializes the bootstrap account from the environment, so a container
 *     can come up already-protected instead of exposing a setup window.
 *  2. Ensures a stable API token exists for non-browser callers (the agent's own
 *     `curl`, the Telegram bridge). Generated and persisted on first boot when
 *     the operator hasn't supplied one.
 *  3. Prunes expired sessions and schedules an hourly sweep.
 *  4. Emits the warnings an operator actually needs to see — above all, "this is
 *     reachable off-box and unauthenticated".
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

import type { AuthConfig } from "./config.ts";
import { isLoopbackHost } from "./config.ts";
import { getDataDir } from "../env-store.ts";
import { logger } from "../log.ts";
import {
	countUsers,
	createUser,
	findUserByUsername,
	hashPassword,
	pruneExpiredSessions,
	setPassword,
} from "./store.ts";

const log = logger("auth-bootstrap");

const API_TOKEN_FILE = "api-token";

/**
 * Resolve the API token: explicit env wins, then a previously persisted token,
 * then a freshly generated one.
 *
 * Persisting matters — a token regenerated on every restart would silently
 * break the Telegram bridge and any script the user wrote, with a 401 that
 * looks like a bug rather than a rotation.
 */
function resolveApiToken(cfg: AuthConfig): string {
	if (cfg.apiToken) return cfg.apiToken;

	const file = path.join(getDataDir(), API_TOKEN_FILE);
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (existing) return existing;
	} catch {
		/* not written yet — fall through and mint one */
	}

	const token = randomBytes(32).toString("base64url");
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
		log.info(`generated deck API token at ${file}`);
	} catch (err) {
		log.warn(`could not persist API token to ${file}; it will change on restart: ${String(err)}`);
	}
	return token;
}

export interface AuthBootstrapResult {
	/** The effective API token for this process. */
	apiToken: string;
	/** True when the deck will serve first-run setup instead of the app. */
	needsSetup: boolean;
}

export async function bootstrapAuth(cfg: AuthConfig, bindHost: string): Promise<AuthBootstrapResult> {
	const apiToken = resolveApiToken(cfg);
	cfg.apiToken = apiToken;
	// Expose to child processes (the Telegram bridge, routine subprocesses) and
	// to the in-process agent, so `curl -H "Authorization: Bearer $OMP_DECK_API_TOKEN"`
	// works from a session's bash tool without the user wiring anything up.
	process.env.OMP_DECK_API_TOKEN = apiToken;

	if (!cfg.enabled) {
		if (!isLoopbackHost(bindHost)) {
			// loadAuthConfig refuses to disable auth on a public bind, so reaching
			// here means the host string itself was unexpected. Say so loudly.
			log.warn(`authentication is DISABLED while bound to ${bindHost} — anyone who can reach this port has full agent access`);
		} else {
			log.info("authentication disabled (loopback bind, no credentials configured)");
		}
		return { apiToken, needsSetup: false };
	}

	const removed = pruneExpiredSessions();
	if (removed > 0) log.debug(`pruned ${removed} expired session(s)`);
	// Hourly sweep. `unref` so a pending timer never holds the process open.
	setInterval(() => {
		try {
			pruneExpiredSessions();
		} catch (err) {
			log.debug(`session prune failed: ${String(err)}`);
		}
	}, 60 * 60_000).unref?.();

	await applyBootstrapCredentials(cfg);

	const needsSetup = countUsers() === 0;
	if (needsSetup) {
		log.warn(
			"no deck account exists yet — the first-run setup screen is live. " +
				"Anyone who reaches this URL before you do can claim the instance; " +
				"set OMP_DECK_AUTH_SETUP_TOKEN, or configure OMP_DECK_AUTH_PASSWORD_HASH, to close that window.",
		);
	} else {
		log.info("authentication enabled");
	}
	return { apiToken, needsSetup };
}

/**
 * Create or update the bootstrap account from environment configuration.
 *
 * The account is created only when none exists. When one does, a changed
 * password in the environment is applied — that is the documented recovery path
 * for a forgotten password on a headless box, and it's why the env password is
 * re-read on every boot rather than only at creation.
 */
async function applyBootstrapCredentials(cfg: AuthConfig): Promise<void> {
	const { bootstrapUsername, bootstrapPassword, bootstrapPasswordHash } = cfg;
	if (!bootstrapPassword && !bootstrapPasswordHash) return;

	const existing = findUserByUsername(bootstrapUsername);
	if (!existing) {
		await createUser({
			username: bootstrapUsername,
			...(bootstrapPasswordHash ? { passwordHash: bootstrapPasswordHash } : { password: bootstrapPassword }),
		});
		log.info(`bootstrapped deck account "${bootstrapUsername}" from environment`);
		return;
	}

	// Account exists. Only the plaintext form can be compared against the stored
	// digest to decide whether anything changed; a supplied hash is applied only
	// when it differs from what's stored, which we can't see from here without a
	// read, so we leave pre-hashed values alone after creation and document that.
	if (bootstrapPassword) {
		const alreadyCurrent = await Bun.password
			.verify(bootstrapPassword, await currentDigest(existing.id))
			.catch(() => false);
		if (!alreadyCurrent) {
			await setPassword(existing.id, bootstrapPassword);
			log.warn(
				`password for "${bootstrapUsername}" reset from OMP_DECK_AUTH_PASSWORD; all existing sessions revoked`,
			);
		}
	}
}

/** Read a user's stored digest. Kept private to this module. */
async function currentDigest(userId: string): Promise<string> {
	const { getDb } = await import("../db/index.ts");
	const row = getDb().query("SELECT password_hash FROM deck_users WHERE id = $id").get({ id: userId }) as
		| { password_hash: string }
		| null;
	return row?.password_hash ?? (await hashPassword(randomBytes(16).toString("hex")));
}
