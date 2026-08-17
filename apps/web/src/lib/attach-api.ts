const BASE = "/api";

export interface AttachTokenResponse {
	token: string;
	url: string;
	expiresAt?: number;
}

export interface AttachHistoryEntry {
	token: string;
	url: string;
	sessionId: string;
	createdAt: string;
}

export interface AttachHistoryResponse {
	entries: AttachHistoryEntry[];
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const attachApi = {
	createAttachToken(sessionId: string): Promise<AttachTokenResponse> {
		return req<AttachTokenResponse>(`/sessions/${encodeURIComponent(sessionId)}/attach-token`, {
			method: "POST",
		});
	},

	getAttachHistory(): Promise<AttachHistoryResponse> {
		return req<AttachHistoryResponse>("/sessions/attach-history");
	},
};
