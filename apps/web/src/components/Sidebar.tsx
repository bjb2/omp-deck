import { useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { shortPath } from "@/lib/utils";
import { NewSessionModal } from "@/components/sessions/NewSessionModal";
import { SessionRow, urgencyRank } from "@/components/sessions/SessionRow";
import type { SessionSummary } from "@omp-deck/protocol";
import type { SessionUi } from "@/lib/types";

type GroupBy = "recent" | "repo" | "urgency" | "importance";

const SHOW_ARCHIVED_STORAGE_KEY = "omp-deck.sidebar.showArchived";

function readShowArchived(): boolean {
	if (typeof window === "undefined") return false;
	return window.localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY) === "1";
}

function persistShowArchived(v: boolean): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, v ? "1" : "0");
	} catch {
		/* swallow: localStorage may be unavailable (private mode, quota) */
	}
}
const GROUP_BY_STORAGE_KEY = "omp-deck.sidebar.groupBy";

function readStoredGroupBy(): GroupBy {
	if (typeof window === "undefined") return "recent";
	const v = window.localStorage.getItem(GROUP_BY_STORAGE_KEY);
	if (v === "repo" || v === "urgency" || v === "importance") return v;
	return "recent";
}

function persistGroupBy(v: GroupBy): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(GROUP_BY_STORAGE_KEY, v);
	} catch {
		/* swallow: localStorage may be unavailable (private mode, quota) */
	}
}

function sortByUrgencyThenUpdated<T extends { urgency?: SessionSummary["urgency"]; updatedAt: string; createdAt: string }>(
	arr: T[],
): T[] {
	return arr
		.slice()
		.sort((a, b) => {
			const u = urgencyRank(b.urgency) - urgencyRank(a.urgency);
			if (u !== 0) return u;
			return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
		});
}

export function Sidebar() {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const activeId = useStore((s) => s.activeId);
	const sessionsById = useStore((s) => s.sessionsById);
	const refreshSessions = useStore((s) => s.refreshSessions);
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
	const createSession = useStore((s) => s.createSession);
	const selectSession = useStore((s) => s.selectSession);
	const regenerateSessionAiMeta = useStore((s) => s.regenerateSessionAiMeta);
	const setSessionUrgency = useStore((s) => s.setSessionUrgency);
	const setSessionImportance = useStore((s) => s.setSessionImportance);
	const archiveSession = useStore((s) => s.archiveSession);
	const unarchiveSession = useStore((s) => s.unarchiveSession);
	const deleteSession = useStore((s) => s.deleteSession);

	const [selectedCwd, setSelectedCwd] = useState<string | "">("");
	const [creating, setCreating] = useState(false);
	const [modalOpen, setModalOpen] = useState(false);
	const [groupBy, setGroupBy] = useState<GroupBy>(() => readStoredGroupBy());
	const [groupedGroups, setGroupedGroups] = useState<Array<{ key: string; sessions: SessionSummary[] }>>([]);
	const [groupedLoading, setGroupedLoading] = useState(false);
	const [showArchived, setShowArchived] = useState<boolean>(() => readShowArchived());

	useEffect(() => {
		persistShowArchived(showArchived);
	}, [showArchived]);

	useEffect(() => {
		persistGroupBy(groupBy);
		if (groupBy === "recent") {
			setGroupedGroups([]);
			return;
		}
		let cancelled = false;
		setGroupedLoading(true);
		void api
			.listGroupedSessions(groupBy)
			.then((res) => {
				if (cancelled) return;
				const groups = (res.groups ?? []).map((g) => ({
					key: g.key,
					sessions: sortByUrgencyThenUpdated(g.sessions),
				}));
				setGroupedGroups(groups);
			})
			.catch((err) => {
				if (cancelled) return;
				console.error("listGroupedSessions failed", err);
				setGroupedGroups([]);
			})
			.finally(() => {
				if (!cancelled) setGroupedLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [groupBy]);

	const cwdInUse = selectedCwd || defaultCwd;

	const filtered = useMemo(() => {
		if (!selectedCwd) return sessions;
		return sessions.filter((s) => s.cwd === selectedCwd);
	}, [sessions, selectedCwd]);

	async function handleNew(): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse });
		} catch (err) {
			console.error(err);
			alert(`Failed to create session: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	async function handleResume(p: string): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd: cwdInUse, resumeFromPath: p });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	async function handleDirectNew(cwd: string): Promise<void> {
		setCreating(true);
		try {
			await createSession({ cwd });
		} catch (err) {
			console.error(err);
			alert(`Failed to create session: ${String(err)}`);
		} finally {
			setCreating(false);
		}
	}

	const liveSessions = Object.values(sessionsById);
	const archivedLive = liveSessions.filter((s) => s.meta?.archived === true);
	const activeLive = liveSessions.filter((s) => s.meta?.archived !== true);
	const persistedAll = filtered
		.filter((s) => !sessionsById[s.id])
		.slice()
		.sort((a, b) => {
			const u = urgencyRank(b.urgency) - urgencyRank(a.urgency);
			if (u !== 0) return u;
			return (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt);
		});
	const archivedPersisted = persistedAll.filter((s) => s.archived === true);
	const persisted = persistedAll.filter((s) => s.archived !== true);
	const archivedCount = archivedLive.length + archivedPersisted.length;

	async function handleUnarchive(id: string): Promise<void> {
		// Reuse the store's archiveSession action by passing a custom meta
		// patch — the action wraps the patch but does not accept an
		// unarchive variant. Direct call to the patch helper is the
		// cleanest path: clear the archived flag locally + remotely.
		await unarchiveSession(id);
	}

	async function handleDelete(id: string): Promise<void> {
		await deleteSession(id);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="space-y-3 px-3 py-3 border-b border-line">
				<div className="flex items-center justify-between">
					<div className="meta">Workspace</div>
					<button
						type="button"
						className="text-ink-3 hover:text-ink"
						onClick={() => void refreshWorkspaces()}
						aria-label="Refresh workspaces"
					>
						<RefreshCw className="h-3 w-3" />
					</button>
				</div>

				<select
					value={selectedCwd}
					onChange={(e) => {
						setSelectedCwd(e.target.value);
						void refreshSessions(e.target.value || undefined);
					}}
					className="field h-7 w-full px-2 font-mono text-xs"
				>
					<option value="">(all workspaces)</option>
					{workspaces.map((w) => (
						<option key={w.cwd} value={w.cwd}>
							{w.label} · {w.sessionCount}
						</option>
					))}
				</select>
				<div className="truncate font-mono text-2xs text-ink-3" title={cwdInUse}>
					{cwdInUse}
				</div>
				<button
					type="button"
					className="btn-primary h-8 w-full text-[13px]"
					onClick={() => setModalOpen(true)}
					disabled={creating || !defaultCwd}
				>
					<Plus className="h-3.5 w-3.5" />
					New session
				</button>
				{workspaces.length > 0 ? (
					<div className="flex flex-col gap-0.5">
						<div className="meta">Quick · recent</div>
						{workspaces.slice(0, 3).map((w) => (
							<button
								key={w.cwd}
								type="button"
								disabled={creating}
								onClick={() => void handleDirectNew(w.cwd)}
								className="btn-ghost flex h-7 items-center justify-between px-2 text-left text-xs"
							>
								<span className="truncate">{w.label}</span>
								<span className="ml-2 shrink-0 font-mono text-2xs text-ink-3">{shortPath(w.cwd, 20)}</span>
							</button>
						))}
					</div>
				) : null}
				<NewSessionModal
					open={modalOpen}
					onClose={() => setModalOpen(false)}
					onCreated={() => {
						/* activeId is set by the store; nothing to do here */
					}}
				/>
			</div>

			<div className="flex items-center justify-between px-3 pt-3 pb-1">
				<div className="meta">Sessions · {filtered.length}</div>
				<button
					type="button"
					className="text-ink-3 hover:text-ink"
					onClick={() => void refreshSessions(selectedCwd || undefined)}
					aria-label="Refresh sessions"
				>
					<RefreshCw className="h-3 w-3" />
				</button>
				{archivedCount > 0 ? (
					<button
						type="button"
						onClick={() => setShowArchived((v) => !v)}
						className="ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink"
						title={showArchived ? "Hide archived sessions" : `Show ${archivedCount} archived`}
					>
						{showArchived ? "hide archived" : `show archived (${archivedCount})`}
					</button>
				) : null}
			</div>

			<div className="px-3 pb-2">
				<label className="meta block pb-1" htmlFor="sidebar-group-by">
					Group by
				</label>
				<select
					id="sidebar-group-by"
					value={groupBy}
					onChange={(e) => setGroupBy(e.target.value as GroupBy)}
					className="field h-7 w-full px-2 font-mono text-xs"
				>
					<option value="recent">Recent</option>
					<option value="repo">Repo</option>
					<option value="urgency">Urgency</option>
					<option value="importance">Importance</option>
				</select>
			</div>

			<div className="flex-1 overflow-y-auto px-1 pb-3">
				{groupBy === "recent" ? (
					<>
						{activeLive.map((s) => (
							<SessionRow
								key={s.sessionId}
								summary={liveSummaryFromUi(s)}
								title={s.sessionName ?? undefined}
								subtitle={shortPath(s.cwd, 30)}
								live
								planMode={s.planMode?.enabled === true}
								active={s.sessionId === activeId}
								updatedAt={s.meta?.aiGeneratedAt ?? undefined}
								sessionId={s.sessionId}
								onClick={() => selectSession(s.sessionId)}
								onArchive={(id) => void archiveSession(id)}
								onUnarchive={(id) => void handleUnarchive(id)}
								onRegenerate={(id) => void regenerateSessionAiMeta(id, { force: true })}
								onSetUrgency={(id, u) => void setSessionUrgency(id, u)}
								onSetImportance={(id, i) => void setSessionImportance(id, i)}
								onDelete={(id) => void handleDelete(id)}
							/>
						))}

						{activeLive.length > 0 && persisted.length > 0 ? (
							<div className="my-2 mx-2 border-t border-line" />
						) : null}

						{persisted.map((s) => (
							<SessionRow
								key={s.id}
								summary={s}
								subtitle={shortPath(s.cwd, 30)}
								onClick={() => void handleResume(s.path)}
								onArchive={(id) => void archiveSession(id)}
								onUnarchive={(id) => void handleUnarchive(id)}
								onRegenerate={(id) => void regenerateSessionAiMeta(id, { force: true })}
								onSetUrgency={(id, u) => void setSessionUrgency(id, u)}
								onSetImportance={(id, i) => void setSessionImportance(id, i)}
								onDelete={(id) => void handleDelete(id)}
							/>
						))}

						{showArchived && (archivedLive.length > 0 || archivedPersisted.length > 0) ? (
							<>
								<div className="mx-2 mt-3 mb-1 flex items-center gap-2">
									<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
										archived
									</div>
									<div className="h-px flex-1 bg-line" />
								</div>
								{archivedLive.map((s) => (
									<SessionRow
										key={`a-${s.sessionId}`}
										summary={liveSummaryFromUi(s)}
										title={s.sessionName ?? undefined}
										subtitle={shortPath(s.cwd, 30)}
										live
										planMode={s.planMode?.enabled === true}
										active={s.sessionId === activeId}
										updatedAt={s.meta?.aiGeneratedAt ?? undefined}
										sessionId={s.sessionId}
										onClick={() => selectSession(s.sessionId)}
										onArchive={(id) => void archiveSession(id)}
										onUnarchive={(id) => void handleUnarchive(id)}
										onRegenerate={(id) => void regenerateSessionAiMeta(id, { force: true })}
										onSetUrgency={(id, u) => void setSessionUrgency(id, u)}
										onSetImportance={(id, i) => void setSessionImportance(id, i)}
										onDelete={(id) => void handleDelete(id)}
									/>
								))}
								{archivedPersisted.map((s) => (
									<SessionRow
										key={`a-${s.id}`}
										summary={s}
										subtitle={shortPath(s.cwd, 30)}
										onClick={() => void handleResume(s.path)}
										onArchive={(id) => void archiveSession(id)}
										onUnarchive={(id) => void handleUnarchive(id)}
										onRegenerate={(id) => void regenerateSessionAiMeta(id, { force: true })}
										onSetUrgency={(id, u) => void setSessionUrgency(id, u)}
										onSetImportance={(id, i) => void setSessionImportance(id, i)}
										onDelete={(id) => void handleDelete(id)}
									/>
								))}
							</>
						) : null}

						{filtered.length === 0 && activeLive.length === 0 && archivedLive.length === 0 ? (
							<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
								No sessions yet.
							</div>
						) : null}
					</>
				) : (
					<>
						{groupedLoading && groupedGroups.length === 0 ? (
							<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
								Loading…
							</div>
						) : null}
						{groupedGroups.map((g) => (
							<div key={g.key} className="px-2 py-1">
								<div className="meta px-1 pb-1 uppercase">{g.key}</div>
								{g.sessions.map((s) => (
									<SessionRow
										key={s.id}
										summary={s}
										subtitle={shortPath(s.cwd, 30)}
										onClick={() => void handleResume(s.path)}
										onArchive={(id) => void archiveSession(id)}
										onUnarchive={(id) => void handleUnarchive(id)}
										onRegenerate={(id) => void regenerateSessionAiMeta(id, { force: true })}
										onSetUrgency={(id, u) => void setSessionUrgency(id, u)}
										onSetImportance={(id, i) => void setSessionImportance(id, i)}
										onDelete={(id) => void handleDelete(id)}
									/>
								))}
							</div>
						))}
						{!groupedLoading && groupedGroups.length === 0 ? (
							<div className="px-3 py-6 text-center font-mono text-2xs text-ink-3">
								No sessions in this grouping.
							</div>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * Build a SessionSummary-shaped value from a live SessionUi so the shared
 * SessionRow can render urgency/importance/AI tags/etc. without knowing
 * about the UI session type. Only the fields SessionRow actually reads
 * are populated; everything else is filled with safe defaults.
 */
function liveSummaryFromUi(s: SessionUi): SessionSummary {
	return {
		id: s.sessionId,
		path: s.sessionFile ?? s.cwd,
		cwd: s.cwd,
		title: s.sessionName,
		createdAt: "",
		updatedAt: s.meta?.aiGeneratedAt ?? "",
		messageCount: s.usage.totalTokens > 0 ? 1 : 0,
		urgency: s.meta?.urgency,
		importance: s.meta?.importance,
		status: s.meta?.archived ? "archived" : "active",
		archived: s.meta?.archived,
		aiSummary: s.meta?.aiSummary,
		aiTags: s.meta?.aiTags,
		aiGeneratedAt: s.meta?.aiGeneratedAt,
		repoId: undefined,
		worktree: undefined,
	};
}
