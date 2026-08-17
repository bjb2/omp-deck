import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { routinesApi } from "@/lib/routines-api";
import type { ListRoutinesResponse, Routine } from "@omp-deck/protocol";
import { useFocusStore } from "./focus-store";

function nextRun(): null {
	// No cron parser installed client-side. The server fires pre-alerts when
	// routines run; the strip just shows which routines have the toggle on.
	return null;
}

export function ScheduleManager({ onClose }: { onClose: () => void }): JSX.Element {
	const [routines, setRoutines] = useState<Routine[]>([]);
	const [loading, setLoading] = useState(true);
	const preAlerts = useFocusStore((s) => s.preAlerts);
	const togglePreAlert = useFocusStore((s) => s.togglePreAlert);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const res: ListRoutinesResponse = await routinesApi.list();
				if (!cancelled) setRoutines(res.routines ?? []);
			} catch {
				if (!cancelled) setRoutines([]);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		<div
			className="fixed inset-0 z-40 flex justify-end bg-black/40"
			role="dialog"
			aria-modal="true"
			aria-label="Scheduled focus alerts"
			onClick={onClose}
		>
			<div
				className="flex h-full w-96 max-w-[90vw] flex-col border-l border-line bg-paper font-sans text-ink"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-between border-b border-line px-3 py-2">
					<h2 className="font-mono text-sm">Scheduled focus alerts</h2>
					<button
						type="button"
						onClick={onClose}
						className="rounded p-1 text-ink-3 hover:bg-paper-3"
						aria-label="Close"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
				<div className="flex-1 overflow-y-auto">
					{loading ? (
						<div className="p-3 font-mono text-2xs text-ink-4">Loading routines…</div>
					) : routines.length === 0 ? (
						<div className="p-3 font-mono text-2xs text-ink-4">No routines yet.</div>
					) : (
						<ul className="divide-y divide-line">
							{routines.map((r) => {
								const id = typeof r.id === "string" ? r.id : r.name;
								const cronText =
									r && typeof r === "object" && "cron" in r
										? typeof (r as { cron?: unknown }).cron === "string" &&
										  (r as { cron: string }).cron.trim()
											? (r as { cron: string }).cron
											: null
										: null;
								const next = nextRun();
								const enabled = !!preAlerts[id];
								return (
									<li key={id} className="flex items-center gap-3 px-3 py-2 text-sm">
										<div className="min-w-0 flex-1">
											<div className="truncate font-mono text-ink">{r.name}</div>
											<div className="font-mono text-2xs text-ink-3">
												{cronText ?? "no schedule"}
												{next ? ` · next ${new Date(next).toLocaleString()}` : ""}
											</div>
										</div>
										<label className="flex items-center gap-2 font-mono text-2xs text-ink-3">
											<span>Pre-alert</span>
											<input
												type="checkbox"
												checked={enabled}
												onChange={() => togglePreAlert(id)}
												className="accent-accent"
												aria-label={`Toggle 15-minute pre-alert for ${r.name}`}
											/>
										</label>
									</li>
								);
							})}
						</ul>
					)}
				</div>
				<div className="border-t border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-4">
					15-minute pre-alerts play during the next focus session start.
				</div>
			</div>
		</div>
	);
}
