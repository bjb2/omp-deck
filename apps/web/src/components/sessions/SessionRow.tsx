import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, MoreHorizontal, RefreshCw, Trash2, ArchiveRestore } from "lucide-react";

import { Badge } from "@/components/ui/Badge";
import type {
	SessionImportance,
	SessionStatus,
	SessionSummary,
	SessionUrgency,
} from "@omp-deck/protocol";
import { cn, shortPath } from "@/lib/utils";

export interface SessionRowProps {
	summary?: SessionSummary;
	title?: string;
	subtitle?: string;
	live?: boolean;
	planMode?: boolean;
	updatedAt?: string;
	active?: boolean;
	onClick?: () => void;
	sessionId?: string;
	onArchive?: (id: string) => void;
	onUnarchive?: (id: string) => void;
	onRegenerate?: (id: string) => void;
	onSetUrgency?: (id: string, urgency: SessionUrgency) => void;
	onSetImportance?: (id: string, importance: SessionImportance) => void;
	onDelete?: (id: string) => void;
}

const ROW_VALUES = ["low", "normal", "high", "critical"] as const;

export function urgencyRank(u: SessionUrgency | undefined): number {
	return u === "critical" ? 4 : u === "high" ? 3 : u === "normal" ? 2 : u === "low" ? 1 : 0;
}

export function formatSessionId(id: string): string {
	return id.length <= 8 ? id : `${id.slice(0, 4)}…${id.slice(-4)}`;
}

const RELATIVE_THRESHOLDS: Array<[number, string]> = [
	[60_000, "just now"],
	[3_600_000, "m"],
	[86_400_000, "h"],
	[2_592_000_000, "d"],
];

export function formatRelative(ts: string | undefined): string {
	if (!ts) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return ts;
	const diff = Date.now() - d.getTime();
	if (diff < 0) return d.toLocaleDateString();
	const first = RELATIVE_THRESHOLDS[0];
	if (!first || diff < first[0]) return "just now";
	for (let i = 1; i < RELATIVE_THRESHOLDS.length; i++) {
		const cur = RELATIVE_THRESHOLDS[i];
		const prev = RELATIVE_THRESHOLDS[i - 1];
		if (!cur || !prev) continue;
		if (diff < cur[0]) return `${Math.floor(diff / prev[0])}${cur[1]} ago`;
	}
	return d.toLocaleDateString();
}

export function SessionRow(props: SessionRowProps) {
	const {
		summary,
		title,
		subtitle,
		live,
		planMode,
		updatedAt,
		active,
		onClick,
		sessionId,
		onArchive,
		onUnarchive,
		onRegenerate,
		onSetUrgency,
		onSetImportance,
		onDelete,
	} = props;

	const resolvedTitle =
		title ?? summary?.title ?? (summary?.id ? formatSessionId(summary.id) : "Untitled");
	const tags = summary?.aiTags?.slice(0, 3) ?? [];
	const urgency = summary?.urgency;
	const importance = summary?.importance;
	const status: SessionStatus = summary?.status ?? (summary?.archived ? "archived" : "active");
	const repoId = summary?.repoId;
	const id = sessionId ?? summary?.id;
	const showMenu = !!(id && (onArchive || onUnarchive || onRegenerate || onSetUrgency || onSetImportance || onDelete));
	const subtitleFull = subtitle ?? (summary?.cwd ? shortPath(summary.cwd, 30) : "");
	const statusTone =
		status === "active" ? "text-success" :
		status === "error" ? "text-danger" :
		status === "archived" ? "text-ink-4" : "text-ink-3";
	const statusDot =
		status === "active" ? "bg-success" :
		status === "error" ? "bg-danger" :
		status === "archived" ? "bg-ink-4" : "bg-ink-3";

	return (
		<div
			className={cn(
				"group relative flex w-full items-start gap-1 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors",
				active ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3/60",
			)}
		>
			<button
				type="button"
				onClick={onClick}
				className="min-w-0 flex-1 text-left"
				aria-label={resolvedTitle}
			>
				<div className="flex items-center gap-1.5">
					{live ? (
						<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-label="live" />
					) : (
						<span className="h-1.5 w-1.5 shrink-0 rounded-full bg-line-strong" />
					)}
					<span className="truncate font-medium">{resolvedTitle}</span>
					{planMode ? (
						<span
							className="ml-auto shrink-0 rounded border border-thinking/40 bg-thinking/10 px-1 py-px font-mono text-[10px] uppercase tracking-meta text-thinking"
							title="Plan mode active"
						>
							plan
						</span>
					) : null}
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-1 pl-3">
					<span className={cn("font-mono text-2xs uppercase tracking-meta", statusTone)}>
						<span className={cn("mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle", statusDot)} />
						{status}
					</span>
					{urgency && urgency !== "normal" ? (
						<Badge
							tone={urgency === "critical" ? "danger" : urgency === "high" ? "warn" : "muted"}
							className="capitalize"
						>
							{urgency}
						</Badge>
					) : null}
					{importance && importance !== "normal" ? (
						<Badge tone="muted" className="capitalize">{importance}</Badge>
					) : null}
					{tags.map((t) => (
						<Badge key={t} tone="default" className="normal-case">{t}</Badge>
					))}
				</div>
				{subtitleFull || repoId ? (
					<div className="mt-0.5 truncate pl-3 font-mono text-2xs text-ink-3">
						{subtitleFull}
						{repoId ? (subtitleFull ? " · " : "") + repoId : ""}
					</div>
				) : null}
			</button>
			<div className="flex shrink-0 flex-col items-end gap-1 pl-1">
				{updatedAt ? (
					<span className="font-mono text-2xs text-ink-4">{formatRelative(updatedAt)}</span>
				) : null}
				{showMenu && id ? (
					<RowMenu
						sessionId={id}
						urgency={urgency}
						importance={importance}
						archived={summary?.archived ?? status === "archived"}
						onArchive={onArchive}
						onUnarchive={onUnarchive}
						onRegenerate={onRegenerate}
						onSetUrgency={onSetUrgency}
						onSetImportance={onSetImportance}
						onDelete={onDelete}
					/>
				) : null}
			</div>
		</div>
	);
}

interface RowMenuProps {
	sessionId: string;
	urgency?: SessionUrgency;
	importance?: SessionImportance;
	archived?: boolean;
	onArchive?: (id: string) => void;
	onUnarchive?: (id: string) => void;
	onRegenerate?: (id: string) => void;
	onSetUrgency?: (id: string, urgency: SessionUrgency) => void;
	onSetImportance?: (id: string, importance: SessionImportance) => void;
	onDelete?: (id: string) => void;
}

function RowMenu({
	sessionId,
	urgency,
	importance,
	archived,
	onArchive,
	onUnarchive,
	onRegenerate,
	onSetUrgency,
	onSetImportance,
	onDelete,
}: RowMenuProps) {
	const [open, setOpen] = useState(false);
	const [submenu, setSubmenu] = useState<"urgency" | "importance" | null>(null);
	const wrapRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		function onDown(e: MouseEvent): void {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") setOpen(false);
		}
		window.addEventListener("mousedown", onDown);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("mousedown", onDown);
			window.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function close(): void {
		setOpen(false);
		setSubmenu(null);
	}

	return (
		<div ref={wrapRef} className="relative" onClick={(e) => e.stopPropagation()}>
			<button
				type="button"
				aria-label="Session actions"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"inline-flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-paper-3 hover:text-ink",
					open ? "bg-paper-3 text-ink" : "opacity-0 group-hover:opacity-100 focus:opacity-100",
				)}
			>
				<MoreHorizontal className="h-3.5 w-3.5" />
			</button>
			{open ? (
				<div
					role="menu"
					className="absolute right-0 top-7 z-30 min-w-[180px] overflow-hidden rounded-md border border-line bg-paper text-[12px] shadow-[0_12px_32px_-12px_rgba(26,24,20,0.35)]"
				>
					<MenuBtn
						icon={<RefreshCw className="h-3 w-3" />}
						label="Regenerate AI summary"
						disabled={!onRegenerate}
						onClick={() => {
							onRegenerate?.(sessionId);
							close();
						}}
					/>
					<div className="border-t border-line" />
					<SubTrigger
						label="Urgency"
						current={urgency}
						open={submenu === "urgency"}
						onToggle={() => setSubmenu(submenu === "urgency" ? null : "urgency")}
					/>
					{submenu === "urgency" ? (
						<ValueList
							current={urgency}
							values={ROW_VALUES}
							onPick={(v) => {
								onSetUrgency?.(sessionId, v as SessionUrgency);
								close();
							}}
						/>
					) : null}
					<SubTrigger
						label="Importance"
						current={importance}
						open={submenu === "importance"}
						onToggle={() => setSubmenu(submenu === "importance" ? null : "importance")}
					/>
					{submenu === "importance" ? (
						<ValueList
							current={importance}
							values={ROW_VALUES}
							onPick={(v) => {
								onSetImportance?.(sessionId, v as SessionImportance);
								close();
							}}
						/>
					) : null}
					<div className="border-t border-line" />
					<MenuBtn
						icon={<Archive className="h-3 w-3" />}
						label={archived ? "Archive (already)" : "Archive"}
						disabled={archived || !onArchive}
						onClick={() => {
							onArchive?.(sessionId);
							close();
						}}
					/>
					{onUnarchive ? (
						<MenuBtn
							icon={<ArchiveRestore className="h-3 w-3" />}
							label="Unarchive"
							disabled={!archived}
							onClick={() => {
								onUnarchive(sessionId);
								close();
							}}
						/>
					) : null}
					{onDelete ? (
						<>
							<div className="border-t border-line" />
							<MenuBtn
								icon={<Trash2 className="h-3 w-3" />}
								label="Delete session"
								danger
								onClick={() => {
									const ok = window.confirm(
										`Delete this session? This removes it from the sidebar AND its persisted record. The transcript cannot be recovered.`,
									);
									if (!ok) return;
									onDelete(sessionId);
									close();
								}}
							/>
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function MenuBtn({
	icon,
	label,
	onClick,
	disabled,
	danger,
}: {
	icon: React.ReactNode;
	label: string;
	onClick: () => void;
	disabled?: boolean;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-paper-3",
				disabled
					? "cursor-not-allowed text-ink-4"
					: danger
						? "text-danger hover:bg-danger/10"
						: "text-ink-2",
			)}
		>
			<span className="text-ink-3">{icon}</span>
			<span>{label}</span>
		</button>
	);
}

function SubTrigger({
	label,
	current,
	open,
	onToggle,
}: {
	label: string;
	current?: string;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			aria-haspopup="menu"
			aria-expanded={open}
			onClick={onToggle}
			className={cn(
				"flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-paper-3",
				open ? "bg-paper-3 text-ink" : "text-ink-2",
			)}
		>
			<span className="flex items-center gap-2">
				<span>{label}</span>
				{current ? (
					<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">{current}</span>
				) : null}
			</span>
			<ChevronDown className="h-3 w-3 text-ink-3" />
		</button>
	);
}

function ValueList<T extends string>({
	current,
	values,
	onPick,
}: {
	current?: T;
	values: readonly T[];
	onPick: (v: T) => void;
}) {
	return (
		<div className="border-y border-line bg-paper-2 py-1">
			{values.map((v) => (
				<button
					key={v}
					type="button"
					role="menuitemradio"
					aria-checked={current === v}
					onClick={() => onPick(v)}
					className={cn(
						"flex w-full items-center justify-between px-3 py-1 text-left hover:bg-paper-3 capitalize",
						current === v ? "text-accent" : "text-ink-2",
					)}
				>
					<span>{v}</span>
					{current === v ? <span aria-hidden>✓</span> : null}
				</button>
			))}
		</div>
	);
}
