/**
 * Tests the LLM smoke-test route (POST /api/llm/test). The route delegates
 * to `gholamDeckLLM.complete()` once the model has been resolved, so the
 * test seam `__setCompleteStreamForTests` swaps that sink for a controllable
 * async iterable. The registry singleton is replaced with a tiny fake via
 * `__setDeckLLMRegistryForTests` so resolution happens without booting the
 * SDK adapter.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import { initAuthConfig } from "./auth/config.ts";
import { createSession, createUser } from "./auth/store.ts";
import {
	buildLLMRouter,
	__setCompleteStreamForTests,
} from "./routes-llm.ts";
import {
	__setDeckLLMRegistryForTests,
	type DeckLLMProvider,
	type DeckLLMModel,
	type LlmChunk,
	type LlmMessage,
} from "./llm-registry.ts";

let dir: string;
let sessionCookie: { name: string; token: string } | null = null;

const MOCK_PROVIDER: DeckLLMProvider = {
	id: "minimax",
	displayName: "MiniMax",
	api: "openai-completions",
	baseUrl: "https://api.minimax.io/v1",
	models: [
		{
			id: "MiniMax-M3",
			displayName: "MiniMax M3",
			contextWindow: 200_000,
			pricing: { inputMicrocents: 0, outputMicrocents: 0 },
			capabilities: { tools: true, vision: false, json: true, thinking: true },
		},
	],
};

beforeEach(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-llm-"));
	openDb({ path: path.join(dir, "deck.db") });
	const cfg = initAuthConfig("127.0.0.1");
	const user = await createUser({ username: "admin", password: "correct-horse" });
	const issued = createSession({ userId: user.id, ttlMs: 60_000 });
	sessionCookie = { name: cfg.cookieName, token: issued.token };
});

afterEach(() => {
	__setCompleteStreamForTests(null);
	__setDeckLLMRegistryForTests(null);
	closeDb();
	fs.rmSync(dir, { recursive: true, force: true });
	sessionCookie = null;
});

function adminReq(body: unknown): Request {
	return new Request("http://127.0.0.1:0/llm/test", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(sessionCookie ? { cookie: `${sessionCookie.name}=${sessionCookie.token}` } : {}),
		},
		body: JSON.stringify(body),
	});
}

function unauthReq(body: unknown): Request {
	return new Request("http://127.0.0.1:0/llm/test", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function makeRegistry(overrides?: {
	resolve?: (ref: { provider: string; id: string }) => Promise<{ provider: DeckLLMProvider; model: DeckLLMModel } | null>;
}) {
	return {
		async list(): Promise<DeckLLMProvider[]> {
			return [MOCK_PROVIDER];
		},
		async resolve(ref: { provider: string; id: string }) {
			if (overrides?.resolve) return overrides.resolve(ref);
			if (ref.provider === MOCK_PROVIDER.id) {
				const model = MOCK_PROVIDER.models.find((m) => m.id === ref.id);
				if (model) return { provider: MOCK_PROVIDER, model };
			}
			return null;
		},
		complete: () => {
			// not used by route — the seam replaces this
			return chunkStream([{ type: "done" }]);
		},
	};
}

async function* chunkStream(chunks: LlmChunk[]): AsyncIterable<LlmChunk> {
	for (const c of chunks) yield c;
}

describe("POST /api/llm/test", () => {
	test("returns 403 without a session", async () => {
		const res = await buildLLMRouter().request(unauthReq({ model: "minimax/MiniMax-M3" }));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("admin required");
	});

	test("rejects non-object JSON bodies", async () => {
		const res = await buildLLMRouter().request(
			new Request("http://127.0.0.1:0/llm/test", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: sessionCookie ? `${sessionCookie.name}=${sessionCookie.token}` : "",
				},
				body: JSON.stringify("just a string"),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("returns 404 for unknown model ref", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		const res = await buildLLMRouter().request(adminReq({ model: "minimax/no-such-model" }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toContain("unknown model");
	});

	test("returns 400 when model lacks provider/id separator", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		const res = await buildLLMRouter().request(adminReq({ model: "just-a-model" }));
		expect(res.status).toBe(400);
	});

	test("resolves body.model as 'provider/id' and streams back ok:true", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		__setCompleteStreamForTests(async function* (opts: {
			model: string;
			messages: LlmMessage[];
			signal?: AbortSignal;
		}) {
			// Sanity: the route forwards the resolved canonical ref.
			expect(opts.model).toBe("minimax/MiniMax-M3");
			expect(opts.messages[0]?.role).toBe("user");
			yield { type: "text", delta: "ok" };
			yield { type: "done" };
		});
		const res = await buildLLMRouter().request(adminReq({ model: "minimax/MiniMax-M3" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			ok: boolean;
			modelId: string;
			provider: string;
			note: string;
			latencyMs: number;
		};
		expect(body.ok).toBe(true);
		expect(body.modelId).toBe("minimax/MiniMax-M3");
		expect(body.provider).toBe("MiniMax");
		expect(body.note).toBe("streamed");
		expect(typeof body.latencyMs).toBe("number");
	});

	test("prefers explicit provider+id over body.model", async () => {
		__setDeckLLMRegistryForTests(
			makeRegistry({
				resolve: async (ref) => {
					expect(ref).toEqual({ provider: "minimax", id: "MiniMax-M3" });
					const model = MOCK_PROVIDER.models[0];
					if (!model) throw new Error("test fixture: MOCK_PROVIDER.models[0] missing");
					return { provider: MOCK_PROVIDER, model };
				},
			}),
		);
		__setCompleteStreamForTests(() =>
			chunkStream([{ type: "text", delta: "hi" }, { type: "done" }]),
		);
		const res = await buildLLMRouter().request(
			adminReq({ model: "wrong/format", provider: "minimax", id: "MiniMax-M3" }),
		);
		expect(res.status).toBe(200);
	});

	test("returns 502 when the upstream yields an error chunk", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		__setCompleteStreamForTests(() =>
			chunkStream([{ type: "error", error: "rate limited" }, { type: "done" }]),
		);
		const res = await buildLLMRouter().request(adminReq({ model: "minimax/MiniMax-M3" }));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("rate limited");
	});

	test("returns 502 when the stream ends with no chunks at all", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		__setCompleteStreamForTests(() => chunkStream([]));
		const res = await buildLLMRouter().request(adminReq({ model: "minimax/MiniMax-M3" }));
		expect(res.status).toBe(502);
		const body = (await res.json()) as { ok: boolean; error: string };
		expect(body.ok).toBe(false);
		expect(body.error).toBe("no response");
	});

	test("falls back to the baked default when no model is supplied", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		__setCompleteStreamForTests(() =>
			chunkStream([{ type: "text", delta: "y" }, { type: "done" }]),
		);
		const res = await buildLLMRouter().request(adminReq({}));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; modelId: string };
		expect(body.ok).toBe(true);
		expect(body.modelId).toBe("minimax/MiniMax-M3");
	});

	test("forwards AbortSignal to the upstream stream", async () => {
		__setDeckLLMRegistryForTests(makeRegistry());
		let receivedSignal: AbortSignal | undefined;
		__setCompleteStreamForTests((opts) => {
			receivedSignal = opts.signal;
			return chunkStream([{ type: "text", delta: "ok" }, { type: "done" }]);
		});
		const res = await buildLLMRouter().request(
			adminReq({ model: "minimax/MiniMax-M3", timeoutMs: 1000 }),
		);
		expect(res.status).toBe(200);
		expect(receivedSignal).toBeDefined();
		expect(receivedSignal?.aborted).toBe(false);
	});
});
