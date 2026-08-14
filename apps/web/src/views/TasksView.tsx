import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
	DndContext,
	DragOverlay,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
	type DragStartEvent,
} from "@dnd-kit/core";
import {
	SortableContext,
	horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Settings2 } from "lucide-react";

import type { Task, TaskState } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Column } from "@/components/tasks/Column";
import { TaskCardBody } from "@/components/tasks/TaskCard";
import { TaskModal } from "@/components/tasks/TaskModal";
import { StateConfig } from "@/components/tasks/StateConfig";
import { tasksApi } from "@/lib/tasks-api";
import { useStore } from "@/lib/store";

export function TasksView() {
	const navigate = useNavigate();
	const [searchParams, setSearchParams] = useSearchParams();
	const setPendingDraft = useStore((s) => s.setPendingDraft);
	const createSession = useStore((s) => s.createSession);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const setInspectorOpen = useStore((s) => s.setInspectorOpen);

	const [tasks, setTasks] = useState<Task[]>([]);
	const [states, setStates] = useState<TaskState[]>([]);
	const [error, setError] = useState<string | undefined>();
	const [loading, setLoading] = useState(true);

	const [openTask, setOpenTask] = useState<Task | undefined>();
	const [showStateConfig, setShowStateConfig] = useState(false);

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
	);
	const [draggingTask, setDraggingTask] = useState<Task | null>(null);
	const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const data = await tasksApi.list();
			setTasks(data.tasks);
			setStates(data.states);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Live updates: any kanban mutation anywhere (UI, deck slash, agent REST)
	// bumps `tasksChangeCounter` in the store. Refetch when it changes so the
	// view stays in sync without polling.
	const tasksChangeCounter = useStore((s) => s.tasksChangeCounter);
	useEffect(() => {
		// Skip the very first render — `refresh` above already loaded the list.
		if (tasksChangeCounter === 0) return;
		void refresh();
	}, [tasksChangeCounter, refresh]);

	// Deep-link support: `?open=<taskId>` (e.g. from "Promote to task" in the
	// inbox) auto-opens the matching task once the list has loaded, then strips
	// the param so back/forward navigation doesn't re-open it.
	useEffect(() => {
		const wantedId = searchParams.get("open");
		if (!wantedId || tasks.length === 0) return;
		const found = tasks.find((t) => t.id === wantedId);
		if (found) {
			setOpenTask(found);
			const next = new URLSearchParams(searchParams);
			next.delete("open");
			setSearchParams(next, { replace: true });
		}
	}, [searchParams, setSearchParams, tasks]);

	const tasksByState = useMemo(() => {
		const map: Record<string, Task[]> = {};
		for (const s of states) map[s.id] = [];
		for (const t of tasks) {
			if (!map[t.stateId]) map[t.stateId] = [];
			map[t.stateId]!.push(t);
		}
		return map;
	}, [tasks, states]);

	async function onCreate(stateId: string, title: string): Promise<void> {
		try {
			const created = await tasksApi.create({ title, stateId });
			setTasks((prev) => [...prev, created]);
		} catch (e) {
			setError(String(e));
		}
	}

	function onDragStart(ev: DragStartEvent): void {
		const dragType = ev.active.data.current?.type as string | undefined;
		if (dragType === "column") {
			setDraggingColumnId(String(ev.active.id));
			return;
		}
		const id = String(ev.active.id);
		const t = tasks.find((x) => x.id === id);
		if (t) setDraggingTask(t);
	}

	async function onDragEnd(ev: DragEndEvent): Promise<void> {
		const { active, over } = ev;
		const dragType = active.data.current?.type as string | undefined;

		if (dragType === "column") {
			setDraggingColumnId(null);
			if (!over || active.id === over.id) return;
			const overType = over.data.current?.type as string | undefined;
			// Only respond when dropped on another column node.
			if (overType !== "column") return;
			const fromIdx = states.findIndex((s) => s.id === active.id);
			const toIdx = states.findIndex((s) => s.id === over.id);
			if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return;

			const prevStates = states;
			const nextStates = [...states];
			const [moved] = nextStates.splice(fromIdx, 1);
			if (!moved) return;
			nextStates.splice(toIdx, 0, moved);
			const orderedIds = nextStates.map((s) => s.id);
			// Stamp optimistic positions so the UI sort key (`position ASC`) lines
			// up with the new order before the server response arrives.
			setStates(nextStates.map((s, i) => ({ ...s, position: (i + 1) * 100 })));
			try {
				const { states: confirmed } = await tasksApi.reorderStates(orderedIds);
				setStates(confirmed);
			} catch (e) {
				setError(String(e));
				setStates(prevStates);
			}
			return;
		}

		if (!over) {
			setDraggingTask(null);
			return;
		}
		const taskId = String(active.id);
		const overId = String(over.id);
		if (taskId === overId) {
			setDraggingTask(null);
			return;
		}

		let targetStateId: string | undefined;
		let targetIndex = 0;

		const overColumn = states.find((s) => s.id === overId);
		if (overColumn) {
			// Dropped on a column (header or empty area) — append to end.
			targetStateId = overColumn.id;
			const peers = (tasksByState[overColumn.id] ?? []).filter((t) => t.id !== taskId);
			targetIndex = peers.length;
		} else {
			const overTask = tasks.find((t) => t.id === overId);
			if (!overTask) {
				setDraggingTask(null);
				return;
			}
			targetStateId = overTask.stateId;
			// Compute insertion index based on the original list (with the dragged
			// task removed) so a same-column reorder lands at the correct slot.
			const peers = (tasksByState[overTask.stateId] ?? []).filter((t) => t.id !== taskId);
			const overIdx = peers.findIndex((t) => t.id === overTask.id);
			targetIndex = overIdx < 0 ? peers.length : overIdx;
		}

		if (!targetStateId) {
			setDraggingTask(null);
			return;
		}

		// ── Optimistic local reorder ─────────────────────────────────────────
		// Move the task in local state synchronously and clear the dragging flag
		// in the same render. Otherwise `DragOverlay`'s drop animation animates
		// the lifted card back to the *original* sortable slot (where the source
		// `useSortable` element still lives) before our `await tasksApi.move()`
		// round-trip finishes — the user sees the card "fall back" before
		// snapping to the new slot. With the synchronous reorder the source
		// element is already at the destination by the time the drop animation
		// computes its target rect.
		const prevTasks = tasks;
		const nextTasks = reorderTasksLocal(tasks, taskId, targetStateId, targetIndex);
		setTasks(nextTasks);
		setDraggingTask(null);

		try {
			const moved = await tasksApi.move(taskId, { stateId: targetStateId, index: targetIndex });
			// Merge the server's authoritative `orderInState` so subsequent moves
			// interpolate against the right gaps. Position in the array is fine —
			// the optimistic splice already placed the card in the right slot.
			setTasks((cur) => cur.map((t) => (t.id === moved.id ? moved : t)));
		} catch (e) {
			setError(String(e));
			setTasks(prevTasks);
		}
	}

	function onDragCancel(): void {
		setDraggingTask(null);
		setDraggingColumnId(null);
	}

	async function saveTask(patch: Parameters<typeof tasksApi.update>[1]): Promise<void> {
		if (!openTask) return;
		try {
			const updated = await tasksApi.update(openTask.id, patch);
			setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
			setOpenTask(updated);
		} catch (e) {
			setError(String(e));
		}
	}

	async function deleteOpenTask(): Promise<void> {
		if (!openTask) return;
		if (!confirm(`Delete "${openTask.title}"?`)) return;
		try {
			await tasksApi.remove(openTask.id);
			setTasks((prev) => prev.filter((t) => t.id !== openTask.id));
			setOpenTask(undefined);
		} catch (e) {
			setError(String(e));
		}
	}

	async function archiveOpenTask(): Promise<void> {
		if (!openTask) return;
		const archived = Boolean(openTask.archivedAt);
		await saveTask({ archived: !archived });
		setOpenTask(undefined);
		await refresh();
	}

	async function openInChat(task: Task): Promise<void> {
		const cwd = task.cwd || defaultCwd;
		try {
			await createSession({ cwd });
		} catch (e) {
			console.warn("createSession failed; falling back to draft only", e);
		}
		setPendingDraft({
			text: `# ${task.title}\n\n${task.body}`.trim(),
		});
		navigate("/chat");
	}

	return (
		<>
			<Layout
				sidebar={<TasksSidebar tasks={tasks} states={states} />}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">Kanban</div>
							<div className="text-xs text-ink-3">
								{tasks.length} task{tasks.length === 1 ? "" : "s"} · {states.length} columns
							</div>
							<button
								type="button"
								onClick={() => {
									setShowStateConfig((v) => !v);
									setInspectorOpen(true);
								}}
								data-tooltip-key="kanban.columns-edit"
								className="btn-ghost ml-auto h-7 px-2 text-xs"
								title="Edit columns"
							>
								<Settings2 className="h-3.5 w-3.5" />
								Columns
							</button>
						</div>

						{error ? (
							<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}

						{loading ? (
							<div className="flex flex-1 items-center justify-center text-sm text-ink-3">
								Loading…
							</div>
						) : (
							<DndContext
								sensors={sensors}
								onDragStart={onDragStart}
								onDragEnd={(ev) => void onDragEnd(ev)}
								onDragCancel={onDragCancel}
							>
								<SortableContext
									items={states.map((s) => s.id)}
									strategy={horizontalListSortingStrategy}
								>
									<div className="flex flex-1 min-h-0 overflow-x-auto">
										{states.map((s) => (
											<Column
												key={s.id}
												state={s}
												tasks={tasksByState[s.id] ?? []}
												onCreate={(stateId, title) => void onCreate(stateId, title)}
												onOpen={(t) => setOpenTask(t)}
												onRenameRequest={() => {
													setShowStateConfig(true);
													setInspectorOpen(true);
												}}
												isDraggingColumns={draggingColumnId !== null}
											/>
										))}
										{states.length === 0 ? (
											<div className="flex flex-1 items-center justify-center text-sm text-ink-3">
												No columns. Open the column editor to add one.
											</div>
										) : null}
									</div>
								</SortableContext>
								<DragOverlay
									dropAnimation={{
										duration: 200,
										easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
									}}
								>
									{draggingTask ? (
										<div className="w-72 px-2">
											<TaskCardBody task={draggingTask} lifted />
										</div>
									) : null}
									{draggingColumnId ? (() => {
										const s = states.find((x) => x.id === draggingColumnId);
										if (!s) return null;
										return (
											<div className="w-72 border border-line-strong bg-paper/95 shadow-[0_12px_24px_-8px_rgba(26,24,20,0.35)] rotate-[1deg]">
												<div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
													<span
														className="h-2 w-2 shrink-0 rounded-full"
														style={{ backgroundColor: s.color }}
													/>
													<span className="font-mono text-2xs uppercase tracking-meta text-ink-2">
														{s.name}
													</span>
													<span className="font-mono text-2xs text-ink-4">
														{(tasksByState[s.id] ?? []).length}
													</span>
												</div>
											</div>
										);
									})() : null}
								</DragOverlay>
							</DndContext>
						)}
					</div>
				}
				inspector={
					showStateConfig ? (
						<StateConfig states={states} onClose={() => setShowStateConfig(false)} onChanged={refresh} />
					) : (
						<EmptyInspector />
					)
				}
				topBar={null}
			/>
			<TaskModal
				task={openTask ?? null}
				states={states}
				onClose={() => setOpenTask(undefined)}
				onSave={(patch) => void saveTask(patch)}
				onDelete={() => void deleteOpenTask()}
				onArchive={() => void archiveOpenTask()}
				onOpenInChat={() => openTask && void openInChat(openTask)}
			/>
		</>
	);
}

function EmptyInspector() {
	return (
		<div className="flex h-full items-center justify-center px-4 text-center font-mono text-2xs text-ink-3">
			Click a task to edit, or the Columns button to configure states.
		</div>
	);
}

function TasksSidebar({ tasks, states }: { tasks: Task[]; states: TaskState[] }) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-3">
				<div className="meta mb-1.5">Overview</div>
				<div className="space-y-1">
					{states.map((s) => {
						const n = tasks.filter((t) => t.stateId === s.id).length;
						return (
							<div key={s.id} className="flex items-center gap-2 text-sm">
								<span
									className="h-2 w-2 shrink-0 rounded-full"
									style={{ backgroundColor: s.color }}
								/>
								<span className="flex-1 truncate text-ink-2">{s.name}</span>
								<span className="font-mono text-2xs text-ink-3">{n}</span>
							</div>
						);
					})}
				</div>
			</div>
			<div className="px-3 py-3 text-xs text-ink-3">
				<div className="meta mb-1.5">Tips</div>
				<ul className="list-disc space-y-1 pl-4">
					<li>Drag cards between columns to change state</li>
					<li>Click a column name to edit it</li>
					<li>Open in chat sends the task as the first prompt</li>
				</ul>
			</div>
		</div>
	);
}

/**
 * Pure synchronous reorder used by `onDragEnd` to optimistically place the
 * moving task at its new slot before the server round-trip completes.
 *
 * - `tasks` is the source-of-truth list (sorted within each column by
 *   `orderInState` as returned by the server).
 * - `targetIndex` is the desired 0-based position inside the destination
 *   column **after** the moving task has been removed from its current slot.
 *
 * Returns a new array with the moving task spliced at the correct absolute
 * index and its `stateId` / `orderInState` updated to plausible values so
 * subsequent renders read the right column ordering even before the server's
 * authoritative response arrives.
 */
function reorderTasksLocal(
	tasks: Task[],
	taskId: string,
	targetStateId: string,
	targetIndex: number,
): Task[] {
	const moving = tasks.find((t) => t.id === taskId);
	if (!moving) return tasks;

	const without = tasks.filter((t) => t.id !== taskId);

	// Locate destination-column peers in the global `without` array so we can
	// translate the per-column `targetIndex` into a global splice position.
	const peerIdxs: number[] = [];
	const peerOrders: number[] = [];
	for (let i = 0; i < without.length; i++) {
		const t = without[i]!;
		if (t.stateId === targetStateId) {
			peerIdxs.push(i);
			peerOrders.push(t.orderInState);
		}
	}

	const clamped = Math.max(0, Math.min(targetIndex, peerIdxs.length));

	let absoluteIndex: number;
	if (peerIdxs.length === 0) {
		// Empty destination column — appending anywhere preserves correctness
		// because Column derives its visible list by filtering on `stateId`.
		absoluteIndex = without.length;
	} else if (clamped === peerIdxs.length) {
		// After the last peer.
		absoluteIndex = peerIdxs[peerIdxs.length - 1]! + 1;
	} else {
		absoluteIndex = peerIdxs[clamped]!;
	}

	// Pick an `orderInState` between the surrounding peers' values so the row
	// survives a re-sort that may happen before the server response merges in.
	let newOrder: number;
	if (peerOrders.length === 0) newOrder = 1000;
	else if (clamped === 0) newOrder = peerOrders[0]! - 1000;
	else if (clamped === peerOrders.length) newOrder = peerOrders[peerOrders.length - 1]! + 1000;
	else newOrder = (peerOrders[clamped - 1]! + peerOrders[clamped]!) / 2;

	const moved: Task = { ...moving, stateId: targetStateId, orderInState: newOrder };
	const next = [...without];
	next.splice(absoluteIndex, 0, moved);
	return next;
}
