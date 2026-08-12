/**
 * Deck authentication configuration.
 *
 * The deck historically bound to loopback and trusted every caller. Self-hosted
 * installs put it on a public hostname, where "whoever reaches the port" is the
 * whole internet, so authentication has to be a first-class part of the config
 * rather than something bolted on by a reverse proxy.
 *
 * Mode resolution (`OMP_DECK_AUTH_MODE`):
 *
 *   auto (default) — on unless the server is bound to loopback AND no
 *                    credentials are configured. This keeps `bun dev` on
 *                    127.0.0.1 frictionless while making a public bind secure
 *                    by default, which is the combination we actually want.
 *   on             — always required, loopback included.
 *   off            — never required. Only honored when the bind host is
 *                    loopback; a public bind ignores it and logs loudly,
 *                    because silently serving an unauthenticated agent to the
 *                    internet is not a footgun we're willing to hand anyone.
 *
 * Bootstrap credentials come from the environment so a container can come up
 * already-configured:
 *
 *   OMP_DECK_AUTH_USERNAME       default "admin"
 *   OMP_DECK_AUTH_PASSWORD_HASH  argon2id digest (preferred — no plaintext in env)
 *   OMP_DECK_AUTH_PASSWORD       plaintext, hashed on first boot then usable to
 *                                reset the password on later boots
 *
 * When neither is set the deck serves a first-run setup screen instead of the
 * app, so a public deployment is never both reachable and unprotected. That
 * screen can be pinned to a one-time token via OMP_DECK_AUTH_SETUP_TOKEN.
 */
import { splitList } from "../config.ts";

export type AuthMode = "auto" | "on" | "off";

export interface AuthConfig {
	/** Resolved from OMP_DECK_AUTH_MODE + bind host. */
	enabled: boolean;
	mode: AuthMode;
	/** Bootstrap username. Only used when creating the first account. */
	bootstrapUsername: string;
	/** Plaintext bootstrap password, if supplied. Hashed at boot; never stored raw. */
	bootstrapPassword?: string;
	/** Pre-hashed bootstrap password (argon2id). Wins over the plaintext form. */
	bootstrapPasswordHash?: string;
	/** Optional shared secret required to complete first-run setup. */
	setupToken?: string;
	/** Session lifetime in ms. */
	sessionTtlMs: number;
	/** Cookie name. Namespaced so several decks on one host don't collide. */
	cookieName: string;
	/** Force the Secure cookie attribute even when the request looks like plain HTTP. */
	forceSecureCookie: boolean;
	/**
	 * Extra origins allowed to make state-changing requests, beyond the request's
	 * own host and the configured public URL. Comma-separated absolute origins.
	 */
	trustedOrigins: string[];
	/**
	 * Static API token for non-browser callers (the agent's own `curl`, the
	 * Telegram bridge, scripts). Sent as `Authorization: Bearer <token>`.
	 * Generated and persisted on first boot when unset.
	 */
	apiToken?: string;
	/** Failed logins per username+IP before a temporary lockout kicks in. */
	maxLoginAttempts: number;
	/** Lockout duration once maxLoginAttempts is exceeded. */
	lockoutMs: number;
}

function envTrim(key: string): string | undefined {
	const raw = process.env[key]?.trim();
	return raw ? raw : undefined;
}

function envBool(key: string, fallback: boolean): boolean {
	const raw = process.env[key]?.trim().toLowerCase();
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw);
}

function envInt(key: string, fallback: number): number {
	const raw = process.env[key]?.trim();
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function isLoopbackHost(host: string): boolean {
	const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
	return h === "127.0.0.1" || h === "localhost" || h === "::1" || h.startsWith("127.");
}

function parseMode(raw: string | undefined): AuthMode {
	const value = raw?.trim().toLowerCase();
	if (value === "on" || value === "required" || value === "true" || value === "1") return "on";
	if (value === "off" || value === "none" || value === "false" || value === "0") return "off";
	return "auto";
}

/**
 * Resolve auth configuration against the host the server will bind to.
 *
 * `bindHost` matters: it is the difference between "a dev box talking to
 * itself" and "a socket the internet can open", and that is exactly the line
 * the default mode draws.
 */
/**
 * Process-wide instance.
 *
 * `bootstrapAuth` mutates `apiToken` on the config it is handed (persisting a
 * generated token), and the request gate must see that same object — two
 * independently loaded configs would disagree about the token and reject every
 * bearer-authenticated call. One instance, initialized at boot, read everywhere.
 */
let cached: AuthConfig | undefined;

export function initAuthConfig(bindHost: string): AuthConfig {
	cached = loadAuthConfig(bindHost);
	return cached;
}

export function getAuthConfig(): AuthConfig {
	if (!cached) throw new Error("auth config not initialized — call initAuthConfig() at boot");
	return cached;
}

export function loadAuthConfig(bindHost: string): AuthConfig {
	const mode = parseMode(process.env.OMP_DECK_AUTH_MODE);
	const loopback = isLoopbackHost(bindHost);
	const bootstrapPassword = envTrim("OMP_DECK_AUTH_PASSWORD");
	const bootstrapPasswordHash = envTrim("OMP_DECK_AUTH_PASSWORD_HASH");
	const hasCredentials = Boolean(bootstrapPassword || bootstrapPasswordHash);

	// `off` is only honored on a loopback bind. On a public bind we override it:
	// the alternative is handing an unauthenticated coding agent to the internet
	// because of one stale env var.
	let enabled: boolean;
	if (mode === "on") enabled = true;
	else if (mode === "off") enabled = !loopback;
	else enabled = !loopback || hasCredentials;

	return {
		enabled,
		mode,
		bootstrapUsername: envTrim("OMP_DECK_AUTH_USERNAME") ?? "admin",
		bootstrapPassword,
		bootstrapPasswordHash,
		setupToken: envTrim("OMP_DECK_AUTH_SETUP_TOKEN"),
		sessionTtlMs: envInt("OMP_DECK_AUTH_SESSION_TTL_MS", 30 * 24 * 60 * 60_000),
		cookieName: envTrim("OMP_DECK_AUTH_COOKIE_NAME") ?? "omp_deck_session",
		forceSecureCookie: envBool("OMP_DECK_AUTH_SECURE_COOKIE", false),
		trustedOrigins: splitList(process.env.OMP_DECK_TRUSTED_ORIGINS).map((o) => o.replace(/\/+$/, "")),
		apiToken: envTrim("OMP_DECK_API_TOKEN"),
		maxLoginAttempts: envInt("OMP_DECK_AUTH_MAX_ATTEMPTS", 8),
		lockoutMs: envInt("OMP_DECK_AUTH_LOCKOUT_MS", 15 * 60_000),
	};
}
