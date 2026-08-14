/**
 * IndexedDB-backed queue for WS frames AND mutating HTTP ops that need to
 * survive a full tab close. The in-memory `WsClient.queue`
 * (`apps/web/src/lib/ws.ts:12`) only lives while the page is open; if the
 * user closes the tab while offline, any prompt the user typed should
 * still go out on the next visit.
 *
 * Scope: three stores, one shared DB. The `drafts` store is owned by
 * `drafts.ts` and the `http-ops` store is owned by `prompts-api.ts`; they
 * live in the same DB so all three modules share one connection + upgrade
 * path.
 *
 * Items stored:
 *   - `frames`:    `{ id: string; frame: unknown; enqueuedAt: number }`
 *                  `id` is the client-generated `id` field of the frame
 *                  (or a stringified timestamp fallback) so re-enqueues
 *                  can be deduped client-side.
 *   - `drafts`:    `{ value, savedAt }` keyed by arbitrary string key —
 *                  see `drafts.ts`. Out-of-line key (no keyPath).
 *   - `http-ops`:  `{ id, kind, method, path, body, enqueuedAt }` keyed
 *                  by `id` — see `prompts-api.ts`.
 */
const DB_NAME = "omp-deck-queue";
const DB_VERSION = 3;
export const FRAMES_STORE = "frames";
export const DRAFTS_STORE = "drafts";
export const HTTP_OPS_STORE = "http-ops";

/**
 * Exported so companion modules (e.g. `drafts.ts`) can reuse the same
 * database handle without opening a second IDB connection per module.
 * onupgradeneeded creates all three stores so they live side-by-side.
 */
export function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = (): void => {
			const db = req.result;
			if (!db.objectStoreNames.contains(FRAMES_STORE)) {
				db.createObjectStore(FRAMES_STORE, { keyPath: "id" });
			}
			if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
				db.createObjectStore(DRAFTS_STORE);
			}
			if (!db.objectStoreNames.contains(HTTP_OPS_STORE)) {
				db.createObjectStore(HTTP_OPS_STORE, { keyPath: "id" });
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
		const tx = db.transaction(FRAMES_STORE, "readwrite");
		tx.objectStore(FRAMES_STORE).put({ id, frame, enqueuedAt: Date.now() });
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb put failed")); };
	});
}

/** Yield each queued frame in insertion order; delete after the callback
 *  resolves true (meaning the frame was sent successfully). */
export async function drain(handler: (frame: { id?: string; [k: string]: unknown }) => Promise<boolean>): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(FRAMES_STORE, "readwrite");
		const store = tx.objectStore(FRAMES_STORE);
		const cursorReq = store.openCursor();
		cursorReq.onsuccess = (): void => {
			const cursor = cursorReq.result;
			if (!cursor) return; // tx.oncomplete will fire
			const value = cursor.value as { id: string; frame: { id?: string; [k: string]: unknown } };
			handler(value.frame).then((ok) => {
				if (ok) cursor.delete();
				cursor.continue();
			}).catch(() => {
				cursor.continue();
			});
		};
		cursorReq.onerror = (): void => reject(cursorReq.error ?? new Error("idb cursor failed"));
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb drain failed")); };
	});
}

/** Peek at the frames queue depth — useful for UI badges. */
export async function size(): Promise<number> {
	if (typeof indexedDB === "undefined") return 0;
	const db = await openDb();
	return await new Promise<number>((resolve, reject) => {
		const tx = db.transaction(FRAMES_STORE, "readonly");
		const req = tx.objectStore(FRAMES_STORE).count();
		req.onsuccess = (): void => { db.close(); resolve(req.result); };
		req.onerror = (): void => { db.close(); reject(req.error ?? new Error("idb count failed")); };
	});
}

/* ───────────── HTTP ops queue (create/update/import) ───────────── */

export type HttpOpKind = "create" | "update" | "import";

export interface HttpOp {
	id: string;
	kind: HttpOpKind;
	method: "POST" | "PUT";
	path: string;
	body: unknown;
}

/** Enqueue a mutating HTTP op for offline replay. */
export async function enqueueHttpOp(op: HttpOp): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HTTP_OPS_STORE, "readwrite");
		tx.objectStore(HTTP_OPS_STORE).put({ ...op, enqueuedAt: Date.now() });
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb http-op put failed")); };
	});
}

/** Yield each queued HTTP op in insertion order; delete after the callback
 *  resolves true (meaning the server accepted the op). */
export async function drainHttpOps(handler: (op: HttpOp) => Promise<boolean>): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(HTTP_OPS_STORE, "readwrite");
		const store = tx.objectStore(HTTP_OPS_STORE);
		const cursorReq = store.openCursor();
		cursorReq.onsuccess = (): void => {
			const cursor = cursorReq.result;
			if (!cursor) return;
			const value = cursor.value as HttpOp;
			handler(value).then((ok) => {
				if (ok) cursor.delete();
				cursor.continue();
			}).catch(() => {
				cursor.continue();
			});
		};
		cursorReq.onerror = (): void => reject(cursorReq.error ?? new Error("idb http-op cursor failed"));
		tx.oncomplete = (): void => { db.close(); resolve(); };
		tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb http-op drain failed")); };
	});
}

/** Peek at the HTTP ops queue depth — mirrors `size()` for frames. */
export async function httpOpsSize(): Promise<number> {
	if (typeof indexedDB === "undefined") return 0;
	const db = await openDb();
	return await new Promise<number>((resolve, reject) => {
		const tx = db.transaction(HTTP_OPS_STORE, "readonly");
		const req = tx.objectStore(HTTP_OPS_STORE).count();
		req.onsuccess = (): void => { db.close(); resolve(req.result); };
		req.onerror = (): void => { db.close(); reject(req.error ?? new Error("idb http-op count failed")); };
	});
}
