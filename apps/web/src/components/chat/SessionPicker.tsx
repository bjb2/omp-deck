import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Clock, ClipboardList, MessagesSquare, Plus } from "lucide-react";
import type { SessionSummary } from "@omp-deck/protocol";

import { selectActiveSession, useStore } from "@/lib/store";
import { cn, shortPath } from "@/lib/utils";

/**
 * Rendered as the chat main pane when there is no active session selected.
 * Replaces the previous "Pick a session from the sidebar" dead-end with a
 * primary "New session" CTA and an inline list of recent persisted sessions,
 * so the user never has to open the sidebar just to start working.
 */
export function SessionPicker() {
	const session = useStore(selectActiveSession);
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const sessionsById = useStore((s) => s.sessionsById);
	const createSession = useStore((s) => s.createSession);
	const selectSession = useStore((s) => s.selectSession);
	const refreshSessions = useStore((s) => s.refreshSessions);

	const [selectedCwd, setSelectedCwd] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const cwdInUse = selectedCwd || defaultCwd;

	const recent = useMemo(() => {
		const live = Object.values(sessionsById);
		// Persisted rows, freshest first, that aren't already loaded in memory.
		const persisted = sessions
			.filter((s) => !sessionsById[s.id])
			.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
			.slice(0, 6);
		return { live, persisted };
	}, [sessions, sessionsById]);

	async function startFresh(): Promise<void> {
		setBusy(true);
		try {
			await createSession({ cwd: cwdInUse });
		} catch (err) {
			console.error(err);
			alert(`Failed to create session: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	async function resume(s: SessionSummary): Promise<void> {
		setBusy(true);
		try {
			await createSession({ cwd: cwdInUse, resumeFromPath: s.path });
		} catch (err) {
			console.error(err);
			alert(`Failed to resume: ${String(err)}`);
		} finally {
			setBusy(false);
		}
	}

	// Only render the picker when there is genuinely no active session.
	if (session) return null;

	return (
		<div className="flex h-full flex-col items-center justify-center px-4">
			<div className="w-full max-w-xl">
				<OnboardingReminderTile />
				<WelcomeTaskTile />
				<div className="mb-6 flex items-baseline gap-2">
					<MessagesSquare className="h-5 w-5 text-ink-3" />
					<h1 className="text-lg font-semibold text-ink">Start a session</h1>
				</div>

				{/* Primary action — workspace picker + new session */}
				<div className="rounded-lg border border-line bg-paper-2 p-4 shadow-[0_1px_2px_rgba(26,24,20,0.04)]">
					<div className="meta mb-1.5">Workspace</div>
					<select
						value={selectedCwd}
						onChange={(e) => {
							setSelectedCwd(e.target.value);
							void refreshSessions(e.target.value || undefined);
						}}
						className="field h-8 w-full px-2 font-mono text-xs"
					>
						<option value="">{`(default) ${defaultCwd}`}</option>
						{workspaces
							.filter((w) => w.cwd !== defaultCwd)
							.map((w) => (
								<option key={w.cwd} value={w.cwd}>
									{w.label} · {w.cwd}
								</option>
							))}
					</select>
					<div className="mt-2 truncate font-mono text-2xs text-ink-3" title={cwdInUse}>
						{shortPath(cwdInUse, 80)}
					</div>
					<button
						type="button"
						onClick={() => void startFresh()}
						disabled={busy}
						className="btn-primary mt-3 h-9 w-full text-sm"
					>
						<Plus className="h-4 w-4" />
						New session
					</button>
				</div>

				{/* Live sessions in this server process — usually empty on a fresh load. */}
				{recent.live.length > 0 ? (
					<section className="mt-6">
						<div className="meta mb-2">Live</div>
						<ul className="space-y-1">
							{recent.live.map((s) => (
								<li key={s.sessionId}>
									<button
										type="button"
										onClick={() => selectSession(s.sessionId)}
										className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-paper-3/60"
									>
										<span
											className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
											aria-label="live"
										/>
										<span className="flex-1 truncate text-ink">
											{s.sessionName || formatSessionId(s.sessionId)}
										</span>
										<span className="font-mono text-2xs text-ink-3">
											{shortPath(s.cwd, 32)}
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				) : null}

				{/* Persisted sessions on disk — top 6 newest. */}
				{recent.persisted.length > 0 ? (
					<section className="mt-6">
						<div className="meta mb-2">Recent</div>
						<ul className="space-y-1">
							{recent.persisted.map((s) => (
								<li key={s.id}>
									<button
										type="button"
										onClick={() => void resume(s)}
										disabled={busy}
										className={cn(
											"group flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
											"hover:bg-paper-3/60 disabled:opacity-60",
										)}
									>
										<Clock className="h-3.5 w-3.5 shrink-0 text-ink-4" />
										<span className="flex-1 truncate text-ink">
											{s.title || formatSessionId(s.id)}
										</span>
										<span className="font-mono text-2xs text-ink-4">
											{shortPath(s.cwd, 24)} · {s.messageCount}m
										</span>
										<span className="font-mono text-2xs text-ink-4">
											{formatRelative(s.updatedAt || s.createdAt)}
										</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				) : recent.live.length === 0 ? (
					<div className="mt-6 text-center font-mono text-2xs text-ink-3">
						No previous sessions yet — start a new one above.
					</div>
				) : null}
			</div>
		</div>
	);
}

function formatSessionId(id: string): string {
	return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

const REL: Array<[number, string]> = [
	[60_000, "just now"],
	[3_600_000, "m"],
	[86_400_000, "h"],
	[2_592_000_000, "d"],
];

function formatRelative(ts: string): string {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diff = Date.now() - d.getTime();
	if (diff < 0) return d.toLocaleDateString();
	const first = REL[0];
	if (!first || diff < first[0]) return "just now";
	for (let i = 1; i < REL.length; i++) {
		const cur = REL[i];
		const prev = REL[i - 1];
		if (!cur || !prev) continue;
		if (diff < cur[0]) return `${Math.floor(diff / prev[0])}${cur[1]} ago`;
	}
	return d.toLocaleDateString();
}

// ─── Onboarding follow-up tiles ─────────────────────────────────────────────

/**
 * One-time toast shown after the user clicked "Skip setup" in the
 * onboarding wizard. Sets a localStorage flag at skip time; clears it on
 * first display. Stays dismissed across reloads.
 */
function OnboardingReminderTile() {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (localStorage.getItem("omp-deck:onboarding-skip-toast-pending") === "1") {
			setVisible(true);
		}
	}, []);
	function dismiss(): void {
		localStorage.removeItem("omp-deck:onboarding-skip-toast-pending");
		setVisible(false);
	}
	if (!visible) return null;
	return (
		<div className="mb-4 flex items-start gap-3 rounded border border-accent/40 bg-accent/5 p-3 text-xs text-ink-2">
			<div className="flex-1">
				You skipped onboarding. Re-run it any time from{" "}
				<a href="/onboarding" className="font-medium text-accent underline">
					Settings → Onboarding
				</a>
				.
			</div>
			<button
				type="button"
				onClick={dismiss}
				className="shrink-0 text-ink-3 hover:text-ink"
				aria-label="Dismiss"
			>
				×
			</button>
		</div>
	);
}

/**
 * Welcome-task tile — surfaces the seeded T-1 task so it's not invisible
 * to users who never click the Tasks tab. Only renders when T-1 still
 * exists and is still in backlog (i.e. the user hasn't read it yet).
 * Hits the tasks endpoint once on mount; no live subscription needed —
 * this is a low-stakes hint, not a critical surface.
 */
function WelcomeTaskTile() {
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void fetch("/api/tasks")
			.then((r) => (r.ok ? r.json() : null))
			.then((data) => {
				if (cancelled || !data) return;
				const tasks = (data.tasks ?? []) as Array<{ displayId: number; stateId: string; archivedAt?: string | null }>;
				const welcome = tasks.find((t) => t.displayId === 1);
				if (welcome && !welcome.archivedAt && welcome.stateId === "s_backlog") {
					setVisible(true);
				}
			})
			.catch(() => {
				/* probe failed; tile stays hidden */
			});
		return () => {
			cancelled = true;
		};
	}, []);
	if (!visible) return null;
	return (
		<a
			href="/tasks"
			className="mb-4 flex items-center justify-between gap-3 rounded border border-line bg-paper-2 p-3 text-sm text-ink hover:border-accent/40 hover:bg-accent/5"
		>
			<div className="flex items-center gap-2">
				<ClipboardList className="h-4 w-4 shrink-0 text-accent" />
				<span>
					<span className="font-medium">T-1 Welcome to omp·deck</span> is waiting in
					your kanban
				</span>
			</div>
			<span className="flex shrink-0 items-center gap-1 text-2xs text-ink-3">
				Open Tasks <ArrowRight className="h-3 w-3" />
			</span>
		</a>
	);
}
