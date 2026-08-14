import { create } from "zustand";

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
	beginInstall: (id) =>
		set((s) => {
			// Don't downgrade a confirmed install to pending.
			if (s.installedAt[id] !== undefined) return {};
			return { installPhase: { ...s.installPhase, [id]: "pending" } };
		}),
	confirmInstall: (id) =>
		set((s) => {
			const nextPhase = { ...s.installPhase };
			delete nextPhase[id];
			return {
				installPhase: nextPhase,
				installedAt: { ...s.installedAt, [id]: Date.now() },
			};
		}),
	revertInstall: (id) =>
		set((s) => {
			const nextPhase = { ...s.installPhase };
			delete nextPhase[id];
			return { installPhase: nextPhase };
		}),
	clearInstall: (id) =>
		set((s) => {
			const nextPhase = { ...s.installPhase };
			const nextAt = { ...s.installedAt };
			delete nextPhase[id];
			delete nextAt[id];
			return { installPhase: nextPhase, installedAt: nextAt };
		}),
}));