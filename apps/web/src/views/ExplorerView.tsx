/**
 * /explorer — the files + git + GitHub cockpit.
 *
 * Sidebar: workspace picker + file tree. Main: open-file tabs, each backed
 * by either the CodeMirror editor or the diff viewer. Inspector: Git status
 * / GitHub repos, tabbed.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Circle,
	Diff as DiffIcon,
	FileCode,
	FolderGit2,
	Github,
	Loader2,
	Save,
	X,
} from "lucide-react";
import type { FileEntry, GitDiffResponse, GitStatusEntry } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { CodeEditor } from "@/components/explorer/CodeEditor";
import { DiffViewer } from "@/components/explorer/DiffViewer";
import { FileTree } from "@/components/explorer/FileTree";
import { GitPanel } from "@/components/explorer/GitPanel";
import { GitHubPanel } from "@/components/explorer/GitHubPanel";
import { filesApi } from "@/lib/files-api";
import { gitApi } from "@/lib/git-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface EditorTab {
	kind: "file";
	path: string;
	dirty: boolean;
}
interface DiffTab {
	kind: "diff";
	path: string;
	staged: boolean;
}
type Tab = EditorTab | DiffTab;

function tabKey(tab: Tab): string {
	return tab.kind === "file" ? `file:${tab.path}` : `diff:${tab.staged ? "staged" : "unstaged"}:${tab.path}`;
}

export function ExplorerView(): JSX.Element {
	const workspaces = useStore((s) => s.workspaces);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const [root, setRoot] = useState<string | null>(null);
	const [tabs, setTabs] = useState<Tab[]>([]);
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [contents, setContents] = useState<Map<string, string>>(new Map());
	const [savedContents, setSavedContents] = useState<Map<string, string>>(new Map());
	const [diffs, setDiffs] = useState<Map<string, GitDiffResponse>>(new Map());
	const [loadingKey, setLoadingKey] = useState<string | null>(null);
	const [inspectorTab, setInspectorTab] = useState<"git" | "github">("git");
	const [refreshKey, setRefreshKey] = useState(0);
	const [statusEntries, setStatusEntries] = useState<GitStatusEntry[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (root === null && defaultCwd) setRoot(defaultCwd);
	}, [defaultCwd, root]);

	const dirtyPaths = useMemo(() => new Set(statusEntries.map((e) => e.path)), [statusEntries]);

	const refreshStatus = useCallback(async () => {
		if (!root) return;
		try {
			const status = await gitApi.status(root);
			setStatusEntries(status.entries);
		} catch {
			setStatusEntries([]); // not a repo, or a transient error — the git panel surfaces the real message
		}
	}, [root]);

	useEffect(() => {
		void refreshStatus();
	}, [refreshStatus]);

	const activeTab = tabs.find((t) => tabKey(t) === activeKey) ?? null;

	const openFile = useCallback(
		async (entry: FileEntry) => {
			if (entry.kind !== "file") return;
			const tab: EditorTab = { kind: "file", path: entry.path, dirty: false };
			const key = tabKey(tab);
			setTabs((prev) => (prev.some((t) => tabKey(t) === key) ? prev : [...prev, tab]));
			setActiveKey(key);
			if (!contents.has(entry.path)) {
				setLoadingKey(key);
				try {
					const result = await filesApi.read(entry.path);
					setContents((prev) => new Map(prev).set(entry.path, result.content));
					setSavedContents((prev) => new Map(prev).set(entry.path, result.content));
					setError(null);
				} catch (err) {
					setError(err instanceof Error ? err.message : String(err));
					setTabs((prev) => prev.filter((t) => tabKey(t) !== key));
					setActiveKey((prev) => (prev === key ? null : prev));
				} finally {
					setLoadingKey(null);
				}
			}
		},
		[contents],
	);

	const openDiff = useCallback(
		async (path: string, staged: boolean) => {
			if (!root) return;
			const tab: DiffTab = { kind: "diff", path, staged };
			const key = tabKey(tab);
			setTabs((prev) => (prev.some((t) => tabKey(t) === key) ? prev : [...prev, tab]));
			setActiveKey(key);
			setLoadingKey(key);
			try {
				const diff = await gitApi.diff(root, path, staged);
				setDiffs((prev) => new Map(prev).set(key, diff));
				setError(null);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoadingKey(null);
			}
		},
		[root],
	);

	function closeTab(key: string): void {
		setTabs((prev) => prev.filter((t) => tabKey(t) !== key));
		setActiveKey((prev) => {
			if (prev !== key) return prev;
			const remaining = tabs.filter((t) => tabKey(t) !== key);
			return remaining.length > 0 ? tabKey(remaining[remaining.length - 1]!) : null;
		});
	}

	async function saveActive(): Promise<void> {
		if (!activeTab || activeTab.kind !== "file") return;
		const content = contents.get(activeTab.path);
		if (content === undefined) return;
		try {
			await filesApi.write({ path: activeTab.path, content });
			setSavedContents((prev) => new Map(prev).set(activeTab.path, content));
			setTabs((prev) => prev.map((t) => (t.kind === "file" && t.path === activeTab.path ? { ...t, dirty: false } : t)));
			void refreshStatus();
			setRefreshKey((k) => k + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	function onEditorChange(path: string, value: string): void {
		setContents((prev) => new Map(prev).set(path, value));
		const saved = savedContents.get(path);
		const dirty = saved !== value;
		setTabs((prev) => prev.map((t) => (t.kind === "file" && t.path === path ? { ...t, dirty } : t)));
	}

	async function createFile(parentDir: string): Promise<void> {
		const name = window.prompt("New file name:");
		if (!name?.trim()) return;
		const path = `${parentDir}/${name.trim()}`;
		try {
			await filesApi.write({ path, content: "" });
			setRefreshKey((k) => k + 1);
			await openFile({ name: name.trim(), path, kind: "file", sizeBytes: 0, modifiedAt: null });
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function createFolder(parentDir: string): Promise<void> {
		const name = window.prompt("New folder name:");
		if (!name?.trim()) return;
		try {
			await filesApi.mkdir({ path: `${parentDir}/${name.trim()}` });
			setRefreshKey((k) => k + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function deleteEntry(entry: FileEntry): Promise<void> {
		const ok = window.confirm(`Delete ${entry.kind === "dir" ? "folder" : "file"} "${entry.name}"? This cannot be undone.`);
		if (!ok) return;
		try {
			await filesApi.remove({ path: entry.path, recursive: entry.kind === "dir" });
			setRefreshKey((k) => k + 1);
			const key = `file:${entry.path}`;
			if (tabs.some((t) => tabKey(t) === key)) closeTab(key);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	// Global Ctrl/Cmd+S — the editor's own keymap only fires while it has
	// focus; this catches the shortcut from anywhere in the view (e.g. right
	// after clicking a tab).
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				void saveActive();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [activeTab, contents]);

	if (!root) {
		return (
			<Layout
				sidebar={<div className="p-3 text-sm text-ink-3">Loading workspace…</div>}
				main={<div className="flex h-full items-center justify-center text-ink-3">Loading…</div>}
				inspector={<div />}
			/>
		);
	}

	return (
		<Layout
			topBar={
				<div className="flex items-center gap-2">
					<FolderGit2 className="h-3.5 w-3.5 text-accent" />
					<select
						value={root}
						onChange={(e) => {
							setRoot(e.target.value);
							setTabs([]);
							setActiveKey(null);
						}}
						className="field h-7 max-w-[220px] truncate bg-transparent px-1.5 text-xs"
					>
						{defaultCwd ? <option value={defaultCwd}>{defaultCwd}</option> : null}
						{workspaces
							.filter((w) => w.cwd !== defaultCwd)
							.map((w) => (
								<option key={w.cwd} value={w.cwd}>
									{w.label}
								</option>
							))}
					</select>
				</div>
			}
			sidebar={
				<div className="flex h-full flex-col">
					<div className="border-b border-line px-3 py-2">
						<div className="meta">Explorer</div>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						<FileTree
							root={root}
							selectedPath={activeTab?.kind === "file" ? activeTab.path : null}
							onSelect={(entry) => void openFile(entry)}
							dirtyPaths={dirtyPaths}
							onCreateFile={createFile}
							onCreateFolder={createFolder}
							onDelete={deleteEntry}
							refreshKey={refreshKey}
						/>
					</div>
				</div>
			}
			main={
				<div className="flex h-full flex-col">
					{/* Tab strip */}
					<div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line bg-paper-2 px-1">
						{tabs.map((tab) => {
							const key = tabKey(tab);
							const isActive = key === activeKey;
							const name = tab.path.split("/").pop() ?? tab.path;
							return (
								<button
									key={key}
									type="button"
									onClick={() => setActiveKey(key)}
									className={cn(
										"group flex h-7 shrink-0 items-center gap-1.5 rounded-t-md px-2.5 font-mono text-xs transition-colors",
										isActive ? "bg-paper text-ink" : "text-ink-3 hover:bg-paper-3",
									)}
								>
									{tab.kind === "diff" ? (
										<DiffIcon className="h-3 w-3 text-accent-2" />
									) : (
										<FileCode className="h-3 w-3 text-ink-4" />
									)}
									<span className="max-w-[140px] truncate">{name}</span>
									{tab.kind === "diff" ? (
										<span className="text-2xs text-ink-4">{tab.staged ? "staged" : "working"}</span>
									) : tab.dirty ? (
										<Circle className="h-1.5 w-1.5 fill-accent text-accent" />
									) : null}
									<span
										role="button"
										tabIndex={-1}
										onClick={(e) => {
											e.stopPropagation();
											closeTab(key);
										}}
										className="rounded p-0.5 opacity-0 hover:bg-paper-3 group-hover:opacity-100"
									>
										<X className="h-3 w-3" />
									</span>
								</button>
							);
						})}
						{activeTab?.kind === "file" ? (
							<Button
								variant="ghost"
								size="sm"
								className="ml-auto shrink-0"
								disabled={!activeTab.dirty}
								onClick={() => void saveActive()}
							>
								<Save className="h-3.5 w-3.5" />
								Save
							</Button>
						) : null}
					</div>

					{error ? (
						<div className="mx-3 mt-2 shrink-0 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 font-mono text-2xs text-danger">
							{error}
							<button className="ml-2 underline" onClick={() => setError(null)}>
								dismiss
							</button>
						</div>
					) : null}

					{/* Content */}
					<div className="min-h-0 flex-1">
						{!activeTab ? (
							<div className="flex h-full flex-col items-center justify-center gap-2 text-ink-3">
								<FolderGit2 className="h-8 w-8 text-ink-4" />
								<p className="text-sm">Select a file to start editing.</p>
							</div>
						) : loadingKey === activeKey ? (
							<div className="flex h-full items-center justify-center gap-2 text-ink-3">
								<Loader2 className="h-4 w-4 animate-spin" /> Loading…
							</div>
						) : activeTab.kind === "file" ? (
							<CodeEditor
								path={activeTab.path}
								value={contents.get(activeTab.path) ?? ""}
								onChange={(value) => onEditorChange(activeTab.path, value)}
								onSave={() => void saveActive()}
							/>
						) : (
							<DiffViewer
								patch={diffs.get(activeKey!)?.patch ?? ""}
								binary={diffs.get(activeKey!)?.binary ?? false}
							/>
						)}
					</div>
				</div>
			}
			inspector={
				<div className="flex h-full flex-col">
					<div className="flex border-b border-line">
						<button
							type="button"
							onClick={() => setInspectorTab("git")}
							className={cn(
								"flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
								inspectorTab === "git" ? "border-b-2 border-accent text-ink" : "text-ink-3 hover:text-ink",
							)}
						>
							<FolderGit2 className="h-3.5 w-3.5" /> Git
						</button>
						<button
							type="button"
							onClick={() => setInspectorTab("github")}
							className={cn(
								"flex flex-1 items-center justify-center gap-1.5 py-2 text-xs font-medium transition-colors",
								inspectorTab === "github" ? "border-b-2 border-accent text-ink" : "text-ink-3 hover:text-ink",
							)}
						>
							<Github className="h-3.5 w-3.5" /> GitHub
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-hidden">
						{inspectorTab === "git" ? (
							<GitPanel
								cwd={root}
								selectedPath={activeTab?.kind === "diff" ? activeTab.path : null}
								onSelectDiff={(p, staged) => void openDiff(p, staged)}
								onChanged={() => {
									setRefreshKey((k) => k + 1);
									void refreshStatus();
								}}
							/>
						) : (
							<GitHubPanel
								onOpenRepo={(path) => {
									setRoot(path);
									setTabs([]);
									setActiveKey(null);
									setInspectorTab("git");
								}}
							/>
						)}
					</div>
				</div>
			}
		/>
	);
}
