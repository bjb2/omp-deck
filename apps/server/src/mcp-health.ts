/**
 * Live MCP health probe — single class, minimal footprint.
 *
 * Reads `~/.omp/agent/mcp.json` (the user-managed MCP config) and probes
 * every enabled server on a fixed cadence (default 30s; configurable via
 * `OMP_MCP_HEALTH_INTERVAL_MS`). HTTP servers get a JSON-RPC `tools/list`
 * POST; stdio servers get a probe via `Bun.spawn`. Results are kept in
 * memory for `GET /api/mcp/health`, persisted to `~/.omp-deck/mcp-health.json`
 * (debounced), and broadcast as `mcp_health` server frames.
 *
 * `mcp_health` is throttled by `WsHub.broadcast` to ≤1/sec/frame-type
 * (the probe cadence is independent; we only cap the bus round-trip).
 *
 * Scope: rows emitted from `mcp.json` carry `scope: "deck"`. The Gholam
 * sidecar speaks five additional providers (openship / parallel / tavily /
 * github / exa) that are NOT in `mcp.json` — they're env-gated MCP clients
 * the sidecar spawns on demand. We synthesise a row per provider so the
 * chrome chip + studio strip surface them too, with `state: "disabled"` +
 * an actionable `lastError` whenever the env token is missing (no more
 * noisy `unreachable` rows for unconfigured providers).
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { McpHealthStatus } from "@omp-deck/protocol";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { loadGholamMcpTools } from "./gholam-mcp-runtime.ts";

const log = logger("mcp-health");

const DEFAULT_INTERVAL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const DEBOUNCE_MS = 1_000;

interface HttpMcpServer {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
}

interface StdioMcpServer {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
}

type McpServerConfig = HttpMcpServer | StdioMcpServer;

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	disabledServers?: string[];
}

function resolveIntervalMs(): number {
	const raw = process.env.OMP_MCP_HEALTH_INTERVAL_MS?.trim();
	if (!raw) return DEFAULT_INTERVAL_MS;
	const n = Number.parseInt(raw, 10);
	if (!Number.isFinite(n) || n < 1_000) return DEFAULT_INTERVAL_MS;
	return n;
}

function isHttp(cfg: McpServerConfig): cfg is HttpMcpServer {
	if (cfg.type === "stdio") return false;
	// Legacy entries with a bare URL but no `type` field are HTTP.
	return true;
}

async function probeHttp(
	url: string,
	headers: Record<string, string> | undefined,
	timeoutMs: number,
): Promise<{ ok: true; toolCount: number; latencyMs: number } | { ok: false; error: string; latencyMs: number }> {
	const start = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, PROBE_TIMEOUT_MS));
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", "accept": "application/json", ...headers },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
			signal: controller.signal,
		});
		if (!res.ok) {
			const hint =
				res.status === 401 || res.status === 403
					? "auth rejected — check the token env var"
					: res.status === 502 || res.status === 504
						? "upstream unreachable"
						: "";
			return { ok: false, error: hint ? `HTTP ${res.status} (${hint})` : `HTTP ${res.status}`, latencyMs: Date.now() - start };
		}
		const body = (await res.json().catch(() => null)) as { result?: { tools?: unknown[] }; error?: { message?: string } } | null;
		if (body?.error?.message) return { ok: false, error: body.error.message, latencyMs: Date.now() - start };
		const tools = Array.isArray(body?.result?.tools) ? body.result.tools : [];
		return { ok: true, toolCount: tools.length, latencyMs: Date.now() - start };
	} catch (err) {
		return { ok: false, error: String((err as Error).message ?? err), latencyMs: Date.now() - start };
	} finally {
		clearTimeout(timer);
	}
}

async function probeStdio(
	cfg: StdioMcpServer,
	timeoutMs: number,
): Promise<{ ok: true; toolCount: number; latencyMs: number } | { ok: false; error: string; latencyMs: number }> {
	const start = Date.now();
	try {
		const proc = Bun.spawn({
			cmd: [cfg.command, ...(cfg.args ?? [])],
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...(cfg.env ?? {}) },
		});
		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
		}, Math.min(timeoutMs, PROBE_TIMEOUT_MS));
		const stdinStream = proc.stdin as unknown as { write: (s: string) => unknown };
		stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) + "\n");
		const reader = (proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const remaining = Math.max(0, Math.min(timeoutMs, PROBE_TIMEOUT_MS) - (Date.now() - start));
			if (remaining === 0) {
				try {
					proc.kill();
				} catch {}
				clearTimeout(timer);
				return { ok: false, error: "probe timeout", latencyMs: Date.now() - start };
			}
			const { value, done } = await Promise.race([
				reader.read(),
				new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), remaining)),
			]);
			if (done) break;
			if (value) buf += decoder.decode(value, { stream: true });
			const newline = buf.indexOf("\n");
			if (newline < 0) continue;
			const line = buf.slice(0, newline).trim();
			buf = buf.slice(newline + 1);
			if (!line.startsWith("{")) continue;
			let parsed: { id?: number; result?: { tools?: unknown[] }; error?: { message?: string } };
			try {
				parsed = JSON.parse(line) as typeof parsed;
			} catch {
				continue;
			}
			if (parsed.id !== 1) continue;
			clearTimeout(timer);
			try {
				proc.kill();
			} catch {}
			if (parsed.error?.message) {
				return { ok: false, error: parsed.error.message, latencyMs: Date.now() - start };
			}
			return {
				ok: true,
				toolCount: Array.isArray(parsed.result?.tools) ? parsed.result.tools.length : 0,
				latencyMs: Date.now() - start,
			};
		}
		clearTimeout(timer);
		try {
			proc.kill();
		} catch {}
		return { ok: false, error: "no JSON-RPC reply", latencyMs: Date.now() - start };
	} catch (err) {
		return { ok: false, error: String((err as Error).message ?? err), latencyMs: Date.now() - start };
	}
}

interface ProbeResult {
	ok: boolean;
	error?: string;
	toolCount?: number;
	latencyMs: number;
}

// ─── Gholam-side provider catalog ─────────────────────────────────────────────
// One row per provider the Gholam sidecar can spawn on demand. Each entry
// gates on an env token (so missing config reports `disabled` with an
// actionable reason, not `unreachable`) and carries the HTTP URL/headers
// shape needed to live-probe when the token is present.

interface GholamProbeSpec {
	transport: "http" | "stdio";
	url?: string;
	headers?: Record<string, string>;
	/** Env-var name whose presence gates the provider. */
	tokenEnv: string;
	/** When true, the bearer token is delivered as a `tavilyApiKey` query param. */
	keyInQuery?: boolean;
}

const GHOLAM_PROBE_SPECS: ReadonlyArray<{ name: string; spec: GholamProbeSpec }> = [
	{
		name: "openship",
		spec: { transport: "http", url: "https://ship.v244.net/api/proxy/api/mcp", tokenEnv: "MCP_OPENSHIP_TOKEN" },
	},
	{
		name: "parallel",
		spec: { transport: "http", url: "https://search.parallel.ai/mcp", tokenEnv: "MCP_PARALLEL_TOKEN" },
	},
	{
		name: "tavily",
		spec: {
			transport: "http",
			url: "https://mcp.tavily.com/mcp",
			tokenEnv: "TAVILY_API_KEY",
			keyInQuery: true,
		},
	},
	{ name: "github", spec: { transport: "stdio", tokenEnv: "GITHUB_PERSONAL_ACCESS_TOKEN" } },
	{ name: "exa", spec: { transport: "stdio", tokenEnv: "EXA_API_KEY" } },
];

/** Initial / disabled row for one gholam-side provider. */
function gholamProviderEntry(name: string, spec: GholamProbeSpec, now: string): McpHealthStatus {
	const id = `gholam:${name}`;
	const hasToken = Boolean(process.env[spec.tokenEnv]?.trim());
	if (!hasToken) {
		return {
			id,
			name,
			transport: spec.transport,
			scope: "gholam",
			state: "disabled",
			lastSuccessAt: null,
			lastErrorAt: null,
			lastError: `${spec.tokenEnv} not set in env`,
			lastLatencyMs: null,
			probedAt: now,
		};
	}
	return {
		id,
		name,
		transport: spec.transport,
		scope: "gholam",
		state: "unknown",
		lastSuccessAt: null,
		lastErrorAt: null,
		lastLatencyMs: null,
		probedAt: now,
	};
}

/** Build the headers / url for a gholam HTTP probe. Returns `null` for
 *  stdio providers — those are reflected as `unknown` until the sidecar
 *  reports back through the WS frame channel. */
async function probeGholamHttp(
	spec: GholamProbeSpec,
	timeoutMs: number,
): Promise<
	| { kind: "skipped"; reason: string }
	| { kind: "ok"; toolCount: number; latencyMs: number }
	| { kind: "err"; error: string; latencyMs: number }
	| { kind: "noprobe" }
> {
	if (spec.transport !== "http" || !spec.url) return { kind: "noprobe" };
	const token = process.env[spec.tokenEnv]?.trim();
	if (!token) return { kind: "skipped", reason: `${spec.tokenEnv} not set in env` };
	if (spec.keyInQuery) {
		const url = new URL(spec.url);
		url.searchParams.set("tavilyApiKey", token);
		const r = await probeHttp(url.toString(), {}, timeoutMs);
		return r.ok
			? { kind: "ok", toolCount: r.toolCount, latencyMs: r.latencyMs }
			: { kind: "err", error: r.error, latencyMs: r.latencyMs };
	}
	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	const r = await probeHttp(spec.url, headers, timeoutMs);
	return r.ok
		? { kind: "ok", toolCount: r.toolCount, latencyMs: r.latencyMs }
		: { kind: "err", error: r.error, latencyMs: r.latencyMs };
}

export class McpHealthProbe {
	private readonly status = new Map<string, McpHealthStatus>();
	private interval: ReturnType<typeof setInterval> | null = null;
	private writeTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly persistPath: string;
	private readonly intervalMs: number;
	private readonly onUpdate: ((status: McpHealthStatus) => void) | undefined;

	constructor(opts: { onUpdate?: (status: McpHealthStatus) => void } = {}) {
		this.intervalMs = resolveIntervalMs();
		this.persistPath = path.join(os.homedir(), ".omp-deck", "mcp-health.json");
		this.onUpdate = opts.onUpdate;
	}

	/** Schedules the probe loop. Safe to call once; subsequent calls no-op. */
	start(): void {
		if (this.interval) return;
		void this.runOnce();
		this.interval = setInterval(() => {
			void this.runOnce();
		}, this.intervalMs);
		this.interval.unref?.();
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = null;
		}
		if (this.writeTimer) {
			clearTimeout(this.writeTimer);
			this.writeTimer = null;
		}
	}

	/** In-memory snapshot for `GET /api/mcp/health`. */
	snapshot(): McpHealthStatus[] {
		return Array.from(this.status.values()).sort((a, b) => {
			if (a.scope !== b.scope) return a.scope.localeCompare(b.scope);
			return a.name.localeCompare(b.name);
		});
	}

	/** Read the persisted snapshot synchronously (e.g. for boot fallback). */
	async loadPersisted(): Promise<McpHealthStatus[]> {
		try {
			const raw = await fs.readFile(this.persistPath, "utf-8");
			const parsed = JSON.parse(raw) as { status?: McpHealthStatus[] };
			if (Array.isArray(parsed.status)) {
				for (const s of parsed.status) this.status.set(s.id, s);
			}
			return this.snapshot();
		} catch {
			return [];
		}
	}

	/**
	 * Trigger a single probe cycle on demand. Used by the chrome "Refresh"
	 * button (`POST /api/mcp/probe-now`); the probe itself broadcasts the
	 * resulting snapshot.
	 */
	async runOnce(): Promise<void> {
		const now = new Date().toISOString();

		// ─── Gholam-side providers ─────────────────────────────────────────────
		// Run first so the broadcast at the end always includes a fresh row for
		// every env-gated provider, even when the deck-side mcp.json is missing.
		await Promise.all(
			GHOLAM_PROBE_SPECS.map(async ({ name, spec }) => {
				const id = `gholam:${name}`;
				const prev = this.status.get(id);
				const base = gholamProviderEntry(name, spec, now);
				if (base.state === "disabled") {
					// Re-emit every cycle so the user sees the actionable reason as
					// soon as they set the env var and restart.
					this.status.set(id, base);
					this.onUpdate?.(base);
					return;
				}
				const probed = await probeGholamHttp(spec, PROBE_TIMEOUT_MS);
				let next: McpHealthStatus = { ...base, lastSuccessAt: prev?.lastSuccessAt ?? null };
				if (probed.kind === "ok") {
					next = {
						...base,
						state: "healthy",
						lastSuccessAt: now,
						lastErrorAt: prev?.lastErrorAt ?? null,
						lastLatencyMs: probed.latencyMs,
						toolCount: probed.toolCount,
					};
				} else if (probed.kind === "err") {
					next = {
						...base,
						state: "unreachable",
						lastSuccessAt: prev?.lastSuccessAt ?? null,
						lastErrorAt: now,
						lastError: probed.error,
						lastLatencyMs: probed.latencyMs,
					};
				} else if (probed.kind === "noprobe") {
					// Stdio providers — leave the row at `unknown` until the sidecar
					// confirms liveness through its own WS frames. The chrome chip
					// renders this as "degraded" / "checking".
					next = {
						...base,
						lastSuccessAt: prev?.lastSuccessAt ?? null,
						lastErrorAt: prev?.lastErrorAt ?? null,
						lastLatencyMs: prev?.lastLatencyMs ?? null,
					};
				}
				this.status.set(id, next);
				this.onUpdate?.(next);
			}),
		);

		// In-process gholam MCP runtime probe — promotes stdio (github / exa)
		// and HTTP (parallel / tavily) providers from `unknown` to `healthy`
		// when the chat-driven runtime can reach them. Cached entries reuse
		// the prior state so the probe never spawns children twice.
		try {
			const tools = await loadGholamMcpTools();
			const toolCounts = new Map<string, number>();
			for (const t of tools) {
				toolCounts.set(t.server, (toolCounts.get(t.server) ?? 0) + 1);
			}
			for (const [serverName, count] of toolCounts) {
				const id = `gholam:${serverName}`;
				const prev = this.status.get(id);
				if (!prev || prev.state === "disabled") continue;
				this.status.set(id, {
					...prev,
					state: prev.state === "unreachable" ? "unknown" : "healthy",
					lastSuccessAt: now,
					lastErrorAt: null,
					lastLatencyMs: prev.lastLatencyMs,
					toolCount: count,
					probedAt: now,
				});
			}
		} catch (err) {
			log.warn(`gholam runtime probe failed`, err);
		}

		// ─── Deck-side mcp.json providers ──────────────────────────────────────
		const configPath = this.resolveConfigPath();
		if (configPath) {
			let cfg: McpConfigFile;
			try {
				const raw = await fs.readFile(configPath, "utf-8");
				cfg = JSON.parse(raw) as McpConfigFile;
			} catch {
				cfg = { mcpServers: {}, disabledServers: [] };
			}
			const disabled = cfg.disabledServers ?? [];
			const servers = cfg.mcpServers ?? {};
			await Promise.all(
				Object.entries(servers).map(async ([name, serverCfg]) => {
					const id = `deck:${name}`;
					const prev = this.status.get(id);
					if (disabled.includes(name) || serverCfg.enabled === false) {
						const next: McpHealthStatus = {
							id,
							name,
							transport: serverCfg.type === "stdio" ? "stdio" : "http",
							scope: "deck",
							state: "disabled",
							lastSuccessAt: prev?.lastSuccessAt ?? null,
							lastErrorAt: null,
							lastLatencyMs: null,
							probedAt: now,
						};
						this.status.set(id, next);
						this.onUpdate?.(next);
						return;
					}
					const timeoutMs = typeof serverCfg.timeout === "number" ? serverCfg.timeout : PROBE_TIMEOUT_MS;
					const probe: ProbeResult = isHttp(serverCfg)
						? await probeHttp(serverCfg.url, serverCfg.headers, timeoutMs)
						: await probeStdio(serverCfg, timeoutMs);
					const next: McpHealthStatus = {
						id,
						name,
						transport: isHttp(serverCfg) ? "http" : "stdio",
						scope: "deck",
						state: probe.ok
							? probe.latencyMs > timeoutMs * 0.75
								? "degraded"
								: "healthy"
							: "unreachable",
						lastSuccessAt: probe.ok ? now : (prev?.lastSuccessAt ?? null),
						lastErrorAt: probe.ok ? (prev?.lastErrorAt ?? null) : now,
						...(probe.ok || !probe.error ? {} : { lastError: probe.error }),
						lastLatencyMs: probe.latencyMs,
						...(probe.toolCount !== undefined
							? { toolCount: probe.toolCount }
							: prev?.toolCount !== undefined
								? { toolCount: prev.toolCount }
								: {}),
						probedAt: now,
					};
					this.status.set(id, next);
					this.onUpdate?.(next);
				}),
			);
		}

		this.schedulePersist();
		// Single broadcast per probe cycle (not one per server). WsHub.broadcast
		// throttles `mcp_health` at 30s anyway, and per-server frames under a
		// multi-server config would be dropped silently after the first; emitting
		// the full snapshot here keeps the chrome badge + studio row coherent.
		broadcastBus.broadcast({
			type: "mcp_health",
			status: this.snapshot(),
		});
	}

	private resolveConfigPath(): string | undefined {
		// Fall back to the standard install location so the probe reads the
		// user's actual mcp.json on a fresh cold-boot. The same fallback is
		// used by routes-mcp-install / skills / storefront-installed /
		// onboarding-state / session-lifecycle / skillsmp / custom-providers,
		// so probe state stays consistent with everything else that touches
		// the user's MCP config. Overridable via OMP_AGENT_DIR.
		const agentDir = loadConfig().agentDir ?? path.join(os.homedir(), ".omp", "agent");
		const candidate = path.join(agentDir, "mcp.json");
		return existsSync(candidate) ? candidate : undefined;
	}

	private schedulePersist(): void {
		if (this.writeTimer) return;
		this.writeTimer = setTimeout(() => {
			this.writeTimer = null;
			void this.persistNow();
		}, DEBOUNCE_MS);
		this.writeTimer.unref?.();
	}

	private async persistNow(): Promise<void> {
		const payload = { status: this.snapshot(), savedAt: new Date().toISOString() };
		try {
			await fs.mkdir(path.dirname(this.persistPath), { recursive: true });
			await fs.writeFile(this.persistPath, JSON.stringify(payload, null, 2), "utf-8");
		} catch (err) {
			log.warn(`mcp-health persist failed`, err);
		}
	}
}

let _instance: McpHealthProbe | undefined;
export function getMcpHealthProbe(): McpHealthProbe {
	if (!_instance) _instance = new McpHealthProbe();
	return _instance;
}
