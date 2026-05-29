import type {
	CompleteOnboardingRequest,
	OnboardingState,
	SeedKbSystemRequest,
	SeedKbSystemResponse,
} from "@omp-deck/protocol";

const BASE = "/api/onboarding";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(body || `HTTP ${res.status} ${path}`);
	}
	return (await res.json()) as T;
}

export const onboardingApi = {
	state(): Promise<OnboardingState> {
		return req<OnboardingState>("/state");
	},
	complete(skipped: boolean): Promise<OnboardingState> {
		return req<OnboardingState>("/complete", {
			method: "POST",
			body: JSON.stringify({ skipped } satisfies CompleteOnboardingRequest),
		});
	},
	seedKbSystem(kbRoot?: string): Promise<SeedKbSystemResponse> {
		const body: SeedKbSystemRequest = kbRoot ? { kbRoot } : {};
		return req<SeedKbSystemResponse>("/seed-kb-system", {
			method: "POST",
			body: JSON.stringify(body),
		});
	},
};
