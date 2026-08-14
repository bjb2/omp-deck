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

/** 503 with the "not configured" body — distinct from generic 5xx so the
 *  panel can render the inline connect hint instead of an error. */
export function isNoTokenError(err: unknown): boolean {
	return err instanceof OpenshipApiError && err.status === 503 && typeof err.body === "object" && err.body !== null && "error" in err.body;
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
		const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `${path} failed: ${res.status}`;
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
