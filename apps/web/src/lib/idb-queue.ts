/**
 * IndexedDB-backed queue for WS frames that need to survive a full tab
 * close. The in-memory `WsClient.queue` (`apps/web/src/lib/ws.ts:12`) only
 * lives while the page is open; if the user closes the tab while offline,
 * any prompt the user typed should still go out on the next visit.
 *
 * Scope: ONE store, ONE index. ~60 lines. No `idb` dependency; native
 * `indexedDB` is enough.
 *
 * Items stored: `{ id: string; frame: unknown; enqueuedAt: number }`.
 * `id` is the client-generated `id` field of the frame (or a stringified
 * timestamp fallback) so re-enqueues can be deduped client-side.
 */
const DB_NAME = "omp-deck-queue";
const DB_VERSION = 1;
const STORE_NAME = "frames";

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (): void => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: "id" });
			}
		};
		req.onsuccess = (): void => resolve(req.result);
		req.onerror = (): void => reject(req.error ?? new Error("indexedDB open failed"));
	});
}

export async function enqueue(frame: { id?: string; [k: string]: unknown }): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	const id = frame.id ?? `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		tx.objectStore(STORE_NAME).put({ id, frame, enqueuedAt: Date.now() });
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb put failed")); };
	});
}

/** Yield each queued frame in insertion order; delete after the callback
 *  resolves true (meaning the frame was sent successfully). */
export async function drain(handler: (frame: { id?: string; [k: string]: unknown }) => Promise<boolean>): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	const drained: { id: string; ok: boolean }[] = [];
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readwrite");
		const store = tx.objectStore(STORE_NAME);
		const cursorReq = store.openCursor();
		cursorReq.onsuccess = (): void => {
			const cursor = cursorReq.result;
			if (!cursor) return; // tx.oncomplete will fire
			const value = cursor.value as { id: string; frame: { id?: string; [k: string]: unknown } };
			handler(value.frame).then((ok) => {
				if (ok) cursor.delete();
				drained.push({ id: value.id, ok });
				cursor.continue();
			}).catch(() => {
				drained.push({ id: value.id, ok: false });
				cursor.continue();
			});
		};
		cursorReq.onerror = (): void => reject(cursorReq.error ?? new Error("idb cursor failed"));
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb drain failed")); };
	});
}

/** Peek at the queue depth — useful for UI badges. */
export async function size(): Promise<number> {
	if (typeof indexedDB === "undefined") return 0;
	const db = await openDb();
	return await new Promise<number>((resolve, reject) => {
		const tx = db.transaction(STORE_NAME, "readonly");
		const req = tx.objectStore(STORE_NAME).count();
		req.onsuccess = (): void => { db.close(); resolve(req.result); };
		req.onerror = (): void => { db.close(); reject(req.error ?? new Error("idb count failed")); };
	});
}
