/**
 * Gholam's private MCP clients.
 *
 * Two transports, one job each:
 *
 *  1. `startGithubMcp({ stdin, stdout, kill })` — wraps a docker stdio
 *     child (the github MCP server) and exposes `send(line)` / `onMessage(fn)`
 *     / `kill()`. The discipline (line-buffered stdout) mirrors the bridge
 *     supervisor in `apps/server/src/bridge-supervisor.ts:220-243`.
 *
 *  2. `startOpenshipClient(token)` — wraps the openship HTTP MCP endpoint
 *     with a small `call(method, params)` helper that sends JSON-RPC
 *     envelopes over `fetch` and resolves with the result.
 *
 * Both are transport-only. Authorization decisions happen in the sidecar
 * caller (gholam's WS handler), so this module stays a dumb pipe.
 */
const warn = (...args: unknown[]) => console.warn("[gholam-mcp:warn]", ...args);

const OPENSHIP_URL = "https://ship.v244.net/api/proxy/api/mcp";
const PARALLEL_URL = "https://search.parallel.ai/mcp";
const TAVILY_URL_BASE = "https://mcp.tavily.com/mcp";

export interface GithubMcpHandle {
	send(line: string): void;
	onMessage(fn: (line: string) => void): void;
	kill(): void;
}

interface GithubMcpArgs {
	child: ReturnType<typeof Bun.spawn>;
	kill(): void;
}

/**
 * Wrap a docker-spawned github MCP server child. `send` writes a JSON-RPC
 * line (caller writes the trailing newline); `onMessage` registers a
 * listener fired for each stdout line.
 */
export function startGithubMcp(args: GithubMcpArgs): GithubMcpHandle {
	const listeners = new Set<(line: string) => void>();

	const decoder = new TextDecoder();
	let pending = "";
	let dead = false;

	const stdin = args.child.stdin as unknown as { write: (line: string) => void };
	const stdout = args.child.stdout as unknown as ReadableStream<Uint8Array>;
	void (async () => {
		const reader = stdout.getReader();
		try {
			while (!dead) {
				const { value, done } = await reader.read();
				if (done) break;
				pending += decoder.decode(value, { stream: true });
				let nl = pending.indexOf("\n");
				while (nl !== -1) {
					const raw = pending.slice(0, nl).replace(/\r$/, "");
					pending = pending.slice(nl + 1);
					if (raw) for (const l of listeners) {
						try { l(raw); } catch (err) { warn("github mcp listener threw", err); }
					}
					nl = pending.indexOf("\n");
				}
			}
			const tail = pending.trim();
			if (tail) for (const l of listeners) {
				try { l(tail); } catch (err) { warn("github mcp listener threw", err); }
			}
		} catch (err) {
			warn("github mcp stdout pump failed", err);
		}
	})();

	return {
		send(line: string) {
			try {
				stdin.write(line);
			} catch (err) {
				warn("github mcp stdin write failed", err);
			}
		},
		onMessage(fn) {
			listeners.add(fn);
		},
		kill() {
			dead = true;
			try { args.kill(); } catch (err) { warn("github mcp kill failed", err); }
		},
	};
}

// ─── HTTP-backed MCP clients (parallel, tavily) ─────────────────────────────────
// Both speak JSON-RPC over HTTP POST. They keep the `GithubMcpHandle` shape
// so the sidecar's caller code stays uniform: `send(line)` packs the
// JSON-RPC envelope, the response is emitted as a single line via
// `onMessage` (matching the stdio child's line buffer).
let httpMcpIdCounter = 0;

function startHttpMcpClient(url: string, headers: Record<string, string>): GithubMcpHandle {
	const listeners = new Set<(line: string) => void>();
	let dead = false;
	return {
		send(line: string) {
			if (dead) return;
			// Pull the `id` field out of the JSON-RPC envelope so we can
			// delegate the response to the same id a real stdio child would.
			let idStr: string;
			try {
				const env = JSON.parse(line) as { id?: string | number };
				idStr = typeof env.id === "string" ? env.id : String(env.id ?? ++httpMcpIdCounter);
			} catch {
				idStr = String(++httpMcpIdCounter);
			}
			fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: line,
			})
				.then(async (resp) => {
					if (!resp.ok) {
						const text = await resp.text().catch(() => "");
						const errLine = JSON.stringify({ id: idStr, error: { message: `http ${resp.status}: ${text}` } });
						for (const l of listeners) l(errLine);
						return;
					}
					const body = await resp.text();
					// Body may be a single JSON object or NDJSON; emit each non-empty line.
					for (const part of body.split("\n")) {
						const trimmed = part.trim();
						if (trimmed) for (const l of listeners) l(trimmed);
					}
				})
				.catch((err: unknown) => {
					const errLine = JSON.stringify({ id: idStr, error: { message: (err as Error).message ?? "fetch failed" } });
					for (const l of listeners) l(errLine);
				});
		},
		onMessage(fn) { listeners.add(fn); },
		kill() { dead = true; },
	};
}

/**
 * Parallel MCP — HTTP, bearer-token auth via `MCP_PARALLEL_TOKEN`.
 */
export function startParallelMcp(token: string): GithubMcpHandle {
	return startHttpMcpClient(PARALLEL_URL, { "Authorization": `Bearer ${token}` });
}

/**
 * Tavily MCP — HTTP, key embedded in the URL (per `agent-defaults/mcp.json.tmpl:75`).
 */
export function startTavilyMcp(apiKey: string): GithubMcpHandle {
	return startHttpMcpClient(`${TAVILY_URL_BASE}/?tavilyApiKey=${apiKey}`, {});
}

/**
 * Exa MCP — stdio (`npx -y exa-mcp-server`). Same shape as `startGithubMcp`;
 * the daemon discipline is identical, just the spawn args differ.
 */
export function startExaMcp(apiKey: string): GithubMcpHandle {
	const child = Bun.spawn({
		cmd: ["npx", "-y", "exa-mcp-server"],
		env: { ...process.env, EXA_API_KEY: apiKey },
		stdio: ["pipe", "pipe", "pipe"],
	});
	return startGithubMcp({ child, kill: () => child.kill() });
}

export interface OpenshipMcpHandle {
	call(method: string, params: Record<string, unknown>): Promise<unknown>;
}

let openshipIdCounter = 0;

/**
 * Thin JSON-RPC over `fetch` for the openship HTTP MCP endpoint. Each
 * `call` is a discrete request — no batching, no streaming — so a
 * monotonic integer id is enough for response correlation.
 */
export function startOpenshipClient(token: string): OpenshipMcpHandle {
	return {
		async call(method: string, params: Record<string, unknown>): Promise<unknown> {
			const id = ++openshipIdCounter;
			const envelope = { jsonrpc: "2.0", id, method, params };
			const resp = await fetch(OPENSHIP_URL, {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${token}`,
					"Content-Type": "application/json",
					"Accept": "application/json",
				},
				body: JSON.stringify(envelope),
			});
			if (!resp.ok) {
				throw new Error(`openship ${resp.status}: ${await resp.text().catch(() => "<no body>")}`);
			}
			const body = await resp.json() as { id?: number; result?: unknown; error?: { message?: string } | string };
			if (body.error !== undefined) {
				const msg = typeof body.error === "string" ? body.error : body.error.message ?? JSON.stringify(body.error);
				throw new Error(msg);
			}
			return body.result;
		},
	};
}
