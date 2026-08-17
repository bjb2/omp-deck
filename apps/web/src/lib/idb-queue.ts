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
const DB_VERSION = 4;
export const FRAMES_STORE = "frames";
export const DRAFTS_STORE = "drafts";
export const HTTP_OPS_STORE = "http-ops";
export const STOREFRONT_INSTALLS_STORE = "storefront-installs";

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
			// v4: persisted optimistic storefront install phase. Mirrors
			// `useStorefrontStore` so the install chip survives a full tab
			// close — pending installs older than 30s are reverted on
			// bootstrap, confirmed installs survive.
			if (!db.objectStoreNames.contains(STOREFRONT_INSTALLS_STORE)) {
				db.createObjectStore(STOREFRONT_INSTALLS_STORE, { keyPath: "id" });
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

/* ───────────── Storefront install phase (optimistic UI) ───────────── */

export interface StorefrontInstallRecord {
	id: string;
	phase: "pending" | "done";
	installedAt?: number;
	/** ms epoch when this row was first written. Used by bootstrap to
	 *  decide whether a stale "pending" entry should be reverted. */
	enqueuedAt: number;
}

/** Best-effort IDB write; never throws into the caller. The chip UX
 *  is optimistic and the network request is the source of truth — a
 *  failed IDB write just means the row is gone after the next reload,
 *  which is the same behavior we had before persistence. */
async function putStorefront(record: StorefrontInstallRecord): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STOREFRONT_INSTALLS_STORE, "readwrite");
			tx.objectStore(STOREFRONT_INSTALLS_STORE).put(record);
			tx.oncomplete = (): void => { db.close(); resolve(); };
			tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb storefront put failed")); };
		});
	} catch {
		// Swallow — see comment above.
	}
}

async function deleteStorefront(id: string): Promise<void> {
	if (typeof indexedDB === "undefined") return;
	try {
		const db = await openDb();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STOREFRONT_INSTALLS_STORE, "readwrite");
			tx.objectStore(STOREFRONT_INSTALLS_STORE).delete(id);
			tx.oncomplete = (): void => { db.close(); resolve(); };
			tx.onerror = (): void => { db.close(); reject(tx.error ?? new Error("idb storefront delete failed")); };
		});
	} catch {
		// Swallow.
	}
}

export const storefrontInstalls = {
	begin(id: string): void {
		// Fire-and-forget; current row is overwritten if it exists so a
		// re-click on a stale pending install refreshes the timestamp.
		void putStorefront({ id, phase: "pending", enqueuedAt: Date.now() });
	},
	confirm(id: string): void {
		// `done` rows survive bootstrap; the timestamp below is what the
		// connection indicator pill (and any future analytics) needs.
		void putStorefront({ id, phase: "done", installedAt: Date.now(), enqueuedAt: Date.now() });
	},
	revert(id: string): void {
		void deleteStorefront(id);
	},
	async list(): Promise<Array<{ id: string; phase: "pending" | "done"; installedAt?: number }>> {
		if (typeof indexedDB === "undefined") return [];
		const db = await openDb();
		return await new Promise<Array<{ id: string; phase: "pending" | "done"; installedAt?: number }>>(
			(resolve, reject) => {
				const tx = db.transaction(STOREFRONT_INSTALLS_STORE, "readonly");
				const req = tx.objectStore(STOREFRONT_INSTALLS_STORE).getAll();
				req.onsuccess = (): void => {
					db.close();
					const rows = (req.result ?? []) as StorefrontInstallRecord[];
					resolve(
						rows.map((r) => {
							const out: { id: string; phase: "pending" | "done"; installedAt?: number } = {
								id: r.id,
								phase: r.phase,
							};
							if (r.installedAt !== undefined) out.installedAt = r.installedAt;
							return out;
						}),
					);
				};
				req.onerror = (): void => {
					db.close();
					reject(req.error ?? new Error("idb storefront list failed"));
				};
			},
		);
	},

	/**
	 * Richer read used by bootstrap reconciliation — needs the raw
	 * `enqueuedAt` timestamp to decide whether a stale `pending` row
	 * (network request died, never confirmed or reverted) should be
	 * reverted. Not exposed on the public `list()` because the chip UX
	 * does not care about timestamps.
	 */
	async listRaw(): Promise<StorefrontInstallRecord[]> {
		if (typeof indexedDB === "undefined") return [];
		const db = await openDb();
		return await new Promise<StorefrontInstallRecord[]>((resolve, reject) => {
			const tx = db.transaction(STOREFRONT_INSTALLS_STORE, "readonly");
			const req = tx.objectStore(STOREFRONT_INSTALLS_STORE).getAll();
			req.onsuccess = (): void => {
				db.close();
				resolve((req.result ?? []) as StorefrontInstallRecord[]);
			};
			req.onerror = (): void => {
				db.close();
				reject(req.error ?? new Error("idb storefront listRaw failed"));
			};
		});
	},
};
