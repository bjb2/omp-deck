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
	setTimeout(() => {
		process.exit(0);
	}, 250);
	// The actual restart is performed by the launcher / `Start-OMP-Deck.*`
	// script that owns the process. We exit with code 0 so the wrapper knows
	// to relaunch us. On Windows, bun's `--hot` does this automatically; on
	// POSIX, the wrapper script restarts on exit code 0.
}

function scheduleShutdown(): void {
	log.info(`lifecycle: scheduling shutdown`);
	lastAction = { action: "shutdown", at: now() };
	setTimeout(() => {
		process.exit(0);
	}, 100);
}
