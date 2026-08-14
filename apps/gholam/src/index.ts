/**
 * Gholam sidecar — long-lived companion process for the deck.
 *
 * Architecture:
 *
 *   deck server  ──HTTP+WS──▶  gholam sidecar (this file)
 *                                     │
 *                                     ├── heartbeat loop (every 30s by default)
 *                                     ├── KB indexer (reads <OMP_DECK_KB_ROOT>)
 *                                     ├── priority queue listener (user-controlled)
 *                                     └── outbound WS bridge (chat overlay)
 *
 * The sidecar runs as its own Bun process so its heartbeat survives a server
 * restart. The deck server owns the priority queue — items land here only
 * after the user has explicitly added them; Gholam never picks its own
 * targets.
 *
 * This file is intentionally small: most logic lives in the server-side
 * `gholam` module that spawned us. The sidecar is essentially a WS endpoint
 * that listens for "priorities" / "tick" / "shutdown" frames and emits
 * "heartbeat" / "activity" frames back. The deck's web UI connects to it
 * over the WS port chosen at spawn time (env GHOLAM_WS_PORT).
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerWebSocket } from "bun";

const log = (...args: unknown[]) => console.log("[gholam]", ...args);
const warn = (...args: unknown[]) => console.warn("[gholam:warn]", ...args);

const WS_PORT = Number.parseInt(process.env.GHOLAM_WS_PORT ?? "47900", 10);
const OMP_DECK_DATA_DIR = process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck");
const KB_ROOT = process.env.OMP_DECK_KB_ROOT ?? path.join(os.homedir(), "kb");
const PRIORITIES_PATH = path.join(OMP_DECK_DATA_DIR, "gholam-priorities.json");
const GHOLAM_DECK_TOKEN = process.env.GHOLAM_DECK_TOKEN ?? "";
const GHOLAM_WS_PROTO = "omp-gholam-v1";
const OPENSHIP_TOKEN = process.env.MCP_OPENSHIP_TOKEN ?? "";
const GITHUB_PAT = process.env.GITHUB_PERSONAL_ACCESS_TOKEN ?? "";
const PARALLEL_TOKEN = process.env.MCP_PARALLEL_TOKEN ?? "";
const EXA_API_KEY = process.env.EXA_API_KEY ?? "";
const TAVILY_API_KEY = process.env.TAVILY_API_KEY ?? "";
const MCP_IDLE_KILL_MS = Number.parseInt(process.env.MCP_IDLE_KILL_MS ?? "30000", 10);

// ─── MCP client bridges (lazy-started) ──────────────────────────────────────
import {
	startExaMcp,
	startGithubMcp,
	startOpenshipClient,
	startParallelMcp,
	startTavilyMcp,
} from "./mcp-clients.ts";
type McpHandle = { send: (line: string) => void; onMessage: (fn: (line: string) => void) => void; kill: () => void };
let githubMcp: McpHandle | undefined;
let openshipClient: { call: (method: string, params: Record<string, unknown>) => Promise<unknown> } | undefined;
let parallelMcp: McpHandle | undefined;
let exaMcp: McpHandle | undefined;
let tavilyMcp: McpHandle | undefined;
/** Idle-kill timer per child. Reset on every activity; fires `kill()` after
 *  `MCP_IDLE_KILL_MS` of silence — matches the "best-effort, lossy" rule. */
const idleTimers: { github?: ReturnType<typeof setTimeout>; parallel?: ReturnType<typeof setTimeout>; exa?: ReturnType<typeof setTimeout>; tavily?: ReturnType<typeof setTimeout> } = {};
function resetIdleTimer(name: "github" | "parallel" | "exa" | "tavily"): void {
	const handle = name === "github" ? githubMcp : name === "parallel" ? parallelMcp : name === "exa" ? exaMcp : tavilyMcp;
	if (!handle) return;
	if (idleTimers[name]) clearTimeout(idleTimers[name]!);
	idleTimers[name] = setTimeout(() => {
		try { handle.kill(); } catch (err) { warn("idle kill failed", err); }
		if (name === "github") githubMcp = undefined;
		if (name === "parallel") parallelMcp = undefined;
		if (name === "exa") exaMcp = undefined;
		if (name === "tavily") tavilyMcp = undefined;
	}, MCP_IDLE_KILL_MS);
}

// Track in-flight MCP calls (id → caller socket id) so we can route
// `mcp_reply` frames back to the deck.
const pendingMcp = new Map<string, { socketId: string; server: string }>();
const pendingDeployWatch = new Map<string, { socketId: string; projectId: string; timer: ReturnType<typeof setInterval> }>();

/** Lazily start the MCP clients on first mcp_call. Surfaced errors are
 *  emitted as `mcp_reply` with ok:false so the deck never sees a hang. */
function ensureMcpClients(): { openship?: string; github?: string; parallel?: string; exa?: string; tavily?: string } {
	const errors: { openship?: string; github?: string; parallel?: string; exa?: string; tavily?: string } = {};
	if (!openshipClient && OPENSHIP_TOKEN) {
		try {
			openshipClient = startOpenshipClient(OPENSHIP_TOKEN);
		} catch (err) {
			errors.openship = (err as Error).message;
		}
	} else if (!OPENSHIP_TOKEN) {
		errors.openship = "MCP_OPENSHIP_TOKEN not set in env";
	}
	if (!githubMcp && GITHUB_PAT) {
		try {
			githubMcp = sendGithubMcpChild();
		} catch (err) {
			errors.github = (err as Error).message;
		}
	} else if (!GITHUB_PAT) {
		errors.github = "GITHUB_PERSONAL_ACCESS_TOKEN not set in env";
	}
	if (!parallelMcp && PARALLEL_TOKEN) {
		try {
			parallelMcp = startParallelMcp(PARALLEL_TOKEN);
		} catch (err) {
			errors.parallel = (err as Error).message;
		}
	} else if (!PARALLEL_TOKEN) {
		errors.parallel = "MCP_PARALLEL_TOKEN not set in env";
	}
	if (!exaMcp && EXA_API_KEY) {
		try {
			exaMcp = startExaMcp(EXA_API_KEY);
		} catch (err) {
			errors.exa = (err as Error).message;
		}
	} else if (!EXA_API_KEY) {
		errors.exa = "EXA_API_KEY not set in env";
	}
	if (!tavilyMcp && TAVILY_API_KEY) {
		try {
			tavilyMcp = startTavilyMcp(TAVILY_API_KEY);
		} catch (err) {
			errors.tavily = (err as Error).message;
		}
	} else if (!TAVILY_API_KEY) {
		errors.tavily = "TAVILY_API_KEY not set in env";
	}
	return errors;
}

/** Spawn the github MCP stdio child, mirroring the agent-defaults mcp.json.tmpl
 *  stanza (docker run -i --rm ghcr.io/github/github-mcp-server). Stdout
 *  frames are routed back to the originating socket via `mcp_reply`. */
function sendGithubMcpChild(): McpHandle {
	const child = Bun.spawn({
		cmd: [
			"docker", "run", "-i", "--rm",
			"-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
			"ghcr.io/github/github-mcp-server",
		],
		env: {
			...process.env,
			GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_PAT,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const handle = startGithubMcp({
		child,
		kill: () => child.kill(),
	});
	// Route each JSON-RPC response back to the socket that initiated the call.
	handle.onMessage((line) => {
		let parsed: { id?: unknown; result?: unknown; error?: unknown };
		try { parsed = JSON.parse(line) as typeof parsed; } catch { return; }
		if (typeof parsed.id !== "string") return;
		const rec = pendingMcp.get(parsed.id);
		if (!rec) return;
		pendingMcp.delete(parsed.id);
		if (parsed.error !== undefined) {
			sendMcpReply(rec.socketId, { type: "mcp_reply", id: parsed.id, ok: false, error: typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error) });
		} else {
			sendMcpReply(rec.socketId, { type: "mcp_reply", id: parsed.id, ok: true, result: parsed.result });
		}
	});
	return handle;
}

function sendMcpReply(socketId: string, reply: { type: "mcp_reply"; id: string; ok: boolean; result?: unknown; error?: string }): void {
	const sock = sockets.get(socketId);
	if (sock) {
		try { sock.send(JSON.stringify(reply)); } catch (err) { warn("mcp_reply send failed", err); }
	}
}

function sendDeployState(socketId: string, state: Record<string, unknown>): void {
	const sock = sockets.get(socketId);
	const frame = { type: "deploy_state" as const, state: { ts: new Date().toISOString(), ...state } };
	if (sock) {
		try { sock.send(JSON.stringify(frame)); } catch (err) { warn("deploy_state send failed", err); }
	}
}

interface GholamPriority {
	id: string;
	label: string;
	cwd: string;
	scope: string;
	addedAt: string;
}

interface SocketState {
	id: string;
	subscribed: boolean;
}

const sockets = new Map<string, ServerWebSocket<SocketState>>();
const wsState = new WeakMap<ServerWebSocket<SocketState>, SocketState>();

let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let priorities: GholamPriority[] = [];

async function readPriorities(): Promise<GholamPriority[]> {
	try {
		const raw = await fs.readFile(PRIORITIES_PATH, "utf-8");
		const parsed = JSON.parse(raw) as GholamPriority[];
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

async function loadKbSnapshot(): Promise<{ pathCount: number; byteSize: number }> {
	let pathCount = 0;
	let byteSize = 0;
	try {
		const walk = async (dir: string): Promise<void> => {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			for (const e of entries) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) {
					await walk(full);
				} else if (e.isFile() && e.name.endsWith(".md")) {
					pathCount++;
					const stat = await fs.stat(full);
					byteSize += stat.size;
				}
			}
		};
		if (existsSync(KB_ROOT)) await walk(KB_ROOT);
	} catch (err) {
		warn("KB walk failed", err);
	}
	return { pathCount, byteSize };
}

function broadcast(frame: Record<string, unknown>): void {
	const payload = JSON.stringify(frame);
	for (const ws of sockets.values()) {
		try {
			ws.send(payload);
		} catch (err) {
			warn("send failed", err);
		}
	}
}

async function tick(): Promise<void> {
	const kb = await loadKbSnapshot();
	const prior = await readPriorities();
	priorities = prior;
	broadcast({
		type: "heartbeat",
		at: new Date().toISOString(),
		priorities: prior.length,
		kb,
	});
}

function startHeartbeat(): void {
	if (heartbeatTimer) return;
	heartbeatTimer = setInterval(() => {
		void tick();
	}, 30_000);
	void tick();
}

function stopHeartbeat(): void {
	if (heartbeatTimer) {
		clearInterval(heartbeatTimer);
		heartbeatTimer = undefined;
	}
}

const server = Bun.serve<SocketState>({
	port: WS_PORT,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			// Validate the WS handshake via Sec-WebSocket-Protocol.
			// The deck sends `omp-gholam-v1, <token>` as the first protocol.
			// Anything else fails closed with 401.
			if (!GHOLAM_DECK_TOKEN) {
				return new Response("server misconfigured", { status: 500 });
			}
			const header = req.headers.get("sec-websocket-protocol") ?? "";
			const protocols = header.split(",").map((p) => p.trim()).filter(Boolean);
			const expected = `${GHOLAM_WS_PROTO}, ${GHOLAM_DECK_TOKEN}`;
			if (!protocols.includes(expected)) {
				return new Response("unauthorized", { status: 401 });
			}
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const data: SocketState = { id, subscribed: true };
			// Negotiate back the bare `omp-gholam-v1` so the runtime sees a
			// real subprotocol instead of the token-bearing one. Bun's
			// `upgrade` only accepts `headers` (not a `protocols` field),
			// so the echo goes through the response headers.
			const ok = srv.upgrade(req, {
				data,
				headers: { "Sec-WebSocket-Protocol": GHOLAM_WS_PROTO },
			});
			if (ok) return undefined;
			return new Response("upgrade failed", { status: 400 });
		}
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ ok: true, port: WS_PORT }), {
				headers: { "content-type": "application/json" },
			});
		}
		if (url.pathname === "/priorities") {
			return new Response(JSON.stringify(priorities), {
				headers: { "content-type": "application/json" },
			});
		}
		return new Response("not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sockets.set(ws.data.id, ws);
			ws.send(JSON.stringify({ type: "hello", id: ws.data.id, port: WS_PORT, kb: KB_ROOT }));
		},
		message(ws, raw) {
			try {
				const frame = JSON.parse(typeof raw === "string" ? raw : raw.toString());
				if (frame && typeof frame === "object" && typeof frame.type === "string") {
					if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
					if (frame.type === "request_priorities") {
						void readPriorities().then((p) => {
							ws.send(JSON.stringify({ type: "priorities", priorities: p }));
						});
				}
				if (frame.type === "mcp_call") {
					const id = String(frame.id ?? "");
					const server = String(frame.server ?? "");
					const method = String(frame.method ?? "");
					const params = (frame.params ?? {}) as Record<string, unknown>;
					if (!id || !server || !method) {
						sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: false, error: "missing id/server/method" });
						return;
					}
					const initErrors = ensureMcpClients();
					// Dispatch by server name. HTTP-backed clients (parallel,
					// tavily) and stdio clients (github, exa) all expose the
					// same `GithubMcpHandle` shape; openship is the lone
					// `call(method, params)` variant.
					if (server === "openship") {
						if (!openshipClient) {
							sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: false, error: initErrors.openship ?? "openship client not started" });
							return;
						}
						pendingMcp.set(id, { socketId: ws.data.id, server });
						openshipClient.call(method, params)
							.then((result) => sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: true, result }))
							.catch((err) => sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: false, error: (err as Error).message ?? "openship call failed" }))
							.finally(() => pendingMcp.delete(id));
					} else if (server === "github" || server === "exa" || server === "parallel" || server === "tavily") {
						const handle = server === "github" ? githubMcp : server === "exa" ? exaMcp : server === "parallel" ? parallelMcp : tavilyMcp;
						if (!handle) {
							sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: false, error: initErrors[server] ?? `${server} client not started` });
							return;
						}
						pendingMcp.set(id, { socketId: ws.data.id, server });
						resetIdleTimer(server);
						handle.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
					} else {
						sendMcpReply(ws.data.id, { type: "mcp_reply", id, ok: false, error: `unknown server: ${server}` });
					}
				}
				if (frame.type === "deploy_watch") {
					const watchId = String(frame.watchId ?? "");
					const projectId = String(frame.projectId ?? "");
					if (!watchId || !projectId) return;
					if (pendingDeployWatch.has(watchId)) return;
					if (!openshipClient) {
						sendDeployState(ws.data.id, { watchId, projectId, phase: "failed", error: "openship client not started" });
						return;
					}
					const timer = setInterval(() => {
						openshipClient!.call("deployments.get", { projectId })
							.then((res) => {
								const r = (res ?? {}) as { phase?: string; status?: string; ref?: string; error?: string };
								sendDeployState(ws.data.id, {
									watchId,
									projectId,
									phase: r.phase ?? r.status ?? "unknown",
									ref: r.ref,
							error: r.error,
						});
							if (r.phase === "healthy" || r.phase === "failed" || r.status === "healthy" || r.status === "failed") {
								clearInterval(timer);
								pendingDeployWatch.delete(watchId);
							}
							})
							.catch((err) => {
								sendDeployState(ws.data.id, { watchId, projectId, phase: "failed", error: (err as Error).message ?? "deploy_watch poll failed" });
							});
					}, 2_000);
					pendingDeployWatch.set(watchId, { socketId: ws.data.id, projectId, timer });
				}
				if (frame.type === "deploy_unwatch") {
					const watchId = String(frame.watchId ?? "");
					const entry = pendingDeployWatch.get(watchId);
					if (entry) {
						clearInterval(entry.timer);
						pendingDeployWatch.delete(watchId);
					}
				}
			}
		} catch (err) {
				warn("bad frame", err);
		}
	},
		close(ws) {
			sockets.delete(ws.data.id);
			// Drop in-flight MCP calls / deploy watches tied to this socket.
			for (const [id, rec] of pendingMcp) {
				if (rec.socketId === ws.data.id) pendingMcp.delete(id);
			}
			for (const [watchId, rec] of pendingDeployWatch) {
				if (rec.socketId === ws.data.id) {
					clearInterval(rec.timer);
					pendingDeployWatch.delete(watchId);
				}
			}
		},
	},
});

log(`gholam sidecar listening on ws://127.0.0.1:${server.port}/ws`);
startHeartbeat();

process.on("SIGINT", () => {
	log("SIGINT received, shutting down");
	stopHeartbeat();
	githubMcp?.kill();
	parallelMcp?.kill();
	exaMcp?.kill();
	tavilyMcp?.kill();
	for (const w of pendingDeployWatch.values()) clearInterval(w.timer);
	server.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	log("SIGTERM received, shutting down");
	stopHeartbeat();
	githubMcp?.kill();
	parallelMcp?.kill();
	exaMcp?.kill();
	tavilyMcp?.kill();
	for (const w of pendingDeployWatch.values()) clearInterval(w.timer);
	server.stop();
	process.exit(0);
});
