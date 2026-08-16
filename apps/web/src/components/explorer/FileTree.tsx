/**
 * Lazy-loading file tree. Each directory's children are fetched only when
 * first expanded and cached in local state — a big monorepo shouldn't pay
 * for a full recursive walk just to render the root.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, Loader2, Trash2 } from "lucide-react";
import type { FileEntry } from "@omp-deck/protocol";
import { filesApi } from "@/lib/files-api";
import { cn } from "@/lib/utils";

interface TreeNodeState {
	expanded: boolean;
	loading: boolean;
	children: FileEntry[] | null;
	error: string | null;
}

interface Props {
	root: string;
	selectedPath: string | null;
	onSelect: (entry: FileEntry) => void;
	/** Paths with uncommitted git changes, for a dirty-dot indicator. */
	dirtyPaths?: Set<string>;
	onCreateFile?: (parentDir: string) => void;
	onCreateFolder?: (parentDir: string) => void;
	onDelete?: (entry: FileEntry) => void;
	/** Bumped by the parent to force a refetch (e.g. after a git operation). */
	refreshKey?: number;
	/**
	 * Override the listing call. Defaults to the workspace file explorer's
	 * `filesApi.list`; the agent-config browser passes `agentConfigApi.list`
	 * instead so this same tree renders `OMP_AGENT_DIR` without duplicating
	 * the expand/lazy-load/error-state logic.
	 */
	list?: (path: string) => Promise<{ entries: FileEntry[] }>;
}

export function FileTree({
	root,
	selectedPath,
	onSelect,
	dirtyPaths,
	onCreateFile,
	onCreateFolder,
	onDelete,
	refreshKey,
	list = filesApi.list,
}: Props): JSX.Element {
	const [nodes, setNodes] = useState<Map<string, TreeNodeState>>(new Map());

	const loadChildren = useCallback(async (dirPath: string) => {
		setNodes((prev) => new Map(prev).set(dirPath, { expanded: true, loading: true, children: null, error: null }));
		try {
			const result = await list(dirPath);
			setNodes((prev) => new Map(prev).set(dirPath, { expanded: true, loading: false, children: result.entries, error: null }));
		} catch (err) {
			setNodes((prev) =>
				new Map(prev).set(dirPath, {
					expanded: true,
					loading: false,
					children: null,
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}, [list]);

	const toggle = useCallback(
		(entry: FileEntry) => {
			const state = nodes.get(entry.path);
			if (state?.expanded) {
				setNodes((prev) => new Map(prev).set(entry.path, { ...state, expanded: false }));
				return;
			}
			if (state?.children) {
				setNodes((prev) => new Map(prev).set(entry.path, { ...state, expanded: true }));
				return;
			}
			void loadChildren(entry.path);
		},
		[nodes, loadChildren],
	);

	// refreshKey changing (after a commit/checkout/pull) invalidates cached
	// listings — every currently-expanded directory re-fetches, but stays
	// expanded, so the tree reflects on-disk reality without collapsing on
	// the user.
	const prevRefreshKey = useRef(refreshKey);
	useEffect(() => {
		if (refreshKey === undefined || refreshKey === prevRefreshKey.current) return;
		prevRefreshKey.current = refreshKey;
		setNodes((prev) => {
			const expandedDirs = [...prev.entries()].filter(([, s]) => s.expanded).map(([p]) => p);
			for (const dir of expandedDirs) void loadChildren(dir);
			return prev;
		});
	}, [refreshKey, loadChildren]);

	return (
		<div className="select-none py-1 text-sm">
			<TreeLevel
				dirPath={root}
				depth={0}
				nodes={nodes}
				selectedPath={selectedPath}
				dirtyPaths={dirtyPaths}
				onToggle={toggle}
				onSelect={onSelect}
				onCreateFile={onCreateFile}
				onCreateFolder={onCreateFolder}
				onDelete={onDelete}
				loadChildren={loadChildren}
			/>
		</div>
	);
}

interface LevelProps {
	dirPath: string;
	depth: number;
	nodes: Map<string, TreeNodeState>;
	selectedPath: string | null;
	dirtyPaths?: Set<string>;
	onToggle: (entry: FileEntry) => void;
	onSelect: (entry: FileEntry) => void;
	onCreateFile?: (parentDir: string) => void;
	onCreateFolder?: (parentDir: string) => void;
	onDelete?: (entry: FileEntry) => void;
	loadChildren: (dirPath: string) => Promise<void>;
}

function TreeLevel({ dirPath, depth, nodes, ...rest }: LevelProps): JSX.Element {
	const state = nodes.get(dirPath);
	if (depth === 0 && !state) {
		// Root auto-loads on first render.
		void rest.loadChildren(dirPath);
		return (
			<div className="flex items-center gap-2 px-3 py-2 text-ink-3">
				<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
			</div>
		);
	}
	if (!state?.children) return <></>;

	return (
		<>
			{state.children.map((entry) => (
				<TreeRow key={entry.path} entry={entry} depth={depth} nodes={nodes} {...rest} />
			))}
		</>
	);
}

interface RowProps extends Omit<LevelProps, "dirPath"> {
	entry: FileEntry;
}

function TreeRow({ entry, depth, nodes, selectedPath, dirtyPaths, onToggle, onSelect, onCreateFile, onCreateFolder, onDelete, loadChildren }: RowProps): JSX.Element {
	const state = nodes.get(entry.path);
	const isDir = entry.kind === "dir";
	const isSelected = selectedPath === entry.path;
	const isDirty = dirtyPaths?.has(entry.path);

	return (
		<div>
			<div
				className={cn(
					"group flex cursor-pointer items-center gap-1 rounded px-2 py-1 transition-colors",
					isSelected ? "bg-accent-soft/50 text-ink" : "text-ink-2 hover:bg-paper-3",
				)}
				style={{ paddingLeft: `${depth * 14 + 8}px` }}
				// data-context-key + data-path / data-name: the global
				// ContextMenu listener walks up to the closest [data-context-key]
				// ancestor on right-click and dispatches the matching MENUS scope.
				// Without these attrs a folder/file right-click falls through to
				// the global.fallback menu (Inspect/Copy selector/Reload) — useless.
				data-context-key={isDir ? "folder.menu" : "file.menu"}
				data-path={entry.path}
				data-name={entry.name}
				onContextMenu={(e) => e.preventDefault()}
				onClick={() => (isDir ? onToggle(entry) : onSelect(entry))}
			>
				{isDir ? (
					<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-ink-4 transition-transform", state?.expanded && "rotate-90")} />
				) : (
					<span className="w-3.5 shrink-0" />
				)}
				{isDir ? (
					state?.expanded ? (
						<FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent" />
					) : (
						<Folder className="h-3.5 w-3.5 shrink-0 text-ink-3" />
					)
				) : (
					<File className="h-3.5 w-3.5 shrink-0 text-ink-4" />
				)}
				<span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.name}</span>
				{isDirty ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="modified" /> : null}
				{isDir ? (
					<span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
						{onCreateFile ? (
							<button
								type="button"
								title="New file"
								className="rounded p-0.5 text-ink-4 hover:bg-paper hover:text-ink"
								onClick={(e) => {
									e.stopPropagation();
									onCreateFile(entry.path);
								}}
							>
								<FilePlus className="h-3 w-3" />
							</button>
						) : null}
						{onCreateFolder ? (
							<button
								type="button"
								title="New folder"
								className="rounded p-0.5 text-ink-4 hover:bg-paper hover:text-ink"
								onClick={(e) => {
									e.stopPropagation();
									onCreateFolder(entry.path);
								}}
							>
								<FolderPlus className="h-3 w-3" />
							</button>
						) : null}
					</span>
				) : null}
				{onDelete ? (
					<button
						type="button"
						title="Delete"
						className="hidden shrink-0 rounded p-0.5 text-ink-4 hover:bg-danger/15 hover:text-danger group-hover:block"
						onClick={(e) => {
							e.stopPropagation();
							onDelete(entry);
						}}
					>
						<Trash2 className="h-3 w-3" />
					</button>
				) : null}
			</div>
			{isDir && state?.expanded ? (
				state.loading ? (
					<div className="flex items-center gap-2 px-3 py-1 text-ink-4" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
						<Loader2 className="h-3 w-3 animate-spin" />
					</div>
				) : state.error ? (
					<div className="px-3 py-1 text-2xs text-danger" style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}>
						{state.error}
					</div>
				) : (
					<TreeLevel
						dirPath={entry.path}
						depth={depth + 1}
						nodes={nodes}
						selectedPath={selectedPath}
						dirtyPaths={dirtyPaths}
						onToggle={onToggle}
						onSelect={onSelect}
						onCreateFile={onCreateFile}
						onCreateFolder={onCreateFolder}
						onDelete={onDelete}
						loadChildren={loadChildren}
					/>
				)
			) : null}
		</div>
	);
}
