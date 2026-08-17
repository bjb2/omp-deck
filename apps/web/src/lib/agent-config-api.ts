import type {
	AgentImportApplyResponse,
	AgentImportMode,
	AgentImportPlan,
	ListAgentBackupsResponse,
	ListAgentDirResponse,
	ReadAgentFileResponse,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: init?.body instanceof FormData ? init.headers : { "content-type": "application/json", ...(init?.headers ?? {}) },
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

export const agentConfigApi = {
	list(subPath: string): Promise<ListAgentDirResponse> {
		return request(`/agent-config/list?path=${encodeURIComponent(subPath)}`);
	},
	read(path: string): Promise<ReadAgentFileResponse> {
		return request(`/agent-config/read?path=${encodeURIComponent(path)}`);
	},
	write(path: string, content: string): Promise<{ path: string }> {
		return request("/agent-config/write", { method: "PUT", body: JSON.stringify({ path, content }) });
	},
	remove(path: string): Promise<{ ok: true }> {
		return request("/agent-config/path", { method: "DELETE", body: JSON.stringify({ path }) });
	},
	exportUrl(): string {
		return `${BASE}/agent-config/export`;
	},
	stageImport(file: File, mode: AgentImportMode): Promise<AgentImportPlan> {
		const form = new FormData();
		form.append("file", file);
		form.append("mode", mode);
		return request("/agent-config/import/stage", { method: "POST", body: form });
	},
	applyImport(stagingId: string): Promise<AgentImportApplyResponse> {
		return request(`/agent-config/import/${encodeURIComponent(stagingId)}/apply`, { method: "POST" });
	},
	discardImport(stagingId: string): Promise<{ ok: true }> {
		return request(`/agent-config/import/${encodeURIComponent(stagingId)}/discard`, { method: "POST" });
	},
	backups(): Promise<ListAgentBackupsResponse> {
		return request("/agent-config/backups");
	},
	restoreBackup(path: string): Promise<AgentImportApplyResponse> {
		return request("/agent-config/backups/restore", { method: "POST", body: JSON.stringify({ path }) });
	},
};
