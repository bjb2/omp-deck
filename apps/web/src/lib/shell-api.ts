/**
 * In-deck shell API client. Mirrors the server's `/api/shell/*` routes:
 *
 *   GET    /shell              — list shells
 *   POST   /shell              — create { command, cwd? }
 *   GET    /shell/:id          — single summary
 *   GET    /shell/:id/tail     — last captured output as { text, status }
 *   POST   /shell/:id/input    — write a line to stdin
 *   DELETE /shell/:id          — kill
 *   GET    /shell/:id/stream   — SSE (consumed via EventSource, not this client)
 *
 * Why a separate client from `api.ts`: the shell surface is deck-only and
 * small; keeping it co-located with the view avoids polluting the chat
 * session bundle.
 */
const BASE = "/api";

export interface ShellSummary {
	id: string;
	command: string;
	cwd: string;
	status: "running" | "exited";
	exitCode?: number;
	startedAt: string;
	exitedAt?: string;
}

export interface ShellTail {
	text: string;
	status: "running" | "exited" | "unknown";
}

export class ShellApiError extends Error {
	readonly status: number;
	readonly path: string;
	constructor(status: number, path: string, body: string) {
		super(`HTTP ${status} ${path}: ${body}`);
		this.name = "ShellApiError";
		this.status = status;
		this.path = path;
	}
	/** The server purged the process — treat as "gone from the rail". */
	get isGone(): boolean {
		return this.status === 404;
	}
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new ShellApiError(res.status, path, body);
	}
	return (await res.json()) as T;
}

export const shellApi = {
	list(): Promise<{ shells: ShellSummary[] }> {
		return req<{ shells: ShellSummary[] }>("/shell");
	},
	get(id: string): Promise<ShellSummary> {
		return req<ShellSummary>(`/shell/${encodeURIComponent(id)}`);
	},
	tail(id: string): Promise<ShellTail> {
		return req<ShellTail>(`/shell/${encodeURIComponent(id)}/tail`);
	},
	create(body: { command: string; cwd?: string }): Promise<{ ok: true; process: ShellSummary }> {
		return req(`/shell`, { method: "POST", body: JSON.stringify(body) });
	},
	input(id: string, input: string): Promise<{ ok: true }> {
		return req(`/shell/${encodeURIComponent(id)}/input`, {
			method: "POST",
			body: JSON.stringify({ input }),
		});
	},
	kill(id: string): Promise<{ ok: true }> {
		return req(`/shell/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
};
