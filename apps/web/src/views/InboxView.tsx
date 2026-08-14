import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
	Archive,
	Check,
	Inbox as InboxIcon,
	ListPlus,
	MessageSquarePlus,
	Plus,
	RotateCcw,
	Trash2,
	X,
} from "lucide-react";
import type { InboxItem, InboxKind } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { MarkdownEdit } from "@/components/MarkdownEdit";
import { inboxApi } from "@/lib/inbox-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const KIND_ORDER: ReadonlyArray<InboxKind> = [
	"capture",
	"idea",
	"investigation",
	"decision",
	"ticket",
	"email",
];

const KIND_LABEL: Record<InboxKind, string> = {
	email: "emails",
	ticket: "tickets",
	idea: "ideas",
	decision: "decisions",
	investigation: "investigations",
	capture: "captures",
};

const KIND_TONE: Record<InboxKind, string> = {
	email: "text-ink-2",
	ticket: "text-ink-2",
	idea: "text-accent",
	decision: "text-thinking",
	investigation: "text-warn",
	capture: "text-success",
};

type Filter = InboxKind | "all";
type ReaderState =
	| { mode: "empty" }
	| { mode: "item"; item: InboxItem }
	| { mode: "compose" };

export function InboxView() {
	const setInspectorOpen = useStore((s) => s.setInspectorOpen);
	const setPendingDraft = useStore((s) => s.setPendingDraft);
	const createSession = useStore((s) => s.createSession);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const navigate = useNavigate();

	const [items, setItems] = useState<InboxItem[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [filter, setFilter] = useState<Filter>("all");
	const [includeProcessed, setIncludeProcessed] = useState(false);
	const [reader, setReader] = useState<ReaderState>({ mode: "empty" });

	// Hide the global inspector — the reader IS the second pane now.
	useEffect(() => {
		setInspectorOpen(false);
	}, [setInspectorOpen]);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const opts: { kind?: InboxKind; includeProcessed?: boolean } = { includeProcessed };
			if (filter !== "all") opts.kind = filter;
			const res = await inboxApi.list(opts);
			setItems(res.items);
			// Keep reader selection in sync — if the selected item is no longer
			// in the list (filtered out / deleted), drop back to empty.
			setReader((prev) => {
				if (prev.mode !== "item") return prev;
				const found = res.items.find((x) => x.id === prev.item.id);
				return found ? { mode: "item", item: found } : { mode: "empty" };
			});
			setError(undefined);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, [filter, includeProcessed]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const counts = useMemo(() => {
		const m: Record<string, number> = { all: items.length };
		for (const k of KIND_ORDER) m[k] = 0;
		for (const it of items) m[it.kind] = (m[it.kind] ?? 0) + 1;
		return m;
	}, [items]);

	async function toggleProcessed(it: InboxItem): Promise<void> {
		try {
			const updated = await inboxApi.update(it.id, { processed: !it.processedAt });
			setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
			if (reader.mode === "item" && reader.item.id === updated.id) {
				setReader({ mode: "item", item: updated });
			}
		} catch (e) {
			setError(String(e));
		}
	}

	async function removeItem(it: InboxItem): Promise<void> {
		if (!confirm(`Delete "${it.title}"?`)) return;
		try {
			await inboxApi.remove(it.id);
			setItems((prev) => prev.filter((x) => x.id !== it.id));
			if (reader.mode === "item" && reader.item.id === it.id) {
				setReader({ mode: "empty" });
			}
		} catch (e) {
			setError(String(e));
		}
	}

	async function patch(it: InboxItem, body: Parameters<typeof inboxApi.update>[1]): Promise<void> {
		try {
			const updated = await inboxApi.update(it.id, body);
			setItems((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
			if (reader.mode === "item" && reader.item.id === updated.id) {
				setReader({ mode: "item", item: updated });
			}
		} catch (e) {
			setError(String(e));
		}
	}

	async function openInChat(it: InboxItem): Promise<void> {
		const cwd = defaultCwd;
		try {
			await createSession({ cwd });
		} catch (e) {
			console.warn("createSession failed; using draft only", e);
		}
		const stamp = new Date(it.createdAt).toLocaleString();
		const draft = [
			`Inbox · ${it.kind} · captured ${stamp}`,
			``,
			`# ${it.title}`,
			``,
			it.body || "(no body)",
			``,
			`---`,
			`Help me act on this. If it's actionable, propose a concrete next step;`,
			`if it's a decision needing input, frame the choice; if it should become a`,
			`task, POST /api/tasks and report the new task id.`,
		].join("\n");
		setPendingDraft({ text: draft });
		navigate("/chat");
	}

	async function promoteToTask(it: InboxItem): Promise<void> {
		try {
			const { task, inbox } = await inboxApi.promote(it.id);
			// Reflect the now-processed item locally so the reader pane updates
			// without a refetch round-trip; refresh in the background so the
			// "unprocessed" filter view recomputes its counts.
			setItems((prev) => prev.map((x) => (x.id === inbox.id ? inbox : x)));
			if (reader.mode === "item" && reader.item.id === inbox.id) {
				setReader({ mode: "item", item: inbox });
			}
			// Deep-link to /tasks with the new task id so the TaskModal opens on
			// arrival. The route reads `?open=<id>` and resolves it once the list
			// has loaded.
			navigate(`/tasks?open=${encodeURIComponent(task.id)}`);
		} catch (e) {
			setError(String(e));
		}
	}

	return (
		<Layout
			sidebar={
				<InboxSidebar
					counts={counts}
					filter={filter}
					setFilter={setFilter}
					includeProcessed={includeProcessed}
					setIncludeProcessed={setIncludeProcessed}
					onCompose={() => setReader({ mode: "compose" })}
				/>
			}
			main={
				<div className="flex h-full min-h-0 flex-row">
					{/* Left pane: list. On <md the list collapses to full-width and
					    the reader/compose pane replaces it once an item is selected
					    (Gmail-mobile pattern); above md they sit side-by-side. */}
					<div
						className={cn(
							"flex flex-col border-line bg-paper",
							"w-full md:w-[360px] md:shrink-0 md:border-r",
							reader.mode === "empty" ? "flex" : "hidden md:flex",
						)}
					>
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">
								{filter === "all" ? "All inbox" : KIND_LABEL[filter]}
							</div>
							<div className="ml-auto font-mono text-2xs text-ink-3">
								{items.length}
							</div>
						</div>

						{error ? (
							<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}

						<div className="min-h-0 flex-1 overflow-y-auto">
							{loading ? (
								<EmptyHint>Loading…</EmptyHint>
							) : items.length === 0 ? (
								<EmptyHint>
									{filter === "all" ? "Inbox is empty." : `No ${KIND_LABEL[filter]}.`}
								</EmptyHint>
							) : (
								<ul className="divide-y divide-line">
									{items.map((it) => (
										<ListRow
											key={it.id}
											item={it}
											active={reader.mode === "item" && reader.item.id === it.id}
											onClick={() => setReader({ mode: "item", item: it })}
										/>
									))}
								</ul>
							)}
						</div>
					</div>

					{/* Right pane: reader / compose / empty placeholder. Hidden on <md
					    when nothing's selected so the list owns the full viewport. */}
					<div
						className={cn(
							"min-w-0 flex-1 bg-paper",
							reader.mode === "empty" ? "hidden md:block" : "block",
						)}
					>
						{reader.mode === "empty" ? (
							<EmptyReader onCompose={() => setReader({ mode: "compose" })} />
						) : reader.mode === "compose" ? (
							<ComposePane
								onClose={() => setReader({ mode: "empty" })}
								onCreated={(it) => {
									setItems((prev) => [it, ...prev]);
									setReader({ mode: "item", item: it });
								}}
							/>
						) : (
							<ReaderPane
								item={reader.item}
								onOpenInChat={() => void openInChat(reader.item)}
								onPromote={() => void promoteToTask(reader.item)}
								onProcess={() => void toggleProcessed(reader.item)}
								onDelete={() => void removeItem(reader.item)}
								onPatch={(body) => void patch(reader.item, body)}
								onClose={() => setReader({ mode: "empty" })}
							/>
						)}
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}

// ─── Sidebar ───────────────────────────────────────────────────────────────

function InboxSidebar({
	counts,
	filter,
	setFilter,
	includeProcessed,
	setIncludeProcessed,
	onCompose,
}: {
	counts: Record<string, number>;
	filter: Filter;
	setFilter: (f: Filter) => void;
	includeProcessed: boolean;
	setIncludeProcessed: (v: boolean) => void;
	onCompose: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-3">
				<button type="button" onClick={onCompose} className="btn-primary h-8 w-full text-sm">
					<Plus className="h-3.5 w-3.5" />
					Capture
				</button>
			</div>
			<div className="border-b border-line px-3 py-3">
				<div className="meta mb-1.5">Filter</div>
				<ul className="space-y-0.5">
					<KindRow
						active={filter === "all"}
						label="all"
						count={counts.all ?? 0}
						onClick={() => setFilter("all")}
					/>
					{KIND_ORDER.map((k) => (
						<KindRow
							key={k}
							active={filter === k}
							label={KIND_LABEL[k]}
							count={counts[k] ?? 0}
							onClick={() => setFilter(k)}
						/>
					))}
				</ul>
			</div>
			<div className="px-3 py-3">
				<label className="flex items-center gap-2 text-sm text-ink-2">
					<input
						type="checkbox"
						checked={includeProcessed}
						onChange={(e) => setIncludeProcessed(e.target.checked)}
					/>
					<span>Show processed</span>
				</label>
			</div>
		</div>
	);
}

function KindRow({
	active,
	label,
	count,
	onClick,
}: {
	active: boolean;
	label: string;
	count: number;
	onClick: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm",
					active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
				)}
			>
				<span>{label}</span>
				<span className="font-mono text-2xs text-ink-3">{count}</span>
			</button>
		</li>
	);
}

// ─── List row ──────────────────────────────────────────────────────────────

function ListRow({
	item,
	active,
	onClick,
}: {
	item: InboxItem;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<li>
			<button
				type="button"
				onClick={onClick}
				className={cn(
					"flex w-full items-start gap-2 px-3 py-2.5 text-left transition-colors",
					active ? "bg-paper-3" : "hover:bg-paper-3/60",
				)}
			>
				<span
					className={cn(
						"mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
						item.processedAt ? "bg-line-strong" : "bg-accent",
					)}
					aria-label={item.processedAt ? "processed" : "unprocessed"}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-baseline gap-2">
						<span
							className={cn(
								"font-mono text-2xs uppercase tracking-meta shrink-0",
								KIND_TONE[item.kind],
							)}
						>
							{item.kind}
						</span>
						<span
							className={cn(
								"truncate text-[13px] font-medium",
								item.processedAt ? "text-ink-3 line-through" : "text-ink",
							)}
						>
							{item.title}
						</span>
					</div>
					{item.body ? (
						<div className="mt-0.5 line-clamp-1 text-xs text-ink-3">
							{firstLine(item.body)}
						</div>
					) : null}
					<div className="mt-0.5 font-mono text-2xs text-ink-4">
						{formatRelative(item.createdAt)}
						{item.source ? ` · ${item.source}` : ""}
					</div>
				</div>
			</button>
		</li>
	);
}

// ─── Reader pane ───────────────────────────────────────────────────────────

function ReaderPane({
	item,
	onOpenInChat,
	onPromote,
	onProcess,
	onDelete,
	onPatch,
	onClose,
}: {
	item: InboxItem;
	onOpenInChat: () => void;
	onPromote: () => void;
	onProcess: () => void;
	onDelete: () => void;
	onPatch: (body: Parameters<typeof inboxApi.update>[1]) => void;
	onClose: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* Action bar — Gmail-style row with the primary action on the right. */}
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
				<select
					value={item.kind}
					onChange={(e) => onPatch({ kind: e.target.value as InboxKind })}
					className="field h-7 min-w-0 max-w-[8rem] flex-shrink px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{KIND_ORDER.map((k) => (
						<option key={k} value={k}>
							{KIND_LABEL[k]}
						</option>
					))}
				</select>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<IconAction
						label={item.processedAt ? "Mark unprocessed" : "Mark processed"}
						onClick={onProcess}
						icon={item.processedAt ? RotateCcw : Archive}
					/>
					<IconAction label="Delete" onClick={onDelete} icon={Trash2} tone="danger" />
					<IconAction
						label="Promote to task"
						onClick={onPromote}
						icon={ListPlus}
						tone="accent"
					/>
					<button
						type="button"
						onClick={onOpenInChat}
						className="btn-primary h-8 shrink-0 gap-1.5 whitespace-nowrap px-2.5 text-sm"
						title="Open this item as a new chat session"
					>
						<MessageSquarePlus className="h-4 w-4 shrink-0" />
						<span>Open in chat</span>
					</button>
					<IconAction label="Close" onClick={onClose} icon={X} />
				</div>
			</div>

			{/* Title — large, editable inline */}
			<div className="border-b border-line px-6 pt-5 pb-3">
				<input
					value={item.title}
					onChange={(e) => onPatch({ title: e.target.value })}
					className="w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none"
					placeholder="Untitled"
				/>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{new Date(item.createdAt).toLocaleString()}
					{item.source ? ` · source: ${item.source}` : ""}
					{item.processedAt
						? ` · processed ${new Date(item.processedAt).toLocaleString()}`
						: ""}
				</div>
			</div>

			{/* Body — rendered markdown, click to edit */}
			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<MarkdownEdit
					value={item.body}
					onChange={(next) => onPatch({ body: next })}
					placeholder="Click to add notes…"
				/>
			</div>
		</div>
	);
}

function IconAction({
	label,
	onClick,
	icon: Icon,
	tone = "default",
}: {
	label: string;
	onClick: () => void;
	icon: typeof Trash2;
	tone?: "default" | "danger" | "accent";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-label={label}
			title={label}
			className={cn(
				"flex h-8 w-8 items-center justify-center rounded-md transition-colors",
				tone === "danger" && "text-ink-3 hover:bg-danger/10 hover:text-danger",
				tone === "accent" && "text-accent hover:bg-accent-soft/60 hover:text-accent",
				tone === "default" && "text-ink-3 hover:bg-paper-3 hover:text-ink",
			)}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}

// ─── Compose pane ──────────────────────────────────────────────────────────

function ComposePane({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: (item: InboxItem) => void;
}) {
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");
	const [kind, setKind] = useState<InboxKind>("capture");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | undefined>();

	async function submit(): Promise<void> {
		const t = title.trim();
		if (!t) return;
		setBusy(true);
		setErr(undefined);
		try {
			const created = await inboxApi.create({ kind, title: t, body });
			onCreated(created);
		} catch (e) {
			setErr(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-paper px-4">
				<select
					value={kind}
					onChange={(e) => setKind(e.target.value as InboxKind)}
					className="field h-7 px-2 font-mono text-2xs uppercase tracking-meta"
				>
					{KIND_ORDER.map((k) => (
						<option key={k} value={k}>
							{KIND_LABEL[k]}
						</option>
					))}
				</select>
				<div className="ml-auto flex items-center gap-1.5">
					<button type="button" onClick={onClose} className="btn-ghost h-8 px-3 text-sm">
						Cancel
					</button>
					<button
						type="button"
						onClick={() => void submit()}
						disabled={busy || !title.trim()}
						className="btn-primary h-8 px-3 text-sm"
					>
						<Check className="h-4 w-4" />
						Capture
					</button>
				</div>
			</div>

			<div className="border-b border-line px-6 pt-5 pb-3">
				<input
					autoFocus
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void submit();
					}}
					placeholder="Title — short summary of the thought"
					className="w-full bg-transparent text-xl font-semibold text-ink placeholder:text-ink-4 focus:outline-none"
				/>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					⌘+enter to save · esc to cancel
				</div>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
				<MarkdownEdit
					value={body}
					onChange={setBody}
					autoEdit
					placeholder="Body — details, context, links… (markdown supported)"
				/>
			</div>

			{err ? (
				<div className="border-t border-line bg-danger/10 px-4 py-1.5 text-xs text-danger">
					{err}
				</div>
			) : null}
		</div>
	);
}

// ─── Empty states ──────────────────────────────────────────────────────────

function EmptyReader({ onCompose }: { onCompose: () => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
			<InboxIcon className="h-8 w-8 text-ink-4" />
			<div className="text-sm text-ink-3">Pick an item to read, or capture a new one.</div>
			<button type="button" onClick={onCompose} className="btn-primary h-8 px-3 text-sm">
				<Plus className="h-3.5 w-3.5" />
				Capture
			</button>
		</div>
	);
}

function EmptyHint({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex h-full items-center justify-center px-6 py-8 text-center font-mono text-2xs text-ink-3">
			{children}
		</div>
	);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function firstLine(body: string): string {
	const line = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
	return line.replace(/^[#>*\-\s]+/, "").slice(0, 140);
}

function formatRelative(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const diff = Date.now() - d.getTime();
	if (diff < 60_000) return "just now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d`;
	return d.toLocaleDateString();
}
