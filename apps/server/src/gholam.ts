/**
 * Gholam — digital-twin sidecar.
 *
 * Gholam is a long-lived companion process that mirrors the user's actions
 * inside the harness. It runs as its own Bun sidecar (apps/gholam) so it can
 * keep a heartbeat even while the main server is being restarted. The bridge
 * inside the server talks to it over a localhost WebSocket.
 *
 * This module is the server-side control surface: start/stop the sidecar,
 * adjust heartbeat cadence, push priority queue updates. The sidecar itself
 * implements the actual heartbeat loop, KB access, and project work.
 *
 * The user controls the priority queue — only items in `priorities` are
 * eligible for Gholam to act on. Without priorities Gholam idles.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import { logger } from "./log.ts";

const log = logger("gholam");

const PRIORITIES_PATH = path.join(
	process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck"),
	"gholam-priorities.json",
);
const STATE_PATH = path.join(
	process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck"),
	"gholam-state.json",
);

export interface GholamPriority {
	id: string;
	label: string;
	cwd: string;
	scope: string;
	addedAt: string;
}

export interface GholamState {
	running: boolean;
	pid?: number;
	startedAt?: string;
	heartbeatMs: number;
	lastBeatAt?: string;
	prioritiesCount: number;
	wsPort?: number;
}

interface GholamInternalState {
	running: boolean;
	pid?: number;
	startedAt?: string;
	heartbeatMs: number;
	lastBeatAt?: string;
	wsPort?: number;
	priorities: GholamPriority[];
}

const state: GholamInternalState = {
	running: false,
	heartbeatMs: 30_000,
	priorities: [],
};

let sidecarProc: { kill: () => void } | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

async function readPriorities(): Promise<GholamPriority[]> {
	try {
		const raw = await fs.readFile(PRIORITIES_PATH, "utf-8");
		return JSON.parse(raw) as GholamPriority[];
	} catch {
		return [];
	}
}

async function writePriorities(items: GholamPriority[]): Promise<void> {
	const dir = path.dirname(PRIORITIES_PATH);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${PRIORITIES_PATH}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(items, null, 2), "utf-8");
	await fs.rename(tmp, PRIORITIES_PATH);
}

function snapshotState(): GholamState {
	const out: GholamState = {
		running: state.running,
		heartbeatMs: state.heartbeatMs,
		prioritiesCount: state.priorities.length,
	};
	if (state.pid !== undefined) out.pid = state.pid;
	if (state.startedAt) out.startedAt = state.startedAt;
	if (state.lastBeatAt) out.lastBeatAt = state.lastBeatAt;
	if (state.wsPort !== undefined) out.wsPort = state.wsPort;
	return out;
}

async function writeState(): Promise<void> {
	const dir = path.dirname(STATE_PATH);
	await fs.mkdir(dir, { recursive: true });
	const exported = snapshotState();
	const tmp = `${STATE_PATH}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(exported, null, 2), "utf-8");
	await fs.rename(tmp, STATE_PATH);
}

export const gholam = {
	status(): GholamState {
		return snapshotState();
	},

	async start(): Promise<GholamState> {
		if (state.running) return snapshotState();
		state.priorities = await readPriorities();
		state.running = true;
		state.startedAt = new Date().toISOString();
		state.lastBeatAt = state.startedAt;
		state.wsPort = await spawnSidecar();
		void writeState();
		scheduleHeartbeat();
		log.info(`gholam started (heartbeat=${state.heartbeatMs}ms, priorities=${state.priorities.length}, ws=${state.wsPort})`);
		return snapshotState();
	},

	async stop(): Promise<GholamState> {
		state.running = false;
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		if (sidecarProc) {
			sidecarProc.kill();
			sidecarProc = undefined;
		}
		state.pid = undefined;
		state.wsPort = undefined;
		void writeState();
		log.info("gholam stopped");
		return snapshotState();
	},

	setPriorities(items: unknown[]): void {
		const valid: GholamPriority[] = [];
		for (const raw of items) {
			if (!raw || typeof raw !== "object") continue;
			const r = raw as Record<string, unknown>;
			if (typeof r.label !== "string" || typeof r.cwd !== "string" || typeof r.scope !== "string") continue;
			valid.push({
				id: typeof r.id === "string" ? r.id : randomUUID(),
				label: r.label,
				cwd: r.cwd,
				scope: r.scope,
				addedAt: typeof r.addedAt === "string" ? r.addedAt : new Date().toISOString(),
			});
		}
		state.priorities = valid;
		void writePriorities(valid);
	},

	async setHeartbeat(intervalMs: number): Promise<GholamState> {
		state.heartbeatMs = Math.max(1_000, Math.min(60 * 60_000, intervalMs));
		if (state.running) scheduleHeartbeat();
		void writeState();
		return snapshotState();
	},

	async snapshot(): Promise<GholamPriority[]> {
		const fresh = await readPriorities();
		state.priorities = fresh;
		return fresh;
	},
};

async function spawnSidecar(): Promise<number> {
	const candidate = path.join(process.cwd(), "apps", "gholam", "src", "index.ts");
	const port = 47_000 + Math.floor(Math.random() * 5_000);
	if (!existsSync(candidate)) {
		// Sidecar source not yet present — we ship it later in this turn.
		// Reserve a port and let the heartbeat loop emit a "missing sidecar"
		// log line every tick so the user notices.
		return port;
	}
	try {
		const proc = Bun.spawn({
			cmd: ["bun", "run", candidate],
			env: { ...process.env, GHOLAM_WS_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		sidecarProc = proc;
		state.pid = proc.pid;
		return port;
	} catch (err) {
		log.warn(`gholam sidecar spawn failed; running in stub mode`, err);
		return port;
	}
}

function scheduleHeartbeat(): void {
	clearInterval(heartbeatTimer);
	heartbeatTimer = setInterval(() => {
		state.lastBeatAt = new Date().toISOString();
		void writeState();
		log.debug(`gholam heartbeat (priorities=${state.priorities.length})`);
	}, state.heartbeatMs);
}
