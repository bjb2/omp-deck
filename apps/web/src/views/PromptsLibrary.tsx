import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Copy,
	Download,
	Loader2,
	Pin,
	Plus,
	Search,
	Sparkles,
	Star,
	Trash2,
	Upload,
} from "lucide-react";
import type { Prompt } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { PromptEditor } from "@/components/PromptEditor";
import { cn } from "@/lib/utils";
import { promptsApi } from "@/lib/prompts-api";
import { useStore } from "@/lib/store";

const SUGGESTED_TEMPLATES: Pick<Prompt, "title" | "body" | "category" | "tags">[] = [
	{
		title: "Explain this code",
		body:
			"Walk me through what `{{path}}` does, line by line. I'm trying to understand {{goal}}. " +
			"Surface any non-obvious side effects or invariants.",
		category: "code",
		tags: ["explain", "reading"],
	},
	{
		title: "Bug repro + fix",
		body:
			"I'm seeing `{{symptom}}` in `{{path}}` when I {{action}}. Help me:\n" +
			"1. Reproduce with the smallest possible case\n" +
			"2. Identify the root cause\n" +
			"3. Propose a minimal patch and explain tradeoffs.",
		category: "code",
		tags: ["debug", "fix"],
	},
	{
		title: "PR review checklist",
		body:
			"Review the diff at `{{path}}` and report:\n" +
			"- correctness\n- tests added\n- edge cases\n- doc impact\n- naming & style\n\n" +
			"Mark any blocking issues clearly.",
		category: "review",
		tags: ["pr", "checklist"],
	},
];

/**
 * Prompt library cockpit. Sidebar: categories, tag filter, pin section,
 * recently used top 5. Main: list + editor split-view at xl+, tabs below.
 */
export function PromptsLibrary() {
	const prompts = useStore((s) => s.promptsLibrary);
	const setPromptsLibrary = useStore((s) => s.setPromptsLibrary);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [activeCategory, setActiveCategory] = useState<string>("all");
	const [activeTag, setActiveTag] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const resp = await promptsApi.list();
			setPromptsLibrary(resp.prompts);
			setError(undefined);
		} catch (err) {
			setError(String((err as Error).message ?? err));
		} finally {
			setLoading(false);
		}
	}, [setPromptsLibrary]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		return prompts.filter((p) => {
			if (activeCategory !== "all" && p.category !== activeCategory) return false;
			if (activeTag && !p.tags.includes(activeTag)) return false;
			if (!q) return true;
			const hay = `${p.title}\n${p.body}\n${p.tags.join(" ")}`.toLowerCase();
			return hay.includes(q);
		});
	}, [prompts, search, activeCategory, activeTag]);

	const selected = filtered.find((p) => p.id === selectedId) ?? filtered[0];

	const onCreate = useCallback(async (): Promise<void> => {
		try {
			const created = await promptsApi.create({
				title: "Untitled prompt",
				body: "Write your prompt here. Use {{variable}} placeholders.",
				category: "general",
				tags: [],
			});
			setSelectedId(created.id);
			void refresh();
		} catch (err) {
			setError(String((err as Error).message ?? err));
		}
	}, [refresh]);

	const onDelete = useCallback(
		async (id: string): Promise<void> => {
			if (!window.confirm("Delete this prompt?")) return;
			try {
				await promptsApi.remove(id);
				if (selectedId === id) setSelectedId(undefined);
				void refresh();
			} catch (err) {
				setError(String((err as Error).message ?? err));
			}
		},
		[refresh, selectedId],
	);

	const onShareCopy = useCallback((p: Prompt): void => {
		const url = `${window.location.origin}/prompts/share/${p.shareSlug ?? p.id}`;
		void navigator.clipboard.writeText(url).catch(() => {});
	}, []);

	const onExport = useCallback(async (p: Prompt): Promise<void> => {
		try {
			const exported = await promptsApi.exportPrompt(p.id);
			const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			a.download = `${exported.title.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase() || "prompt"}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
		} catch (err) {
			setError(String((err as Error).message ?? err));
		}
	}, []);

	const onImport = useCallback(async (): Promise<void> => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			const text = await file.text();
			try {
				await promptsApi.importPrompt({ rawJson: text });
				void refresh();
			} catch (err) {
				setError(String((err as Error).message ?? err));
			}
		};
		input.click();
	}, [refresh]);

	const sidebar = (
		<LibrarySidebar
			prompts={prompts}
			activeCategory={activeCategory}
			activeTag={activeTag}
			onCategoryChange={setActiveCategory}
			onTagChange={setActiveTag}
			onCreate={onCreate}
			onImport={onImport}
			onSeed={async (tpl) => {
				try {
					const created = await promptsApi.create(tpl);
					setSelectedId(created.id);
					void refresh();
				} catch (err) {
					setError(String((err as Error).message ?? err));
				}
			}}
		/>
	);

	const main = (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
				<Search className="h-3.5 w-3.5 text-ink-3" />
				<input
					className="flex-1 bg-transparent text-sm placeholder:text-ink-3 focus:outline-none"
					placeholder="Filter prompts"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
				<button
					type="button"
					className="btn-ghost h-7 gap-1 px-2 text-xs"
					onClick={onCreate}
					title="New prompt"
				>
					<Plus className="h-3 w-3" />
					new
				</button>
			</div>
			{error ? (
				<div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-2xs text-danger">
					{error}
				</div>
			) : null}
			<div className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(260px,1fr)_minmax(0,2fr)]">
				<div className="min-h-0 overflow-y-auto border-b border-line xl:border-b-0 xl:border-r">
					{loading ? (
						<div className="flex items-center gap-2 px-3 py-3 font-mono text-2xs text-ink-3">
							<Loader2 className="h-3 w-3 animate-spin" />
							loading
						</div>
					) : filtered.length === 0 ? (
						<div className="px-3 py-3 text-xs text-ink-3">
							No prompts match. Use the sidebar to seed a starter, or click <b>new</b>.
						</div>
					) : (
						filtered.map((p) => (
							<PromptRow
								key={p.id}
								prompt={p}
								active={selected?.id === p.id}
								onClick={() => setSelectedId(p.id)}
								onPin={async () => {
									try {
										await promptsApi.update(p.id, { pinned: !p.pinned });
										void refresh();
									} catch (err) {
										setError(String((err as Error).message ?? err));
									}
								}}
							/>
						))
					)}
				</div>
				<div className="min-h-0 overflow-hidden">
					{selected ? (
						<EditorPane
							prompt={selected}
							onSave={async (patch) => {
								try {
									await promptsApi.update(selected.id, patch);
									void refresh();
								} catch (err) {
									setError(String((err as Error).message ?? err));
								}
							}}
							onDelete={() => onDelete(selected.id)}
							onShare={() => onShareCopy(selected)}
							onExport={() => onExport(selected)}
							onShareToggle={async () => {
								try {
									await promptsApi.update(selected.id, { share: !selected.shareSlug });
									void refresh();
								} catch (err) {
									setError(String((err as Error).message ?? err));
								}
							}}
						/>
					) : (
						<div className="flex h-full items-center justify-center text-xs text-ink-3">
							Pick a prompt from the list, or create a new one.
						</div>
					)}
				</div>
			</div>
		</div>
	);

	return <Layout sidebar={sidebar} main={main} inspector={null} />;
}

function PromptRow({
	prompt,
	active,
	onClick,
	onPin,
}: {
	prompt: Prompt;
	active: boolean;
	onClick: () => void;
	onPin: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-start gap-2 border-b border-line/50 px-3 py-2 text-left",
				active ? "bg-paper-3" : "hover:bg-paper-2",
			)}
		>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onPin();
				}}
				className={cn(
					"mt-0.5 shrink-0 rounded p-0.5",
					prompt.pinned ? "text-accent" : "text-ink-3 hover:text-ink",
				)}
				aria-label={prompt.pinned ? "Unpin" : "Pin"}
				title={prompt.pinned ? "Unpin" : "Pin"}
			>
				<Pin className="h-3 w-3" fill={prompt.pinned ? "currentColor" : "none"} />
			</button>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium text-ink">{prompt.title}</div>
				<div className="mt-0.5 truncate font-mono text-2xs text-ink-3">
					{prompt.category} · {prompt.tags.join(" · ") || "no tags"}
				</div>
			</div>
			{prompt.usageCount > 0 ? (
				<span className="shrink-0 font-mono text-2xs text-ink-3" title="usage">
					×{prompt.usageCount}
				</span>
			) : null}
		</button>
	);
}

function EditorPane({
	prompt,
	onSave,
	onDelete,
	onShare,
	onExport,
	onShareToggle,
}: {
	prompt: Prompt;
	onSave: (patch: Partial<Prompt>) => Promise<void>;
	onDelete: () => void;
	onShare: () => void;
	onExport: () => void;
	onShareToggle: () => void;
}) {
	const [saving, setSaving] = useState(false);
	const [savedAt, setSavedAt] = useState<number | undefined>();

	const commit = useCallback(
		async (patch: Partial<Prompt>): Promise<void> => {
			if (Object.keys(patch).length === 0) return;
			setSaving(true);
			try {
				await onSave(patch);
				setSavedAt(Date.now());
			} finally {
				setSaving(false);
			}
		},
		[onSave],
	);

	return (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-line bg-paper-2 px-3 py-1.5">
				<button
					type="button"
					className={cn(
						"btn-ghost h-7 gap-1 px-2 text-xs",
						prompt.shareSlug && "text-accent",
					)}
					onClick={onShareToggle}
					title={prompt.shareSlug ? "Unshare" : "Share by link"}
				>
					<Sparkles className="h-3 w-3" />
					{prompt.shareSlug ? "shared" : "share"}
				</button>
				{prompt.shareSlug ? (
					<button
						type="button"
						className="btn-ghost h-7 gap-1 px-2 text-xs"
						onClick={onShare}
						title="Copy share URL"
					>
						<Copy className="h-3 w-3" />
						copy link
					</button>
				) : null}
				<button
					type="button"
					className="btn-ghost h-7 gap-1 px-2 text-xs"
					onClick={onExport}
					title="Export as JSON"
				>
					<Download className="h-3 w-3" />
					export
				</button>
				<div className="flex-1" />
				<button
					type="button"
					className="btn-ghost h-7 gap-1 px-2 text-xs hover:text-danger"
					onClick={onDelete}
					title="Delete prompt"
				>
					<Trash2 className="h-3 w-3" />
					delete
				</button>
			</div>
			<div className="min-h-0 flex-1">
				<PromptEditor
					value={prompt}
					variables={prompt.variables}
					saving={saving}
					savedAt={savedAt}
					onChange={commit}
					onCommit={() => void commit({})}
				/>
			</div>
		</div>
	);
}

function LibrarySidebar({
	prompts,
	activeCategory,
	activeTag,
	onCategoryChange,
	onTagChange,
	onCreate,
	onImport,
	onSeed,
}: {
	prompts: Prompt[];
	activeCategory: string;
	activeTag: string | undefined;
	onCategoryChange: (c: string) => void;
	onTagChange: (t: string | undefined) => void;
	onCreate: () => void;
	onImport: () => void;
	onSeed: (tpl: (typeof SUGGESTED_TEMPLATES)[number]) => void;
}) {
	const categories = useMemo(() => {
		const set = new Set<string>();
		for (const p of prompts) set.add(p.category);
		return [...set].sort();
	}, [prompts]);
	const allTags = useMemo(() => {
		const counts = new Map<string, number>();
		for (const p of prompts) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
		return [...counts.entries()].sort((a, b) => b[1] - a[1]);
	}, [prompts]);
	const pinned = prompts.filter((p) => p.pinned);
	const recent = useMemo(() => {
		return prompts
			.filter((p) => p.lastUsedAt !== null)
			.sort((a, b) => (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? ""))
			.slice(0, 5);
	}, [prompts]);

	return (
		<div className="flex h-full flex-col overflow-y-auto p-3 font-mono text-xs">
			<div className="flex items-center gap-2">
				<button type="button" className="btn-primary flex-1 h-7 gap-1 px-2 text-xs" onClick={onCreate}>
					<Plus className="h-3 w-3" />
					new
				</button>
				<button
					type="button"
					className="btn-ghost h-7 w-7 p-0"
					onClick={onImport}
					title="Import JSON / gist"
				>
					<Upload className="h-3.5 w-3.5" />
				</button>
			</div>

			<Section title="categories">
				<FilterRow
					label="all"
					active={activeCategory === "all"}
					onClick={() => onCategoryChange("all")}
				/>
				{categories.map((c) => (
					<FilterRow
						key={c}
						label={c}
						count={prompts.filter((p) => p.category === c).length}
						active={activeCategory === c}
						onClick={() => onCategoryChange(c)}
					/>
				))}
			</Section>

			<Section title="tags">
				{allTags.length === 0 ? (
					<div className="px-1 py-1 text-ink-3">no tags yet</div>
				) : (
					allTags.map(([t, n]) => (
						<FilterRow
							key={t}
							label={t}
							count={n}
							active={activeTag === t}
							onClick={() => onTagChange(activeTag === t ? undefined : t)}
						/>
					))
				)}
			</Section>

			{pinned.length > 0 ? (
				<Section title="pinned">
					{pinned.map((p) => (
						<div key={p.id} className="truncate py-0.5 text-2xs text-ink-2">
							<Star className="mr-1 inline h-2.5 w-2.5 text-accent" />
							{p.title}
						</div>
					))}
				</Section>
			) : null}

			{recent.length > 0 ? (
				<Section title="recently used">
					{recent.map((p) => (
						<div key={p.id} className="truncate py-0.5 text-2xs text-ink-2">
							{p.title}
						</div>
					))}
				</Section>
			) : null}

			<Section title="starters">
				{SUGGESTED_TEMPLATES.map((tpl) => (
					<button
						key={tpl.title}
						type="button"
						className="block w-full rounded px-1 py-1 text-left text-2xs text-ink-2 hover:bg-paper-3"
						onClick={() => onSeed(tpl)}
					>
						+ {tpl.title}
					</button>
				))}
			</Section>
		</div>
	);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="mt-3 border-t border-line pt-2 first:mt-3 first:border-t-0 first:pt-0">
			<div className="px-1 pb-1 uppercase tracking-meta text-2xs text-ink-3">{title}</div>
			{children}
		</div>
	);
}

function FilterRow({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count?: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			className={cn(
				"flex w-full items-center justify-between rounded px-1 py-0.5 text-left text-2xs",
				active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
			)}
			onClick={onClick}
		>
			<span className="truncate">{label}</span>
			{typeof count === "number" ? <span className="text-ink-3">×{count}</span> : null}
		</button>
	);
}