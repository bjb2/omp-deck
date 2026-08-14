import type { ListSkillsResponse, SkillDetailResponse, SkillSummary } from "@omp-deck/protocol";

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

function withCwd(path: string, cwd: string | undefined): string {
	if (!cwd) return path;
	const sep = path.includes("?") ? "&" : "?";
	return `${path}${sep}cwd=${encodeURIComponent(cwd)}`;
}

export const skillsApi = {
	list(cwd?: string): Promise<ListSkillsResponse> {
		return req<ListSkillsResponse>(withCwd("/skills", cwd));
	},
	detail(id: string, cwd?: string): Promise<SkillDetailResponse> {
		// `id` is server-issued (base64url of the SKILL.md path). Clients
		// pass it back opaquely; the server validates that the decoded path
		// was actually returned by loadCapability before reading.
		return req<SkillDetailResponse>(withCwd(`/skills/${encodeURIComponent(id)}`, cwd));
	},
	enable(id: string, cwd?: string): Promise<{ ok: true; skill: SkillSummary }> {
		return req<{ ok: true; skill: SkillSummary }>(withCwd(`/skills/${encodeURIComponent(id)}/enable`, cwd), { method: "POST" });
	},
	disable(id: string, cwd?: string): Promise<{ ok: true; skill: SkillSummary }> {
		return req<{ ok: true; skill: SkillSummary }>(withCwd(`/skills/${encodeURIComponent(id)}/disable`, cwd), { method: "POST" });
	},
	remove(id: string, cwd?: string): Promise<{ ok: true; name: string; path: string }> {
		return req<{ ok: true; name: string; path: string }>(withCwd(`/skills/${encodeURIComponent(id)}`, cwd), { method: "DELETE" });
	},
	update(id: string, source: string, cwd?: string): Promise<{ ok: true; path: string }> {
		return req<{ ok: true; path: string }>(withCwd(`/skills/${encodeURIComponent(id)}/update`, cwd), {
			method: "POST",
			body: JSON.stringify({ source }),
		});
	},
};
