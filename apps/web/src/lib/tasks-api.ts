import type {
	CreateTaskRequest,
	CreateTaskStateRequest,
	ListTasksResponse,
	MoveTaskRequest,
	Task,
	TaskState,
	UpdateTaskRequest,
	UpdateTaskStateRequest,
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

export const tasksApi = {
	list(includeArchived = false): Promise<ListTasksResponse> {
		const q = includeArchived ? "?includeArchived=1" : "";
		return req<ListTasksResponse>(`/tasks${q}`);
	},
	create(body: CreateTaskRequest): Promise<Task> {
		return req<Task>(`/tasks`, { method: "POST", body: JSON.stringify(body) });
	},
	update(id: string, body: UpdateTaskRequest): Promise<Task> {
		return req<Task>(`/tasks/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	remove(id: string): Promise<{ ok: boolean }> {
		return req(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	move(id: string, body: MoveTaskRequest): Promise<Task> {
		return req<Task>(`/tasks/${encodeURIComponent(id)}/move`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	createState(body: CreateTaskStateRequest): Promise<TaskState> {
		return req<TaskState>(`/task-states`, { method: "POST", body: JSON.stringify(body) });
	},
	updateState(id: string, body: UpdateTaskStateRequest): Promise<TaskState> {
		return req<TaskState>(`/task-states/${encodeURIComponent(id)}`, {
			method: "PATCH",
			body: JSON.stringify(body),
		});
	},
	removeState(id: string): Promise<{ reassigned: number }> {
		return req(`/task-states/${encodeURIComponent(id)}`, { method: "DELETE" });
	},
	reorderStates(orderedIds: string[]): Promise<{ states: TaskState[] }> {
		return req<{ states: TaskState[] }>(`/task-states/reorder`, {
			method: "POST",
			body: JSON.stringify({ orderedIds }),
		});
	},
	dispatch(id: string, body: { branches: number; prompt?: string }): Promise<Task> {
		return req<Task>(`/tasks/${encodeURIComponent(id)}/dispatch`, {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
	mergeDispatchBranch(id: string, branchId: string): Promise<Task> {
		return req<Task>(
			`/tasks/${encodeURIComponent(id)}/dispatch/${encodeURIComponent(branchId)}/merge`,
			{ method: "POST" },
		);
	},
	discardDispatchBranch(id: string, branchId: string): Promise<Task> {
		return req<Task>(
			`/tasks/${encodeURIComponent(id)}/dispatch/${encodeURIComponent(branchId)}/discard`,
			{ method: "POST" },
		);
	},
};
