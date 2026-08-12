/**
 * The git cockpit: status, staging, commit, branch switch, and remote sync —
 * everything short of an interactive rebase — for whichever repo is open in
 * the explorer.
 */
import { useEffect, useMemo, useState } from "react";
import {
	AlertCircle,
	ArrowDownToLine,
	ArrowUpFromLine,
	Check,
	ChevronDown,
	CircleDot,
	GitBranch,
	GitCommit,
	Loader2,
	Minus,
	Plus,
	RefreshCw,
	Undo2,
} from "lucide-react";
import type { GitFileStatus, GitRepoStatus, GitStatusEntry } from "@omp-deck/protocol";
import { Button } from "@/components/ui/Button";
import { gitApi } from "@/lib/git-api";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<GitFileStatus, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	untracked: "U",
	ignored: "I",
	unmerged: "!",
	typechange: "T",
};

const STATUS_COLOR: Record<GitFileStatus, string> = {
	modified: "text-warn",
	added: "text-success",
	deleted: "text-danger",
	renamed: "text-accent-2",
	copied: "text-accent-2",
	untracked: "text-ink-3",
	ignored: "text-ink-4",
	unmerged: "text-danger",
	typechange: "text-warn",
};

interface Props {
	cwd: string;
	selectedPath: string | null;
	onSelectDiff: (path: string, staged: boolean) => void;
	/** Fired after any operation that changes what's on disk (commit, checkout, pull). */
	onChanged: () => void;
}

export function GitPanel({ cwd, selectedPath, onSelectDiff, onChanged }: Props): JSX.Element {
	const [status, setStatus] = useState<GitRepoStatus | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [branchMenuOpen, setBranchMenuOpen] = useState(false);
	const [branches, setBranches] = useState<Array<{ name: string; current: boolean; remote: boolean }>>([]);
	const [notice, setNotice] = useState<string | null>(null);

	async function refresh(): Promise<void> {
		try {
			setStatus(await gitApi.status(cwd));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setStatus(null);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		setLoading(true);
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [cwd]);

	const staged = useMemo(() => status?.entries.filter((e) => e.staged) ?? [], [status]);
	const unstaged = useMemo(() => status?.entries.filter((e) => e.unstaged) ?? [], [status]);

	async function run(label: string, fn: () => Promise<void>): Promise<void> {
		setBusy(label);
		setNotice(null);
		try {
			await fn();
			await refresh();
			onChanged();
		} catch (err) {
			setNotice(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(null);
		}
	}

	async function openBranchMenu(): Promise<void> {
		setBranchMenuOpen((v) => !v);
		if (branches.length === 0) {
			try {
				const { branches: list } = await gitApi.branches(cwd);
				setBranches(list.filter((b) => !b.remote));
			} catch {
				/* branch list is a nicety; status already shows the current one */
			}
		}
	}

	if (loading) {
		return (
			<div className="flex items-center gap-2 p-4 text-sm text-ink-3">
				<Loader2 className="h-4 w-4 animate-spin" /> Loading git status…
			</div>
		);
	}

	if (error || !status) {
		return (
			<div className="flex flex-col items-center gap-2 p-6 text-center text-sm text-ink-3">
				<AlertCircle className="h-5 w-5 text-ink-4" />
				<p>{error ?? "Not a git repository."}</p>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Branch + sync header */}
			<div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
				<div className="relative">
					<button
						type="button"
						onClick={() => void openBranchMenu()}
						className="flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-xs text-ink hover:bg-paper-3"
					>
						<GitBranch className="h-3.5 w-3.5 text-accent" />
						{status.detached ? "detached" : (status.branch ?? "—")}
						<ChevronDown className="h-3 w-3 text-ink-4" />
					</button>
					{branchMenuOpen ? (
						<div className="glass animate-rise-in absolute left-0 top-full z-20 mt-1 max-h-64 w-56 overflow-auto rounded-lg py-1 shadow-lg">
							{branches.length === 0 ? (
								<div className="px-3 py-2 text-2xs text-ink-3">No local branches found.</div>
							) : (
								branches.map((b) => (
									<button
										key={b.name}
										type="button"
										className={cn(
											"flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs hover:bg-paper-3",
											b.current ? "text-accent" : "text-ink-2",
										)}
										onClick={() => {
											setBranchMenuOpen(false);
											if (!b.current) void run("checkout", () => gitApi.checkout({ cwd, branch: b.name }).then(() => undefined));
										}}
									>
										{b.current ? <Check className="h-3 w-3" /> : <span className="w-3" />}
										{b.name}
									</button>
								))
							)}
						</div>
					) : null}
				</div>

				{status.ahead > 0 || status.behind > 0 ? (
					<span className="font-mono text-2xs text-ink-3">
						{status.ahead > 0 ? `↑${status.ahead}` : ""} {status.behind > 0 ? `↓${status.behind}` : ""}
					</span>
				) : null}

				<div className="ml-auto flex items-center gap-1">
					<Button
						variant="ghost"
						size="sm"
						disabled={busy !== null}
						title="Fetch"
						onClick={() => void run("fetch", () => gitApi.fetch(cwd).then(() => undefined))}
					>
						{busy === "fetch" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={busy !== null}
						title="Pull"
						onClick={() => void run("pull", () => gitApi.pull(cwd).then(() => undefined))}
					>
						{busy === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						disabled={busy !== null}
						title="Push"
						onClick={() =>
							void run("push", () => gitApi.push(cwd, { setUpstream: !status.upstream }).then(() => undefined))
						}
					>
						{busy === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
					</Button>
				</div>
			</div>

			{notice ? (
				<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 font-mono text-2xs text-danger">
					{notice}
				</div>
			) : null}

			{/* Commit box */}
			<div className="border-b border-line p-3">
				<textarea
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder={staged.length > 0 ? `Commit ${staged.length} staged file${staged.length === 1 ? "" : "s"}…` : "Stage files to commit…"}
					rows={2}
					className="field w-full resize-none px-2 py-1.5 text-xs"
				/>
				<Button
					variant="primary"
					size="sm"
					className="mt-2 w-full gradient-accent border-none text-white"
					disabled={staged.length === 0 || !message.trim() || busy !== null}
					onClick={() =>
						void run("commit", async () => {
							await gitApi.commit({ cwd, message: message.trim() });
							setMessage("");
						})
					}
				>
					{busy === "commit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <GitCommit className="h-3.5 w-3.5" />}
					Commit
				</Button>
			</div>

			{/* Status lists */}
			<div className="min-h-0 flex-1 overflow-auto">
				{status.clean ? (
					<div className="flex flex-col items-center gap-1.5 p-8 text-center text-ink-3">
						<Check className="h-5 w-5 text-success" />
						<p className="text-xs">Working tree clean.</p>
					</div>
				) : (
					<>
						{staged.length > 0 ? (
							<StatusGroup
								title="Staged"
								entries={staged}
								selectedPath={selectedPath}
								staged
								onSelect={(p) => onSelectDiff(p, true)}
								onAction={(paths) => void run("unstage", () => gitApi.unstage({ cwd, paths }).then(() => undefined))}
								actionIcon={<Minus className="h-3 w-3" />}
								actionTitle="Unstage"
							/>
						) : null}
						{unstaged.length > 0 ? (
							<StatusGroup
								title="Changes"
								entries={unstaged}
								selectedPath={selectedPath}
								staged={false}
								onSelect={(p) => onSelectDiff(p, false)}
								onAction={(paths) => void run("stage", () => gitApi.stage({ cwd, paths }).then(() => undefined))}
								actionIcon={<Plus className="h-3 w-3" />}
								actionTitle="Stage"
								secondaryAction={(paths) =>
									void run("discard", () => gitApi.discard({ cwd, paths }).then(() => undefined))
								}
								secondaryIcon={<Undo2 className="h-3 w-3" />}
								secondaryTitle="Discard"
							/>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

interface StatusGroupProps {
	title: string;
	entries: GitStatusEntry[];
	selectedPath: string | null;
	staged: boolean;
	onSelect: (path: string) => void;
	onAction: (paths: string[]) => void;
	actionIcon: React.ReactNode;
	actionTitle: string;
	secondaryAction?: (paths: string[]) => void;
	secondaryIcon?: React.ReactNode;
	secondaryTitle?: string;
}

function StatusGroup({
	title,
	entries,
	selectedPath,
	staged,
	onSelect,
	onAction,
	actionIcon,
	actionTitle,
	secondaryAction,
	secondaryIcon,
	secondaryTitle,
}: StatusGroupProps): JSX.Element {
	return (
		<div>
			<div className="flex items-center justify-between px-3 py-1.5">
				<span className="meta">
					{title} ({entries.length})
				</span>
				<button
					type="button"
					className="font-mono text-2xs text-ink-3 hover:text-accent"
					onClick={() => onAction(entries.map((e) => e.path))}
				>
					{staged ? "Unstage all" : "Stage all"}
				</button>
			</div>
			{entries.map((entry) => {
				const code = staged ? entry.staged : entry.unstaged;
				if (!code) return null;
				return (
					<div
						key={entry.path}
						className={cn(
							"group flex cursor-pointer items-center gap-2 px-3 py-1 text-xs hover:bg-paper-3",
							selectedPath === entry.path && "bg-accent-soft/40",
						)}
						onClick={() => onSelect(entry.path)}
					>
						<CircleDot className={cn("h-2.5 w-2.5 shrink-0", STATUS_COLOR[code])} aria-hidden="true" />
						<span className={cn("w-3 shrink-0 text-center font-mono font-semibold", STATUS_COLOR[code])}>
							{STATUS_LABEL[code]}
						</span>
						<span className="min-w-0 flex-1 truncate font-mono">{entry.path}</span>
						{secondaryAction ? (
							<button
								type="button"
								title={secondaryTitle}
								className="hidden shrink-0 rounded p-0.5 text-ink-4 hover:bg-paper hover:text-danger group-hover:block"
								onClick={(e) => {
									e.stopPropagation();
									secondaryAction([entry.path]);
								}}
							>
								{secondaryIcon}
							</button>
						) : null}
						<button
							type="button"
							title={actionTitle}
							className="hidden shrink-0 rounded p-0.5 text-ink-4 hover:bg-paper hover:text-accent group-hover:block"
							onClick={(e) => {
								e.stopPropagation();
								onAction([entry.path]);
							}}
						>
							{actionIcon}
						</button>
					</div>
				);
			})}
		</div>
	);
}
