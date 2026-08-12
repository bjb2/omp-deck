/**
 * User + session persistence for deck authentication.
 *
 * Passwords are argon2id digests via `Bun.password` — no dependency, memory-hard
 * by default, and `Bun.password.verify` is constant-time. Session cookies carry
 * a random 256-bit token; only its SHA-256 is stored, so a copy of the database
 * cannot be replayed as a live login.
 *
 * Sessions are server-side rows rather than stateless signed cookies. That costs
 * one indexed lookup per request and buys real revocation: signing out a device,
 * or changing a password, actually ends the other sessions instead of waiting
 * for a token to expire.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { getDb } from "../db/index.ts";
import { logger } from "../log.ts";

const log = logger("auth-store");

export interface DeckUser {
	id: string;
	username: string;
	createdAt: string;
	passwordChangedAt: string;
	lastLoginAt: string | null;
}

export interface DeckSession {
	id: string;
	userId: string;
	createdAt: string;
	expiresAt: string;
	lastSeenAt: string;
	userAgent: string | null;
	ip: string | null;
}

interface UserRow {
	id: string;
	username: string;
	password_hash: string;
	created_at: string;
	password_changed_at: string;
	last_login_at: string | null;
}

interface SessionRow {
	id: string;
	user_id: string;
	created_at: string;
	expires_at: string;
	last_seen_at: string;
	user_agent: string | null;
	ip: string | null;
}

const nowIso = (): string => new Date().toISOString();

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function toUser(row: UserRow): DeckUser {
	return {
		id: row.id,
		username: row.username,
		createdAt: row.created_at,
		passwordChangedAt: row.password_changed_at,
		lastLoginAt: row.last_login_at,
	};
}

// ─── Users ─────────────────────────────────────────────────────────────────

export function countUsers(): number {
	const row = getDb().query("SELECT COUNT(*) AS n FROM deck_users").get() as { n: number };
	return row.n;
}

export function findUserByUsername(username: string): DeckUser | null {
	const row = getDb()
		.query("SELECT * FROM deck_users WHERE username_lower = $u")
		.get({ u: username.trim().toLowerCase() }) as UserRow | null;
	return row ? toUser(row) : null;
}

export function findUserById(id: string): DeckUser | null {
	const row = getDb().query("SELECT * FROM deck_users WHERE id = $id").get({ id }) as UserRow | null;
	return row ? toUser(row) : null;
}

export function listUsers(): DeckUser[] {
	const rows = getDb().query("SELECT * FROM deck_users ORDER BY created_at ASC").all() as UserRow[];
	return rows.map(toUser);
}

export async function hashPassword(plaintext: string): Promise<string> {
	return Bun.password.hash(plaintext, { algorithm: "argon2id" });
}

/**
 * Create a user. `passwordHash` lets the caller pass a pre-computed argon2id
 * digest (used by the env bootstrap path, where the operator supplies the hash
 * so no plaintext ever lands in the container's environment).
 */
export async function createUser(opts: {
	username: string;
	password?: string;
	passwordHash?: string;
}): Promise<DeckUser> {
	const username = opts.username.trim();
	if (!username) throw new Error("username is required");
	const hash = opts.passwordHash ?? (opts.password ? await hashPassword(opts.password) : undefined);
	if (!hash) throw new Error("password or passwordHash is required");

	const ts = nowIso();
	const id = crypto.randomUUID();
	getDb()
		.query(
			`INSERT INTO deck_users
				(id, username, username_lower, password_hash, created_at, updated_at, password_changed_at)
			 VALUES ($id, $username, $lower, $hash, $ts, $ts, $ts)`,
		)
		.run({ id, username, lower: username.toLowerCase(), hash, ts });
	log.info(`created deck user "${username}"`);
	return { id, username, createdAt: ts, passwordChangedAt: ts, lastLoginAt: null };
}

/**
 * Verify a password. Always runs a hash comparison — even for an unknown
 * username — so response timing does not reveal which accounts exist.
 */
export async function verifyPassword(username: string, password: string): Promise<DeckUser | null> {
	const row = getDb()
		.query("SELECT * FROM deck_users WHERE username_lower = $u")
		.get({ u: username.trim().toLowerCase() }) as UserRow | null;

	// Dummy digest for the unknown-user path. Same argon2id cost as a real
	// verify, so "no such user" and "wrong password" take the same wall time.
	const digest = row?.password_hash ?? (await getDummyHash());
	let ok = false;
	try {
		ok = await Bun.password.verify(password, digest);
	} catch {
		ok = false;
	}
	if (!row || !ok) return null;

	const ts = nowIso();
	getDb().query("UPDATE deck_users SET last_login_at = $ts WHERE id = $id").run({ ts, id: row.id });
	return toUser({ ...row, last_login_at: ts });
}

/**
 * An argon2id digest of a random string, computed once on first use.
 *
 * Hardcoding a literal digest would be simpler but fragile: it has to stay
 * parameter-compatible with whatever `Bun.password.hash` defaults to, and a
 * mismatch makes `verify` throw instantly instead of burning the same CPU a
 * real check would — which is precisely the timing signal this exists to erase.
 * Deriving it from the live hasher keeps the two costs identical by
 * construction.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
	dummyHashPromise ??= hashPassword(randomBytes(32).toString("base64url"));
	return dummyHashPromise;
}

export async function setPassword(userId: string, password: string): Promise<void> {
	const hash = await hashPassword(password);
	const ts = nowIso();
	getDb()
		.query("UPDATE deck_users SET password_hash = $hash, updated_at = $ts, password_changed_at = $ts WHERE id = $id")
		.run({ hash, ts, id: userId });
	// Every other device is now holding a session minted before the new epoch.
	deleteSessionsForUser(userId);
	log.info(`password changed for user ${userId}; all sessions revoked`);
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export interface IssuedSession {
	token: string;
	session: DeckSession;
}

export function createSession(opts: {
	userId: string;
	ttlMs: number;
	userAgent?: string | null;
	ip?: string | null;
}): IssuedSession {
	const token = randomBytes(32).toString("base64url");
	const id = crypto.randomUUID();
	const created = new Date();
	const expires = new Date(created.getTime() + opts.ttlMs);
	const row = {
		id,
		user_id: opts.userId,
		token_hash: hashToken(token),
		created_at: created.toISOString(),
		expires_at: expires.toISOString(),
		last_seen_at: created.toISOString(),
		user_agent: opts.userAgent?.slice(0, 400) ?? null,
		ip: opts.ip ?? null,
	};
	getDb()
		.query(
			`INSERT INTO deck_sessions
				(id, user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip)
			 VALUES ($id, $user_id, $token_hash, $created_at, $expires_at, $last_seen_at, $user_agent, $ip)`,
		)
		.run(row);
	return {
		token,
		session: {
			id,
			userId: opts.userId,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			lastSeenAt: row.last_seen_at,
			userAgent: row.user_agent,
			ip: row.ip,
		},
	};
}

export interface ResolvedSession {
	user: DeckUser;
	session: DeckSession;
}

/**
 * Resolve a cookie token to a live session.
 *
 * Rejects expired rows and — via `password_changed_at` — any session minted
 * before the account's most recent password change.
 */
export function resolveSessionToken(token: string): ResolvedSession | null {
	if (!token) return null;
	const row = getDb()
		.query("SELECT * FROM deck_sessions WHERE token_hash = $h")
		.get({ h: hashToken(token) }) as SessionRow | null;
	if (!row) return null;

	const expires = Date.parse(row.expires_at);
	if (!Number.isFinite(expires) || expires <= Date.now()) {
		deleteSessionById(row.id);
		return null;
	}

	const user = findUserById(row.user_id);
	if (!user) {
		deleteSessionById(row.id);
		return null;
	}

	// Password-change revocation epoch.
	if (Date.parse(row.created_at) < Date.parse(user.passwordChangedAt)) {
		deleteSessionById(row.id);
		return null;
	}

	return {
		user,
		session: {
			id: row.id,
			userId: row.user_id,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			lastSeenAt: row.last_seen_at,
			userAgent: row.user_agent,
			ip: row.ip,
		},
	};
}

/**
 * Bump `last_seen_at` at most once a minute.
 *
 * Every authenticated request would otherwise be a write, which on WAL sqlite
 * turns a read-mostly workload into a write-mostly one for no benefit.
 */
export function touchSession(session: DeckSession): void {
	if (Date.now() - Date.parse(session.lastSeenAt) < 60_000) return;
	getDb().query("UPDATE deck_sessions SET last_seen_at = $ts WHERE id = $id").run({
		ts: nowIso(),
		id: session.id,
	});
}

export function deleteSessionByToken(token: string): void {
	getDb().query("DELETE FROM deck_sessions WHERE token_hash = $h").run({ h: hashToken(token) });
}

export function deleteSessionById(id: string): void {
	getDb().query("DELETE FROM deck_sessions WHERE id = $id").run({ id });
}

export function deleteSessionsForUser(userId: string): void {
	getDb().query("DELETE FROM deck_sessions WHERE user_id = $u").run({ u: userId });
}

export function listSessionsForUser(userId: string): DeckSession[] {
	const rows = getDb()
		.query("SELECT * FROM deck_sessions WHERE user_id = $u ORDER BY last_seen_at DESC")
		.all({ u: userId }) as SessionRow[];
	return rows.map((row) => ({
		id: row.id,
		userId: row.user_id,
		createdAt: row.created_at,
		expiresAt: row.expires_at,
		lastSeenAt: row.last_seen_at,
		userAgent: row.user_agent,
		ip: row.ip,
	}));
}

/** Drop expired rows. Cheap; called at boot and hourly. */
export function pruneExpiredSessions(): number {
	const res = getDb().query("DELETE FROM deck_sessions WHERE expires_at <= $now").run({ now: nowIso() });
	return Number(res.changes ?? 0);
}

/** Constant-time compare for bearer tokens. */
export function tokensMatch(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}
