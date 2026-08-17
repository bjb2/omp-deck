/**
 * In-process MCP runtime for the Gholam chat loop.
 *
 * Walks the same `~/.omp/agent/mcp.json` the deck health probe reads
 * (`mcp-health.ts`) and talks to those servers directly using the
 * MCP 2025-06-18 spec — no `/v1/tools/list` shim, no assumptions about
 * a sidecar.
 *
 * Two transports:
 *   - HTTP: Streamable HTTP — POST a JSON-RPC 2.0 body to the configured
 *     URL, parse either a JSON response or an SSE stream of `data: {json}`
 *     events. Capture `Mcp-Session-Id` on the first reply and pass it back.
 *   - stdio: spawn the configured `command` + `args`, write JSON-RPC
 *     newline-delimited frames over stdin, multiplex responses by `id`
 *     on stdout. Initialize handshake (`initialize` + `notifications/initialized`)
 *     runs once per session lifetime.
 *
 * Both transports honour a per-call timeout, cache the advertised tools
 * for 60s per server, and evict on failure so the next call re-initializes.
 *
 * No async side effects on import — config is read lazily, the cache is
 * module-level but unwarmed.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("gholam-mcp-runtime");

const LIST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 30_000;
const TOOLS_CACHE_TTL_MS = 60_000;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "omp-deck-gholam", version: "0.6.1" };

export interface GholamMcpTool {
	server: string;
	name: string;
	description?: string;
	inputSchema?: unknown;
}

interface HttpMcpServer {
	type?: "http";
	url: string;
	headers?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
	disabledTools?: string[];
}

interface StdioMcpServer {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
	disabledTools?: string[];
}

type McpServerConfig = HttpMcpServer | StdioMcpServer;

interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	disabledServers?: string[];
}

function resolveMcpConfigPath(): string {
	const agentDir = loadConfig().agentDir ?? path.join(os.homedir(), ".omp", "agent");
	return path.join(agentDir, "mcp.json");
}

async function readMcpConfig(filePath: string): Promise<McpConfigFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as McpConfigFile;
		if (parsed && typeof parsed === "object") return parsed;
		return {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

function isStdio(cfg: McpServerConfig): cfg is StdioMcpServer {
	return cfg.type === "stdio";
}

type RawTool = { name: string; description?: string; inputSchema?: unknown };

/** Expand `${VAR}` and `$VAR` references against `process.env` + `extra`. */
function substituteEnv(str: string, extra?: Record<string, string>): string {
	const env: Record<string, string | undefined> = { ...process.env, ...(extra ?? {}) };
	return str.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, b1, b2) => {
		const key = b1 ?? b2;
		return env[key] ?? "";
	});
}

// ─── JSON-RPC framing ────────────────────────────────────────────────────

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

interface JsonRpcReply {
	id?: number;
	result?: unknown;
	error?: { message?: string; code?: number };
}

interface JsonRpcError extends Error {
	code?: number;
}

function makeError(reply: JsonRpcReply): JsonRpcError {
	const msg = reply.error?.message ?? "JSON-RPC error";
	const err = new Error(msg) as JsonRpcError;
	if (reply.error?.code !== undefined) err.code = reply.error.code;
	return err;
}

// ─── HTTP transport (Streamable HTTP) ────────────────────────────────────

interface HttpClient {
	readonly url: string;
	readonly headers: Record<string, string>;
	sessionId: string | undefined;
}

async function httpCall(
	client: HttpClient,
	request: JsonRpcRequest,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JsonRpcReply> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	signal?.addEventListener("abort", onAbort, { once: true });
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
		...client.headers,
	};
	if (client.sessionId) headers["mcp-session-id"] = client.sessionId;
	try {
		const res = await fetch(client.url, {
			method: "POST",
			headers,
			body: JSON.stringify(request),
			signal: controller.signal,
		});
		if (client.sessionId === undefined) {
			const sid = res.headers.get("mcp-session-id");
			if (sid) client.sessionId = sid;
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
		}
		const ct = res.headers.get("content-type") ?? "";
		if (ct.includes("text/event-stream")) {
			return await parseSseReply(res, request.id, timeoutMs, signal);
		}
		const body = (await res.json()) as JsonRpcReply | { error?: { message?: string } };
		// Some servers wrap the JSON-RPC reply in `{result: {...}}` for non-streamable.
		// Normalise: if it's a JSON-RPC reply (id/result/error) return as-is, else unwrap.
		const reply = (body as JsonRpcReply).id !== undefined || (body as JsonRpcReply).error !== undefined
			? (body as JsonRpcReply)
			: { result: body };
		if (reply.id !== undefined && reply.id !== request.id) {
			throw new Error(`jsonrpc id mismatch: sent ${request.id}, got ${reply.id}`);
		}
		return reply;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function parseSseReply(
	res: Response,
	expectedId: number,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JsonRpcReply> {
	if (!res.body) throw new Error("sse: empty body");
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = Math.max(0, deadline - Date.now());
		if (remaining === 0) throw new Error(`sse: timeout after ${timeoutMs}ms`);
		const { value, done } = await Promise.race([
			reader.read(),
			new Promise<{ value: undefined; done: true }>((r) =>
				setTimeout(() => r({ value: undefined, done: true }), remaining),
			),
		]);
		if (done) break;
		if (value) buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			const dataLine = block
				.split("\n")
				.map((l) => l.trim())
				.find((l) => l.startsWith("data:"));
			if (!dataLine) continue;
			const payload = dataLine.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;
			let parsed: JsonRpcReply;
			try {
				parsed = JSON.parse(payload) as JsonRpcReply;
			} catch {
				continue;
			}
			if (parsed.id !== undefined && parsed.id !== expectedId) continue;
			if (parsed.error?.message) return parsed;
			return parsed;
		}
		if (signal?.aborted) throw new Error("aborted");
	}
	throw new Error("sse: stream ended without reply");
}

async function httpSend(
	client: HttpClient,
	method: string,
	id: number,
	params: unknown,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JsonRpcReply> {
	const reply = await httpCall(client, { jsonrpc: "2.0", id, method, params }, timeoutMs, signal);
	if (reply.error?.message) throw makeError(reply);
	return reply;
}

// ─── stdio transport ─────────────────────────────────────────────────────

interface StdioClient {
	proc: ReturnType<typeof Bun.spawn>;
	writer: { write: (s: string) => unknown };
	initialized: boolean;
	readerTask: Promise<void>;
	pending: Map<number, { resolve: (r: JsonRpcReply) => void; reject: (e: Error) => void }>;
	nextId: number;
	closed: boolean;
}

function startStdioClient(cmd: string, args: string[], env: Record<string, string> | undefined): StdioClient {
	const proc = Bun.spawn({
		cmd: [cmd, ...args],
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...(env ?? {}) },
	});
	const client: StdioClient = {
		proc,
		writer: proc.stdin as unknown as { write: (s: string) => unknown },
		initialized: false,
		readerTask: Promise.resolve(),
		pending: new Map(),
		nextId: 1,
		closed: false,
	};
	client.readerTask = readStdioLoop(client, proc.stderr as unknown as ReadableStream<Uint8Array>);
	return client;
}

async function readStdioLoop(client: StdioClient, stderr: ReadableStream<Uint8Array>): Promise<void> {
	// Drain stderr to /dev/null so the child can't block on a full pipe.
	(async () => {
		try {
			const reader = stderr.getReader();
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch {}
	})();
	try {
		const reader = (client.proc.stdout as unknown as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		let buf = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			if (value) buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line || !line.startsWith("{")) continue;
				let parsed: JsonRpcReply;
				try {
					parsed = JSON.parse(line) as JsonRpcReply;
				} catch {
					continue;
				}
				if (parsed.id === undefined) continue; // unsolicited notification
				const waiter = client.pending.get(parsed.id);
				if (!waiter) continue;
				client.pending.delete(parsed.id);
				waiter.resolve(parsed);
			}
		}
	} catch (err) {
		// Process died — reject every waiter.
		for (const waiter of client.pending.values()) {
			waiter.reject(err instanceof Error ? err : new Error(String(err)));
		}
		client.pending.clear();
	} finally {
		client.closed = true;
	}
}

function stdioSend(client: StdioClient, request: JsonRpcRequest, timeoutMs: number, signal?: AbortSignal): Promise<JsonRpcReply> {
	if (client.closed) return Promise.reject(new Error("stdio: client closed"));
	const id = request.id;
	const frame = JSON.stringify(request) + "\n";
	return new Promise<JsonRpcReply>((resolve, reject) => {
		const timer = setTimeout(() => {
			client.pending.delete(id);
			reject(new Error(`stdio: timeout after ${timeoutMs}ms`));
		}, timeoutMs);
		const onAbort = () => {
			client.pending.delete(id);
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		client.pending.set(id, {
			resolve: (r) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(r);
			},
			reject: (e) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(e);
			},
		});
		try {
			client.writer.write(frame);
		} catch (err) {
			client.pending.delete(id);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

async function stdioInitialize(client: StdioClient, timeoutMs: number, signal?: AbortSignal): Promise<void> {
	if (client.initialized) return;
	// 1. initialize
	const initResp = await stdioSend(
		client,
		{
			jsonrpc: "2.0",
			id: client.nextId++,
			method: "initialize",
			params: {
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
		},
		timeoutMs,
		signal,
	);
	if (initResp.error?.message) throw makeError(initResp);
	// 2. notifications/initialized (no id, no reply expected)
	const notif: JsonRpcNotification = { jsonrpc: "2.0", method: "notifications/initialized" };
	client.writer.write(JSON.stringify(notif) + "\n");
	client.initialized = true;
}

async function stdioRequest(
	client: StdioClient,
	method: string,
	params: unknown,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<JsonRpcReply> {
	if (!client.initialized) await stdioInitialize(client, timeoutMs, signal);
	const reply = await stdioSend(
		client,
		{ jsonrpc: "2.0", id: client.nextId++, method, params },
		timeoutMs,
		signal,
	);
	if (reply.error?.message) throw makeError(reply);
	return reply;
}

function closeStdio(client: StdioClient): void {
	if (client.closed) return;
	client.closed = true;
	try {
		client.proc.kill();
	} catch {}
	for (const w of client.pending.values()) {
		w.reject(new Error("stdio: client closed"));
	}
	client.pending.clear();
}

// ─── Cache + client lifecycle ─────────────────────────────────────────────

type Client = { kind: "http"; client: HttpClient } | { kind: "stdio"; client: StdioClient };

interface CacheEntry {
	tools: GholamMcpTool[];
	fetchedAt: number;
	client: Client | undefined;
}

const cache = new Map<string, CacheEntry>();

function isCacheFresh(entry: CacheEntry, now: number): boolean {
	return now - entry.fetchedAt < TOOLS_CACHE_TTL_MS && entry.client !== undefined;
}

async function ensureClient(
	serverName: string,
	cfg: McpServerConfig,
	signal?: AbortSignal,
): Promise<{ client: Client; timeoutMs: number }> {
	const existing = cache.get(serverName);
	if (existing?.client) {
		return { client: existing.client, timeoutMs: cfg.timeout ?? LIST_TIMEOUT_MS };
	}
	const timeoutMs = cfg.timeout ?? LIST_TIMEOUT_MS;
	let client: Client;
	if (isStdio(cfg)) {
		const cmd = substituteEnv(cfg.command, cfg.env);
		const args = (cfg.args ?? []).map((a) => substituteEnv(a, cfg.env));
		const stdio = startStdioClient(cmd, args, cfg.env);
		await stdioInitialize(stdio, timeoutMs, signal);
		client = { kind: "stdio", client: stdio };
	} else {
		const http: HttpClient = {
			url: cfg.url,
			headers: cfg.headers ?? {},
			sessionId: undefined,
		};
		// Probe with initialize so the server hands us a session id (if any).
		await httpSend(
			http,
			"initialize",
			1,
			{
				protocolVersion: MCP_PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: CLIENT_INFO,
			},
			timeoutMs,
			signal,
		);
		client = { kind: "http", client: http };
	}
	cache.set(serverName, {
		tools: existing?.tools ?? [],
		fetchedAt: existing?.fetchedAt ?? 0,
		client,
	});
	return { client, timeoutMs };
}

async function fetchTools(
	client: Client,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<RawTool[]> {
	const reply =
		client.kind === "http"
			? await httpSend(client.client, "tools/list", 1, {}, timeoutMs, signal)
			: await stdioRequest(client.client, "tools/list", {}, timeoutMs, signal);
	const result = (reply.result ?? {}) as { tools?: RawTool[] };
	const tools = Array.isArray(result.tools) ? result.tools : [];
	return tools.filter((t): t is RawTool => typeof t?.name === "string");
}

async function callTool(
	client: Client,
	toolName: string,
	args: unknown,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<unknown> {
	const reply =
		client.kind === "http"
			? await httpSend(client.client, "tools/call", 2, { name: toolName, arguments: args ?? {} }, timeoutMs, signal)
			: await stdioRequest(client.client, "tools/call", { name: toolName, arguments: args ?? {} }, timeoutMs, signal);
	return reply.result;
}

function normaliseContent(result: unknown): unknown {
	const r = result as { content?: unknown } | undefined;
	if (!r || !Array.isArray(r.content)) return result;
	return r.content.map((part: { type?: string; text?: string }) => {
		if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
			try {
				return JSON.parse(part.text);
			} catch {
				return part.text;
			}
		}
		if (typeof part === "string") {
			try {
				return JSON.parse(part);
			} catch {
				return part;
			}
		}
		return part;
	});
}

function evict(serverName: string): void {
	const entry = cache.get(serverName);
	if (!entry) return;
	if (entry.client?.kind === "stdio") closeStdio(entry.client.client);
	cache.delete(serverName);
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Per-server `tools/list` for the picker surface. Re-reads `mcp.json` on
 * every call so the caller always sees the current `disabledTools`, then
 * delegates to the same 60s cache as the chat surface — a chat and a
 * picker call share state, no double round-trip. Throws if the named
 * server is not configured (route layer maps that to 404).
 */
export async function listGholamMcpToolsForServer(
	serverName: string,
	signal?: AbortSignal,
): Promise<{ tools: GholamMcpTool[]; disabledTools: string[] }> {
	const cfg = await readMcpConfig(resolveMcpConfigPath());
	const serverCfg = cfg.mcpServers?.[serverName];
	if (!serverCfg) {
		throw new Error(`mcp server "${serverName}" not found`);
	}
	const disabledTools = Array.from(new Set(serverCfg.disabledTools ?? []));
	if (cfg.disabledServers?.includes(serverName) || serverCfg.enabled === false) {
		return { tools: [], disabledTools };
	}
	const cached = cache.get(serverName);
	const now = Date.now();
	if (cached && isCacheFresh(cached, now) && cached.tools.length > 0) {
		return { tools: cached.tools, disabledTools };
	}
	try {
		const { client, timeoutMs } = await ensureClient(serverName, serverCfg, signal);
		const raw = await fetchTools(client, timeoutMs, signal);
		const tools: GholamMcpTool[] = raw.map((t) => ({ server: serverName, ...t }));
		const prev = cache.get(serverName);
		cache.set(serverName, { tools, fetchedAt: now, client: client ?? prev?.client });
		return { tools, disabledTools };
	} catch (err) {
		log.warn(`mcp ${serverName}: tools/list failed`, String((err as Error).message ?? err));
		evict(serverName);
		return { tools: [], disabledTools };
	}
}

/**
 * Enumerate every configured `mcpServers` entry and return their advertised
 * tools (one row per tool, prefix-tagged with the server name). Hits each
 * server once per 60s; the rest of the time the same cache is returned.
 */
export async function loadGholamMcpTools(signal?: AbortSignal): Promise<GholamMcpTool[]> {
	const cfg = await readMcpConfig(resolveMcpConfigPath());
	const servers = cfg.mcpServers ?? {};
	const disabled = new Set(cfg.disabledServers ?? []);
	const entries = Object.entries(servers);
	const out: GholamMcpTool[] = [];
	const now = Date.now();

	await Promise.all(
		entries.map(async ([name, serverCfg]) => {
			if (disabled.has(name) || serverCfg.enabled === false) return;
			const perServerDisabled = new Set(serverCfg.disabledTools ?? []);
			const cached = cache.get(name);
			if (cached && isCacheFresh(cached, now) && cached.tools.length > 0) {
				for (const tool of cached.tools) {
					if (!perServerDisabled.has(tool.name)) out.push(tool);
				}
				return;
			}
			try {
				const { client, timeoutMs } = await ensureClient(name, serverCfg, signal);
				const raw = await fetchTools(client, timeoutMs, signal);
				const tools: GholamMcpTool[] = raw.map((t) => ({ server: name, ...t }));
				const prev = cache.get(name);
				cache.set(name, { tools, fetchedAt: now, client: client ?? prev?.client });
				for (const tool of tools) {
					if (!perServerDisabled.has(tool.name)) out.push(tool);
				}
			} catch (err) {
				log.warn(`mcp ${name}: tools/list failed`, String((err as Error).message ?? err));
				evict(name);
			}
		}),
	);
	return out;
}

export async function callGholamMcpTool(
	serverName: string,
	toolName: string,
	args: unknown,
	signal?: AbortSignal,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
	const cfg = await readMcpConfig(resolveMcpConfigPath());
	const serverCfg = cfg.mcpServers?.[serverName];
	if (!serverCfg) return { ok: false, error: `unknown mcp server: ${serverName}` };
	if ((cfg.disabledServers ?? []).includes(serverName) || serverCfg.enabled === false) {
		return { ok: false, error: `mcp server disabled: ${serverName}` };
	}

	const timeoutMs = serverCfg.timeout ?? CALL_TIMEOUT_MS;
	try {
		const { client } = await ensureClient(serverName, serverCfg, signal);
		const result = await callTool(client, toolName, args, timeoutMs, signal);
		return { ok: true, result: normaliseContent(result) };
	} catch (err) {
		evict(serverName);
		return { ok: false, error: String((err as Error).message ?? err) };
	}
}

// ─── Self-test ───────────────────────────────────────────────────────────

if (import.meta.main) {
	const filePath = resolveMcpConfigPath();
	if (!existsSync(filePath)) {
		log.error(`mcp config not found at ${filePath}; skipping self-test`);
		process.exit(0);
	}
	try {
		const tools = await loadGholamMcpTools();
		const cfg = await readMcpConfig(filePath);
		const servers = Object.keys(cfg.mcpServers ?? {}).filter((n) => {
			const s = cfg.mcpServers?.[n];
			if (!s) return false;
			if ((cfg.disabledServers ?? []).includes(n)) return false;
			if (s.enabled === false) return false;
			return true;
		}).length;
		// eslint-disable-next-line no-console
		console.log(`[${tools.length} tools across ${servers} servers]`);
	} catch (err) {
		log.error("self-test failed", String((err as Error).message ?? err));
		process.exit(1);
	}
}
