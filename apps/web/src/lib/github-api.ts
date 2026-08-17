import type { CloneRepoRequest, CloneRepoResponse, GitHubBranch, GitHubCommit, GitHubPullRequest, GitHubRepoSummary, GitHubStatusResponse, GitHubViewer, ListGitHubReposResponse } from "@omp-deck/protocol";

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
	branches(owner: string, repo: string): Promise<GitHubBranch[]> {
		return request(`/github/branches?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`);
	},
	commits(owner: string, repo: string, ref: string): Promise<GitHubCommit[]> {
		return request(`/github/commits?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&ref=${encodeURIComponent(ref)}`);
	},
	createRepo(name: string, isPrivate: boolean): Promise<GitHubRepoSummary> {
		return request("/github/repos", { method: "POST", body: JSON.stringify({ name, private: isPrivate }) });
	},
	listPullRequests(owner: string, repo: string, state: "open" | "closed" | "all" = "open"): Promise<GitHubPullRequest[]> {
		return request(`/github/pulls?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}&state=${encodeURIComponent(state)}`);
	},
	getPullRequest(owner: string, repo: string, number: number): Promise<GitHubPullRequest> {
		return request(`/github/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}`);
	},
	createPullRequest(owner: string, repo: string, data: { title: string; head: string; base: string; body?: string }): Promise<GitHubPullRequest> {
		return request("/github/pulls", { method: "POST", body: JSON.stringify({ owner, repo, ...data }) });
	},
	mergePullRequest(owner: string, repo: string, number: number, method: "merge" | "squash" | "rebase" = "merge"): Promise<{ message: string }> {
		return request(`/github/pulls/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/merge`, {
			method: "PUT",
			body: JSON.stringify({ method }),
		});
	},
};
