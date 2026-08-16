/**
 * Gholam chat REST client (§1 of docs/GENERATIVE.md).
 *
 * Thin wrappers around `fetch` mirroring the server's `/gholam/chats/*`
 * routes. No streaming — runtime messages arrive over the WS broadcast bus
 * (`gholam_chat_message`, `gholam_chat_state`); REST handles list/read/post/
 * cancel/restart/delete. The store wires the WS reducer into this surface.
 */
import type {
	CreateGholamChatMessageRequest,
	CreateGholamChatRequest,
	GholamChat,
	GholamChatMessage,
	RestartGholamChatRequest,
} from "@omp-deck/protocol";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`/api${path}`, {
		...init,
		headers: {
			"content-type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "(unreadable)");
		throw new Error(`HTTP ${res.status} ${path}: ${body}`);
	}
	return (await res.json()) as T;
}

export const gholamChatApi = {
	list(opts: { cursor?: string; kind?: string; cwd?: string; limit?: number } = {}): Promise<{ chats: GholamChat[] }> {
		const params = new URLSearchParams();
		if (opts.cursor) params.set("cursor", opts.cursor);
		if (opts.kind) params.set("kind", opts.kind);
		if (opts.cwd) params.set("cwd", opts.cwd);
		if (opts.limit) params.set("limit", String(opts.limit));
		const qs = params.toString();
		return request(`/gholam/chats${qs ? `?${qs}` : ""}`);
	},
	get(id: string): Promise<GholamChat> {
		return request(`/gholam/chats/${encodeURIComponent(id)}`);
	},
	messages(id: string, since?: number): Promise<{ messages: GholamChatMessage[] }> {
		const qs = since !== undefined ? `?since=${since}` : "";
		return request(`/gholam/chats/${encodeURIComponent(id)}/messages${qs}`);
	},
	create(body: CreateGholamChatRequest): Promise<GholamChat> {
		return request("/gholam/chats", { method: "POST", body: JSON.stringify(body) });
	},
	appendMessage(id: string, body: CreateGholamChatMessageRequest): Promise<{ message: GholamChatMessage; chat: GholamChat }> {
		return request(`/gholam/chats/${encodeURIComponent(id)}/messages`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	cancel(id: string): Promise<GholamChat> {
		return request(`/gholam/chats/${encodeURIComponent(id)}/cancel`, { method: "POST" });
	},
	patchModel(id: string, model: string): Promise<{ chat: GholamChat }> {
		return request(`/gholam/chats/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify({ model }),
		});
	},
	restart(id: string, body: RestartGholamChatRequest): Promise<GholamChat> {
		return request(`/gholam/chats/${encodeURIComponent(id)}/restart`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: true }> {
		return request(`/gholam/chats/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
};
