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
		const detail = body as { error?: string; message?: string };
		throw new Error(detail.message ?? detail.error ?? `HTTP ${res.status}`);
	}
	return body as T;
}

export const pushApi = {
	vapidPublicKey: (): Promise<{ publicKey: string }> => request("/push/vapid-public-key"),
	subscribe: (subscription: PushSubscriptionJSON): Promise<{ ok: true }> =>
		request("/push/subscribe", { method: "POST", body: JSON.stringify(subscription) }),
	unsubscribe: (endpoint: string): Promise<{ ok: true }> =>
		request("/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint }) }),
	test: (): Promise<{ sent: number; pruned: number }> => request("/push/test", { method: "POST" }),
};
