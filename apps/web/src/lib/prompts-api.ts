import type {
	CreatePromptRequest,
	ImportPromptRequest,
	ListPromptRecommendationsResponse,
	ListPromptsResponse,
	Prompt,
	UpdatePromptRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

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

export const promptsApi = {
	list(): Promise<ListPromptsResponse> {
		return req<ListPromptsResponse>("/prompts/library");
	},
	get(id: string): Promise<Prompt> {
		return req<Prompt>(`/prompts/library/${encodeURIComponent(id)}`);
	},
	create(body: CreatePromptRequest): Promise<Prompt> {
		return req<Prompt>("/prompts/library", { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, patch: UpdatePromptRequest): Promise<Prompt> {
		return req<Prompt>(`/prompts/library/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify(patch),
		});
	},
	remove(id: string): Promise<{ ok: true }> {
		return req<{ ok: true }>(`/prompts/library/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	exportPrompt(id: string): Promise<Prompt> {
		return req<Prompt>(`/prompts/library/${encodeURIComponent(id)}/export`);
	},
	importPrompt(body: ImportPromptRequest): Promise<{ id: string; prompt: Prompt }> {
		return req<{ id: string; prompt: Prompt }>("/prompts/library/import", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	getBySlug(slug: string): Promise<Prompt> {
		return req<Prompt>(`/prompts/share/${encodeURIComponent(slug)}`);
	},
	recommend(opts: {
		limit?: number;
		projectTerms?: string[];
		historyTerms?: string[];
	}): Promise<ListPromptRecommendationsResponse> {
		const params = new URLSearchParams();
		if (opts.limit !== undefined) params.set("limit", String(opts.limit));
		const q = params.toString();
		// POST keeps the term lists out of URLs (and keeps URL length bounded);
		// the server's GET variant also accepts them as comma-separated query
		// params for one-shot calls from `<PromptSuggestions />` on cold load.
		return req<ListPromptRecommendationsResponse>(
			`/prompts/recommend${q ? `?${q}` : ""}`,
			{
				method: "POST",
				body: JSON.stringify({
					...(opts.projectTerms ? { projectTerms: opts.projectTerms } : {}),
					...(opts.historyTerms ? { historyTerms: opts.historyTerms } : {}),
				}),
			},
		);
	},
};