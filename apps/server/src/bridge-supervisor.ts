import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import type { BridgeInfo, BridgeLogLine, BridgeName, BridgeStatus } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { resolveBunExecutable } from "./runtime-bun.ts";
import { bridgeSpawnEnv } from "./spawn-env.ts";

const log = logger("bridges");

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolved path to the telegram bridge entry. In dev the server runs from
 * `apps/server/src/`, so the bridge entry sits four hops away. In production
 * builds (server bundled into `dist/`) the operator can override via
 * `OMP_BRIDGE_TELEGRAM_ENTRY`.
 */
function defaultTelegramEntry(): string {
	const override = process.env.OMP_BRIDGE_TELEGRAM_ENTRY?.trim();
	if (override) return path.resolve(override);
	return path.resolve(here, "..", "..", "bridges", "telegram", "src", "index.ts");
}

interface BridgeSpec {
	name: BridgeName;
	label: string;
	entry: string;
	requiredEnv: string[];
}

class LogRing {
	private buf: BridgeLogLine[] = [];
	constructor(private readonly capacity: number) {}
	push(line: BridgeLogLine): void {
		this.buf.push(line);
		if (this.buf.length > this.capacity) this.buf.shift();
	}
	snapshot(): BridgeLogLine[] {
		return this.buf.slice();
	}
	clear(): void {
		this.buf = [];
	}
}

interface Tracked {
	spec: BridgeSpec;
	proc?: Subprocess;
	startedAt?: number;
	stoppedAt?: number;
	status: BridgeStatus;
	exitCode?: number;
	exitSignal?: string;
	crashCount: number;
	logs: LogRing;
	stopRequested: boolean;
	lastError?: string;
}

export class BridgeSupervisor {
	private readonly tracked = new Map<BridgeName, Tracked>();

	constructor(specs: BridgeSpec[]) {
		for (const spec of specs) {
			this.tracked.set(spec.name, {
				spec,
				status: "stopped",
				crashCount: 0,
				logs: new LogRing(200),
				stopRequested: false,
			});
		}
	}

	list(): BridgeInfo[] {
		return Array.from(this.tracked.values()).map((t) => this.toInfo(t));
	}

	get(name: BridgeName): BridgeInfo {
		const t = this.requireBridge(name);
		return this.toInfo(t);
	}

	async start(name: BridgeName): Promise<BridgeInfo> {
		const t = this.requireBridge(name);
		if (t.proc) return this.toInfo(t);

		const missing = this.missingEnv(t.spec);
		if (missing.length > 0) {
			t.lastError = `missing required env: ${missing.join(", ")}`;
			throw new Error(t.lastError);
		}

		t.stopRequested = false;
		t.lastError = undefined;
		t.logs.clear();
		t.status = "starting";

		let proc: Subprocess;
		try {
			proc = Bun.spawn({
				// Use the resolved Bun path rather than `process.execPath` directly.
				// `process.execPath` can be stale (issue #6: user reinstalls Bun /
				// uninstalls the official-installer copy / switches version managers
				// after deck boot) and posix_spawn ENOENTs on it. `resolveBunExecutable`
				// falls back to a PATH lookup.
				cmd: [resolveBunExecutable(), t.spec.entry],
				cwd: path.dirname(t.spec.entry),
				// SECURITY-019: bridges inherit only what they declare. The
				// default allow-list carries the deck API token + agent dir;
				// spec.requiredEnv adds per-bridge keys (e.g. TELEGRAM_BOT_TOKEN).
				// Anything else — provider keys, MCP tokens — is dropped here.
				env: bridgeSpawnEnv(t.spec.requiredEnv),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				onExit: (_subprocess, exitCode, signalCode, _error) => {
					t.proc = undefined;
					t.exitCode = exitCode ?? undefined;
					t.exitSignal = signalCode != null ? String(signalCode) : undefined;
					t.stoppedAt = Date.now();
					if (t.stopRequested) {
						t.status = "stopped";
					} else {
						t.crashCount += 1;
						t.status = "crashed";
						log.warn(`bridge ${name} crashed`, { exitCode, signalCode });
					}
				},
			});
		} catch (err) {
			t.status = "crashed";
			t.lastError = String(err);
			throw err;
		}

		t.proc = proc;
		t.startedAt = Date.now();
		t.stoppedAt = undefined;
		t.exitCode = undefined;
		t.exitSignal = undefined;
		t.status = "running";

		void pumpStream(t, proc.stdout as ReadableStream<Uint8Array>, "stdout");
		void pumpStream(t, proc.stderr as ReadableStream<Uint8Array>, "stderr");
		log.info(`bridge ${name} started pid=${proc.pid}`);
		return this.toInfo(t);
	}

	async stop(name: BridgeName): Promise<BridgeInfo> {
		const t = this.requireBridge(name);
		if (!t.proc) {
			t.status = "stopped";
			return this.toInfo(t);
		}
		t.stopRequested = true;
		try {
			t.proc.kill();
		} catch (err) {
			log.warn(`bridge ${name} kill threw`, err);
		}
		try {
			await t.proc.exited;
		} catch {
			// ignore — onExit already updated bookkeeping
		}
		// onExit may fire before or after `exited` resolves on Bun's Windows
		// path. Force-converge state so the response reflects the actual
		// post-stop reality rather than whatever the race produced.
		t.proc = undefined;
		t.status = "stopped";
		t.lastError = undefined;
		t.stoppedAt = t.stoppedAt ?? Date.now();
		return this.toInfo(t);
	}

	async restart(name: BridgeName): Promise<BridgeInfo> {
		await this.stop(name);
		return this.start(name);
	}

	logs(name: BridgeName): BridgeLogLine[] {
		return this.requireBridge(name).logs.snapshot();
	}

	async shutdown(): Promise<void> {
		await Promise.all(
			Array.from(this.tracked.keys()).map((name) =>
				this.stop(name).catch((err) => log.warn(`bridge ${name} shutdown failed`, err)),
			),
		);
	}

	private requireBridge(name: BridgeName): Tracked {
		const t = this.tracked.get(name);
		if (!t) throw new Error(`unknown bridge: ${name}`);
		return t;
	}

	private missingEnv(spec: BridgeSpec): string[] {
		return spec.requiredEnv.filter((key) => !(process.env[key] ?? "").trim());
	}

	private toInfo(t: Tracked): BridgeInfo {
		const info: BridgeInfo = {
			name: t.spec.name,
			label: t.spec.label,
			status: t.status,
			crashCount: t.crashCount,
			missingEnv: this.missingEnv(t.spec),
			requiredEnv: [...t.spec.requiredEnv],
		};
		if (t.proc) info.pid = t.proc.pid;
		if (t.startedAt) info.startedAt = new Date(t.startedAt).toISOString();
		if (t.stoppedAt) info.stoppedAt = new Date(t.stoppedAt).toISOString();
		if (t.exitCode !== undefined) info.exitCode = t.exitCode;
		if (t.exitSignal !== undefined) info.exitSignal = t.exitSignal;
		if (t.lastError) info.lastError = t.lastError;
		return info;
	}
}

async function pumpStream(t: Tracked, stream: ReadableStream<Uint8Array> | undefined, label: "stdout" | "stderr"): Promise<void> {
	if (!stream) return;
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let pending = "";
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			pending += decoder.decode(value, { stream: true });
			let nl = pending.indexOf("\n");
			while (nl !== -1) {
				const raw = pending.slice(0, nl).replace(/\r$/, "");
				pending = pending.slice(nl + 1);
				if (raw) t.logs.push({ stream: label, text: raw, timestamp: new Date().toISOString() });
				nl = pending.indexOf("\n");
			}
		}
		const tail = pending.trim();
		if (tail) t.logs.push({ stream: label, text: tail, timestamp: new Date().toISOString() });
	} catch (err) {
		log.warn(`bridge ${t.spec.name} ${label} pump failed`, err);
	}
}

export function buildDefaultBridgeSupervisor(): BridgeSupervisor {
	return new BridgeSupervisor([
		{
			name: "telegram",
			label: "Telegram",
			entry: defaultTelegramEntry(),
			requiredEnv: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_USERS"],
		},
	]);
}
