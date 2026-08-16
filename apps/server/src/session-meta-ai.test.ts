/**
 * Unit tests for sessionMetaAI.summarize.
 *
 * Mocks the gholamDeckLLM stream via the routes-llm test seam (we own
 * that file; monkey-patching gholamDeckLLM.complete is the lighter seam
 * since session-meta-ai doesn't import the seam). Boots a fresh on-disk
 * SQLite db so patchSessionMeta has a real target.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import { gholamDeckLLM } from "./llm-registry.ts";
import { getSessionMeta } from "./db/session-meta.ts";
import { sessionMetaAI, type AiMeta, __setRegistryForTests } from "./session-meta-ai.ts";
import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import type { DeckLLMProviderRegistry, LlmChunk } from "./llm-registry.ts";
import type { AgentMessageJson, SessionSnapshot } from "@omp-deck/protocol";

let dir: string;
let originalComplete: typeof gholamDeckLLM.complete;

function makeHandle(snapshot: SessionSnapshot, setNameImpl?: (n: string) => Promise<void>): SessionHandle {
	const calls: string[] = [];
	const handle: SessionHandle = {
		sessionId: snapshot.sessionId,
		sessionFile: snapshot.sessionFile,
		cwd: snapshot.cwd,
		subscribe: () => () => {},
		snapshot: () => snapshot,
		prompt: async () => {},
		isStreamingNow: () => snapshot.isStreaming,
		queuedMessageCount: () => 0,
		clearQueue: () => ({ steering: 0, followUp: 0 }),
		getQueueSnapshot: () => [],
		cancelQueuedById: async () => false,
		editQueuedById: async () => false,
		abort: async () => {},
		setName: setNameImpl ?? (async (n: string) => { calls.push(n); }),
		compact: async () => {},
		setModel: async () => {},
		dispatchSlashCommand: async () => ({ kind: "fallthrough" }),
		dispatchDeckSlashCommand: async () => ({ kind: "fallthrough" }),
		getContextUsage: () => undefined,
		dispose: async () => {},
		setPlanMode: async () => {},
		getPlanModeContext: () => undefined,
		getPendingPlanApproval: () => undefined,
		respondToPlanApproval: async () => "settled",
	};
	return handle;
}

function makeBridge(sessionId: string, handle: SessionHandle): AgentBridge {
	const sessionMap = new Map<string, SessionHandle>([[sessionId, handle]]);
	return {
		createSession: async () => handle,
		resumeSession: async () => handle,
		getSession: (id: string) => sessionMap.get(id),
		listSessions: async () => [],
		trackSubscriberAdded: () => {},
		trackSubscriberRemoved: () => {},
		bumpActivity: () => {},
		listIdleSessions: async () => [],
		listModels: async () => [],
		subscribeUiFrames: () => () => {},
		respondToUiDialog: () => {},
		subscribePlanModeFrames: () => () => {},
		respondToPlanApproval: async () => "settled",
		dispose: async () => {},
	};
}

function message(role: "user" | "assistant", text: string): AgentMessageJson {
	return { role, content: text } as unknown as AgentMessageJson;
}

async function* chunkStream(chunks: LlmChunk[]): AsyncIterable<LlmChunk> {
	for (const c of chunks) yield c;
}

/** No-op registry whose resolve() always returns null — forces the
 *  heuristic-only path regardless of the host's provider config. */
function emptyRegistry(): DeckLLMProviderRegistry {
	return {
		list: async () => [],
		resolve: async () => null,
		complete: () => chunkStream([{ type: "done" }]),
	};
}

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-meta-ai-"));
	openDb({ path: path.join(dir, "deck.db") });
	originalComplete = gholamDeckLLM.complete;
	sessionMetaAI.__resetForTests();
});

afterEach(() => {
	// Restore original gholamDeckLLM.complete so other tests aren't affected.
	(gholamDeckLLM as { complete: typeof gholamDeckLLM.complete }).complete = originalComplete;
	__setRegistryForTests(null);
	closeDb();
	try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("sessionMetaAI.summarize", () => {
	test("valid JSON → returns parsed meta and persists to the session row", async () => {
		const sid = "01HFAKEUSERSESSID000000000";
		const handle = makeHandle({
			sessionId: sid,
			cwd: "/tmp/x",
			isStreaming: false,
			sessionFile: "/tmp/x.jsonl",
			messages: [
				message("user", "Investigate why the OpenAI call returns 401 only in production"),
				message("assistant", "Likely env var mismatch; check the deploy step."),
				message("user", "Confirmed — the key is loaded from the wrong file"),
			],
		} as SessionSnapshot);
		const bridge = makeBridge(sid, handle);

		const metaJson = JSON.stringify({
			title: "OpenAI 401 in prod",
			tags: ["openai", "auth", "deploy"],
			urgency: "high",
			importance: "high",
			status: "active",
			summary: "401 from OpenAI only in production; env var mismatch confirmed.",
		});
		(gholamDeckLLM as { complete: typeof gholamDeckLLM.complete }).complete = () => chunkStream([{ type: "text", delta: metaJson }, { type: "done" }]);

		const meta: AiMeta = await sessionMetaAI.summarize({ bridge, sessionId: sid });
		expect(meta.title).toBe("OpenAI 401 in prod");
		expect(meta.tags).toEqual(["openai", "auth", "deploy"]);
		expect(meta.urgency).toBe("high");
		expect(meta.importance).toBe("high");
		expect(meta.status).toBe("active");
		expect(meta.summary).toContain("401");

		const row = getSessionMeta(sid);
		expect(row).not.toBeNull();
		expect(row?.aiSummary).toBe(meta.summary);
		expect(row?.aiTags).toEqual(["openai", "auth", "deploy"]);
		expect(row?.aiGeneratedAt).not.toBe("");
	});

	test("invalid JSON → falls back to heuristic title, does not throw", async () => {
		const sid = "01HFAKEFAILSESSID000000000";
		const handle = makeHandle({
			sessionId: sid,
			cwd: "/tmp/x",
			isStreaming: false,
			messages: [message("user", "Refactor the websocket hub to use a single emitter")],
		} as SessionSnapshot);
		const bridge = makeBridge(sid, handle);

		(gholamDeckLLM as { complete: typeof gholamDeckLLM.complete }).complete = () =>
			chunkStream([{ type: "text", delta: "this is not json at all" }, { type: "done" }]);

		const meta = await sessionMetaAI.summarize({ bridge, sessionId: sid });
		expect(meta.title).toMatch(/Refactor|Websocket|Hub/);
		expect(meta.tags).toEqual([]);
		expect(meta.status).toBe("active");
		expect(meta.summary).toBe("");

		// Even on failure, the persisted row records the heuristic attempt with
		// empty AI fields so the deck UI can distinguish "tried" vs "untouched".
		const row = getSessionMeta(sid);
		expect(row?.aiTags).toEqual([]);
		expect(row?.aiGeneratedAt).not.toBe("");
	});

	test("cache hits on second call (zero LLM invocations)", async () => {
		const sid = "01HFAKECACHESESSID000000000";
		const handle = makeHandle({
			sessionId: sid,
			cwd: "/tmp/x",
			isStreaming: false,
			messages: [
				message("user", "Diagnose the dashboard latency spike after the v2 rollout"),
				message("assistant", "Looking at the request log now."),
			],
		} as SessionSnapshot);
		const bridge = makeBridge(sid, handle);

		let calls = 0;
		(gholamDeckLLM as { complete: typeof gholamDeckLLM.complete }).complete = () => {
			calls++;
			const payload = JSON.stringify({
				title: "Dashboard latency spike",
				tags: ["perf"],
				urgency: "high",
				importance: "high",
				status: "active",
				summary: "Latency spike post-rollout.",
			});
			return chunkStream([{ type: "text", delta: payload }, { type: "done" }]);
		};

		const a = await sessionMetaAI.summarize({ bridge, sessionId: sid });
		const b = await sessionMetaAI.summarize({ bridge, sessionId: sid });
		expect(calls).toBe(1);
		expect(b.title).toBe(a.title);

		// force:true bypasses the cache.
		const c = await sessionMetaAI.summarize({ bridge, sessionId: sid, force: true });
		expect(calls).toBe(2);
		expect(c.title).toBe(a.title);
	});

	test("empty model registry → heuristic-only path, no LLM call", async () => {
		__setRegistryForTests(emptyRegistry());
		const sid = "01HFAKENOSESSID00000000000";
		const handle = makeHandle({
			sessionId: sid,
			cwd: "/tmp/x",
			isStreaming: false,
			messages: [message("user", "Audit the auth middleware for token edge cases")],
		} as SessionSnapshot);
		const bridge = makeBridge(sid, handle);

		let calls = 0;
		(gholamDeckLLM as { complete: typeof gholamDeckLLM.complete }).complete = () => {
			calls++;
			return chunkStream([{ type: "error", error: "no registry" }]);
		};
		delete process.env.OMP_SESSION_META_MODEL;

		const meta = await sessionMetaAI.summarize({ bridge, sessionId: sid });
		expect(calls).toBe(0);
		expect(meta.title).toMatch(/Audit|Auth|Middleware/);
		expect(meta.tags).toEqual([]);
		expect(meta.status).toBe("active");
	});
});