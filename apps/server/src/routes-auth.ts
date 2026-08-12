/**
 * Deck user authentication routes — sign in, sign out, first-run setup, and
 * session management.
 *
 * Distinct from `routes-auth-oauth.ts`, which signs the *agent* into model
 * providers (Anthropic, OpenAI, …). This file is about who is allowed to drive
 * the deck at all.
 *
 * Every route here is reachable without a principal (the gate allowlists
 * `/auth/*`), so each handler is responsible for its own authorization. The
 * ones that mutate state re-resolve the caller and refuse anonymous requests.
 */
import { Hono } from "hono";

import type { AuthConfig } from "./auth/config.ts";
import {
	isAllowedOrigin,
	needsFirstRunSetup,
	parseCookies,
	resolvePrincipal,
	serializeSessionCookie,
	shouldUseSecureCookie,
} from "./auth/guard.ts";
import {
	countUsers,
	createSession,
	createUser,
	deleteSessionById,
	deleteSessionByToken,
	deleteSessionsForUser,
	listSessionsForUser,
	setPassword,
	tokensMatch,
	verifyPassword,
} from "./auth/store.ts";
import { logger } from "./log.ts";

const log = logger("auth-routes");

/** Minimum password length. Short enough to not annoy, long enough to matter. */
const MIN_PASSWORD_LENGTH = 8;

// ─── Login throttling ──────────────────────────────────────────────────────

/**
 * In-memory failed-attempt tracker, keyed by username+client IP.
 *
 * Deliberately not persisted: a restart clearing the counters is an acceptable
 * trade for never letting a login attempt write to disk. This is a brute-force
 * speed bump for a single-tenant deck, not a distributed rate limiter.
 */
interface AttemptRecord {
	failures: number;
	lockedUntil: number;
}
const attempts = new Map<string, AttemptRecord>();

function attemptKey(username: string, ip: string): string {
	return `${username.trim().toLowerCase()}@${ip}`;
}

function checkLockout(key: string): { locked: true; retryAfterSeconds: number } | { locked: false } {
	const record = attempts.get(key);
	if (!record) return { locked: false };
	if (record.lockedUntil > Date.now()) {
		return { locked: true, retryAfterSeconds: Math.ceil((record.lockedUntil - Date.now()) / 1000) };
	}
	if (record.lockedUntil && record.lockedUntil <= Date.now()) attempts.delete(key);
	return { locked: false };
}

function recordFailure(key: string, cfg: AuthConfig): void {
	const record = attempts.get(key) ?? { failures: 0, lockedUntil: 0 };
	record.failures += 1;
	if (record.failures >= cfg.maxLoginAttempts) {
		record.lockedUntil = Date.now() + cfg.lockoutMs;
		record.failures = 0;
	}
	attempts.set(key, record);
}

function clearFailures(key: string): void {
	attempts.delete(key);
}

/** Best-effort client IP for throttling and session bookkeeping. */
function clientIp(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) return forwarded.split(",")[0]!.trim();
	return req.headers.get("x-real-ip")?.trim() || "unknown";
}

// ─── Router ────────────────────────────────────────────────────────────────

export function buildAuthRouter(cfg: AuthConfig, getPublicUrl: () => string | undefined): Hono {
	const app = new Hono();

	/**
	 * Reject cross-origin writes before any handler runs. The gate applies the
	 * same rule to the rest of the API; login has to enforce it too, or it would
	 * be the one unprotected write on the server.
	 */
	app.use("*", async (c, next) => {
		if (!isAllowedOrigin(c.req.raw, cfg, getPublicUrl())) {
			return c.json({ error: "forbidden", message: "Cross-origin request rejected." }, 403);
		}
		await next();
	});

	/**
	 * Unauthenticated bootstrap probe. The web app calls this before rendering
	 * anything so it knows whether to show the app, the login form, or the
	 * first-run setup form.
	 */
	app.get("/status", (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		return c.json({
			authRequired: cfg.enabled,
			needsSetup: cfg.enabled && needsFirstRunSetup(),
			setupTokenRequired: Boolean(cfg.setupToken),
			authenticated: Boolean(principal),
			user:
				principal?.kind === "user"
					? { id: principal.user.id, username: principal.user.username }
					: principal
						? { id: principal.kind, username: principal.kind }
						: null,
		});
	});

	app.get("/session", (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		if (!principal) return c.json({ error: "unauthorized" }, 401);
		if (principal.kind !== "user") {
			return c.json({ user: { id: principal.kind, username: principal.kind }, kind: principal.kind });
		}
		return c.json({
			kind: "user",
			user: {
				id: principal.user.id,
				username: principal.user.username,
				createdAt: principal.user.createdAt,
				lastLoginAt: principal.user.lastLoginAt,
			},
			session: { id: principal.session.id, expiresAt: principal.session.expiresAt },
		});
	});

	/**
	 * First-run setup — creates the initial account.
	 *
	 * Only callable while zero accounts exist, so it cannot be used to add a
	 * second admin later. On a public deployment there is a window between first
	 * boot and first login where anyone who finds the URL could claim the
	 * instance; `OMP_DECK_AUTH_SETUP_TOKEN` closes it, and configuring a
	 * password via the environment skips the window entirely.
	 */
	app.post("/setup", async (c) => {
		if (!cfg.enabled) return c.json({ error: "auth-disabled" }, 400);
		if (countUsers() > 0) return c.json({ error: "already-configured" }, 409);

		let body: { username?: string; password?: string; setupToken?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		if (cfg.setupToken) {
			const presented = body.setupToken?.trim() ?? "";
			if (!presented || !tokensMatch(presented, cfg.setupToken)) {
				log.warn("first-run setup rejected: bad setup token");
				return c.json({ error: "bad-setup-token", message: "Setup token is incorrect." }, 403);
			}
		}

		const username = body.username?.trim() || cfg.bootstrapUsername;
		const password = body.password ?? "";
		if (password.length < MIN_PASSWORD_LENGTH) {
			return c.json(
				{ error: "weak-password", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
				400,
			);
		}

		const user = await createUser({ username, password });
		const issued = createSession({
			userId: user.id,
			ttlMs: cfg.sessionTtlMs,
			userAgent: c.req.header("user-agent") ?? null,
			ip: clientIp(c.req.raw),
		});
		log.info(`first-run setup completed for "${username}"`);
		c.header(
			"set-cookie",
			serializeSessionCookie(cfg.cookieName, issued.token, {
				maxAgeSeconds: cfg.sessionTtlMs / 1000,
				secure: shouldUseSecureCookie(c.req.raw, cfg),
			}),
		);
		return c.json({ ok: true, user: { id: user.id, username: user.username } });
	});

	app.post("/login", async (c) => {
		if (!cfg.enabled) return c.json({ error: "auth-disabled", message: "Authentication is not enabled." }, 400);

		let body: { username?: string; password?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const username = body.username?.trim() ?? "";
		const password = body.password ?? "";
		if (!username || !password) {
			return c.json({ error: "missing-credentials", message: "Username and password are required." }, 400);
		}

		const key = attemptKey(username, clientIp(c.req.raw));
		const lock = checkLockout(key);
		if (lock.locked) {
			return c.json(
				{
					error: "locked-out",
					message: `Too many failed attempts. Try again in ${lock.retryAfterSeconds} seconds.`,
					retryAfterSeconds: lock.retryAfterSeconds,
				},
				429,
			);
		}

		const user = await verifyPassword(username, password);
		if (!user) {
			recordFailure(key, cfg);
			log.warn(`failed login for "${username}"`);
			// Same message for unknown user and wrong password — don't confirm
			// which usernames exist.
			return c.json({ error: "invalid-credentials", message: "Incorrect username or password." }, 401);
		}
		clearFailures(key);

		const issued = createSession({
			userId: user.id,
			ttlMs: cfg.sessionTtlMs,
			userAgent: c.req.header("user-agent") ?? null,
			ip: clientIp(c.req.raw),
		});
		log.info(`login: "${user.username}"`);
		c.header(
			"set-cookie",
			serializeSessionCookie(cfg.cookieName, issued.token, {
				maxAgeSeconds: cfg.sessionTtlMs / 1000,
				secure: shouldUseSecureCookie(c.req.raw, cfg),
			}),
		);
		return c.json({ ok: true, user: { id: user.id, username: user.username } });
	});

	app.post("/logout", (c) => {
		const token = parseCookies(c.req.header("cookie") ?? null).get(cfg.cookieName);
		if (token) deleteSessionByToken(token);
		c.header(
			"set-cookie",
			serializeSessionCookie(cfg.cookieName, "", {
				maxAgeSeconds: 0,
				secure: shouldUseSecureCookie(c.req.raw, cfg),
			}),
		);
		return c.json({ ok: true });
	});

	/** Change the current user's password; revokes every other session. */
	app.post("/password", async (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		if (principal?.kind !== "user") {
			return c.json({ error: "unauthorized", message: "Sign in to change your password." }, 401);
		}
		let body: { currentPassword?: string; newPassword?: string };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const current = body.currentPassword ?? "";
		const next = body.newPassword ?? "";
		if (next.length < MIN_PASSWORD_LENGTH) {
			return c.json(
				{ error: "weak-password", message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
				400,
			);
		}
		const verified = await verifyPassword(principal.user.username, current);
		if (!verified) {
			return c.json({ error: "invalid-credentials", message: "Current password is incorrect." }, 403);
		}

		await setPassword(principal.user.id, next);
		// setPassword revoked every session including this one — mint a fresh
		// one so the user isn't signed out of the tab they just used.
		const issued = createSession({
			userId: principal.user.id,
			ttlMs: cfg.sessionTtlMs,
			userAgent: c.req.header("user-agent") ?? null,
			ip: clientIp(c.req.raw),
		});
		c.header(
			"set-cookie",
			serializeSessionCookie(cfg.cookieName, issued.token, {
				maxAgeSeconds: cfg.sessionTtlMs / 1000,
				secure: shouldUseSecureCookie(c.req.raw, cfg),
			}),
		);
		return c.json({ ok: true });
	});

	/** Devices currently signed in as the calling user. */
	app.get("/sessions", (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		if (principal?.kind !== "user") return c.json({ error: "unauthorized" }, 401);
		const sessions = listSessionsForUser(principal.user.id).map((s) => ({
			id: s.id,
			createdAt: s.createdAt,
			lastSeenAt: s.lastSeenAt,
			expiresAt: s.expiresAt,
			userAgent: s.userAgent,
			ip: s.ip,
			current: s.id === principal.session.id,
		}));
		return c.json({ sessions });
	});

	app.delete("/sessions/:id", (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		if (principal?.kind !== "user") return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		// Scope the delete to the caller's own sessions.
		const owned = listSessionsForUser(principal.user.id).some((s) => s.id === id);
		if (!owned) return c.json({ error: "not-found" }, 404);
		deleteSessionById(id);
		return c.json({ ok: true });
	});

	/** Sign out everywhere, including this device. */
	app.post("/sessions/revoke-all", (c) => {
		const principal = resolvePrincipal(c.req.raw, cfg);
		if (principal?.kind !== "user") return c.json({ error: "unauthorized" }, 401);
		deleteSessionsForUser(principal.user.id);
		c.header(
			"set-cookie",
			serializeSessionCookie(cfg.cookieName, "", {
				maxAgeSeconds: 0,
				secure: shouldUseSecureCookie(c.req.raw, cfg),
			}),
		);
		return c.json({ ok: true });
	});

	return app;
}
