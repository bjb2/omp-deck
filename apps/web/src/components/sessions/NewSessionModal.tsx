/**
 * New-session modal. Three sections, in order:
 *
 *   1. Workspace — default cwd plus recent workspaces from `store.workspaces`.
 *   2. Managed repo + worktree — fetch `/api/repos` and `/api/repos/:owner/:repo/worktrees`,
 *      collapsible per-repo accordion. Picking (repo, branch) calls `createSession`
 *      with `repoId` + `worktreeBranch` and lets the server resolve cwd.
 *   3. Directory browser — type or paste a path, or browse server-side folders.
 *
 * Plus "Resume from recent" — top 5 newest persisted sessions, freshest first.
 *
 * Modal stays out of sessionRow/chatHeader territory; it only owns the create path.
 */
import { useEffect, useMemo, useState } from "react";
import { ArrowUp, ChevronDown, ChevronRight, FolderGit2, FolderOpen, History, Plus, RefreshCw, Search } from "lucide-react";
import type { RepoEntry, SessionSummary, WorktreeEntry } from "@omp-deck/protocol";

import { Modal } from "@/components/ui/Modal";
import { useStore } from "@/lib/store";
import { api } from "@/lib/api";
import { shortPath } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface Props {
	open: boolean;
	onClose(): void;
	onCreated(sessionId: string): void;
}

type Mode = "workspace" | "repo" | "manual" | "resume";

export function NewSessionModal({ open, onClose, onCreated }: Props): JSX.Element {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const sessions = useStore((s) => s.sessions);
	const sessionsById = useStore((s) => s.sessionsById);
	const createSession = useStore((s) => s.createSession);
	const refreshWorkspaces = useStore((s) => s.refreshWorkspaces);
	// Section-1
	const [selectedCwd, setSelectedCwd] = useState<string>(defaultCwd);
	// Section-2
	const [repos, setRepos] = useState<RepoEntry[] | null>(null);
	const [reposError, setReposError] = useState<string | null>(null);
	const [openRepoKey, setOpenRepoKey] = useState<string | null>(null);
	const [loadingWorktrees, setLoadingWorktrees] = useState<string | null>(null);
	const [worktreesByRepo, setWorktreesByRepo] = useState<Record<string, WorktreeEntry[]>>({});
	// Section-3
	const [manualCwd, setManualCwd] = useState<string>(defaultCwd);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [browserCwd, setBrowserCwd] = useState<string>(defaultCwd);
	const [browserQuery, setBrowserQuery] = useState("");
	const [browserEntries, setBrowserEntries] = useState<Array<{ name: string; path: string; isDir: boolean }>>([]);
	const [browserLoading, setBrowserLoading] = useState(false);
	const [browserError, setBrowserError] = useState<string | null>(null);
	const [registering, setRegistering] = useState(false);
	const [registeredLabel, setRegisteredLabel] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Reset state on close.
	useEffect(() => {
		if (!open) return;
		setSelectedCwd(defaultCwd);
		setManualCwd(defaultCwd);
		setOpenRepoKey(null);
		setError(null);
		setBrowserOpen(false);
		setBrowserCwd(defaultCwd);
		setBrowserQuery("");
		setBrowserEntries([]);
		setBrowserError(null);
		setRegistering(false);
		setRegisteredLabel(null);
	}, [open, defaultCwd]);

	// Fetch managed repos when modal opens.
	async function reloadRepos(): Promise<void> {
		setRepos(null);
		setReposError(null);
	try {
			const resp = await api.listRepos();
				setRepos(resp.repos ?? []);
	} catch (err) {
			setReposError((err as Error).message);
				setRepos([]);
	}
	}

	useEffect(() => {
			if (open) void reloadRepos();
	}, [open]);

	async function loadBrowser(cwd: string, q = ""): Promise<void> {
		setBrowserLoading(true);
		setBrowserError(null);
		try {
			const resp = await api.listFsDialog(cwd, q);
			setBrowserEntries(resp.entries ?? []);
		} catch (err) {
			setBrowserError((err as Error).message);
			setBrowserEntries([]);
		} finally {
			setBrowserLoading(false);
		}
	}

	function parentDir(cwd: string): string {
		const idx = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
		if (idx < 0) return cwd;
		if (/^[A-Za-z]:[\\/]/.test(cwd) && idx === 2) return `${cwd.slice(0, 2)}\\`;
		if (idx === 0) return "/";
		return cwd.slice(0, idx);
	}

	function openBrowser(): void {
		const seed = manualCwd.trim() || defaultCwd;
		setBrowserCwd(seed);
		setBrowserQuery("");
		setBrowserEntries([]);
		setBrowserError(null);
		setRegisteredLabel(null);
		setBrowserOpen(true);
		void loadBrowser(seed);
	}

	function goInto(entry: { path: string; isDir: boolean }): void {
		if (!entry.isDir) return;
		setBrowserCwd(entry.path);
		setBrowserQuery("");
		setRegisteredLabel(null);
		void loadBrowser(entry.path);
	}

	function goUp(): void {
		const next = parentDir(browserCwd);
		setBrowserCwd(next);
		setBrowserQuery("");
		setRegisteredLabel(null);
		void loadBrowser(next);
	}

	function pickDirectory(): void {
		setManualCwd(browserCwd);
		setRegisteredLabel(null);
	}

	async function registerManual(): Promise<void> {
		const target = manualCwd.trim();
		if (!target) return;
		setRegistering(true);
		setRegisteredLabel(null);
		setError(null);
		try {
			const resp = await api.registerWorkspace(target);
			setRegisteredLabel(resp.workspace.label);
			await refreshWorkspaces();
		} catch (err) {
			setError(`Failed to register workspace: ${(err as Error).message}`);
		} finally {
			setRegistering(false);
		}
	}

	const recentPersisted = useMemo<SessionSummary[]>(() => {
		return [...sessions]
			.sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))
			.slice(0, 5);
	}, [sessions, sessionsById]);

	async function loadWorktrees(owner: string, repo: string): Promise<void> {
		const key = `${owner}/${repo}`;
		if (worktreesByRepo[key]) return;
		setLoadingWorktrees(key);
		try {
			const resp = await api.listWorktrees(owner, repo);
			setWorktreesByRepo((prev) => ({ ...prev, [key]: resp.worktrees ?? [] }));
		} catch (err) {
			setError(`Failed to list worktrees for ${key}: ${(err as Error).message}`);
		} finally {
			setLoadingWorktrees(null);
		}
	}

	async function submit(mode: Mode, payload: { cwd?: string; resumeFromPath?: string; repoId?: string; worktreeBranch?: string }): Promise<void> {
		const cwd = payload.cwd ?? "";
		if (!cwd && !payload.resumeFromPath) {
			setError("Pick a workspace, repo+branch, type a directory, or select a recent session.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const id = await createSession({
				cwd: cwd || defaultCwd,
				...(payload.resumeFromPath ? { resumeFromPath: payload.resumeFromPath } : {}),
				...(payload.repoId ? { repoId: payload.repoId } : {}),
				...(payload.worktreeBranch ? { worktreeBranch: payload.worktreeBranch } : {}),
			});
			onCreated(id);
			onClose();
		} catch (err) {
			setError(`Failed to create session: ${(err as Error).message}`);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-2xl">
			<div className="flex max-h-[80vh] flex-col">
				<header className="border-b border-line px-5 py-3">
					<h2 className="text-sm font-semibold text-ink">New session</h2>
					<p className="mt-0.5 font-mono text-2xs text-ink-3">
						default: {defaultCwd || "(unset)"}
					</p>
				</header>

				<div className="flex-1 overflow-y-auto px-5 py-4">
					<div className="flex flex-col gap-5">
						{/* 1. Workspace picker */}
						<section>
							<div className="meta mb-1.5 flex items-center gap-2">
								<FolderOpen className="h-3.5 w-3.5" />
								<span>Workspace</span>
							</div>
							<select
								value={selectedCwd}
								onChange={(e) => setSelectedCwd(e.target.value)}
								className="field h-8 w-full px-2 font-mono text-xs"
							>
								<option value={defaultCwd}>{`(default) ${defaultCwd || "—"}`}</option>
								{workspaces
									.filter((w) => w.cwd !== defaultCwd)
									.map((w) => (
										<option key={w.cwd} value={w.cwd}>
											{w.label} · {shortPath(w.cwd, 48)}
										</option>
									))}
							</select>
							<button
								type="button"
								disabled={busy || !selectedCwd}
								onClick={() => void submit("workspace", { cwd: selectedCwd })}
								className="btn-primary mt-2 h-9 w-full text-sm"
							>
								<Plus className="h-3.5 w-3.5" />
								Open in {shortPath(selectedCwd || defaultCwd, 40)}
							</button>
						</section>

						{/* 2. Managed repo + worktree */}
						<section>
							<div className="meta mb-1.5 flex items-center gap-2">
								<FolderGit2 className="h-3.5 w-3.5" />
								<span>Managed repo</span>
							</div>
							{repos === null ? (
								<div className="rounded border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
									Loading repos…
								</div>
							) : reposError ? (
								<div className="rounded border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
									repos unavailable: {reposError}
								</div>
							) : repos.length === 0 ? (
								<div className="rounded border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
									No managed repos yet. Clone one via Settings → Repos.
								</div>
							) : (
								<ul className="flex flex-col gap-1">
									{repos.map((r) => {
										const key = `${r.owner}/${r.repo}`;
										const isOpen = openRepoKey === key;
										const cached = worktreesByRepo[key];
										const loading = loadingWorktrees === key;
										return (
											<li key={key} className="rounded border border-line bg-paper-2">
												<button
													type="button"
													className="flex w-full items-center gap-2 px-3 py-2 text-left"
													onClick={() => {
														const next = isOpen ? null : key;
														setOpenRepoKey(next);
														if (next && !cached) void loadWorktrees(r.owner, r.repo);
													}}
												>
													{isOpen ? <ChevronDown className="h-3.5 w-3.5 text-ink-3" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-3" />}
													<span className="font-mono text-xs text-ink">{key}</span>
													<span className="ml-auto font-mono text-2xs text-ink-3">
														{r.worktrees?.length ?? 0} worktree{(r.worktrees?.length ?? 0) === 1 ? "" : "s"}
													</span>
												</button>
												{isOpen ? (
													<div className="border-t border-line px-3 py-2">
														{loading ? (
															<div className="font-mono text-2xs text-ink-3">loading worktrees…</div>
														) : cached && cached.length > 0 ? (
															<ul className="flex flex-col gap-1">
																{cached.map((wt) => (
																	<li key={`${wt.branch}-${wt.path}`} className="flex items-center gap-2">
																		<button
																			type="button"
																			disabled={busy}
																			onClick={() =>
																				void submit("repo", {
																					cwd: wt.path,
																					repoId: key,
																					worktreeBranch: wt.branch,
																				})
																			}
																			className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-paper-3"
																		>
																			<span className="font-mono text-ink">{wt.branch}</span>
																			<span className="font-mono text-2xs text-ink-3">{shortPath(wt.path, 42)}</span>
																		</button>
																	</li>
																))}
															</ul>
														) : (
															<div className="font-mono text-2xs text-ink-3">No worktrees for this repo.</div>
														)}
													</div>
												) : null}
											</li>
										);
									})}
								</ul>
							)}
						</section>

						{/* 3. Manual cwd */}
						<section>
							<div className="meta mb-1.5 flex items-center gap-2">
								<FolderOpen className="h-3.5 w-3.5" />
								<span>Other directory</span>
							</div>
							<input
								type="text"
								value={manualCwd}
								onChange={(e) => setManualCwd(e.target.value)}
								placeholder="Absolute path…"
								className="field h-8 w-full px-2 font-mono text-xs"
							/>
			<div className="mt-2 flex gap-2">
							<button
					type="button"
					disabled={busy || !manualCwd.trim()}
					onClick={() => void submit("manual", { cwd: manualCwd.trim() })}
					className="btn-secondary h-9 flex-1 text-sm"
				>
					Open here
				</button>
							<button
					type="button"
					disabled={busy || !manualCwd.trim() || registering}
					onClick={() => void registerManual()}
					className="btn-ghost h-9 text-xs"
				>
					{registering ? "Registering…" : "Register workspace"}
				</button>
							<button
					type="button"
					disabled={busy}
					onClick={openBrowser}
					className="btn-ghost h-9 text-xs"
				>
					{browserOpen ? "Hide browser" : "Browse"}
				</button>
							</div>
			{registeredLabel ? (
				<p className="mt-1 font-mono text-2xs text-ink-3">
					Registered “{registeredLabel}” — appears in the workspace picker.
				</p>
			) : null}
			{browserOpen ? (
				<div className="mt-2 rounded border border-line bg-paper-2">
					<div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
							<button
							type="button"
							disabled={browserLoading || browserCwd === "/" || browserCwd === ""}
							onClick={goUp}
							className="btn-ghost h-6 px-2 text-2xs"
							title="Parent directory"
						>
							<ArrowUp className="h-3 w-3" />
							Up
						</button>
						<span className="flex-1 truncate font-mono text-2xs text-ink-3" title={browserCwd}>
							{browserCwd || "(unset)"}
						</span>
						<div className="relative">
							<Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-3" />
							<input
								type="text"
								value={browserQuery}
								onChange={(e) => {
									setBrowserQuery(e.target.value);
									void loadBrowser(browserCwd, e.target.value);
								}}
								placeholder="filter…"
								className="field h-6 w-32 pl-6 pr-2 font-mono text-2xs"
							/>
							</div>
							</div>
					<div className="max-h-56 overflow-y-auto">
						{browserLoading ? (
							<div className="px-3 py-2 font-mono text-2xs text-ink-3">loading…</div>
						) : browserError ? (
							<div className="px-3 py-2 font-mono text-2xs text-danger">{browserError}</div>
						) : browserEntries.length === 0 ? (
							<div className="px-3 py-2 font-mono text-2xs text-ink-3">No subdirectories.</div>
						) : (
							<ul className="flex flex-col">
								{browserEntries.map((e) => (
									<li key={e.path}>
							<button
											type="button"
											disabled={busy}
											onClick={() => goInto(e)}
											className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-paper-3"
											title={e.path}
										>
											<FolderOpen className="h-3 w-3 text-ink-3" />
											<span className="truncate font-mono text-ink">{e.name}</span>
										</button>
									</li>
								))}
							</ul>
						)}
							</div>
					<div className="flex items-center justify-between gap-2 border-t border-line px-2 py-1.5">
						<span className="truncate font-mono text-2xs text-ink-3" title={browserCwd}>
							{shortPath(browserCwd, 60)}
						</span>
							<button
							type="button"
							disabled={busy || !browserCwd}
							onClick={pickDirectory}
							className="btn-primary h-7 px-3 text-xs"
						>
							Use this folder
						</button>
							</div>
							</div>
			) : null}
		</section>

						{/* 4. Resume recent */}
						{recentPersisted.length > 0 ? (
							<section>
								<div className="meta mb-1.5 flex items-center gap-2">
									<History className="h-3.5 w-3.5" />
									<span>Resume recent</span>
								</div>
								<ul className="flex flex-col gap-1">
									{recentPersisted.map((s) => (
										<li key={s.id}>
											<button
												type="button"
												disabled={busy}
												onClick={() => void submit("resume", { cwd: s.cwd, resumeFromPath: s.path })}
												className={cn(
													"flex w-full items-center justify-between rounded border border-line bg-paper-2 px-3 py-2 text-left text-xs hover:bg-paper-3",
												)}
											>
												<span className="font-mono text-ink">{s.title || "Untitled"}</span>
												<span className="font-mono text-2xs text-ink-3">{shortPath(s.cwd, 50)}</span>
											</button>
										</li>
									))}
								</ul>
							</section>
						) : null}
					</div>

					{error ? (
						<div className="mt-4 rounded border border-danger/30 bg-danger/5 px-3 py-2 font-mono text-2xs text-danger">
							{error}
						</div>
					) : null}
				</div>

				<footer className="flex items-center justify-end gap-2 border-t border-line px-5 py-2">
					<button type="button" onClick={onClose} className="btn-ghost h-8 text-xs" disabled={busy}>
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void reloadRepos()}
						className="btn-ghost h-8 text-xs"
						disabled={busy}
					>
						<RefreshCw className="h-3 w-3" />
						Reload
					</button>
				</footer>
			</div>
		</Modal>
	);
}
