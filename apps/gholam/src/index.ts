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
import type { Server, ServerWebSocket } from "bun";

const log = (...args: unknown[]) => console.log("[gholam]", ...args);
const warn = (...args: unknown[]) => console.warn("[gholam:warn]", ...args);

const WS_PORT = Number.parseInt(process.env.GHOLAM_WS_PORT ?? "47900", 10);
const OMP_DECK_DATA_DIR = process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck");
const KB_ROOT = process.env.OMP_DECK_KB_ROOT ?? path.join(os.homedir(), "kb");
const PRIORITIES_PATH = path.join(OMP_DECK_DATA_DIR, "gholam-priorities.json");

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

const server: Server = Bun.serve<SocketState, undefined>({
	port: WS_PORT,
	fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const data: SocketState = { id, subscribed: true };
			const ok = srv.upgrade(req, { data });
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
				}
			} catch (err) {
				warn("bad frame", err);
			}
		},
		close(ws) {
			sockets.delete(ws.data.id);
		},
	},
});

log(`gholam sidecar listening on ws://127.0.0.1:${server.port}/ws`);
startHeartbeat();

process.on("SIGINT", () => {
	log("SIGINT received, shutting down");
	stopHeartbeat();
	server.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	log("SIGTERM received, shutting down");
	stopHeartbeat();
	server.stop();
	process.exit(0);
});
