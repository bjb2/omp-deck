import { useEffect, type ReactNode } from "react";
import { useFocusStore } from "./focus-store";
import { playNotificationTone } from "@/lib/audio";

export function useFocus() {
	return useFocusStore();
}

/**
 * Drives the focus session timer. Each second, computes elapsed/remaining
 * for the active phase; when it hits zero, plays the info tone, fires an OS
 * notification if permitted, then transitions to break (or stops if we
 * were already in break).
 */
export function FocusModeProvider({ children }: { children: ReactNode }): JSX.Element {
	const session = useFocusStore((s) => s.session);
	const startBreak = useFocusStore((s) => s.startBreak);
	const stop = useFocusStore((s) => s.stop);

	useEffect(() => {
		if (!session) return;
		const id = setInterval(() => {
			const current = useFocusStore.getState().session;
			if (!current) return;
			const mins = current.phase === "focus" ? current.durationMin : current.breakMin;
			const elapsedMs = Date.now() - current.startedAt;
			if (elapsedMs >= mins * 60_000) {
				void firePhaseCompleteCue(current.phase);
				if (current.phase === "focus") {
					startBreak();
				} else {
					stop();
				}
			}
		}, 1000);
		return () => clearInterval(id);
	}, [session, startBreak, stop]);

	return <>{children}</>;
}

async function firePhaseCompleteCue(phase: "focus" | "break"): Promise<void> {
	try {
		await playNotificationTone("info");
	} catch {
		// audio unlock failures are non-fatal; surface only the OS notif.
	}
	if (typeof window !== "undefined" && "Notification" in window) {
		if (Notification.permission === "granted") {
			try {
				new Notification(phase === "focus" ? "Focus complete — break time" : "Break over", {
					body: phase === "focus" ? "Take a short break." : "Start another focus session?",
					silent: true,
				});
			} catch {
				// ignore — some browsers throw if constructed too often
			}
		}
	}
}
