import { useEffect, useMemo, useState } from "react";
import { Play, Square, SkipForward, Calendar } from "lucide-react";
import { useFocusStore } from "./focus-store";
import { tasksApi } from "@/lib/tasks-api";
import type { Task } from "@omp-deck/protocol";
import { ScheduleManager } from "./ScheduleManager";

const RING_R = 10;
const RING_C = 2 * Math.PI * RING_R;

function formatMmSs(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

export function FocusStrip(): JSX.Element {
	const session = useFocusStore((s) => s.session);
	const startFocus = useFocusStore((s) => s.startFocus);
	const startBreak = useFocusStore((s) => s.startBreak);
	const stop = useFocusStore((s) => s.stop);

	const [tasks, setTasks] = useState<Task[]>([]);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [scheduleOpen, setScheduleOpen] = useState(false);
	// Re-render once a second so the timer text + ring progress stay live.
	const [, setTick] = useState(0);

	useEffect(() => {
		void tasksApi
			.list()
			.then((res) => setTasks(res.tasks ?? []))
			.catch(() => setTasks([]));
	}, []);

	useEffect(() => {
		if (!session) return;
		const id = setInterval(() => setTick((n) => n + 1), 1000);
		return () => clearInterval(id);
	}, [session]);

	const activeTask = useMemo(
		() =>
			session?.taskId ? (tasks.find((t) => t.id === session.taskId) ?? null) : null,
		[session, tasks],
	);

	const mins = session
		? session.phase === "focus"
			? session.durationMin
			: session.breakMin
		: 25;
	const elapsedMs = session ? Date.now() - session.startedAt : 0;
	const remainingMs = Math.max(0, mins * 60_000 - elapsedMs);
	const progress = session ? Math.min(1, elapsedMs / (mins * 60_000)) : 0;
	const dashOffset = RING_C * (1 - progress);

	const title = activeTask?.title ?? (session?.phase === "break" ? "Break" : "Focus session");

	// Idle / collapsed strip — focus mode is enabled but no active session.
	if (!session) {
		return (
			<div className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-paper-2 px-3 py-1 font-mono text-2xs text-ink-3">
				<div className="flex items-center gap-2">
					<Play className="h-3 w-3 text-ink-4" aria-hidden />
					<span>Focus off</span>
				</div>
				<button
					type="button"
					onClick={() => setPickerOpen(true)}
					className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-paper-3"
				>
					<Play className="h-3 w-3" />
					<span>Start focus</span>
				</button>
				{pickerOpen && (
					<TaskPicker
						tasks={tasks}
						onPick={(id) => {
							startFocus(id);
							setPickerOpen(false);
						}}
						onCancel={() => setPickerOpen(false)}
					/>
				)}
				{scheduleOpen && <ScheduleManager onClose={() => setScheduleOpen(false)} />}
			</div>
		);
	}

	return (
		<div className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-paper-2 px-3 py-1.5 font-mono text-2xs text-ink-3">
			<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
				<circle
					cx="12"
					cy="12"
					r={RING_R}
					fill="none"
					stroke="rgb(var(--line))"
					strokeWidth="2"
				/>
				<circle
					cx="12"
					cy="12"
					r={RING_R}
					fill="none"
					stroke="rgb(var(--accent))"
					strokeWidth="2"
					strokeDasharray={RING_C}
					strokeDashoffset={dashOffset}
					transform="rotate(-90 12 12)"
					strokeLinecap="round"
				/>
			</svg>
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="truncate text-ink">{title}</span>
				<span className="text-ink-4">·</span>
				<span className="text-ink-2">{session.phase === "focus" ? "focus" : "break"}</span>
				<span className="text-ink-4">·</span>
				<span className="text-ink-2">{formatMmSs(remainingMs)} left</span>
			</div>
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={() => setPickerOpen(true)}
					className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-paper-3"
					aria-label="Start focus on a task"
				>
					<Play className="h-3 w-3" />
					<span>Start</span>
				</button>
				{pickerOpen && (
					<TaskPicker
						tasks={tasks}
						onPick={(id) => {
							startFocus(id);
							setPickerOpen(false);
						}}
						onCancel={() => setPickerOpen(false)}
					/>
				)}
				<button
					type="button"
					onClick={() => startBreak()}
					className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-paper-3"
					aria-label="Skip to break"
				>
					<SkipForward className="h-3 w-3" />
					<span>Break</span>
				</button>
				<button
					type="button"
					onClick={() => stop()}
					className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-paper-3"
					aria-label="Stop focus session"
				>
					<Square className="h-3 w-3" />
					<span>Stop</span>
				</button>
				<button
					type="button"
					onClick={() => setScheduleOpen(true)}
					className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:bg-paper-3"
					aria-label="Manage scheduled alerts"
				>
					<Calendar className="h-3 w-3" />
					<span>Schedules</span>
				</button>
			</div>
			{scheduleOpen && <ScheduleManager onClose={() => setScheduleOpen(false)} />}
		</div>
	);
}

function TaskPicker({
	tasks,
	onPick,
	onCancel,
}: {
	tasks: Task[];
	onPick: (id: string | null) => void;
	onCancel: () => void;
}): JSX.Element {
	return (
		<select
			autoFocus
			onBlur={onCancel}
			onChange={(e) => onPick(e.target.value || null)}
			className="absolute right-3 top-9 rounded border border-line bg-paper px-1 py-0.5 text-ink"
		>
			<option value="">No task (free focus)</option>
			{tasks.map((t) => (
				<option key={t.id} value={t.id}>
					{t.title}
				</option>
			))}
		</select>
	);
}
