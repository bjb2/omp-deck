import type {
	KbBacklinksResponse,
	KbFileResponse,
	KbGraphResponse,
	KbSearchResponse,
	KbTreeResponse,
} from "@omp-deck/protocol";

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		let detail = body;
		try {
			const parsed = JSON.parse(body) as { error?: string };
			if (parsed && typeof parsed.error === "string") detail = parsed.error;
		} catch {
			// body wasn't JSON — fall through with the raw text.
	}
		throw new Error(`HTTP ${res.status} ${path}: ${detail}`);
	}
	return (await res.json()) as T;
}

function qs(params: Record<string, string | undefined>): string {
	const parts: string[] = [];
	for (const [k, v] of Object.entries(params)) {
		if (v === undefined || v === "") continue;
		parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
	}
	return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export const kbApi = {
	tree(path?: string): Promise<KbTreeResponse> {
		return req<KbTreeResponse>(`/kb/tree${qs({ path })}`);
	},
	file(path: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`);
	},
	put(path: string, content: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`, {
			method: "PUT",
			body: JSON.stringify({ content }),
		});
	},
	create(path: string, content: string): Promise<KbFileResponse> {
		return req<KbFileResponse>(`/kb/file${qs({ path })}`, {
			method: "POST",
			body: JSON.stringify({ content }),
		});
	},
	graph(): Promise<KbGraphResponse> {
		return req<KbGraphResponse>("/kb/graph");
	},
	backlinks(path: string): Promise<KbBacklinksResponse> {
		return req<KbBacklinksResponse>(`/kb/backlinks${qs({ path })}`);
	},
	search(q: string, limit = 20): Promise<KbSearchResponse> {
		return req<KbSearchResponse>(`/kb/search${qs({ q, limit: String(limit) })}`);
	},
	status(): Promise<KbStatusResponse> {
		return req<KbStatusResponse>("/kb/status");
	},
	init(): Promise<KbInitResponse> {
		return req<KbInitResponse>("/kb/init", { method: "POST" });
	},
};

// Lightweight local types so we don't need to round-trip through the protocol
// package just for two endpoints used only by the welcome panel.
export interface KbStatusResponse {
	root: string;
	exists: boolean;
	fileCount: number;
	error?: string;
}
export interface KbInitResponse extends KbStatusResponse {
	created: boolean;
	refusedReason?: string;
}
