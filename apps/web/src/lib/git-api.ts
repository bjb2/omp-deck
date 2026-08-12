import type {
	CheckoutBranchRequest,
	CommitRequest,
	CommitResult,
	DiscardRequest,
	GitBranchesResponse,
	GitDiffResponse,
	GitLogResponse,
	GitRepoStatus,
	GitSyncResult,
	StageRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const text = await res.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = { message: text };
	}
	if (!res.ok) {
		const detail = body as { error?: string; stderr?: string };
		throw new Error([detail.error, detail.stderr].filter(Boolean).join("\n") || `HTTP ${res.status}`);
	}
	return body as T;
}

export const gitApi = {
	status(cwd: string): Promise<GitRepoStatus> {
		return request(`/git/status?cwd=${encodeURIComponent(cwd)}`);
	},
	diff(cwd: string, path: string, staged: boolean): Promise<GitDiffResponse> {
		const params = new URLSearchParams({ cwd, path, staged: staged ? "1" : "0" });
		return request(`/git/diff?${params.toString()}`);
	},
	stage(body: StageRequest): Promise<{ ok: true }> {
		return request("/git/stage", { method: "POST", body: JSON.stringify(body) });
	},
	unstage(body: StageRequest): Promise<{ ok: true }> {
		return request("/git/unstage", { method: "POST", body: JSON.stringify(body) });
	},
	discard(body: DiscardRequest): Promise<{ ok: true }> {
		return request("/git/discard", { method: "POST", body: JSON.stringify(body) });
	},
	commit(body: CommitRequest): Promise<CommitResult> {
		return request("/git/commit", { method: "POST", body: JSON.stringify(body) });
	},
	log(cwd: string, opts: { limit?: number; path?: string } = {}): Promise<GitLogResponse> {
		const params = new URLSearchParams({ cwd });
		if (opts.limit) params.set("limit", String(opts.limit));
		if (opts.path) params.set("path", opts.path);
		return request(`/git/log?${params.toString()}`);
	},
	branches(cwd: string): Promise<GitBranchesResponse> {
		return request(`/git/branches?cwd=${encodeURIComponent(cwd)}`);
	},
	checkout(body: CheckoutBranchRequest): Promise<{ ok: true }> {
		return request("/git/checkout", { method: "POST", body: JSON.stringify(body) });
	},
	push(cwd: string, opts: { setUpstream?: boolean; force?: boolean } = {}): Promise<GitSyncResult> {
		return request("/git/push", { method: "POST", body: JSON.stringify({ cwd, ...opts }) });
	},
	pull(cwd: string): Promise<GitSyncResult> {
		return request("/git/pull", { method: "POST", body: JSON.stringify({ cwd }) });
	},
	fetch(cwd: string): Promise<GitSyncResult> {
		return request("/git/fetch", { method: "POST", body: JSON.stringify({ cwd }) });
	},
};
