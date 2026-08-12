/**
 * The request gate.
 *
 * `Bun.serve`'s `fetch` is the only place every surface converges — the API
 * router, the WebSocket upgrade, the uploads reader and the static handler all
 * pass through it — so that is where authentication is enforced. Enforcing in
 * Hono middleware alone would leave `/ws` and `/uploads` wide open, which is
 * the more valuable half of the attack surface: the socket drives agent
 * sessions.
 *
 * Three principals can satisfy the gate:
 *
 *   user      — a browser session cookie. The normal path.
 *   api-token — `Authorization: Bearer <OMP_DECK_API_TOKEN>`. For the agent's
 *               own `curl` calls, the Telegram bridge, and scripts. Non-browser
 *               callers can't hold a cookie and shouldn't need one.
 *   internal  — the routine runner's per-run HMAC headers. This scheme already
 *               existed (`routines/internal-auth.ts`) but was never verified by
 *               anything; turning the gate on is what finally gives it a
 *               consumer, and it's what keeps routine `http` steps working once
 *               unauthenticated access stops being a thing.
 *
 * Static assets are deliberately NOT gated. The SPA bundle carries no secrets,
 * and serving it anonymously is what lets the login screen exist at all.
 */
import type { AuthConfig } from "./config.ts";
import { verifyInternalToken } from "../routines/internal-auth.ts";
import {
	type DeckSession,
	type DeckUser,
	countUsers,
	resolveSessionToken,
	tokensMatch,
	touchSession,
} from "./store.ts";

export type Principal =
	| { kind: "user"; user: DeckUser; session: DeckSession }
	| { kind: "api-token" }
	| { kind: "internal"; runId: string };

/**
 * API paths reachable without a principal.
 *
 * `/auth/*` has to be open or nobody could ever log in; `/health` stays open so
 * container health checks and load balancers don't need a credential to ask
 * whether the process is alive. Both are matched against the *stripped* path
 * (the `/api` prefix is removed before the router sees it) and against the raw
 * path, so callers of this helper can pass either form.
 */
const PUBLIC_API_PREFIXES = ["/auth/login", "/auth/logout", "/auth/session", "/auth/setup", "/auth/status", "/health"];

export function isPublicApiPath(pathname: string): boolean {
	const p = pathname.startsWith("/api/") ? pathname.slice(4) : pathname;
	return PUBLIC_API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** Parse a Cookie header into a map. Tolerates spaces and `=` inside values. */
export function parseCookies(header: string | null): Map<string, string> {
	const out = new Map<string, string>();
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		const name = part.slice(0, eq).trim();
		if (!name) continue;
		out.set(name, decodeURIComponent(part.slice(eq + 1).trim()));
	}
	return out;
}

export interface CookieOptions {
	maxAgeSeconds?: number;
	secure: boolean;
}

export function serializeSessionCookie(name: string, value: string, opts: CookieOptions): string {
	const parts = [
		`${name}=${encodeURIComponent(value)}`,
		"Path=/",
		"HttpOnly",
		// Lax rather than Strict: an OAuth provider redirect is a cross-site
		// top-level GET, and under Strict the user would land back on the deck
		// logged out. Lax still blocks cross-site POSTs, which is the CSRF case
		// that matters, and the Origin check below covers the rest.
		"SameSite=Lax",
	];
	if (opts.secure) parts.push("Secure");
	parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds ?? 0))}`);
	return parts.join("; ");
}

/**
 * Should the session cookie carry `Secure`?
 *
 * Behind a TLS-terminating proxy the origin request is plain HTTP, so sniffing
 * `req.url` alone would drop `Secure` on exactly the deployments that need it.
 * `X-Forwarded-Proto` is the proxy's own statement about the client leg.
 */
export function shouldUseSecureCookie(req: Request, cfg: AuthConfig): boolean {
	if (cfg.forceSecureCookie) return true;
	const forwarded = req.headers.get("x-forwarded-proto");
	if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase() === "https";
	return new URL(req.url).protocol === "https:";
}

/** Extract a bearer token from the Authorization header. */
function bearerToken(req: Request): string | undefined {
	const header = req.headers.get("authorization");
	if (!header) return undefined;
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match?.[1]?.trim() || undefined;
}

/**
 * Identify the caller, or return null when nothing valid is presented.
 * Never throws — an unparseable credential is simply not a principal.
 */
export function resolvePrincipal(req: Request, cfg: AuthConfig): Principal | null {
	// Internal routine-runner token first: it's the cheapest check and these
	// requests never carry a cookie.
	const internal = verifyInternalToken(req);
	if (internal.ok) return { kind: "internal", runId: internal.runId };

	const bearer = bearerToken(req);
	if (bearer && cfg.apiToken && tokensMatch(bearer, cfg.apiToken)) {
		return { kind: "api-token" };
	}

	const cookies = parseCookies(req.headers.get("cookie"));
	const token = cookies.get(cfg.cookieName);
	if (token) {
		const resolved = resolveSessionToken(token);
		if (resolved) {
			touchSession(resolved.session);
			return { kind: "user", user: resolved.user, session: resolved.session };
		}
	}
	return null;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cross-origin write protection.
 *
 * SameSite=Lax already stops cross-site form POSTs from carrying the cookie,
 * but it does nothing for a `fetch` from a page on another origin that somehow
 * obtains one, and nothing at all for bearer-token callers. Comparing Origin to
 * the request's own Host closes that: a browser cannot forge Origin.
 *
 * A missing Origin is allowed because non-browser clients (curl, the bridge)
 * don't send one; those callers authenticate with a bearer token, which an
 * attacker's page cannot read or replay.
 */
export function isAllowedOrigin(req: Request, cfg: AuthConfig, publicUrl?: string): boolean {
	if (SAFE_METHODS.has(req.method.toUpperCase())) return true;
	const origin = req.headers.get("origin");
	if (!origin) return true;

	let originHost: string;
	try {
		originHost = new URL(origin).host.toLowerCase();
	} catch {
		return false;
	}

	const allowed = new Set<string>();
	const host = req.headers.get("host")?.toLowerCase();
	if (host) allowed.add(host);
	const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
	if (forwardedHost) allowed.add(forwardedHost);
	for (const extra of [publicUrl, ...cfg.trustedOrigins]) {
		if (!extra) continue;
		try {
			allowed.add(new URL(extra).host.toLowerCase());
		} catch {
			/* ignore malformed configuration rather than failing every write */
		}
	}
	return allowed.has(originHost);
}

/** True when the deck has no accounts yet and must show first-run setup. */
export function needsFirstRunSetup(): boolean {
	return countUsers() === 0;
}

export function unauthorizedResponse(reason: string, status = 401): Response {
	return new Response(JSON.stringify({ error: "unauthorized", message: reason }), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}
