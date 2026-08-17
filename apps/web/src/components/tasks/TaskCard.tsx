import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@omp-deck/protocol";
import { formatBriefTime } from "@/lib/time";
import { useStore } from "@/lib/store";
import { Target, Zap } from "lucide-react";
import { cn, truncate } from "@/lib/utils";

interface Props {
	task: Task;
	onOpen: (task: Task) => void;
}

/**
 * Sortable card inside a column. While dragging, the in-list instance
 * collapses to a dashed-outline placeholder so the user sees where the card
 * will land; the lifted card itself is rendered by the DragOverlay in
 * TasksView. The two modes share `<TaskCardBody>` so the visual is identical.
 */
export function TaskCard({ task, onOpen }: Props) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: task.id });

	const style: React.CSSProperties = {
		transform: CSS.Transform.toString(transform),
		transition,
	};

	if (isDragging) {
		// Slot placeholder — same dimensions as the rendered card (content kept
		// in flow but invisible) so the column layout stays pixel-stable while
		// the lifted overlay is dragged around.
		return (
			<div
				ref={setNodeRef}
				style={style}
				{...attributes}
				{...listeners}
				aria-hidden="true"
				className="rounded-md border border-dashed border-line-strong bg-paper-3/30 px-3 py-2"
			>
				<div className="invisible text-sm font-medium">{task.title}</div>
				{task.body ? (
					<div className="invisible mt-1 line-clamp-2 text-xs">
						{truncate(task.body.split(/\r?\n/)[0] ?? "", 120)}
					</div>
				) : null}
			</div>
		);
	}

	return (
		<div
			ref={setNodeRef}
			style={style}
			{...attributes}
			{...listeners}
			onClick={(e) => {
				if (e.defaultPrevented) return;
				onOpen(task);
			}}
			role="button"
			tabIndex={0}
			className="group"
		>
			<TaskCardBody task={task} lifted={false} />
		</div>
	);
}

/**
 * Visual body of the card. Reused by the DragOverlay so the lifted version is
 * identical in shape; only the chrome differs (shadow, scale, rotation).
 */
export function TaskCardBody({ task, lifted }: { task: Task; lifted: boolean }) {
	// Surface the most recent activity timestamp — body edits bump updatedAt
	// without disturbing the per-column sort, which is exactly the signal a
	// glance at the card should reveal.
	const stamp = task.updatedAt;
	const brief = formatBriefTime(stamp);
	const branches = task.dispatch?.branches ?? [];
	const focusSessionId = useStore((s) => s.focusSessionId);
	const setFocusSession = useStore((s) => s.setFocusSession);
	const isFocusing = focusSessionId === task.id;
	return (
		<div
			data-context-key="kanban.card"
			data-task-id={task.id}
			className={cn(
				"select-none rounded-md border bg-paper-2 px-3 py-2 text-sm transition-shadow",
				lifted
					? "border-ink/30 shadow-[0_12px_24px_-8px_rgba(26,24,20,0.35),0_2px_4px_-2px_rgba(26,24,20,0.2)] rotate-[1.5deg] scale-[1.02] cursor-grabbing"
					: "border-line cursor-grab hover:border-line-strong active:cursor-grabbing",
			)}
		>
			<div className="flex items-baseline gap-2 font-mono text-[10px] uppercase tracking-meta text-ink-3">
				<span>T-{task.displayId}</span>
				{task.energyTag ? (
					<span
						className={cn(
							"inline-flex items-center gap-1 rounded-full px-1.5 py-0.2 font-mono text-[9px] uppercase tracking-meta font-medium",
							task.energyTag === "low" && "bg-sky-500/10 text-sky-400 border border-sky-500/20",
							task.energyTag === "medium" && "bg-amber-500/10 text-amber-400 border border-amber-500/20",
							task.energyTag === "high" && "bg-purple-500/10 text-purple-400 border border-purple-500/20",
						)}
					>
						<Zap className="h-2.5 w-2.5" />
						{task.energyTag}
					</span>
				) : null}
				{brief ? (
					<time
						dateTime={stamp}
						title={new Date(stamp).toLocaleString()}
						className="ml-auto text-ink-4"
					>
						{brief}
					</time>
				) : null}
			</div>
			<div className="mt-0.5 font-medium leading-snug text-ink">{task.title}</div>
			{branches.length ? (
				<div className="mt-1.5 flex flex-wrap gap-1">
					{branches.map((b) => (
						<button
							key={b.id}
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								if (b.sessionId) {
									window.location.href = `/chat?session=${encodeURIComponent(b.sessionId)}`;
								}
							}}
							disabled={!b.sessionId}
							title={b.sessionId ? `Open ${b.branchName} in chat` : b.branchName}
							className={cn(
								"inline-flex items-center gap-1 rounded-full border border-line bg-paper-3 px-2 py-0.5 font-mono text-[10px] text-ink-2",
								b.sessionId && "hover:border-line-strong hover:text-ink",
							)}
						>
							<span
								aria-hidden="true"
								className={cn(
									"h-1.5 w-1.5 rounded-full",
									b.status === "merged" && "bg-ok",
									b.status === "discarded" && "bg-ink-4",
									b.status === "failed" && "bg-danger",
									b.status === "running" && "bg-warn animate-pulse",
								)}
							/>
							<span className="truncate max-w-[8rem]">{b.branchName || b.id.slice(0, 6)}</span>
						</button>
					))}
				</div>
			) : null}
			{task.body ? (
				<div className="mt-1 line-clamp-2 text-xs text-ink-3">
					{truncate(task.body.split(/\r?\n/)[0] ?? "", 120)}
				</div>
			) : null}
			<div className="mt-2 flex items-center justify-end border-t border-line/50 pt-1.5">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						setFocusSession(isFocusing ? null : task.id);
					}}
					className={cn(
						"inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors",
						isFocusing
							? "bg-accent text-paper font-semibold shadow-sm"
							: "bg-paper-3 text-ink-3 hover:bg-paper-2 hover:text-ink border border-line",
					)}
					title={isFocusing ? "Clear focus" : "Focus on this task"}
				>
					<Target className={cn("h-3 w-3", isFocusing && "animate-spin")} />
					<span>{isFocusing ? "Focused" : "Focus"}</span>
				</button>
			</div>
		</div>
	);
}
