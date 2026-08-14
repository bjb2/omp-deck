/**
 * Contract tests for `apps/web/src/lib/drafts.ts` — the IDB round-trip
 * surface the `useDraft` hook calls into. The localStorage mirror is a
 * one-line `JSON.stringify` guard and the typed-during-hydration race
 * needs a separate jsdom + hook test fixture; neither is wired here.
 *
 * Two seams are stubbed:
 *   1. `globalThis.indexedDB` set to a truthy sentinel so production's
 *      `typeof indexedDB === "undefined"` guard lets us through to the
 *      shim below. The guard never reads the value.
 *   2. `./idb-queue`'s `openDb` is mocked via `bun:test`'s `mock.module`
 *      to return a Map-backed in-memory store that satisfies the IDB
 *      request shape the production code listens on (`tx.oncomplete`,
 *      `req.onsuccess`, `req.result`).
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// 1. Open the production `typeof indexedDB === "undefined"` guard.
(globalThis as unknown as { indexedDB: unknown }).indexedDB = true as unknown;

// 2. Stub the queue module's IDB connection with an in-memory store.
const mem = new Map<string, { value: unknown; savedAt: number }>();

type IdbReq<T> = {
	onsuccess: (() => void) | null;
	onerror: (() => void) | null;
	result: T;
};
type IdbStore = {
	put: (v: { value: unknown; savedAt: number }, k: string) => IdbReq<unknown>;
	get: (k: string) => IdbReq<{ value: unknown; savedAt: number } | undefined>;
	delete: (k: string) => IdbReq<unknown>;
};
type IdbTx = {
	objectStore: (_name: string) => IdbStore;
	oncomplete: (() => void) | null;
	onerror: (() => void) | null;
	error: Error | null;
};
type IdbConn = {
	transaction: (_store: string, _mode: "readonly" | "readwrite") => IdbTx;
	close: () => void;
};

// Real IDB requests fire their success/complete event one event-loop
// tick AFTER the synchronous listener wiring — so the promise the
// caller is awaiting is reachable before the listener fires. A queued
// microtask from inside the stub gives us that ordering deterministically
// without any wall-clock delay.
function settle(listener: () => void) {
	void Promise.resolve().then(listener);
}

const fakeConn: IdbConn = {
	transaction(_store, mode) {
		const tx: IdbTx = {
			oncomplete: null,
			onerror: null,
			error: null,
			objectStore(_name) {
				return {
					put: (v, k) => {
						mem.set(k, v);
						const req: IdbReq<unknown> = {
							onsuccess: null,
							onerror: null,
							result: undefined,
						};
						settle(() => tx.oncomplete?.());
						return req;
					},
					get: (k) => {
						const req: IdbReq<{ value: unknown; savedAt: number } | undefined> = {
							onsuccess: null,
							onerror: null,
							result: mem.get(k),
						};
						settle(() => req.onsuccess?.());
						return req;
					},
					delete: (k) => {
						mem.delete(k);
						const req: IdbReq<unknown> = {
							onsuccess: null,
							onerror: null,
							result: undefined,
						};
						settle(() => tx.oncomplete?.());
						return req;
					},
				};
			},
		};
		void mode;
		return tx;
	},
	close() {},
};

mock.module("./idb-queue", () => ({
	openDb: async () => fakeConn,
	DRAFTS_STORE: "drafts",
	enqueueHttpOp: () => {},
	drainHttpOps: async () => 0,
	httpOpsSize: () => 0,
}));

const { saveDraft, loadDraft, clearDraft } = await import("./drafts.ts");

beforeEach(() => {
	mem.clear();
});

describe("drafts (IDB round-trip)", () => {
	test("save → load roundtrip preserves a string value", async () => {
		await saveDraft("composer:abc", "the user's giant prompt");
		expect(await loadDraft<string>("composer:abc")).toBe("the user's giant prompt");
	});

	test("loadDraft returns null for an unknown key", async () => {
		expect(await loadDraft<string>("never-saved")).toBe(null);
	});

	test("saveDraft overwrites a previous value for the same key", async () => {
		await saveDraft("k", "first");
		await saveDraft("k", "second");
		expect(await loadDraft<string>("k")).toBe("second");
	});

	test("clearDraft removes the saved entry", async () => {
		await saveDraft("k", "v");
		await clearDraft("k");
		expect(await loadDraft<string>("k")).toBe(null);
	});

	test("structured-cloneable object values round-trip", async () => {
		const obj = { text: "t", count: 3, tags: ["a", "b"] };
		await saveDraft("o", obj);
		expect(await loadDraft<typeof obj>("o")).toEqual(obj);
	});
});
