import type {
	DeleteFileRequest,
	ListDirResponse,
	MakeDirRequest,
	ReadFileResponse,
	RenamePathRequest,
	WriteFileRequest,
} from "@omp-deck/protocol";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		let message = body;
		try {
			message = JSON.parse(body).error ?? body;
		} catch {
			/* not json */
		}
		throw new Error(message || `HTTP ${res.status}`);
	}
	return (await res.json()) as T;
}

export const filesApi = {
	list(dirPath: string): Promise<ListDirResponse> {
		return request(`/files/list?path=${encodeURIComponent(dirPath)}`);
	},
	read(filePath: string): Promise<ReadFileResponse> {
		return request(`/files/read?path=${encodeURIComponent(filePath)}`);
	},
	write(body: WriteFileRequest): Promise<{ path: string; sizeBytes: number }> {
		return request("/files/write", { method: "PUT", body: JSON.stringify(body) });
	},
	mkdir(body: MakeDirRequest): Promise<{ path: string }> {
		return request("/files/mkdir", { method: "POST", body: JSON.stringify(body) });
	},
	rename(body: RenamePathRequest): Promise<{ path: string }> {
		return request("/files/rename", { method: "POST", body: JSON.stringify(body) });
	},
	remove(body: DeleteFileRequest): Promise<{ ok: true }> {
		return request("/files", { method: "DELETE", body: JSON.stringify(body) });
	},
};
