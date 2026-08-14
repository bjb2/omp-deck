/**
 * Tiny per-key IndexedDB draft store. Reuses the `omp-deck-queue` DB
 * opened by `idb-queue.ts` (the `drafts` object store is co-located so
 * both modules share one connection + upgrade path).
 *
 * Exposes raw CRUD helpers (`saveDraft`, `loadDraft`, `clearDraft`) plus
 * a `useDraft(key, value, setValue)` hook that:
 *   - hydrates once on mount from IDB when a saved value exists,
 *   - debounces writes to IDB (~300ms) on every `value` change,
 *   - never throws into render — all errors are logged and swallowed.
 *
 * Writes are fire-and-forget. Callers that need to know when a write
 * landed can await `saveDraft` directly; the hook itself does not.
 */
import { useEffect, useRef } from "react";

import { openDb, DRAFTS_STORE } from "./idb-queue";

const DEBOUNCE_MS = 300;
const LS_PREFIX = "omp-deck:draft:";

/**
 * IndexedDB transactions opened inside `pagehide`/`visibilitychange` are
 * NOT guaranteed to complete — browsers may kill the page before the
 * async transaction commits, especially on a cold close or a fast
 * reload. `localStorage.setItem` is synchronous and reliably durable in
 * those same teardown handlers, so it's the actual safety net for "the
 * last few keystrokes before the tab dies". IDB stays canonical (larger
 * quota, works for Blobs); localStorage is best-effort JSON-only backup,
 * consulted on hydration only when IDB has nothing newer.
 */
function mirrorToLocalStorage(key: string, value: unknown): void {
	if (typeof localStorage === "undefined") return;
	if (!isJsonSerializable(value)) return;
	try {
		if (typeof File !== "undefined" && value instanceof File) return;
		if (typeof Blob !== "undefined" && value instanceof Blob) return;
		localStorage.setItem(LS_PREFIX + key, JSON.stringify({ value, savedAt: Date.now() }));
	} catch {
		/* quota / private-mode / non-JSON-safe — IDB remains canonical */
	}
}

function readLocalStorageMirror<T>(key: string): { value: T; savedAt: number } | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(LS_PREFIX + key);
		return raw ? (JSON.parse(raw) as { value: T; savedAt: number }) : null;
	} catch {
		return null;
	}
}

function clearLocalStorageMirror(key: string): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(LS_PREFIX + key);
	} catch {
		/* ignore */
	}
}

type TimeoutHandle = ReturnType<typeof setTimeout>;

function isJsonSerializable(value: unknown): boolean {
	// IndexedDB's structured clone handles JSON-safe values + Blobs/Files.
	// We refuse plain functions/Symbols so we never silently drop data.
	if (value === null || value === undefined) return true;
	const t = typeof value;
	if (t === "function" || t === "symbol") return false;
	if (t !== "object") return true;
	const v = value as { [k: string]: unknown };
	// `File`/`Blob` are objects but have structured-clone support.
	if (typeof File !== "undefined" && v instanceof File) return true;
	if (typeof Blob !== "undefined" && v instanceof Blob) return true;
	// Plain object / array — trust the caller for nested shape.
	return true;
}

export async function saveDraft(key: string, value: unknown): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	if (!isJsonSerializable(value)) {
		console.warn(`saveDraft: refusing non-serializable value for key "${key}"`);
		return;
	}
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(DRAFTS_STORE, "readwrite");
		tx.objectStore(DRAFTS_STORE).put({ value, savedAt: Date.now() }, key);
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb draft put failed")); };
	});
}

export async function loadDraft<T = unknown>(key: string): Promise<T | null> {
	if (typeof indexedDB === "undefined") return null;
	const db = await openDb();
	const idbResult = await new Promise<{ value: T; savedAt: number } | undefined>(
		(resolve, reject) => {
			const tx = db.transaction(DRAFTS_STORE, "readonly");
			const req = tx.objectStore(DRAFTS_STORE).get(key);
			req.onsuccess = (): void => {
				db.close();
				resolve(req.result as { value: T; savedAt: number } | undefined);
			};
			req.onerror = (): void => {
				db.close();
				reject(req.error ?? new Error("idb draft get failed"));
			};
		},
	);
	// The localStorage mirror only ever wins when it is strictly newer —
	// it exists to cover the window between the last completed IDB write
	// and an abrupt teardown, not to replace IDB as the source of truth.
	const lsResult = readLocalStorageMirror<T>(key);
	if (lsResult && (!idbResult || lsResult.savedAt > idbResult.savedAt)) {
		return lsResult.value;
	}
	return idbResult ? idbResult.value : null;
}

export async function clearDraft(key: string): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	clearLocalStorageMirror(key);
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(DRAFTS_STORE, "readwrite");
		tx.objectStore(DRAFTS_STORE).delete(key);
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb draft delete failed")); };
	});
}

/**
 * Debounced autosave hook. Hydrates `setValue` once on mount from IDB
 * (if a saved value exists), then debounces subsequent writes whenever
 * `value` changes. Symmetric JSON handling is the caller's job — the
 * hook stores the raw `value` reference. If `value` is `undefined`, no
 * hydration is attempted and writes still proceed (useful for empty
 * initial states).
 */
export function useDraft<T>(
	key: string,
	value: T,
	setValue: (next: T) => void,
): void {
	// Hydration is tracked *per key*: the composer mounts with
	// `composer:global` and switches to `composer:<sessionId>` once the
	// session resolves. A single boolean would leave the second key
	// unhydrated while the write effect happily persisted the empty
	// initial value over the saved draft.
	const hydratedKeyRef = useRef<string | null>(null);
	const timerRef = useRef<TimeoutHandle | null>(null);
	const latestRef = useRef(value);
	latestRef.current = value;

	// Hydrate once per key. On hydration we deliberately overwrite the
	// caller's `value` via `setValue` so the textarea reflects the saved
	// draft. Errors are swallowed upstream; we never throw into render.
	useEffect(() => {
		if (hydratedKeyRef.current === key) return;
		let alive = true;
		void loadDraft<T>(key).then((saved) => {
			if (!alive) return;
			if (saved !== null && saved !== undefined) {
				setValue(saved);
				latestRef.current = saved;
			}
			// Only unblock writes once the read has settled, so the
			// initial empty value can never race ahead of the restore.
			hydratedKeyRef.current = key;
		});
		return () => {
			alive = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);

	// Debounced write on every value change, suppressed until the key has
	// hydrated. We capture the latest value via the ref so the debounced
	// fn always writes the freshest snapshot (avoids stale-closure
	// overwrites when the user types fast).
	useEffect(() => {
		if (hydratedKeyRef.current !== key) return;
		clearTimeout(timerRef.current!);
		timerRef.current = setTimeout(() => {
			// Mirror synchronously on every debounced fire, not only on
			// teardown — otherwise the 0-300ms gap between "last IDB
			// write landed" and "next debounce timer fires" is exactly
			// the window `pagehide` may not cover (unreliable on iOS
			// Safari backgrounding), leaving the mirror stale.
			mirrorToLocalStorage(key, latestRef.current);
			void saveDraft(key, latestRef.current);
		}, DEBOUNCE_MS);
		return () => {
			clearTimeout(timerRef.current!);
		};
	}, [key, value]);

	// A debounce window is exactly the interval in which a tab close, a
	// reload, or a crashing network can eat the newest keystrokes. Flush
	// synchronously-ish whenever the page is being hidden or torn down.
	useEffect(() => {
		const flush = () => {
			if (hydratedKeyRef.current !== key) return;
			clearTimeout(timerRef.current!);
			// Fire both: the localStorage write is synchronous and will
			// have landed before the browser tears the page down; the IDB
			// write may or may not finish, but it's strictly better than
			// nothing when it does.
			mirrorToLocalStorage(key, latestRef.current);
			void saveDraft(key, latestRef.current);
		};
		const onHide = () => {
			if (document.visibilityState === "hidden") flush();
		};
		document.addEventListener("visibilitychange", onHide);
		window.addEventListener("pagehide", flush);
		return () => {
			document.removeEventListener("visibilitychange", onHide);
			window.removeEventListener("pagehide", flush);
			flush();
		};
	}, [key]);
}
