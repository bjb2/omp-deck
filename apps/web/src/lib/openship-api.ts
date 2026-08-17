/**
 * Typed fetch wrapper for `/api/openship/*`. Mirrors the route layer's
 * contract and lets the panel degrade cleanly when the token isn't set
 * (server returns 503 with a clear message — `isNoToken()` flags that
 * case so the panel can render the connect-hint empty state).
 */
const BASE = "/api";

export interface OpenshipProject {
	id: string;
	name?: string;
	status?: string;
	url?: string;
	updatedAt?: string;
}

export interface OpenshipDeployment {
	id: string;
	status?: string;
	createdAt?: string;
	commit?: string;
}

export interface OpenshipStatusResponse {
	configured: boolean;
}

/** Thrown for non-OK responses; carries status + parsed body (when JSON). */
export class OpenshipApiError extends Error {
	status: number;
	body: unknown;
	constructor(status: number, message: string, body: unknown) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

/** Structured error body the OpenShip route layer returns alongside the
 *  HTTP status. Lets the panel distinguish "bad token" (route user to env
 *  settings) from "upstream 5xx" (offer retry) without parsing free-text
 *  messages. The token itself is never present here — the server strips
 *  it before responding. */
export interface OpenshipErrorBody {
	error: string;
	kind?: "auth" | "timeout" | "unreachable" | "upstream" | "internal";
	retryable?: boolean;
	upstreamStatus?: number;
	endpoint?: string;
}

/** True when the body looks like the server's not-configured sentinel —
 *  the panel renders its connect-hint empty state instead of an error. */
export function isNoTokenError(err: unknown): boolean {
	if (!(err instanceof OpenshipApiError) || err.status !== 503) return false;
	if (!err.body || typeof err.body !== "object") return false;
	const body = err.body as Record<string, unknown>;
	if (!("error" in body)) return false;
	if (body.kind === "auth") return true;
	return typeof body.error === "string";
}

/** Best-effort structured error body for callers that want to branch on
 *  `kind`/`retryable` rather than message text. */
export function asOpenshipErrorBody(err: unknown): OpenshipErrorBody | null {
	if (!(err instanceof OpenshipApiError)) return null;
	if (!err.body || typeof err.body !== "object") return null;
	const b = err.body as Record<string, unknown>;
	const error = typeof b.error === "string" ? b.error : err.message;
	const kind: OpenshipErrorBody["kind"] | undefined =
		typeof b.kind === "string"
			? b.kind === "auth" || b.kind === "timeout" || b.kind === "unreachable" || b.kind === "upstream" || b.kind === "internal"
				? b.kind
				: undefined
			: undefined;
	const upstreamStatus = typeof b.upstreamStatus === "number" ? b.upstreamStatus : undefined;
	const endpoint = typeof b.endpoint === "string" ? b.endpoint : undefined;
	return {
		error,
		kind,
		retryable: Boolean(b.retryable),
		upstreamStatus,
		endpoint,
	};
}
async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		headers: { "Content-Type": "application/json" },
		...init,
	});
	if (!res.ok) {
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			body = await res.text().catch(() => null);
		}
		const msg =
			body && typeof body === "object" && "error" in body && typeof body.error === "string"
				? body.error
				: `${path} failed: ${res.status}`;
		throw new OpenshipApiError(res.status, msg, body);
	}
	return (await res.json()) as T;
}

export const openshipApi = {
	status(): Promise<OpenshipStatusResponse> {
		return req<OpenshipStatusResponse>("/openship/status");
	},
	listProjects(): Promise<{ items: OpenshipProject[] }> {
		return req<{ items: OpenshipProject[] }>("/openship/projects");
	},
	getProject(id: string): Promise<{ project: OpenshipProject; deployments: OpenshipDeployment[] }> {
		return req<{ project: OpenshipProject; deployments: OpenshipDeployment[] }>(`/openship/projects/${encodeURIComponent(id)}`);
	},
	triggerDeploy(id: string): Promise<{ deploymentId: string }> {
		return req<{ deploymentId: string }>(`/openship/projects/${encodeURIComponent(id)}/deploy`, { method: "POST" });
	},
	deploymentLogs(id: string, tail = 200): Promise<{ lines: string[] }> {
		return req<{ lines: string[] }>(`/openship/deployments/${encodeURIComponent(id)}/logs?tail=${tail}`);
	},
};
