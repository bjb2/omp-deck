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

import { currentGholamToken, revokeGholamToken } from "./gholam-token.ts";
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

const GHOLAM_WS_PROTO = "omp-gholam-v1";

// ─── Deck ↔ sidecar control channel ──────────────────────────────────────────
// A tiny self-managed WebSocket that talks to the sidecar's `/ws` endpoint
// using the `Sec-WebSocket-Protocol: omp-gholam-v1, <token>` subprotocol
// the sidecar validates before upgrading. The browser-facing `/ws` is a
// separate channel; this one is private to the deck process.
let gholamWs: WebSocket | undefined;
let gholamWsState: "idle" | "connecting" | "open" | "closed" = "idle";
let gholamWsUrl: string | undefined;
let gholamSendQueue: string[] = [];
let gholamReconnectTimer: ReturnType<typeof setTimeout> | undefined;
const gholamFrameListeners = new Set<(frame: { type: string; [k: string]: unknown }) => void>();

function openGholamWs(): void {
	if (gholamWsState === "open" || gholamWsState === "connecting") return;
	const port = state.wsPort;
	const token = state.gholamToken;
	if (!port || !token) return;
	gholamWsState = "connecting";
	gholamWsUrl = `ws://127.0.0.1:${port}/ws`;
	// Bun's WebSocket constructor accepts protocols as the second/third
	// argument. The sidecar reads the `omp-gholam-v1, <token>` suffix and
	// rejects upgrades whose token does not match `GHOLAM_DECK_TOKEN`.
	const sock = new WebSocket(gholamWsUrl, [`${GHOLAM_WS_PROTO}, ${token}`, GHOLAM_WS_PROTO]);
	gholamWs = sock;
	sock.addEventListener("open", () => {
		gholamWsState = "open";
		while (gholamSendQueue.length > 0 && sock.readyState === WebSocket.OPEN) {
			const f = gholamSendQueue.shift()!;
			sock.send(f);
		}
	});
	sock.addEventListener("message", (ev) => {
		try {
			const data = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
			const frame = JSON.parse(data) as { type: string; [k: string]: unknown };
			for (const l of gholamFrameListeners) {
				try { l(frame); } catch (err) { log.warn("gholam ws listener threw", err); }
			}
		} catch (err) {
			log.warn("gholam ws bad frame", err);
		}
	});
	const teardown = (): void => {
		gholamWs = undefined;
		gholamWsState = "closed";
		if (state.running) scheduleGholamReconnect();
	};
	sock.addEventListener("close", teardown);
	sock.addEventListener("error", () => sock.close());
}

function scheduleGholamReconnect(): void {
	if (gholamReconnectTimer) return;
	gholamReconnectTimer = setTimeout(() => {
		gholamReconnectTimer = undefined;
		openGholamWs();
	}, 1_000);
}

function disposeGholamWs(): void {
	if (gholamReconnectTimer) {
		clearTimeout(gholamReconnectTimer);
		gholamReconnectTimer = undefined;
	}
	gholamWs?.close();
	gholamWs = undefined;
	gholamWsState = "closed";
	gholamSendQueue = [];
}

/** Send a JSON frame to the sidecar. Lazily connects on first call. */
export function sendGholamFrame(frame: { type: string; [k: string]: unknown }): void {
	const payload = JSON.stringify(frame);
	if (gholamWs && gholamWs.readyState === WebSocket.OPEN) {
		gholamWs.send(payload);
		return;
	}
	gholamSendQueue.push(payload);
	if (gholamWsState === "idle") openGholamWs();
}

export function onGholamFrame(l: (frame: { type: string; [k: string]: unknown }) => void): () => void {
	gholamFrameListeners.add(l);
	return () => gholamFrameListeners.delete(l);
}

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
	/** Bearer token the sidecar's WS handshake validates. Persisted in
	 *  `OMP_DECK_DATA_DIR/gholam-token.json` so the sidecar can re-attach
	 *  after a deck restart without the deck re-minting. */
	gholamToken?: string;
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
		// Reuse a persisted token if the deck restarted but the sidecar
		// is still using the old one; otherwise mint a fresh one and
		// write it to disk so the sidecar can read it back via env.
		state.gholamToken = await currentGholamToken();
		state.wsPort = await spawnSidecar();
		void writeState();
		scheduleHeartbeat();
		openGholamWs();
		log.info(`gholam started (heartbeat=${state.heartbeatMs}ms, priorities=${state.priorities.length}, ws=${state.wsPort})`);
		return snapshotState();
	},

	async stop(): Promise<GholamState> {
		disposeGholamWs();
		state.running = false;
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
		if (sidecarProc) {
			sidecarProc.kill();
			sidecarProc = undefined;
		}
		state.pid = undefined;
		state.wsPort = undefined;
		await revokeGholamToken();
		state.gholamToken = undefined;
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

	/**
	 * Push a file edit through the gholam sidecar via `mcp_call` to the
	 * github MCP server. Returns `{ ok, ref, contentSha }` on success or
	 * `{ ok: false, error }` on failure. The deck never reaches GitHub
	 * directly; the sidecar is the only process that should have the PAT.
	 */
	async edit(opts: {
		owner: string;
		repo: string;
		path: string;
		content: string;
		message?: string;
		branch?: string;
		sha?: string;
	}): Promise<{ ok: boolean; ref?: string; contentSha?: string; error?: string }> {
		if (!state.running) return { ok: false, error: "gholam not running" };
		const id = `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const { promise, resolve } = Promise.withResolvers<{ ok: boolean; ref?: string; contentSha?: string; error?: string }>();
		let settled = false;
		const settle = (v: { ok: boolean; ref?: string; contentSha?: string; error?: string }): void => {
			if (settled) return;
			settled = true;
			dispose();
			clearTimeout(timer);
			resolve(v);
		};
		const dispose = onGholamFrame((frame) => {
			if (frame.type === "mcp_reply" && frame.id === id) {
				if (frame.ok) {
					const result = (frame.result ?? {}) as { commit?: { sha?: string }; content?: { sha?: string } };
					settle({ ok: true, ref: result.commit?.sha, contentSha: result.content?.sha });
				} else {
					settle({ ok: false, error: typeof frame.error === "string" ? frame.error : "github mcp call failed" });
				}
			}
		});
		const timer = setTimeout(() => {
			settle({ ok: false, error: "github mcp call timed out" });
		}, 60_000);
		sendGholamFrame({
			type: "mcp_call",
			id,
			server: "github",
			method: "create_or_update_file",
			params: {
				owner: opts.owner,
				repo: opts.repo,
				path: opts.path,
				content: opts.content,
				message: opts.message ?? `gholam: edit ${opts.path}`,
				...(opts.branch ? { branch: opts.branch } : {}),
				...(opts.sha ? { sha: opts.sha } : {}),
			},
		});
		return await promise;
	},
};

/**
 * Resolve `owner/repo` from a cwd's `git remote origin` URL. Falls back to
 * `OMP_DECK_REPO` (env of form `owner/repo`) when no git context is
 * available. Returns null when neither resolves.
 */
export async function parseRemoteOwnerRepo(cwd: string): Promise<{ owner: string; repo: string } | null> {
	try {
		const proc = Bun.spawn({
			cmd: ["git", "-C", cwd, "config", "--get", "remote.origin.url"],
			stdio: ["ignore", "pipe", "pipe"],
		});
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		const url = text.trim();
		if (url) {
			const m = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(url);
			if (m && m[1] && m[2]) return { owner: m[1], repo: m[2] };
		}
	} catch (err) {
		log.warn(`parseRemoteOwnerRepo(${cwd}) git failed`, err);
	}
	const envRepo = process.env.OMP_DECK_REPO?.trim();
	if (envRepo && envRepo.includes("/")) {
		const [owner, repo] = envRepo.split("/", 2);
		if (owner && repo) return { owner, repo };
	}
	return null;
}

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
		const env: Record<string, string> = {
			...process.env,
			GHOLAM_WS_PORT: String(port),
			GHOLAM_DECK_TOKEN: state.gholamToken ?? "",
		};
		const proc = Bun.spawn({
			cmd: ["bun", "run", candidate],
			env,
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
