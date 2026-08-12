import type { CloneRepoRequest, CloneRepoResponse, GitHubStatusResponse, GitHubViewer, ListGitHubReposResponse } from "@omp-deck/protocol";

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
		const detail = body as { error?: string };
		throw new Error(detail.error || `HTTP ${res.status}`);
	}
	return body as T;
}

export const githubApi = {
	status(): Promise<GitHubStatusResponse> {
		return request("/github/status");
	},
	viewer(): Promise<GitHubViewer> {
		return request("/github/viewer");
	},
	repos(page = 1, perPage = 50): Promise<ListGitHubReposResponse> {
		return request(`/github/repos?page=${page}&perPage=${perPage}`);
	},
	clone(body: CloneRepoRequest): Promise<CloneRepoResponse> {
		return request("/github/clone", { method: "POST", body: JSON.stringify(body) });
	},
};
