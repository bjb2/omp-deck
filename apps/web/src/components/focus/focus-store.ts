import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { FocusSession } from "./types";

interface FocusState {
	enabled: boolean;
	session: FocusSession | null;
	durationMin: number;
	breakMin: number;
	preAlerts: Record<string, boolean>; // routineId → toggle
	setEnabled: (v: boolean) => void;
	startFocus: (taskId: string | null) => void;
	startBreak: () => void;
	stop: () => void;
	togglePreAlert: (routineId: string) => void;
	setDurations: (focus: number, brk: number) => void;
}

export const useFocusStore = create<FocusState>()(
	persist(
		(set) => ({
			enabled: false,
			session: null,
			durationMin: 25,
			breakMin: 5,
			preAlerts: {},
			setEnabled: (v) => set({ enabled: v }),
			startFocus: (taskId) =>
				set({
					session: {
						taskId,
						startedAt: Date.now(),
						durationMin: 25,
						breakMin: 5,
						phase: "focus",
					},
					enabled: true,
				}),
			startBreak: () =>
				set((s) =>
					s.session
						? { session: { ...s.session, phase: "break", startedAt: Date.now() } }
						: { session: s.session },
				),
			stop: () => set({ session: null }),
			togglePreAlert: (id) =>
				set((s) => ({ preAlerts: { ...s.preAlerts, [id]: !s.preAlerts[id] } })),
			setDurations: (focus, brk) => set({ durationMin: focus, breakMin: brk }),
		}),
		{ name: "omp-deck:focus-mode" },
	),
);

export const useFocus = useFocusStore;
