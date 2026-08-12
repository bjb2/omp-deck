/**
 * Deck sign-in API.
 *
 * Distinct from `auth-api.ts`, which drives *model provider* OAuth (signing the
 * agent into Anthropic, OpenAI, …). This module is about who is allowed to open
 * the deck at all.
 *
 * Session state rides in an HttpOnly cookie the server sets, so nothing here
 * stores a token: the browser attaches it to same-origin requests
 * automatically, and JavaScript deliberately cannot read it.
 */

const BASE = "/api/auth";

export interface AuthStatus {
	/** True when the server requires a signed-in user. */
	authRequired: boolean;
	/** True when no account exists yet and first-run setup should be shown. */
	needsSetup: boolean;
	/** True when the setup form must also collect a setup token. */
	setupTokenRequired: boolean;
	authenticated: boolean;
	user: { id: string; username: string } | null;
}

export interface AuthError extends Error {
	status: number;
	code?: string;
	retryAfterSeconds?: number;
}

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
		const detail = body as { error?: string; message?: string; retryAfterSeconds?: number };
		const err = new Error(detail.message ?? `Request failed (${res.status})`) as AuthError;
		err.status = res.status;
		if (detail.error) err.code = detail.error;
		if (detail.retryAfterSeconds) err.retryAfterSeconds = detail.retryAfterSeconds;
		throw err;
	}
	return body as T;
}

export const deckAuthApi = {
	status: (): Promise<AuthStatus> => request<AuthStatus>("/status"),

	login: (username: string, password: string): Promise<{ ok: true; user: { id: string; username: string } }> =>
		request("/login", { method: "POST", body: JSON.stringify({ username, password }) }),

	setup: (input: {
		username: string;
		password: string;
		setupToken?: string;
	}): Promise<{ ok: true; user: { id: string; username: string } }> =>
		request("/setup", { method: "POST", body: JSON.stringify(input) }),

	logout: (): Promise<{ ok: true }> => request("/logout", { method: "POST" }),

	changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
		request("/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) }),
};
