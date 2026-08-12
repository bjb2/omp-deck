import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Config {
	host: string;
	port: number;
	defaultCwd: string;
	extraWorkspaces: string[];
	agentDir?: string;
	webDist?: string;
	devMode: boolean;
	/** Ms a session may sit without WS subscribers before the reaper disposes it. 0 disables. */
	idleTimeoutMs: number;
	/** Absolute path to the sqlite database file. */
	dbPath: string;
	/** Absolute path to the uploads root (images pasted into task bodies). */
	uploadsRoot: string;
	/**
	 * The origin users actually reach this deck on, e.g. `https://deck.example.com`.
	 *
	 * Nothing about serving requests depends on it — the app is same-origin, so
	 * the browser resolves `/api/...` correctly whatever the hostname. It exists
	 * because the deck *talks about* URLs: onboarding text, the agent's own API
	 * base, OAuth instructions, notification links. Without it every one of those
	 * says `127.0.0.1`, which is right for a laptop and wrong for a server.
	 */
	publicUrl?: string;
	/**
	 * Prompt to fire automatically on every NEW session once a WS subscriber
	 * attaches. Empty string or null disables. Default: "/start" (expands to the
	 * ~/.omp/agent/commands/start.md slash command if present).
	 */
	autoStartCommand: string | null;
}

export function parseInt10(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) ? n : fallback;
}

export function parseAutoStart(value: string | undefined): string | null {
	// Default is OFF on a fresh install: a new session lands on an empty
	// composer waiting for the user's first prompt. Opt-in by setting the env
	// var (typically to `/start` after creating `~/.omp/agent/commands/start.md`).
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (trimmed === "" || trimmed === "0" || trimmed.toLowerCase() === "false") return null;
	return trimmed;
}

export function splitList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Normalize a configured public URL to a bare origin.
 *
 * Accepts what people actually type — `deck.example.com`, with or without a
 * scheme, with or without a trailing slash — and returns `https://deck.example.com`.
 * A bare hostname is assumed to be https: a deck published on a public hostname
 * without TLS is a mistake, not a configuration we should quietly render into
 * sign-in instructions.
 */
export function normalizePublicUrl(raw: string | undefined): string | undefined {
	const value = raw?.trim();
	if (!value) return undefined;
	const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
	try {
		const url = new URL(withScheme);
		return url.origin;
	} catch {
		return undefined;
	}
}

function resolveWebDist(): string | undefined {
	const explicit = process.env.OMP_DECK_WEB_DIST?.trim();
	const candidates = [
		explicit,
		// Common deployment layouts:
		path.resolve(process.cwd(), "public"),
		path.resolve(process.cwd(), "../web/dist"),
		path.resolve(process.cwd(), "../../apps/web/dist"),
	].filter((c): c is string => Boolean(c));
	for (const c of candidates) {
		try {
			if (fs.statSync(c).isDirectory()) return c;
		} catch {
			// not found — try the next candidate
		}
	}
	return undefined;
}

export function loadConfig(): Config {
	const home = os.homedir();
	const defaultCwd = process.env.OMP_DECK_DEFAULT_CWD?.trim() || home;
	const extra = splitList(process.env.OMP_DECK_WORKSPACES);
	const agentDir = process.env.OMP_AGENT_DIR?.trim() || undefined;
	const webDist = resolveWebDist();

	return {
		host: process.env.OMP_DECK_HOST?.trim() || "127.0.0.1",
		port: parseInt10(process.env.OMP_DECK_PORT, 8787),
		defaultCwd: path.resolve(defaultCwd),
		extraWorkspaces: extra.map((p) => path.resolve(p)),
		agentDir,
		webDist,
		devMode: process.env.NODE_ENV !== "production",
		// 5 minutes default. Set to 0 to disable reaping (kernels live until SIGINT).
		idleTimeoutMs: parseInt10(process.env.OMP_DECK_IDLE_TIMEOUT_MS, 5 * 60_000),
		dbPath: path.resolve(
			process.env.OMP_DECK_DB_PATH?.trim() ||
				process.env.OMP_DECK_DB?.trim() ||
				path.join(process.cwd(), "data", "deck.db"),
		),
		uploadsRoot: path.resolve(
			process.env.OMP_DECK_UPLOADS_ROOT?.trim() ||
				path.join(
					path.dirname(
						path.resolve(
							process.env.OMP_DECK_DB_PATH?.trim() ||
								process.env.OMP_DECK_DB?.trim() ||
								path.join(process.cwd(), "data", "deck.db"),
						),
					),
					"uploads",
				),
		),
		// Set OMP_DECK_AUTO_START="" or "0" to disable, or to any other prompt
		// string to override the default "/start" slash-command invocation.
		autoStartCommand: parseAutoStart(process.env.OMP_DECK_AUTO_START),
		publicUrl: normalizePublicUrl(process.env.OMP_DECK_PUBLIC_URL),
	};
}
