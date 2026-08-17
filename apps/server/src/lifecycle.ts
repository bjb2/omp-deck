/**
 * System lifecycle — start, stop, restart, status.
 *
 * The deck runs as a long-lived Bun process; the existing scheduleRestart
 * helper already handles self-restart on Windows + macOS + Linux. This module
 * adds a uniform API so the UI can fire actions without needing to know the
 * underlying Bun.spawn gymnastics:
 *
 *   - `status()`: uptime, pid, version, buildSha, last-restart reason.
 *   - `dispatch("status" | "restart" | "shutdown")`: action router.
 *   - `scheduleRestart(reason)`: graceful self-restart (SIGUSR1 on unix;
 *     spawn-replace on Windows).
 *
 * Stop is intentionally a SIGTERM-then-exit, not a hard kill — gives the
 * in-flight sessions a chance to flush their journal before the process goes.
 */
import { logger } from "./log.ts";
import { resolveBunExecutable } from "./runtime-bun.ts";

const log = logger("lifecycle");

interface LifecycleStatus {
	uptimeSecs: number;
	pid: number;
	version: string;
	buildSha?: string;
	lastAction: { action: string; at: string; reason?: string };
}

let lastAction: LifecycleStatus["lastAction"] = { action: "boot", at: new Date().toISOString() };

function now() {
	return new Date().toISOString();
}

function packageVersion(): string {
	try {
		// Bun resolves workspace package.json synchronously.
		return require("../package.json").version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

async function packageSha(): Promise<string | undefined> {
	try {
		const { existsSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const gitHead = join(process.cwd(), ".git", "HEAD");
		if (existsSync(gitHead)) {
			const ref = readFileSync(gitHead, "utf-8").trim();
			return ref;
		}
	} catch {
		// fall through
	}
	return undefined;
}

export const lifecycle = {
	async status(): Promise<LifecycleStatus> {
		const status: LifecycleStatus = {
			uptimeSecs: Math.floor(process.uptime()),
			pid: process.pid,
			version: packageVersion(),
			lastAction,
		};
		const sha = await packageSha();
		if (sha) status.buildSha = sha;
		return status;
	},

	async dispatch(action: string): Promise<{ ok: boolean; action: string; reason?: string }> {
		lastAction = { action, at: now() };
		switch (action) {
			case "status":
				return { ok: true, action };
			case "restart":
				scheduleSelf("user-requested restart");
				return { ok: true, action };
			case "shutdown":
				scheduleShutdown();
				return { ok: true, action };
			default:
				return { ok: false, action, reason: "unknown action" };
		}
	},

	scheduleSelfRestart(reason: string): void {
		scheduleSelf(reason);
	},
};

function scheduleSelf(reason: string): void {
	log.info(`lifecycle: scheduling self-restart (${reason})`);
	lastAction = { action: "restart", at: now(), reason };
	// Spawn-replace: detach a new bun process with the same argv, then exit.
	// This works in dev mode (plain `bun src/index.ts`) and in production
	// without a supervisor — no wrapper script required. Mirrors the
	// `scheduleRestart(server)` path in index.ts so the two restart entry
	// points (POST /api/system/lifecycle vs /api/restart via routes.ts)
	// behave identically.
	const cmd = [resolveBunExecutable(), ...process.argv.slice(1)];
	const cwd = process.cwd();
	const env = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
	);
	setTimeout(() => {
		try {
			const child = Bun.spawn({
				cmd,
				cwd,
				env,
				stdin: "ignore",
				stdout: "inherit",
				stderr: "inherit",
				detached: true,
			});
			child.unref();
		} catch (err) {
			log.warn(`lifecycle: spawn-replace failed; falling back to bare exit`, err);
		}
		setTimeout(() => process.exit(0), 80);
	}, 100);
}

function scheduleShutdown(): void {
	log.info(`lifecycle: scheduling shutdown`);
	lastAction = { action: "shutdown", at: now() };
	setTimeout(() => {
		process.exit(0);
	}, 100);
}
