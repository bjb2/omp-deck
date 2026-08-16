import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
	ArrowLeft,
	BookOpen,
	ChevronDown,
	ChevronRight,
	Eye,
	File as FileIcon,
	FilePlus,
	FileText,
	Folder,
	FolderOpen,
	Link2,
	Link2Off,
	Loader2,
	Pencil,
	Network,
	Save,
	Search,
	X,
} from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { KbBacklink, KbFileResponse, KbTreeEntry, KbTreeResponse } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { CopyButton } from "@/lib/CopyButton";
import { kbApi, type KbStatusResponse } from "@/lib/kb-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { KbGraphPane } from "./KbGraphPane";
import { KbCommandPalette } from "./KbCommandPalette";
import { RichEditor } from "@/components/RichEditor";

/**
 * /kb — Karpathy-style llm-wiki viewer. Sidebar = tree; main = markdown
 * viewer (resolves [[wikilinks]] to in-app navigation); inspector =
 * frontmatter + outbound list. URL state in `?path=<rel>` drives the open
 * file; back/forward works.
 *
 * Editor (T-36) and graph view (T-37/38) plug into this shell.
 */
export function KbView() {
	const [params, setParams] = useSearchParams();
	const currentPath = params.get("path") ?? undefined;

	const setCurrentPath = useCallback(
		(p: string | undefined) => {
			const next = new URLSearchParams(params);
			if (p) next.set("path", p);
			else next.delete("path");
			setParams(next, { replace: false });
		},
		[params, setParams],
	);

	// On mobile (<lg), tree and viewer can't share a column; we slide between
	// them. At lg+ both render side-by-side and this flag is inert.
	const [mobileDetailOpen, setMobileDetailOpen] = useState(Boolean(currentPath));
	useEffect(() => {
		if (currentPath) setMobileDetailOpen(true);
	}, [currentPath]);

	const kbChangeCounter = useStore((s) => s.kbChangeCounter);

	// Quick-open palette state. Bound to Ctrl-P / Cmd-P globally while /kb is
	// mounted. We swallow the default browser print dialog only when the
	// active element isn't an input or textarea so cmd-P from inside the
	// editor still prints if the user really wants to.
	const [paletteOpen, setPaletteOpen] = useState(false);
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			const mod = e.ctrlKey || e.metaKey;
			if (!mod || e.key.toLowerCase() !== "p") return;
			const target = e.target as HTMLElement | null;
			const tag = target?.tagName;
			// Skip the binding when the user is typing into an input or textarea
			// (e.g. the editor). Esc closes the editor; if they want search they
			// can blur first.
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			e.preventDefault();
			setPaletteOpen((open) => !open);
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	// Setup detection. An empty/missing kb is a first-run state; we render a
	// welcome panel inside main instead of an empty tree so a fresh deck doesn't
	// look broken. Refetched on every kb_changed so the panel disappears the
	// moment the user creates their first file.
	const [status, setStatus] = useState<KbStatusResponse | null>(null);
	useEffect(() => {
		let cancelled = false;
		kbApi
			.status()
			.then((s) => {
				if (!cancelled) setStatus(s);
			})
			.catch(() => {
				if (!cancelled) setStatus({ root: "(unknown)", exists: false, fileCount: 0 });
			});
		return () => {
			cancelled = true;
		};
	}, [kbChangeCounter]);

	// `view` URL param picks between the file-viewer and the force-directed
	// graph. We default to file; the graph is opt-in via the top-bar toggle.
	const viewMode: "file" | "graph" = params.get("view") === "graph" ? "graph" : "file";
	const setViewMode = useCallback(
		(v: "file" | "graph") => {
			const next = new URLSearchParams(params);
			if (v === "graph") next.set("view", "graph");
			else next.delete("view");
			setParams(next, { replace: false });
		},
		[params, setParams],
	);

	return (
		<>
		<Layout
			sidebar={<KbSidebar />}
			inspector={
				<KbInspector
					currentPath={currentPath}
					onNavigate={(p) => {
						// Respect current view mode so clicking a backlink from graph
						// mode keeps the graph mounted (preview-pane behavior).
						const next = new URLSearchParams(params);
						next.set("path", p);
						if (viewMode === "graph") next.set("view", "graph");
						setParams(next, { replace: false });
						setMobileDetailOpen(true);
					}}
					kbChangeCounter={kbChangeCounter}
				/>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					{status && (status.fileCount === 0 || status.exists === false) ? (
						<KbWelcome
							status={status}
							onInitialized={() => {
								void kbApi.status().then(setStatus).catch(() => undefined);
							}}
						/>
					) : (
						<>
							<KbTopBar
								currentPath={currentPath}
								mobileDetailOpen={mobileDetailOpen}
								viewMode={viewMode}
								onViewMode={setViewMode}
								onBack={() => {
									setMobileDetailOpen(false);
									setCurrentPath(undefined);
								}}
								onNewFile={() => {
									void promptCreate(currentPath, setCurrentPath);
								}}
							/>
							{viewMode === "graph" ? (
								<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)]">
									<div
										className={cn(
											"min-h-0 lg:block",
											currentPath && mobileDetailOpen ? "hidden" : "block",
										)}
									>
										<KbGraphPane
											currentPath={currentPath}
											onSelect={(p) => {
												// Stay in graph mode; only update `path` so the file
												// opens in the right preview pane and the graph stays
												// visible. Browser-back collapses the preview
												// (URL: ?view=graph&path=X → ?view=graph).
												const next = new URLSearchParams(params);
												next.set("path", p);
												next.set("view", "graph");
												setParams(next, { replace: false });
												setMobileDetailOpen(true);
											}}
											kbChangeCounter={kbChangeCounter}
										/>
									</div>
									<div
										className={cn(
											"min-h-0 overflow-y-auto border-line lg:block lg:border-l",
											currentPath && mobileDetailOpen ? "block" : "hidden lg:block",
										)}
									>
										{currentPath ? (
											<KbFilePane
												path={currentPath}
												onNavigate={(p) => {
													const next = new URLSearchParams(params);
													next.set("path", p);
													next.set("view", "graph");
													setParams(next, { replace: false });
												}}
												onClose={() => {
													const next = new URLSearchParams(params);
													next.delete("path");
													next.set("view", "graph");
													setParams(next, { replace: false });
													setMobileDetailOpen(false);
												}}
												kbChangeCounter={kbChangeCounter}
											/>
										) : (
											<GraphPreviewEmpty />
										)}
									</div>
								</div>
							) : (
								<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
									<div
										className={cn(
											"min-h-0 overflow-y-auto border-line lg:block lg:border-r",
											mobileDetailOpen ? "hidden" : "block",
										)}
									>
										<KbTree
											currentPath={currentPath}
											onSelect={(p) => {
												setCurrentPath(p);
												setMobileDetailOpen(true);
											}}
											onOpenSearch={() => setPaletteOpen(true)}
											kbChangeCounter={kbChangeCounter}
										/>
									</div>
									<div
										className={cn(
											"min-h-0 overflow-y-auto lg:block",
											mobileDetailOpen ? "block" : "hidden lg:block",
										)}
									>
										{currentPath ? (
											<KbFilePane path={currentPath} onNavigate={(p) => setCurrentPath(p)} kbChangeCounter={kbChangeCounter} />
										) : (
											<KbEmpty />
										)}
									</div>
								</div>
							)}
						</>
					)}
				</div>
			}
			/>
			<KbCommandPalette
				open={paletteOpen}
				onClose={() => setPaletteOpen(false)}
				onSelect={(p) => {
					const next = new URLSearchParams(params);
					next.set("path", p);
					if (viewMode === "graph") next.set("view", "graph");
					setParams(next, { replace: false });
					setMobileDetailOpen(true);
				}}
			/>
		</>
	);
}

function KbTopBar({
	currentPath,
	mobileDetailOpen,
	viewMode,
	onViewMode,
	onBack,
	onNewFile,
}: {
	currentPath: string | undefined;
	mobileDetailOpen: boolean;
	viewMode: "file" | "graph";
	onViewMode: (v: "file" | "graph") => void;
	onBack: () => void;
	onNewFile?: () => void;
}) {
	return (
		<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
			{mobileDetailOpen && viewMode === "file" ? (
				<button
					type="button"
					onClick={onBack}
					aria-label="Back to tree"
					className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink lg:hidden"
				>
					<ArrowLeft className="h-4 w-4" />
				</button>
			) : null}
			<BookOpen className="h-4 w-4 text-accent" aria-hidden="true" />
			<div className="meta">Knowledge</div>
			<div className="min-w-0 truncate font-mono text-xs text-ink-3">
				{viewMode === "graph" ? "graph" : (currentPath ?? "browse")}
			</div>
			<div className="ml-auto inline-flex items-center rounded-md border border-line bg-paper-2 p-0.5 text-xs">
				<button
					type="button"
					onClick={() => onViewMode("file")}
					className={cn(
						"inline-flex h-6 items-center gap-1 rounded px-2 transition-colors",
						viewMode === "file" ? "bg-accent-soft/50 text-ink" : "text-ink-3 hover:text-ink",
					)}
					title="File viewer (?view=file)"
				>
					<FileText className="h-3.5 w-3.5" />
					File
				</button>
				<button
					type="button"
					onClick={() => onViewMode("graph")}
					className={cn(
						"inline-flex h-6 items-center gap-1 rounded px-2 transition-colors",
						viewMode === "graph" ? "bg-accent-soft/50 text-ink" : "text-ink-3 hover:text-ink",
					)}
					title="Force-directed graph (?view=graph)"
				>
					<Network className="h-3.5 w-3.5" />
					Graph
				</button>
			</div>
			{onNewFile ? (
				<button
					type="button"
					onClick={onNewFile}
					className="btn-ghost ml-1 inline-flex h-7 items-center gap-1 rounded-md border border-line bg-paper-2 px-2 text-xs transition-colors hover:bg-paper-3"
					title="Create new kb file (relative to current file's directory, or root)"
				>
					<FilePlus className="h-3.5 w-3.5" />
					<span className="hidden sm:inline">New file</span>
				</button>
			) : null}
		</div>
	);
}

function KbEmpty() {
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
			<BookOpen className="h-6 w-6 text-ink-4" />
			<div className="mt-3 text-sm text-ink-2">Pick a file from the tree.</div>
			<div className="mt-1 max-w-sm text-xs text-ink-3">
				The KB cockpit reads your wiki at <span className="font-mono text-ink-2">~/kb</span>. Set{" "}
				<span className="font-mono">OMP_DECK_KB_EXCLUDE_DIRS</span> to hide subtrees if you need to.
			</div>
		</div>
	);
}

function GraphPreviewEmpty() {
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
			<Network className="h-5 w-5 text-ink-4" />
			<div className="mt-3 text-sm text-ink-2">Click a node</div>
			<div className="mt-1 max-w-xs text-xs text-ink-3">
				The file opens here. The graph stays put so you can keep exploring.
			</div>
		</div>
	);
}

function KbWelcome({
	status,
	onInitialized,
}: {
	status: KbStatusResponse;
	onInitialized: () => void;
}) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const onCreate = useCallback(async () => {
		setBusy(true);
		setError(undefined);
		try {
			const res = await kbApi.init();
			if (res.refusedReason) {
				setError(res.refusedReason);
			}
			onInitialized();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [onInitialized]);
	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center px-6 py-10">
			<div className="max-w-lg text-left">
				<div className="flex items-center gap-2">
					<BookOpen className="h-5 w-5 text-accent" />
					<h1 className="text-base font-medium text-ink">Set up your knowledge base</h1>
				</div>
				<p className="mt-3 text-sm text-ink-2">
					omp-deck reads a Karpathy-style llm-wiki from a single folder on disk. The cockpit
					is currently pointed at{" "}
					<span className="break-all font-mono text-ink">{status.root}</span>
					{status.exists ? " (which is empty)" : " (which doesn't exist yet)"}.
				</p>
				<p className="mt-2 text-sm text-ink-3">
					Click below to scaffold a starter <span className="font-mono">README.md</span> at
					that location. From there you can drop in your own markdown files; the tree, the
					graph, and the file pane all refresh live as you add content.
				</p>
				<div className="mt-5 flex items-center gap-3">
					<button
						type="button"
						onClick={() => void onCreate()}
						disabled={busy}
						className="btn-primary inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-paper transition-opacity disabled:opacity-60"
					>
						{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FilePlus className="h-3.5 w-3.5" />}
						Create starter README
					</button>
					<span className="text-2xs text-ink-3">
						Or set <span className="font-mono text-ink-2">OMP_DECK_KB_ROOT</span> and restart the deck.
					</span>
				</div>
				{error ? (
					<div className="mt-3 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 font-mono text-2xs text-warn">
						{error}
					</div>
				) : null}
				<div className="mt-6 border-t border-line pt-4 text-xs text-ink-3">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
						What this is NOT
					</div>
					<p className="mt-1">
						This kb is separate from omp's <span className="font-mono">memory.backend</span>{" "}
						(rolling session summaries / vector recall). The kb is your hand-tended,
						long-term notes; omp memory is short-term session context.
					</p>
				</div>
			</div>
		</div>
	);
}

// ─── Tree ────────────────────────────────────────────────────────────────

function KbSidebar() {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Knowledge</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Filters and tag chips land in T-39. For now, browse the tree on the right.
				</div>
			</div>
			<div className="min-h-0 flex-1 px-3 py-2 text-xs text-ink-3">
				The cockpit reads <span className="font-mono">~/kb</span> via{" "}
				<span className="font-mono">OMP_DECK_KB_ROOT</span>. Hide subtrees via{" "}
				<span className="font-mono">OMP_DECK_KB_EXCLUDE_DIRS</span>.
			</div>
		</div>
	);
}

function KbTree({
	currentPath,
	onSelect,
	onOpenSearch,
	kbChangeCounter,
}: {
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	onOpenSearch: () => void;
	kbChangeCounter: number;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="flex items-center gap-2">
					<div className="meta">Knowledge</div>
					<button
						type="button"
						onClick={onOpenSearch}
						aria-label="Search KB (Ctrl-P)"
						title="Search (Ctrl-P / ⌘P)"
						className="ml-auto inline-flex h-7 items-center gap-1 rounded-md border border-line bg-paper-2 px-2 text-2xs text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink"
					>
						<Search className="h-3 w-3" />
						<span className="font-mono">Ctrl-P</span>
					</button>
				</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Your Karpathy-style llm-wiki. Click a file to open; wikilinks navigate in-app.
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto py-1">
				<TreeBranch path="" depth={0} expanded openOnMount currentPath={currentPath} onSelect={onSelect} kbChangeCounter={kbChangeCounter} />
			</div>
		</div>
	);
}

function TreeBranch({
	path,
	depth,
	expanded: expandedDefault,
	openOnMount,
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	path: string;
	depth: number;
	expanded: boolean;
	openOnMount?: boolean;
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [expanded, setExpanded] = useState(expandedDefault);
	const [data, setData] = useState<KbTreeResponse | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const fetchHere = useCallback(async () => {
		setLoading(true);
		try {
			const r = await kbApi.tree(path);
			setData(r);
			setError(undefined);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setLoading(false);
		}
	}, [path]);

	useEffect(() => {
		if (!expanded) return;
		void fetchHere();
	}, [expanded, fetchHere, kbChangeCounter]);

	useEffect(() => {
		if (openOnMount) setExpanded(true);
	}, [openOnMount]);

	return (
		<div>
			{data ? (
				<>
					{data.dirs.map((d) => (
						<TreeDir
							key={d.path}
							entry={d}
							depth={depth}
							currentPath={currentPath}
							onSelect={onSelect}
							kbChangeCounter={kbChangeCounter}
						/>
					))}
					{data.files.map((f) => (
						<TreeFile key={f.path} entry={f} depth={depth} active={currentPath === f.path} onSelect={onSelect} />
					))}
				</>
			) : null}
			{loading && !data ? (
				<div className="px-3 py-1.5 text-xs text-ink-3">
					<Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" /> loading
				</div>
			) : null}
			{error ? (
				<div className="px-3 py-1.5 font-mono text-2xs text-danger">{error}</div>
			) : null}
		</div>
	);
}

function TreeDir({
	entry,
	depth,
	currentPath,
	onSelect,
	kbChangeCounter,
}: {
	entry: KbTreeEntry;
	depth: number;
	currentPath: string | undefined;
	onSelect: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [expanded, setExpanded] = useState(false);
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const FolderIcon = expanded ? FolderOpen : Folder;
	return (
		<div>
			<button
				type="button"
				onClick={() => setExpanded((x) => !x)}
				className={cn(
					"flex w-full items-center gap-1 px-2 py-1 text-left text-sm transition-colors hover:bg-paper-3",
				)}
				style={{ paddingLeft: 8 + depth * 12 }}
			>
				<Chevron className="h-3 w-3 shrink-0 text-ink-3" />
				<FolderIcon className="h-3.5 w-3.5 shrink-0 text-ink-3" />
				<span className="min-w-0 truncate text-ink-2">{entry.name}</span>
				{entry.symlink ? (
					<span className="font-mono text-2xs uppercase text-ink-4" title="symlink/junction">→</span>
				) : null}
				{typeof entry.mdCount === "number" ? (
					<span className="ml-auto font-mono text-2xs text-ink-4">{entry.mdCount}</span>
				) : null}
			</button>
			{expanded ? (
				<TreeBranch
					path={entry.path}
					depth={depth + 1}
					expanded
					currentPath={currentPath}
					onSelect={onSelect}
					kbChangeCounter={kbChangeCounter}
				/>
			) : null}
		</div>
	);
}

function TreeFile({
	entry,
	depth,
	active,
	onSelect,
}: {
	entry: KbTreeEntry;
	depth: number;
	active: boolean;
	onSelect: (p: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={() => onSelect(entry.path)}
			className={cn(
				"flex w-full items-center gap-1 px-2 py-1 text-left text-sm transition-colors",
				active ? "bg-accent-soft/40 text-ink" : "text-ink-2 hover:bg-paper-3",
			)}
			style={{ paddingLeft: 8 + depth * 12 + 16 }}
		>
			<FileText className="h-3.5 w-3.5 shrink-0 text-ink-3" />
			<span className="min-w-0 truncate">{entry.name.replace(/\.md$/i, "")}</span>
		</button>
	);
}

// ─── File pane ───────────────────────────────────────────────────────────

function KbFilePane({
	path,
	onNavigate,
	onClose,
	kbChangeCounter,
}: {
	path: string;
	onNavigate: (p: string) => void;
	onClose?: () => void;
	kbChangeCounter: number;
}) {
	const [file, setFile] = useState<KbFileResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	// Edit state. When `draft === null` we're in view mode; once the user
	// hits Edit, we capture the rawContent into `draft` and switch.
	const [draft, setDraft] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string | undefined>();

	const dirty = draft !== null && file !== null && draft !== file.rawContent;
	const editing = draft !== null;

	useEffect(() => {
		// Don't blow away the user's buffer when the watcher fires for a
		// file they're editing — defer the refetch until they exit edit mode.
		if (editing) return;
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		kbApi
			.file(path)
			.then((d) => {
				if (cancelled) return;
				setFile(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setError(String((e as Error).message ?? e));
				setFile(null);
			})
			.finally(() => {
				if (cancelled) return;
				setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [path, kbChangeCounter, editing]);

	const startEdit = useCallback(() => {
		if (!file) return;
		setDraft(file.rawContent);
		setSaveError(undefined);
	}, [file]);

	const cancelEdit = useCallback(() => {
		if (dirty && !window.confirm("Discard unsaved changes?")) return;
		setDraft(null);
		setSaveError(undefined);
	}, [dirty]);

	const save = useCallback(async () => {
		if (draft === null || !file) return;
		setSaving(true);
		setSaveError(undefined);
		try {
			const next = await kbApi.put(file.path, draft);
			setFile(next);
			setDraft(null);
		} catch (e) {
			setSaveError(String((e as Error).message ?? e));
		} finally {
			setSaving(false);
		}
	}, [draft, file]);

	// Ctrl/Cmd-S saves; Esc discards.
	useEffect(() => {
		if (!editing) return;
		function onKey(e: KeyboardEvent): void {
			if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
				e.preventDefault();
				void save();
			} else if (e.key === "Escape") {
				e.preventDefault();
				cancelEdit();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [editing, save, cancelEdit]);

	const handleWikilink = useCallback(
		(href: string) => {
			if (href.startsWith("kb-link:")) {
				const raw = href.slice("kb-link:".length);
				const target = raw.split("?", 1)[0];
				if (!target) return true;
				onNavigate(decodeURI(target));
				return true;
			}
			if (href.startsWith("kb-unresolved:")) {
				const target = decodeURIComponent(href.slice("kb-unresolved:".length));
				if (file) void createUnresolved(target, file.path, onNavigate);
				return true;
			}
			return false;
		},
		[onNavigate, file],
	);

	if (loading && !file) {
		return (
			<div className="flex items-center gap-2 px-4 py-3 text-sm text-ink-3">
				<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading {path}…
			</div>
		);
	}
	if (error) {
		return (
			<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
				{error}
			</div>
		);
	}
	if (!file) return <KbEmpty />;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-4 py-3">
				<div className="flex items-center gap-2">
					<div className="min-w-0">
						<h1 className="truncate text-base font-medium text-ink">
							{typeof file.frontmatter?.name === "string" && (file.frontmatter.name as string).trim()
								? (file.frontmatter.name as string)
								: titleFromPath(file.path)}
							{dirty ? <span className="ml-1 text-warn" title="unsaved changes">●</span> : null}
						</h1>
						<div className="mt-1 font-mono text-2xs text-ink-3">{file.path}</div>
					</div>
					<div className="ml-auto flex items-center gap-1">
						{editing ? (
							<>
								<button
									type="button"
									onClick={() => void save()}
									disabled={!dirty || saving}
									className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs disabled:opacity-50"
									title="Save (Ctrl-S)"
								>
									{saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
									Save
								</button>
								<button
									type="button"
									onClick={cancelEdit}
									className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs"
									title="Discard (Esc)"
								>
									<X className="h-3.5 w-3.5" />
									Cancel
								</button>
							</>
						) : (
							<>
								<button
									type="button"
									onClick={startEdit}
									className="btn-ghost inline-flex h-7 items-center gap-1 px-2 text-xs"
									title="Edit (or click anywhere in the body)"
								>
									<Pencil className="h-3.5 w-3.5" />
									Edit
								</button>
								{onClose ? (
									<button
										type="button"
										onClick={onClose}
										className="btn-ghost inline-flex h-7 w-7 items-center justify-center p-0 text-ink-3 hover:text-ink"
										title="Close preview"
										aria-label="Close preview"
									>
										<X className="h-3.5 w-3.5" />
									</button>
								) : null}
							</>
						)}
					</div>
				</div>
				{file.frontmatterError ? (
					<div className="mt-2 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 font-mono text-2xs text-warn">
						frontmatter: {file.frontmatterError}
					</div>
				) : null}
				{saveError ? (
					<div className="mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1 font-mono text-2xs text-danger">
						save failed: {saveError}
					</div>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
				{editing ? (
					<RichEditor
						value={draft}
						onChange={(v) => setDraft(v)}
						disableRichText={false}
						className="h-full min-h-[60vh] w-full resize-none whitespace-pre-wrap break-words rounded-md border border-line bg-paper-2 p-3 font-mono text-xs leading-relaxed text-ink focus:border-accent focus:outline-none"
					/>
				) : (
					<KbMarkdown body={file.bodyForRender} onWikilink={handleWikilink} />
				)}
			</div>
		</div>
	);
}

/**
 * Shared create flow: prompt for a relative path, validate it, write a
 * sensible stub, navigate to it. Used both by the unresolved-wikilink
 * flow and the top-bar `New file` button. Errors surface as inline
 * toasts via the kb-change bus instead of native dialogs so the kb
 * shell never gets blocked behind a modal.
 */
async function promptCreate(currentFilePath: string | undefined, onNavigate: (p: string) => void): Promise<void> {
	const currentDir = currentFilePath && currentFilePath.includes("/")
		? currentFilePath.slice(0, currentFilePath.lastIndexOf("/"))
		: "";
	const suggestedStem = currentFilePath
		? currentFilePath.split("/").pop()?.replace(/\.md$/i, "") ?? "untitled"
		: "untitled";
	const defaultPath = currentDir ? `${currentDir}/${suggestedStem}-copy.md` : `${suggestedStem}-copy.md`;
	const proposed = window.prompt(
		"Create a new kb file.\nPath (relative to kb root, must end in .md):",
		defaultPath,
	);
	if (!proposed) return;
	const normalized = proposed.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized) {
		window.alert("Path cannot be empty");
		return;
	}
	if (!normalized.toLowerCase().endsWith(".md")) {
		window.alert("Path must end in .md");
		return;
	}
	const stem = normalized.split("/").pop()?.replace(/\.md$/i, "") ?? "untitled";
	const today = new Date().toISOString().slice(0, 10);
	const title = stem.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
	const stub = `---\ntype: knowledge\ncreated: ${today}\nupdated: ${today}\ntags: []\n---\n\n# ${title}\n\n`;
	try {
		await kbApi.create(normalized, stub);
		onNavigate(normalized);
	} catch (e) {
		window.alert(`create failed: ${(e as Error).message ?? e}`);
	}
}

/**
 * Prompt the user to create a file for an unresolved wikilink target. The
 * filename defaults to the bare target (cleaned for filesystem safety);
 * directory defaults to the current file's parent. Cancel = no-op.
 */
async function createUnresolved(target: string, currentFilePath: string, onNavigate: (p: string) => void): Promise<void> {
	const currentDir = currentFilePath.includes("/") ? currentFilePath.slice(0, currentFilePath.lastIndexOf("/")) : "";
	const slug = target.replace(/[\\:*?"<>|]/g, "-").replace(/\.md$/i, "");
	const defaultPath = currentDir ? `${currentDir}/${slug}.md` : `${slug}.md`;
	const proposed = window.prompt(
		`Create a new kb file for unresolved wikilink "${target}"?\nPath (relative to kb root):`,
		defaultPath,
	);
	if (!proposed) return;
	const normalized = proposed.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized.toLowerCase().endsWith(".md")) {
		window.alert("Path must end in .md");
		return;
	}
	const stem = normalized.split("/").pop()?.replace(/\.md$/i, "") ?? target;
	const today = new Date().toISOString().slice(0, 10);
	const stub = `---\ntype: knowledge\ncreated: ${today}\nupdated: ${today}\ntags: []\n---\n\n# ${target}\n\n`;
	try {
		await kbApi.create(normalized, stub);
		onNavigate(normalized);
	} catch (e) {
		window.alert(`create failed: ${(e as Error).message ?? e}`);
	}
}

// ─── Inspector ───────────────────────────────────────────────────────────

function KbInspector({
	currentPath,
	onNavigate,
	kbChangeCounter,
}: {
	currentPath: string | undefined;
	onNavigate: (p: string) => void;
	kbChangeCounter: number;
}) {
	const [file, setFile] = useState<KbFileResponse | null>(null);
	const [backlinks, setBacklinks] = useState<KbBacklink[]>([]);
	const [backlinksLoading, setBacklinksLoading] = useState(false);

	useEffect(() => {
		if (!currentPath) {
			setFile(null);
			setBacklinks([]);
			return;
		}
		let cancelled = false;
		setBacklinksLoading(true);
		kbApi.file(currentPath).then((d) => {
			if (!cancelled) setFile(d);
		}).catch(() => {
			if (!cancelled) setFile(null);
		});
		kbApi.backlinks(currentPath).then((b) => {
			if (!cancelled) {
				setBacklinks(b.backlinks);
				setBacklinksLoading(false);
			}
		}).catch(() => {
			if (!cancelled) {
				setBacklinks([]);
				setBacklinksLoading(false);
			}
		});
		return () => {
			cancelled = true;
		};
	}, [currentPath, kbChangeCounter]);

	if (!currentPath) {
		return <div className="px-3 py-4 text-xs text-ink-3">Pick a file to inspect.</div>;
	}

	const isOrphan = file !== null && !backlinksLoading && backlinks.length === 0;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Inspector</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Frontmatter, outbound, backlinks, tags.
				</div>
			</div>
			<div className="space-y-3 overflow-y-auto px-3 py-3 text-xs">
				{file ? (
					<>
						<DefRow k="path" v={<span className="break-all font-mono text-2xs">{file.path}</span>} />
						<DefRow k="size" v={<span className="font-mono text-2xs">{formatBytes(file.size)}</span>} />
						<DefRow k="updated" v={<span className="font-mono text-2xs">{formatTime(file.mtime)}</span>} />
						{isOrphan ? (
							<div className="flex items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2 py-1 font-mono text-2xs text-warn">
								<Link2Off className="h-3 w-3" />
								orphan — no backlinks
							</div>
						) : null}
						<TagChips fm={file.frontmatter} />
						<FrontmatterBlock fm={file.frontmatter} />
						<OutboundBlock links={file.outgoingLinks} onNavigate={onNavigate} />
						<BacklinksBlock
							backlinks={backlinks}
							loading={backlinksLoading}
							onNavigate={onNavigate}
						/>
					</>
				) : (
					<div className="text-ink-3">loading…</div>
				)}
			</div>
		</div>
	);
}

function DefRow({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">{k}</div>
			<div className="mt-0.5 text-ink-2">{v}</div>
		</div>
	);
}

function FrontmatterBlock({ fm }: { fm: Record<string, unknown> }) {
	const entries = Object.entries(fm).filter(([k]) => k !== "_raw");
	if (entries.length === 0) {
		return <div className="text-2xs text-ink-3">no frontmatter</div>;
	}
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">frontmatter</div>
			<dl className="mt-1 space-y-0.5 font-mono text-2xs">
				{entries.map(([k, v]) => (
					<div key={k} className="flex items-baseline gap-2">
						<dt className="text-ink-4">{k}</dt>
						<dd className="break-all text-ink-2">{formatValue(v)}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

function OutboundBlock({
	links,
	onNavigate,
}: {
	links: KbFileResponse["outgoingLinks"];
	onNavigate: (p: string) => void;
}) {
	if (links.length === 0) {
		return <div className="text-2xs text-ink-3">no outbound links</div>;
	}
	const resolved = links.filter((l) => l.resolved);
	const unresolved = links.filter((l) => !l.resolved);
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
				outbound ({links.length})
			</div>
			<ul className="mt-1 space-y-0.5 font-mono text-2xs">
				{resolved.map((l, i) => (
					<li key={`r-${i}`}>
						<button
							type="button"
							onClick={() => l.resolved && onNavigate(l.resolved)}
							className="flex w-full items-center gap-1.5 truncate rounded px-1 py-0.5 text-left text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink"
							title={l.resolved ?? ""}
						>
							<Link2 className="h-3 w-3 shrink-0 text-accent" />
							<span className="truncate">{l.label}</span>
						</button>
					</li>
				))}
				{unresolved.map((l, i) => (
					<li
						key={`u-${i}`}
						className="flex items-center gap-1.5 px-1 py-0.5 text-ink-3"
						title={l.unresolvedReason}
					>
						<Link2Off className="h-3 w-3 shrink-0" />
						<span className="truncate italic">{l.label}</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function BacklinksBlock({
	backlinks,
	loading,
	onNavigate,
}: {
	backlinks: KbBacklink[];
	loading: boolean;
	onNavigate: (p: string) => void;
}) {
	if (loading) {
		return (
			<div className="text-2xs text-ink-3">
				<Loader2 className="mr-1 inline-block h-3 w-3 animate-spin" /> loading backlinks…
			</div>
		);
	}
	if (backlinks.length === 0) {
		return <div className="text-2xs text-ink-3">no backlinks</div>;
	}
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
				backlinks ({backlinks.length})
			</div>
			<ul className="mt-1 space-y-1 font-mono text-2xs">
				{backlinks.map((b, i) => (
					<li key={`b-${i}`} className="rounded px-1 py-0.5 hover:bg-paper-3">
						<button
							type="button"
							onClick={() => onNavigate(b.source)}
							className="flex w-full items-start gap-1.5 text-left"
							title={b.source}
						>
							<Link2 className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
							<div className="min-w-0 flex-1">
								<div className="truncate text-ink-2">{b.source}</div>
								{b.snippet ? (
									<div className="mt-0.5 truncate text-ink-3">{b.snippet}</div>
								) : null}
							</div>
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}

function TagChips({ fm }: { fm: Record<string, unknown> }) {
	const tags = Array.isArray(fm.tags)
		? (fm.tags as unknown[]).filter((t): t is string => typeof t === "string" && t.length > 0)
		: [];
	if (tags.length === 0) return null;
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">tags</div>
			<div className="mt-1 flex flex-wrap gap-1">
				{tags.map((t) => (
					<span
						key={t}
						className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
						title="Click-to-filter lands in T-40"
					>
						{t}
					</span>
				))}
			</div>
		</div>
	);
}

// ─── Wikilink-aware Markdown ─────────────────────────────────────────────

interface WikiAnchorProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
	href?: string;
	children?: ReactNode;
}

const KbMarkdown = memo(function KbMarkdown({
	body,
	onWikilink,
}: {
	body: string;
	onWikilink: (href: string) => boolean;
}) {
	const Anchor = useCallback(
		({ href, children, ...rest }: WikiAnchorProps) => {
			const isKbLink = href?.startsWith("kb-link:") ?? false;
			const isUnresolved = href?.startsWith("kb-unresolved:") ?? false;
			// Everything that isn't an in-app wikilink and points at an outside
			// URL should open in a new tab so reading the kb isn't disrupted.
			const isExternal =
				!isKbLink && !isUnresolved && href != null && /^(https?:|mailto:)/i.test(href);
			const cls = isKbLink
				? "text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
				: isUnresolved
					? "text-ink-3 italic underline decoration-dotted decoration-ink-4 hover:text-ink-2"
					: undefined;
			const onClick: React.MouseEventHandler<HTMLAnchorElement> = (e) => {
				if (!href) return;
				if (isKbLink || isUnresolved) {
					if (onWikilink(href)) e.preventDefault();
				}
			};
			const externalProps = isExternal
				? { target: "_blank", rel: "noopener noreferrer" }
				: {};
			return (
				<a {...rest} {...externalProps} href={href} onClick={onClick} className={cls}>
					{children}
				</a>
			);
		},
		[onWikilink],
	);
	return (
		<div className="markdown text-sm">
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
				urlTransform={kbUrlTransform}
				components={{ pre: CopyablePre, a: Anchor }}
			>
				{body}
			</ReactMarkdown>
		</div>
	);
});

/**
 * Allow `kb-link:` and `kb-unresolved:` URI schemes through react-markdown's
 * default sanitizer. Without this override, react-markdown rewrites unknown
 * schemes to empty strings before our custom `a` component sees them, so
 * wikilink clicks fall through to a default-href anchor that does nothing.
 */
function kbUrlTransform(url: string): string {
	if (url.startsWith("kb-link:") || url.startsWith("kb-unresolved:")) return url;
	if (/^(https?:|mailto:|tel:|#|\/)/i.test(url)) return url;
	return "";
}

function CopyablePre({ children, ...rest }: React.HTMLAttributes<HTMLPreElement> & { children?: ReactNode }) {
	return (
		<div className="group relative">
			<pre {...rest}>{children}</pre>
			<CopyButton />
		</div>
	);
}

// ─── helpers ─────────────────────────────────────────────────────────────

function titleFromPath(p: string): string {
	const last = p.split("/").pop() ?? p;
	return last.replace(/\.md$/i, "");
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function formatTime(iso: string): string {
	try {
		return new Date(iso).toLocaleString();
	} catch {
		return iso;
	}
}

function formatValue(v: unknown): string {
	if (v === null || v === undefined) return "—";
	if (Array.isArray(v)) return v.map((x) => formatValue(x)).join(", ");
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}
