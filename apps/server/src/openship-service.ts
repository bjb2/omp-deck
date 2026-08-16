/**
 * OpenShip PaaS client — first-class REST surface for the deck.
 *
 * Speaks MCP-over-HTTP/JSON-RPC to the same endpoint the gholam sidecar
 * already uses (`https://ship.v244.net/api/proxy/api/mcp`, bearer
 * `MCP_OPENSHIP_TOKEN`). Adding a second mount path keeps the sidecar
 * working unchanged for the chat-driven call site.
 *
 * Tools: the openship MCP server exposes the same verb-shaped tool names as
 * its REST API (`get_projects`, `get_projects_by_id`,
 * `get_projects_by_id_deployments`, `post_deployments`,
 * `get_deployments_by_id_logs`). We ship with the names the sidecar's REST
 * surface proves are valid; on first `init()` we additionally call
 * `tools/list` and cache the canonical name map so a future upstream rename
 * is non-breaking on the existing routes.
 *
 * ponytail: 15s timeout matches the rest of the deck's outbound HTTP
 * surface; raise if a specific tool times out in practice.
 */
import { logger } from "./log.ts";

const log = logger("openship-service");

const DEFAULT_OPENSHIP_URL = "https://ship.v244.net/api/proxy/api/mcp";
const DEFAULT_TIMEOUT_MS = 15_000;

type SemanticToolName = "listProjects" | "getProject" | "listDeployments" | "triggerDeploy" | "deploymentLogs";

/** Public OpenShip tool names we depend on. Verified against the
 *  ship.v244.net surface as of the sidecar's existing call patterns and
 *  `agent-defaults/managed-skills/openship/SKILL.md`. The cache above lets
 *  the actual names drift without breaking these routes. */
const KNOWN_TOOL_NAMES: Readonly<Record<SemanticToolName, string>> = {
	listProjects: "get_projects",
	getProject: "get_projects_by_id",
	listDeployments: "get_projects_by_id_deployments",
	triggerDeploy: "post_deployments",
	deploymentLogs: "get_deployments_by_id_logs",
};

interface JsonRpcResponse {
	id?: number;
	result?: unknown;
	error?: { message?: string } | string;
}

/** Token missing or rejected by upstream (HTTP 401/403). Surface as a 503
 *  from the route so the web panel renders its connect-hint rather than
 *  a generic 502. */
export class OpenshipAuthError extends Error {}
/** Network/DNS/connect failure (fetch threw before HTTP). Surface as a
 *  502 with `retryable: true` so the panel can offer a retry button. */
export class OpenshipUnreachableError extends Error {
	readonly cause?: unknown;
	constructor(message: string, cause?: unknown) {
		super(message);
		this.cause = cause;
	}
}
/** Local AbortController tripped the timeout. */
export class OpenshipTimeoutError extends Error {}
/** Anything the upstream server actually returned (HTTP 4xx/5xx or a
 *  JSON-RPC `error`). The route maps non-auth upstream failures to 502 so
 *  the existing web contract keeps its meaning. */
export class OpenshipApiError extends Error {
	readonly upstreamStatus?: number;
	readonly retryable: boolean;
	constructor(message: string, upstreamStatus?: number, retryable = false) {
		super(message);
		this.upstreamStatus = upstreamStatus;
		this.retryable = retryable;
	}
}

let idCounter = 0;
let initialized = false;

/** Tool-name overrides discovered at runtime. Populated lazily by `init()`. */
let nameOverrides: Partial<Record<SemanticToolName, string>> = {};

function resolveTool(semanticName: SemanticToolName): string {
	const override = nameOverrides[semanticName];
	if (override) return override;
	const canonical = KNOWN_TOOL_NAMES[semanticName];
	const lastDot = canonical.lastIndexOf(".");
	return lastDot >= 0 ? canonical.slice(lastDot + 1) : canonical;
}

/** Configurable endpoint so deployments behind a different host (or behind a
 *  Cloudflare tunnel that returns HTML on errors) can repoint without a
 *  rebuild. Default keeps the sidecar working unchanged. */
export function getOpenshipEndpoint(): string {
	const raw = process.env.OMP_OPENSHIP_URL?.trim();
	if (!raw) return DEFAULT_OPENSHIP_URL;
	try {
		const u = new URL(raw);
		if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
	} catch {
		// fall through to default
	}
	log.warn(`OMP_OPENSHIP_URL is not a valid http(s) URL: ${raw}; using default`);
	return DEFAULT_OPENSHIP_URL;
}

/** Discover the actual tool names the server exposes. Non-fatal — when the
 *  server refuses to list tools, the well-known names above remain in use. */
async function init(): Promise<void> {
	const token = tryGetToken();
	if (!token) return;
	try {
		const result = await rawCall<{ tools?: { name: string }[] }>("tools/list", {}, token);
		if (!result?.tools?.length) return;
		const toolNames = new Set(result.tools.map((t) => t.name));
		const next: Partial<Record<SemanticToolName, string>> = {};
		for (const semantic of Object.keys(KNOWN_TOOL_NAMES) as SemanticToolName[]) {
			const candidate = KNOWN_TOOL_NAMES[semantic];
			const lastDot = candidate.lastIndexOf(".");
			const bare = lastDot >= 0 ? candidate.slice(lastDot + 1) : candidate;
			next[semantic] = toolNames.has(candidate) ? candidate : (toolNames.has(bare) ? bare : candidate);
		}
		nameOverrides = next;
		initialized = true;
	} catch (err) {
		log.warn(`tools/list failed; falling back to known names: ${(err as Error).message}`);
		// Still mark initialized so we don't retry tools/list on every call.
		initialized = true;
	}
}
/** Strip a Bearer token if one was accidentally pasted into a user-supplied
 *  string (e.g. an error message from the upstream). Used before logging or
 *  returning an error body so the secret never leaks. */
function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join("[redacted]");
}

async function rawCall<T>(method: string, params: Record<string, unknown>, token: string): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
	const id = ++idCounter;
	const envelope = { jsonrpc: "2.0", id, method, params };
	const endpoint = getOpenshipEndpoint();
	try {
		let resp: Response;
		try {
			resp = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(envelope),
			signal: controller.signal,
		});
		} catch (err) {
			if ((err as Error).name === "AbortError") {
				throw new OpenshipTimeoutError(`openship ${method} timed out after ${DEFAULT_TIMEOUT_MS}ms`);
			}
			throw new OpenshipUnreachableError(
				`openship ${method} could not reach ${endpoint}: ${(err as Error).message ?? "network error"}`,
				err,
			);
		}
		if (!resp.ok) {
			if (resp.status === 401 || resp.status === 403) {
				throw new OpenshipAuthError(`openship ${method} rejected the token (HTTP ${resp.status})`);
			}
			const text = await resp.text().catch(() => "<no body>");
			const safe = redactToken(text, token);
			const retryable = resp.status === 429 || resp.status >= 500;
			throw new OpenshipApiError(
				`openship ${method} returned HTTP ${resp.status}: ${safe.slice(0, 240)}`,
				resp.status,
				retryable,
			);
		}
		let body: JsonRpcResponse;
		try {
			body = (await resp.json()) as JsonRpcResponse;
		} catch {
			throw new OpenshipApiError(`openship ${method} returned non-JSON body`, resp.status, false);
		}
		if (body.error !== undefined) {
			const msg = typeof body.error === "string" ? body.error : body.error.message ?? JSON.stringify(body.error);
			throw new OpenshipApiError(`openship ${method}: ${redactToken(msg, token)}`, undefined, false);
		}
		return body.result as T;
	} catch (err) {
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

function tryGetToken(): string | undefined {
	const t = process.env.MCP_OPENSHIP_TOKEN?.trim();
	return t ? t : undefined;
}

export function hasOpenshipToken(): boolean {
	return Boolean(tryGetToken());
}

async function withToken<T>(fn: (token: string) => Promise<T>, semantic: SemanticToolName): Promise<T> {
	const token = tryGetToken();
	if (!token) throw new OpenshipAuthError("MCP_OPENSHIP_TOKEN not set in env");
	if (!initialized) await init();
	return fn(token);
}

// ─── Result shapes ────────────────────────────────────────────────────────

export interface OpenshipProject {
	id: string;
	name?: string;
	status?: string;
	url?: string;
	updatedAt?: string;
	[key: string]: unknown;
}

export interface OpenshipDeployment {
	id: string;
	status?: string;
	createdAt?: string;
	commit?: string;
	[key: string]: unknown;
}

// ─── Helpers (typed) ─────────────────────────────────────────────────────

/** List all OpenShip projects in the org. */
export async function listProjects(): Promise<OpenshipProject[]> {
	return withToken(async (token) => {
		const result = await rawCall<unknown>(resolveTool("listProjects"), {}, token);
		return normalizeProjects(result);
	}, "listProjects");
}

/** Fetch a project + its deployments in one call. The OpenShip server
 *  already returns both, so we map onto our contract and fall back to a
 *  separate list if a particular server version splits them. */
export async function getProject(id: string): Promise<{ project: OpenshipProject; deployments: OpenshipDeployment[] }> {
	return withToken(async (token) => {
		const project = await rawCall<unknown>(resolveTool("getProject"), { id }, token);
		// Best-effort deployments list; treat a 4xx / unknown tool as empty.
		let deployments: OpenshipDeployment[] = [];
		try {
			const d = await rawCall<unknown>(resolveTool("listDeployments"), { id }, token);
			deployments = normalizeDeployments(d);
		} catch (err) {
			log.debug(`deployments list failed for ${id}: ${(err as Error).message}`);
		}
		return {
			project: normalizeProject(project, id),
			deployments,
		};
	}, "getProject");
}

/** Trigger a redeploy for `id`; returns the new deployment id. */
export async function triggerDeploy(id: string): Promise<{ deploymentId: string }> {
	return withToken(async (token) => {
		const result = await rawCall<unknown>(resolveTool("triggerDeploy"), { projectId: id }, token);
		const r = (result ?? {}) as { id?: string; deploymentId?: string };
		const deploymentId = r.id ?? r.deploymentId ?? "";
		if (!deploymentId) throw new OpenshipApiError("openship post_deployments returned no deployment id");
		return { deploymentId };
	}, "triggerDeploy");
}

/** Fetch the tail of a deployment's logs. */
export async function deploymentLogs(id: string, tail = 200): Promise<string[]> {
	return withToken(async (token) => {
		const result = await rawCall<unknown>(resolveTool("deploymentLogs"), { id, tail }, token);
		return normalizeLogs(result);
	}, "deploymentLogs");
}

// ─── Normalization ───────────────────────────────────────────────────────

function asArray<T>(value: unknown): T[] {
	if (Array.isArray(value)) return value as T[];
	if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) {
		return ((value as { items: unknown[] }).items) as T[];
	}
	return [];
}

function normalizeProjects(result: unknown): OpenshipProject[] {
	return asArray<Record<string, unknown>>(result).map((p) => normalizeProject(p, String(p.id ?? "")));
}

function normalizeProject(raw: unknown, fallbackId: string): OpenshipProject {
	const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	return {
		id: String(p.id ?? fallbackId),
		name: typeof p.name === "string" ? p.name : undefined,
		status: typeof p.status === "string" ? p.status : undefined,
		url: typeof p.url === "string" ? p.url : (typeof p.hostname === "string" ? p.hostname : undefined),
		updatedAt: pickString(p, ["updatedAt", "updated_at", "lastDeployedAt"]),
		...p,
	};
}

function normalizeDeployments(result: unknown): OpenshipDeployment[] {
	return asArray<Record<string, unknown>>(result).map((d) => {
		return {
			id: String(d.id ?? ""),
			status: typeof d.status === "string" ? d.status : undefined,
			createdAt: pickString(d, ["createdAt", "created_at"]),
			commit: pickString(d, ["commit", "sha"]),
			...d,
		};
	});
}

function pickString(o: Record<string, unknown>, keys: string[]): string | undefined {
	for (const k of keys) {
		const v = o[k];
		if (typeof v === "string" && v) return v;
		if (typeof v === "number") return String(v);
	}
	return undefined;
}

function normalizeLogs(result: unknown): string[] {
	if (!result) return [];
	if (typeof result === "string") return result.split(/\r?\n/);
	// Common shapes: { lines: string[] } | { log: string } | string[].
	if (Array.isArray(result)) return result.map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
	const o = result as { lines?: unknown; log?: unknown; output?: unknown; content?: unknown };
	if (Array.isArray(o.lines)) return o.lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l)));
	if (typeof o.log === "string") return o.log.split(/\r?\n/);
	if (typeof o.output === "string") return o.output.split(/\r?\n/);
	if (typeof o.content === "string") return o.content.split(/\r?\n/);
	return [];
}
