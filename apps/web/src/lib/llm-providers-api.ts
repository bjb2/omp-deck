/**
 * LLM registry fetcher (§2 of docs/GENERATIVE.md).
 *
 * Mirrors the GET /api/llm/providers response. The server's `DeckLLMProvider`
 * type lives in `apps/server/src/llm-registry.ts`; we re-declare the small
 * subset the web client needs so the protocol package stays server-agnostic.
 */
export interface DeckLLMModelSummary {
	id: string;
	displayName: string;
}

export interface DeckLLMProviderSummary {
	id: string;
	displayName: string;
	models: DeckLLMModelSummary[];
}

export interface ListLLMProvidersResponse {
	providers: DeckLLMProviderSummary[];
}

async function request<T>(path: string): Promise<T> {
	const res = await fetch(`/api${path}`);
	if (!res.ok) {
		const body = await res.text().catch(() => "(unreadable)");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const llmProvidersApi = {
	list(): Promise<ListLLMProvidersResponse> {
		return request<ListLLMProvidersResponse>("/llm/providers");
	},
};
