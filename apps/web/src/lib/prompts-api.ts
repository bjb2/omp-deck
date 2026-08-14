import type {
	CreatePromptRequest,
	ImportPromptRequest,
	ListPromptRecommendationsResponse,
	ListPromptsResponse,
	Prompt,
	UpdatePromptRequest,
} from "@omp-deck/protocol";

import {
	enqueueHttpOp,
	drainHttpOps,
	type HttpOp,
} from "./idb-queue";

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

/**
 * Run a mutating HTTP op with offline durability. If the network call
 * fails (offline OR 5xx), the op is persisted in IDB and replayed on the
 * next online `replayQueuedOps()` call. The local draft is kept until the
 * server actually accepts the op (the promptsApi wrapper calling this
 * is responsible for clearing its own draft state on success).
 */
async function runMutating<T>(
	op: Omit<HttpOp, "id">,
): Promise<T> {
	try {
		return await req<T>(op.path, { method: op.method, body: JSON.stringify(op.body) });
	} catch (err) {
		// Network failure / server error → persist for later replay.
		// Distinct id per attempt so a future update with the same prompt
		// id replaces the queued op (we tombstone the old one with delete).
		const id = `http-${op.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		await enqueueHttpOp({ ...op, id });
		throw err;
	}
}

/**
 * Replay every queued HTTP op against the server. Called from the WS
 * `open` listener so the same offline work drains regardless of which
 * transport (WS or HTTP) carried it. Each op is removed on a 2xx reply;
 * failures preserve the op for next time (FIFO preserved).
 *
 * Returns when the queue is empty or the loop hits a failure (preserves
 * order — we don't skip over a broken op to try the next one).
 */
export async function replayQueuedOps(): Promise<void> {
	let stop = false;
	await drainHttpOps(async (op) => {
		if (stop) return false;
		try {
			await req(op.path, { method: op.method, body: JSON.stringify(op.body) });
			return true;
		} catch (err) {
			console.warn(`replayQueuedOps: ${op.kind} ${op.path} failed`, err);
			stop = true;
			return false;
		}
	});
}


export const promptsApi = {
	list(): Promise<ListPromptsResponse> {
		return req<ListPromptsResponse>("/prompts/library");
	},
	get(id: string): Promise<Prompt> {
		return req<Prompt>(`/prompts/library/${encodeURIComponent(id)}`);
	},
	create(body: CreatePromptRequest): Promise<Prompt> {
		return runMutating<Prompt>({
			kind: "create",
			method: "POST",
			path: "/prompts/library",
			body,
		});
	},
	update(id: string, patch: UpdatePromptRequest): Promise<Prompt> {
		return runMutating<Prompt>({
			kind: "update",
			method: "PUT",
			path: `/prompts/library/${encodeURIComponent(id)}`,
			body: patch,
		});
	},
	remove(id: string): Promise<{ ok: true }> {
		return req<{ ok: true }>(`/prompts/library/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	exportPrompt(id: string): Promise<Prompt> {
		return req<Prompt>(`/prompts/library/${encodeURIComponent(id)}/export`);
	},
	importPrompt(body: ImportPromptRequest): Promise<{ id: string; prompt: Prompt }> {
		return runMutating<{ id: string; prompt: Prompt }>({
			kind: "import",
			method: "POST",
			path: "/prompts/library/import",
			body,
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
