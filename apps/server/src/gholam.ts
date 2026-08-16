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
import { broadcastBus } from "./broadcast-bus.ts";
import { gholamDeckLLM } from "./llm-registry.ts";
import type { AgentBridge } from "./bridge/types.ts";
import type { WsHub } from "./ws.ts";

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
	if (!token) return;
	gholamWsState = "connecting";
	// One-time migration warning: GHOLAM_WS_URL was the legacy key. New
	// code reads OMP_DECK_GHOLAM_EXTERNAL_URL instead. If we see the
	// legacy key but not the new one, the operator almost certainly
	// still has it set from a previous deploy — warn loudly so the
	// misconfig is visible in the logs even when the UI doesn't show it.
	if (process.env.GHOLAM_WS_URL && !process.env.OMP_DECK_GHOLAM_EXTERNAL_URL) {
		log.warn(`gholam: GHOLAM_WS_URL=${process.env.GHOLAM_WS_URL} is set but IGNORED — rename to OMP_DECK_GHOLAM_EXTERNAL_URL, or unset to use the in-process sidecar on ws://127.0.0.1:47900/ws`);
	}
	// External sidecar mode is opt-in under the explicit OMP_DECK_GHOLAM_EXTERNAL_URL
	// key. The legacy GHOLAM_WS_URL was misconfigured several times in production
	// (pointing at a broken-cert external host that never came up), leaving the
	// deck stuck "connecting". Renaming to an OMP_* key makes any leftover env
	// value inert — production always uses the in-process spawn at
	// ws://127.0.0.1:47900/ws unless this opt-in is set deliberately.
	const rawWsUrl = process.env.OMP_DECK_GHOLAM_EXTERNAL_URL?.trim() || "";
	if (rawWsUrl) {
		// External sidecar mode is opt-in (debugging / multi-host setups only).
		// Production decks always run gholam in-process via spawnSidecar();
		// an unexpected external URL is almost always misconfiguration that
		// leaves the deck stuck "connecting" forever, so log loudly.
		log.warn(`gholam: external sidecar mode active (OMP_DECK_GHOLAM_EXTERNAL_URL=${rawWsUrl}). In-process spawn disabled.`);
		const base = rawWsUrl.replace(/\/+$/, "");
		gholamWsUrl = base.endsWith("/ws") ? base : `${base}/ws`;
	} else if (port) {
		gholamWsUrl = `ws://127.0.0.1:${port}/ws`;
	} else {
		gholamWsState = "idle";
		return;
	}
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
	/** Last start-failure or spawn error. Cleared on successful start. */
	error?: string;
}

interface GholamInternalState {
	running: boolean;
	pid?: number;
	startedAt?: string;
	heartbeatMs: number;
	lastBeatAt?: string;
	wsPort?: number;
	priorities: GholamPriority[];
	/** Most recent start error. Cleared by a successful start(). */
	error?: string;
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
// ─── Companion runtime (set once by index.ts once the bridge + WsHub exist) ──
// The poll loop lives in the server process so it can talk to the bridge
// and broadcast bus directly. The sidecar is still the heartbeat owner;
// this stays a server-side companion.
let companionBridge: AgentBridge | undefined;
let companionWsHub: WsHub | undefined;
let idlePollTimer: ReturnType<typeof setInterval> | undefined;
/** Rolling 60s window of classification start-times (ms). Caps the global
 *  rate at 10/min regardless of how many idle sessions we discover. */
const classifyCalls: number[] = [];
const IDLE_THRESHOLD_MS = 5 * 60_000;
const IDLE_POLL_INTERVAL_MS = 60_000;
const CLASSIFY_WINDOW_MS = 60_000;
const CLASSIFY_MAX_PER_WINDOW = 10;
const CLASSIFY_MODEL = process.env.OMP_DECK_COMPANION_MODEL ?? "minimax/MiniMax-M3";
const TRANSCRIPT_LINES = 20;

/** Wire the bridge + WsHub so the idle-classification poll has somewhere to
 *  read session state and broadcast frames. Idempotent; safe to call once
 *  during server startup. */
export function setGholamCompanion(deps: { bridge: AgentBridge; wsHub: WsHub }): void {
	companionBridge = deps.bridge;
	companionWsHub = deps.wsHub;
	startIdlePoll();
}

function startIdlePoll(): void {
	if (idlePollTimer) return;
	idlePollTimer = setInterval(() => {
		void classifyIdleSessions();
	}, IDLE_POLL_INTERVAL_MS);
	(idlePollTimer as unknown as { unref?: () => void }).unref?.();
}

function stopIdlePoll(): void {
	if (idlePollTimer) {
		clearInterval(idlePollTimer);
		idlePollTimer = undefined;
	}
}

function pruneClassifyWindow(now: number): void {
	const cutoff = now - CLASSIFY_WINDOW_MS;
	while (classifyCalls.length > 0 && classifyCalls[0]! < cutoff) classifyCalls.shift();
}

function classifyBudgetAvailable(now: number): boolean {
	pruneClassifyWindow(now);
	return classifyCalls.length < CLASSIFY_MAX_PER_WINDOW;
}

async function readLastTranscriptLines(path: string | undefined, n: number): Promise<string[]> {
	if (!path) return [];
	try {
		const text = await fs.readFile(path, "utf-8");
		const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
		return lines.slice(-n);
	} catch {
		return [];
	}
}

type Hint = "working" | "needs_input" | "error" | "done" | "idle";
const VALID_HINTS: ReadonlySet<Hint> = new Set<Hint>(["working", "needs_input", "error", "done", "idle"]);

/** Pull the first non-whitespace token from the model's response and map it
 *  to a known hint. Falls back to `idle` when the output is garbage so the
 *  UI never sees an unknown value. */
function parseHint(text: string): Hint {
	const token = text.trim().toLowerCase().split(/\s+/)[0] ?? "";
	return VALID_HINTS.has(token as Hint) ? (token as Hint) : "idle";
}

async function classifyOne(sessionId: string, sessionFile: string | undefined): Promise<void> {
	const lines = await readLastTranscriptLines(sessionFile, TRANSCRIPT_LINES);
	const transcript = lines.length > 0 ? lines.join("\n") : "(no transcript available)";
	let text = "";
	try {
		for await (const chunk of gholamDeckLLM.complete({
			model: CLASSIFY_MODEL,
			messages: [
				{
					role: "system",
					content: "Classify the agent's current state from the recent transcript. Answer with exactly one word: working, needs_input, error, done, or idle.",
				},
				{ role: "user", content: transcript },
			],
		})) {
			if (chunk.type === "text") text += chunk.delta;
			else if (chunk.type === "error") {
				log.warn(`classify ${sessionId} LLM error: ${chunk.error}`);
				return;
			}
		}
	} catch (err) {
		log.warn(`classify ${sessionId} failed`, err);
		return;
	}
	const hint = parseHint(text);
	broadcastBus.broadcast({ type: "session_status_hint", sessionId, hint });
}

async function classifyIdleSessions(): Promise<void> {
	if (!companionBridge) return;
	let idle: { sessionId: string; lastActivityAt: number }[];
	try {
		idle = await companionBridge.listIdleSessions(IDLE_THRESHOLD_MS);
	} catch (err) {
		log.warn(`listIdleSessions failed`, err);
		return;
	}
	if (idle.length === 0) return;
	// Skip work entirely while the user is actively at their desk — the
	// push-notification gate applies to classification too: a hint is only
	// useful when the user is away.
	if (companionWsHub?.hasRecentActivity(30_000)) return;
	const now = Date.now();
	for (const { sessionId, lastActivityAt } of idle) {
		// Re-check the threshold: a session may have become active between
		// the snapshot and the loop reaching it.
		if (Date.now() - lastActivityAt < IDLE_THRESHOLD_MS) continue;
		if (!classifyBudgetAvailable(now)) {
			log.debug(`classify budget exhausted (${classifyCalls.length}/${CLASSIFY_MAX_PER_WINDOW} in last ${CLASSIFY_WINDOW_MS}ms)`);
			return;
		}
		classifyCalls.push(Date.now());
		const handle = companionBridge.getSession(sessionId);
		try {
			await classifyOne(sessionId, handle?.sessionFile);
		} catch (err) {
			log.warn(`classify ${sessionId} threw`, err);
		}
	}
}

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
	if (state.error) out.error = state.error;
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
		state.error = undefined;
		// Reuse a persisted token if the deck restarted but the sidecar
		// is still using the old one; otherwise mint a fresh one and
		// write it to disk so the sidecar can read it back via env.
		state.gholamToken = await currentGholamToken();
		try {
			state.wsPort = await spawnSidecar();
		} catch (err) {
			const msg = (err as Error).message ?? String(err);
			state.error = msg;
			state.running = false;
			state.wsPort = undefined;
			sidecarProc = undefined;
			state.pid = undefined;
			clearInterval(heartbeatTimer);
			heartbeatTimer = undefined;
			log.warn(`gholam start failed: ${msg}`);
			void writeState();
			return snapshotState();
		}
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
	const containerCandidate = path.resolve(process.cwd(), "..", "gholam", "src", "index.ts");
	const cwdCandidate = path.join(process.cwd(), "apps", "gholam", "src", "index.ts");
	const candidate = existsSync(containerCandidate) ? containerCandidate : cwdCandidate;
	// If the operator pinned a port (e.g. exposed via deploy env), honor it
	// exactly. Otherwise pick a deterministic default in the
	// IANA-dynamic/private range (47900 is what apps/gholam/src/index.ts
	// reads from `GHOLAM_WS_PORT` by default). Deterministic ports make
	// restarts predictable and let the deck-side handshake know where to
	// dial without env plumbing.
	const basePort = Number.parseInt(process.env.OMP_DECK_GHOLAM_PORT ?? "47900", 10);
	if (!Number.isFinite(basePort) || basePort < 1024 || basePort > 65535) {
		throw new Error(`OMP_DECK_GHOLAM_PORT=${process.env.OMP_DECK_GHOLAM_PORT} is not a valid port`);
	}
	if (!existsSync(candidate)) {
		throw new Error(`gholam sidecar source not found at ${candidate} — Dockerfile must COPY apps/gholam`);
	}
	const env: Record<string, string> = {
		...process.env,
		GHOLAM_WS_PORT: String(basePort),
		GHOLAM_DECK_TOKEN: state.gholamToken ?? "",
	};
	// Try the pinned port, then bump up to 5 times on EADDRINUSE so a
	// stale sidecar from a prior crash doesn't wedge the deck.
	let lastError: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		const port = basePort + attempt;
		const proc = Bun.spawn({
			cmd: ["bun", "run", candidate],
			env: { ...env, GHOLAM_WS_PORT: String(port) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		// Give the sidecar a moment to bind. If it exits cleanly within
		// 250ms with a stderr line about EADDRINUSE, retry the next port.
		await new Promise((r) => setTimeout(r, 250));
		const probe = await Promise.race([
			proc.exited,
			new Promise<null>((r) => setTimeout(() => r(null), 0)),
		]);
		if (probe === null) {
			sidecarProc = proc;
			state.pid = proc.pid;
			state.error = undefined;
			return port;
		}
		const exitCode = proc.exitCode;
		const stderr = await new Response(proc.stderr).text();
		lastError = stderr.trim() || `exit ${exitCode}`;
		if (!/EADDRINUSE|already in use/i.test(lastError as string)) {
			// Some other failure (e.g. bad import). Surface immediately.
			throw new Error(`gholam sidecar exited (port ${port}): ${lastError}`);
		}
		log.warn(`gholam: port ${port} busy, retrying on ${port + 1}`);
	}
	throw new Error(`gholam sidecar failed to bind on any port in [${basePort}, ${basePort + 4}]: ${lastError}`);
}

function scheduleHeartbeat(): void {
	clearInterval(heartbeatTimer);
	heartbeatTimer = setInterval(() => {
		state.lastBeatAt = new Date().toISOString();
		void writeState();
		log.debug(`gholam heartbeat (priorities=${state.priorities.length})`);
	}, state.heartbeatMs);
}
