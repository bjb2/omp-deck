import { create } from "zustand";

import { storefrontInstalls } from "./idb-queue";

/**
 * Pending installs older than this on bootstrap are treated as orphaned
 * (the network request died, never completed, never reverted) and
 * reverted. Confirmed installs always survive.
 */
const STALE_PENDING_MS = 30_000;

/**
 * Storefront UI state — orthogonal to the global `useStore`. Tracks the
 * optimistic install slice used by `InstallButton` (`installPhase` while
 * the request is in-flight, `installedAt` once the server has confirmed).
 * Realtime insertion-glow state lives in the global
 * `storefrontPulse.byId` slice; see `lib/store.ts`.
 */
interface StorefrontUiState {
	/**
	 * Item ids optimistically in a click-driven phase (`pending`) or already
	 * confirmed installed by the server (`done`). The button reflects this
	 * map so the chip is stable across store re-renders — pure React state
	 * would reset on any parent re-render that drops the button.
	 */
	installPhase: Record<string, "pending" | "done">;
	/** Server-confirmed install timestamp per item id. Drives the "Open" label. */
	installedAt: Record<string, number>;
	beginInstall: (id: string) => void;
	confirmInstall: (id: string) => void;
	revertInstall: (id: string) => void;
	clearInstall: (id: string) => void;
}

export const useStorefrontStore = create<StorefrontUiState>((set) => ({
	installPhase: {},
	installedAt: {},
	beginInstall: (id) => {
		if (typeof indexedDB !== "undefined") storefrontInstalls.begin(id);
		set((s) => {
			// Don't downgrade a confirmed install to pending.
			if (s.installedAt[id] !== undefined) return {};
			return { installPhase: { ...s.installPhase, [id]: "pending" } };
		});
	},
	confirmInstall: (id) => {
		if (typeof indexedDB !== "undefined") storefrontInstalls.confirm(id);
		set((s) => {
			const nextPhase = { ...s.installPhase };
			delete nextPhase[id];
			return {
				installPhase: nextPhase,
				installedAt: { ...s.installedAt, [id]: Date.now() },
			};
		});
	},
	revertInstall: (id) => {
		if (typeof indexedDB !== "undefined") storefrontInstalls.revert(id);
		set((s) => {
			const nextPhase = { ...s.installPhase };
			delete nextPhase[id];
			return { installPhase: nextPhase };
		});
	},
	clearInstall: (id) => {
		if (typeof indexedDB !== "undefined") storefrontInstalls.revert(id);
		set((s) => {
			const nextPhase = { ...s.installPhase };
			const nextAt = { ...s.installedAt };
			delete nextPhase[id];
			delete nextAt[id];
			return { installPhase: nextPhase, installedAt: nextAt };
		});
	},
}));

// ─── Bootstrap reconciliation ─────────────────────────────────────────────
// Runs once per module load in the browser. Reads the persisted install
// slice from IDB and rebuilds the in-memory store. Pending entries older
// than STALE_PENDING_MS are reverted (network request died, never
// confirmed, never reverted — we don't want a stale spinner forever);
// confirmed entries always survive. SSR / non-browser contexts no-op
// because `indexedDB` is undefined.

if (typeof indexedDB !== "undefined") {
	void (async (): Promise<void> => {
		try {
			const rows = await storefrontInstalls.listRaw();
			const now = Date.now();
			const phase: Record<string, "pending"> = {};
			const installedAt: Record<string, number> = {};
			const staleIds: string[] = [];
			for (const row of rows) {
				if (row.phase === "done") {
					if (row.installedAt !== undefined) installedAt[row.id] = row.installedAt;
				} else if (now - row.enqueuedAt > STALE_PENDING_MS) {
					// Orphaned pending — the network request that created
					// this row never confirmed and never reverted. Treat
					// as reverted so the chip stops spinning.
					staleIds.push(row.id);
				} else {
					phase[row.id] = "pending";
				}
			}
			for (const id of staleIds) storefrontInstalls.revert(id);
			if (Object.keys(phase).length === 0 && Object.keys(installedAt).length === 0) return;
			useStorefrontStore.setState((s) => ({
				installPhase: { ...s.installPhase, ...phase },
				installedAt: { ...s.installedAt, ...installedAt },
			}));
		} catch {
			// IDB unavailable or schema mismatch — fall back to empty store.
			// Same behavior as before persistence shipped.
		}
	})();
}