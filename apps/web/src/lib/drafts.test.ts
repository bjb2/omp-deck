/**
 * Contract tests for `apps/web/src/lib/drafts.ts` — covers the five
 * guarantees the offline-autosave promise depends on:
 *
 *   1. IDB save → load round-trip (string).
 *   2. IDB save → load round-trip (structured-cloneable object).
 *   3. `clearDraft` removes both the IDB entry and the mirror.
 *   4. localStorage mirror is written SYNCHRONOUSLY by `mirrorToLocalStorage`
 *      (the contract protecting keystrokes in the IDB-commit window).
 *   5. Strictly-newer mirror wins over IDB on load.
 *
 * Typed-during-hydration race is exercised separately in the hook itself;
 * the jsdom + render harness is heavy and out of scope for this fixture.
 */
import { describe, test, expect, beforeEach, mock } from "bun:test";

// 1. Open production's `typeof indexedDB === "undefined"` guard.
(globalThis as unknown as { indexedDB: unknown }).indexedDB = true as unknown;

// 2. localStorage shim — a Map-backed Storage object, deterministic.
const lsMap = new Map<string, string>();
const fakeLocalStorage: Storage = {
	get length() {
		return lsMap.size;
	},
	clear() {
		lsMap.clear();
	},
	getItem(key) {
		return lsMap.get(key) ?? null;
	},
	key(i) {
		return Array.from(lsMap.keys())[i] ?? null;
	},
	removeItem(key) {
		lsMap.delete(key);
	},
	setItem(key, value) {
		lsMap.set(key, value);
	},
};
(globalThis as unknown as { localStorage: Storage }).localStorage = fakeLocalStorage;

// 3. In-memory IDB store shim, mock the queue module's `openDb`.
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

const {
	saveDraft,
	loadDraft,
	clearDraft,
	mirrorToLocalStorage,
	readLocalStorageMirror,
} = await import("./drafts.ts");

beforeEach(() => {
	mem.clear();
	lsMap.clear();
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

	test("structured-cloneable object values round-trip", async () => {
		const obj = { text: "t", count: 3, tags: ["a", "b"] };
		await saveDraft("o", obj);
		expect(await loadDraft<typeof obj>("o")).toEqual(obj);
	});
});

describe("drafts (localStorage mirror)", () => {
	test("mirrorToLocalStorage writes synchronously to the mirror key", () => {
		// Before: nothing in storage.
		expect(readLocalStorageMirror("k")).toBe(null);
		// Mirror write is sync, no async hop.
		mirrorToLocalStorage("k", "the latest keystrokes");
		const raw = lsMap.get("omp-deck:draft:k");
		expect(raw).not.toBe(null);
		const parsed = JSON.parse(raw!) as { value: string; savedAt: number };
		expect(parsed.value).toBe("the latest keystrokes");
		expect(typeof parsed.savedAt).toBe("number");
	});

	test("loadDraft prefers a strictly-newer mirror over a stale IDB copy", async () => {
		// Older IDB entry.
		await saveDraft("k", "old-idb-value");
		// Newer mirror — keystroke landed in the mirror between the last
		// IDB commit and the next debounce fire.
		lsMap.set(
			"omp-deck:draft:k",
			JSON.stringify({
				value: "newer-mirror-value",
				savedAt: Date.now() + 10_000,
			}),
		);
		expect(await loadDraft<string>("k")).toBe("newer-mirror-value");
	});

	test("loadDraft keeps the IDB copy when it is strictly newer than the mirror", async () => {
		// Newer IDB entry — mirror is stale.
		await saveDraft("k", "fresh-idb-value");
		lsMap.set(
			"omp-deck:draft:k",
			JSON.stringify({ value: "stale-mirror", savedAt: 0 }),
		);
		expect(await loadDraft<string>("k")).toBe("fresh-idb-value");
	});

	test("clearDraft wipes both the IDB entry and the mirror", async () => {
		await saveDraft("k", "v");
		mirrorToLocalStorage("k", "v");
		expect(lsMap.has("omp-deck:draft:k")).toBe(true);
		await clearDraft("k");
		expect(await loadDraft<string>("k")).toBe(null);
		expect(lsMap.has("omp-deck:draft:k")).toBe(false);
	});
});
