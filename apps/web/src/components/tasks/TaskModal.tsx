import { useEffect, useState } from "react";
import { Archive, GitBranch, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { Task, TaskState } from "@omp-deck/protocol";

import { MarkdownEdit } from "@/components/MarkdownEdit";
import { Modal } from "@/components/ui/Modal";
import { tasksApi } from "@/lib/tasks-api";
import { cn } from "@/lib/utils";

interface Props {
	task: Task | null;
	states: TaskState[];
	onClose: () => void;
	onSave: (patch: { title?: string; body?: string; stateId?: string; cwd?: string; energyTag?: "low" | "medium" | "high" }) => void;
	onDelete: () => void;
	onArchive: () => void;
	onOpenInChat: () => void;
}

/**
 * Centered modal for full task detail / edit. Title is a large inline-editable
 * input; body uses MarkdownEdit (rendered by default, click to edit). The
 * action bar mirrors the inbox reader for consistency: state-change on the
 * left, archive / delete / Open-in-chat / close on the right.
 */
export function TaskModal({
	task,
	states,
	onClose,
	onSave,
	onDelete,
	onArchive,
	onOpenInChat,
}: Props) {
	const open = task !== null;

	// Local mirror of editable fields so we can commit on blur without
	// thrashing the API on every keystroke.
	const [title, setTitle] = useState("");
	const [stateId, setStateId] = useState("");
	const [cwd, setCwd] = useState("");
	const [energyTag, setEnergyTag] = useState<"low" | "medium" | "high" | "">("");

	// Dispatch form state — always rendered so hooks order is stable.
	const [newBranches, setNewBranches] = useState(2);
	const [newPrompt, setNewPrompt] = useState("");
	const [dispatchBusy, setDispatchBusy] = useState(false);
	const [dispatchError, setDispatchError] = useState<string | null>(null);

	useEffect(() => {
		if (!task) return;
		setTitle(task.title);
		setStateId(task.stateId);
		setCwd(task.cwd ?? "");
		setEnergyTag(task.energyTag ?? "");
	}, [task]);

	if (!task) return null;

	const dispatchBranches = task.dispatch?.branches ?? [];

	async function handleDispatch(): Promise<void> {
		if (!task) return;
		setDispatchBusy(true);
		setDispatchError(null);
		try {
			await tasksApi.dispatch(task.id, {
				branches: newBranches,
				prompt: newPrompt.trim() || undefined,
			});
			onSave({});
		} catch (err) {
			setDispatchError(err instanceof Error ? err.message : String(err));
		} finally {
			setDispatchBusy(false);
		}
	}
	function commitEnergyTag(next: string): void {
		const tag = (next || undefined) as "low" | "medium" | "high" | undefined;
		setEnergyTag(next as any);
		if (!task || tag === task.energyTag) return;
		onSave({ energyTag: tag });
	}

	async function handleMerge(branchId: string): Promise<void> {
		if (!task) return;
		setDispatchBusy(true);
		setDispatchError(null);
		try {
			await tasksApi.mergeDispatchBranch(task.id, branchId);
			onSave({});
		} catch (err) {
			setDispatchError(err instanceof Error ? err.message : String(err));
		} finally {
			setDispatchBusy(false);
		}
	}

	async function handleDiscard(branchId: string): Promise<void> {
		if (!task) return;
		setDispatchBusy(true);
		setDispatchError(null);
		try {
			await tasksApi.discardDispatchBranch(task.id, branchId);
			onSave({});
		} catch (err) {
			setDispatchError(err instanceof Error ? err.message : String(err));
		} finally {
			setDispatchBusy(false);
		}
	}

	function commitTitle(): void {
		if (!task) return;
		if (title !== task.title) onSave({ title });
	}
	function commitState(next: string): void {
		setStateId(next);
		if (!task || next === task.stateId) return;
		onSave({ stateId: next });
	}
	function commitCwd(): void {
		if (!task) return;
		const next = cwd.trim() || undefined;
		if ((task.cwd ?? "") !== (next ?? "")) onSave({ cwd: next });
	}

	const isArchived = Boolean(task.archivedAt);

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-3xl">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-line px-4">
				<select
					value={stateId}
					onChange={(e) => commitState(e.target.value)}
					className="field h-8 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{states.map((s) => (
						<option key={s.id} value={s.id}>
							{s.name}
						</option>
					))}
				</select>
				<div
					className="h-2 w-2 rounded-full"
					style={{
						backgroundColor:
							states.find((s) => s.id === stateId)?.color ?? "var(--ink-3, #6e6a62)",
					}}
				/>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconAction
						label={isArchived ? "Unarchive" : "Archive"}
						icon={isArchived ? RotateCcw : Archive}
						onClick={onArchive}
					/>
					<IconAction label="Delete" icon={Trash2} tone="danger" onClick={onDelete} />
					<button
						type="button"
						onClick={onOpenInChat}
						className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Open this task as a new chat session"
					>
						<MessageSquarePlus className="h-4 w-4 shrink-0" />
						<span>Open in chat</span>
					</button>
					<IconAction label="Close" icon={X} onClick={onClose} />
				</div>
			</header>

			<div className="shrink-0 border-b border-line px-6 pt-5 pb-3">
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitTitle}
					onKeyDown={(e) => {
						if (e.key === "Enter") (e.target as HTMLInputElement).blur();
					}}
					placeholder="Untitled task"
					className={cn(
						"w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none",
						isArchived && "text-ink-3 line-through",
					)}
				/>
				<div className="mt-1 grid grid-cols-[max-content_1fr_max-content_1fr] gap-x-4 gap-y-1 font-mono text-2xs text-ink-3">
					<span className="text-ink-4">created</span>
					<span>{new Date(task.createdAt).toLocaleString()}</span>
					<span className="text-ink-4">updated</span>
					<span>{new Date(task.updatedAt).toLocaleString()}</span>
					<span className="text-ink-4">cwd</span>
					<span className="col-span-3">
						<input
							value={cwd}
							onChange={(e) => setCwd(e.target.value)}
							onBlur={commitCwd}
							placeholder="(defaults to server cwd)"
							className="w-full bg-transparent font-mono text-2xs text-ink placeholder:text-ink-4 focus:outline-none"
						/>
					</span>
					<span className="text-ink-4">energy</span>
					<span className="col-span-3">
						<select
							value={energyTag}
							onChange={(e) => commitEnergyTag(e.target.value)}
							className="bg-transparent font-mono text-2xs text-ink outline-none border border-line rounded px-1.5 py-0.5"
						>
							<option value="">(none)</option>
							<option value="low">Low Energy</option>
							<option value="medium">Medium Energy</option>
							<option value="high">High Energy</option>
						</select>
					</span>
					{isArchived ? (
						<>
							<span className="text-warn">archived</span>
							<span>{new Date(task.archivedAt!).toLocaleString()}</span>
						</>
					) : null}
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<MarkdownEdit
					value={task.body}
					onChange={(next) => onSave({ body: next })}
					placeholder="Click to add notes — markdown supported. Use this for context, acceptance criteria, links."
				/>

				<section className="mt-6 border-t border-line pt-5">
					<header className="mb-3 flex items-center gap-2">
						<GitBranch className="h-4 w-4 text-ink-3" />
						<h3 className="font-mono text-2xs uppercase tracking-meta text-ink-3">
							Dispatch Fan-Out
						</h3>
					</header>

					{dispatchBranches.length ? (
						<ul className="mb-4 space-y-2">
							{dispatchBranches.map((b) => (
								<li
									key={b.id}
									className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-3 py-2"
								>
									<span
										aria-hidden="true"
										className={cn(
											"h-2 w-2 shrink-0 rounded-full",
											b.status === "merged" && "bg-ok",
											b.status === "discarded" && "bg-ink-4",
											b.status === "failed" && "bg-danger",
											b.status === "running" && "bg-warn animate-pulse",
										)}
									/>
									<span className="font-mono text-xs text-ink">
										{b.branchName || b.id.slice(0, 8)}
									</span>
									<span className="font-mono text-2xs uppercase tracking-meta text-ink-4">
										{b.status}
									</span>
									{b.sessionId ? (
										<a
											href={`/chat?session=${encodeURIComponent(b.sessionId)}`}
											className="text-2xs text-link hover:underline"
											title="Open branch session"
										>
											open chat
										</a>
									) : null}
									<div className="ml-auto flex items-center gap-1">
										<button
											type="button"
											disabled={dispatchBusy || b.status === "merged" || b.status === "discarded"}
											onClick={() => handleMerge(b.id)}
											className="btn-primary h-7 px-2 text-xs"
										>
											Merge
										</button>
										<button
											type="button"
											disabled={dispatchBusy || b.status === "merged" || b.status === "discarded"}
											onClick={() => handleDiscard(b.id)}
											className="h-7 rounded-md border border-line px-2 text-xs text-ink-2 hover:bg-paper-3 hover:text-ink disabled:opacity-50"
										>
											Discard
										</button>
									</div>
								</li>
							))}
						</ul>
					) : null}

					<div className="flex flex-wrap items-end gap-3">
						<label className="flex flex-col gap-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
							Branches
							<select
								value={newBranches}
								onChange={(e) => setNewBranches(Number(e.target.value))}
								disabled={dispatchBusy}
								className="field h-8 px-2 font-mono text-sm"
							>
								<option value={2}>2</option>
								<option value={3}>3</option>
								<option value={4}>4</option>
								<option value={5}>5</option>
							</select>
						</label>
						<label className="flex min-w-0 flex-1 flex-col gap-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
							Prompt (optional)
							<input
								value={newPrompt}
								onChange={(e) => setNewPrompt(e.target.value)}
								disabled={dispatchBusy}
								placeholder="extra instructions for the runner"
								className="field h-8 px-2 font-mono text-sm"
							/>
						</label>
						<button
							type="button"
							disabled={dispatchBusy}
							onClick={handleDispatch}
							className="btn-primary h-8 px-3 text-sm"
						>
							{dispatchBusy ? "Dispatching…" : `Dispatch ${newBranches} Branches`}
						</button>
					</div>
					{dispatchError ? (
						<p className="mt-2 font-mono text-2xs text-danger">{dispatchError}</p>
					) : null}
				</section>
			</div>
		</Modal>
	);
}

function IconAction({
	label,
	icon: Icon,
	onClick,
	tone = "default",
}: {
	label: string;
	icon: typeof Trash2;
	onClick: () => void;
	tone?: "default" | "danger";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger"
					? "text-ink-3 hover:bg-danger/10 hover:text-danger"
					: "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
