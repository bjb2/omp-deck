import { useEffect, useRef, useState } from "react";
import type { ContextUsage } from "@omp-deck/protocol";
import { api } from "@/lib/api";
import { RichEditor } from "@/components/RichEditor";
import { cn } from "@/lib/utils";

interface Props {
	sessionId: string;
	usage: ContextUsage | undefined;
}

/**
 * Compact button that lives in the chat header showing current context-window
 * utilization (e.g. `42% · 96.0K`). Clicking opens a popover with a one-shot
 * `Compact now` action and an optional focus instruction.
 *
 * Renders nothing when `usage` is undefined — happens for models that don't
 * declare a context window, and for sessions before their first assistant
 * response. After a compaction, the SDK reports `tokens: null` until the next
 * turn supplies fresh usage; we render a `—%` affordance in that window
 * rather than misleading the user with a 0%.
 */
export function ContextIndicator({ sessionId, usage }: Props) {
	const [open, setOpen] = useState(false);
	const [focus, setFocus] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const popoverRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function onDocClick(e: MouseEvent): void {
			if (!popoverRef.current) return;
			if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
		}
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);

	if (!usage) return null;

	const percent = usage.percent;
	const tokens = usage.tokens;
	const known = percent !== null && tokens !== null;
	// Color thresholds match the task spec: <70% muted, 70-90% warn, >90% danger.
	const tone: "muted" | "warn" | "danger" = !known
		? "muted"
		: percent >= 90
			? "danger"
			: percent >= 70
				? "warn"
				: "muted";

	async function runCompact(): Promise<void> {
		setSubmitting(true);
		setError(undefined);
		try {
			await api.compactSession(sessionId, focus.trim() || undefined);
			setOpen(false);
			setFocus("");
		} catch (e) {
			setError(String(e));
		} finally {
			setSubmitting(false);
		}
	}

	const barColor = tone === "danger" ? "bg-danger" : tone === "warn" ? "bg-warn" : "bg-ink-3";
	const textColor =
		tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-ink-3";
	const fillPct = known ? Math.min(100, Math.max(0, percent)) : 0;

	return (
		<div className="relative" ref={popoverRef}>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				title={
					known
						? `Context window: ${formatTokens(tokens)} / ${formatTokens(usage.contextWindow)} tokens (${percent.toFixed(1)}%)`
						: "Context usage calculating — next turn will refresh"
				}
				className={cn(
					"flex h-7 shrink-0 items-center gap-1.5 rounded px-1.5 text-2xs font-mono",
					"hover:bg-paper-3 transition-colors",
				)}
			>
				<span
					className="h-1.5 w-10 overflow-hidden rounded-full bg-paper-3"
					aria-hidden="true"
				>
					<span
						className={cn("block h-full transition-all", barColor)}
						style={{ width: `${fillPct}%` }}
					/>
				</span>
				<span className={cn(textColor, "tabular-nums")}>
					{known ? `${Math.round(percent)}%` : "—%"}
				</span>
				<span className="text-ink-4">·</span>
				<span className="text-ink-3 tabular-nums">
					{known ? `${formatTokens(tokens)} TOK` : ""}
				</span>
			</button>

			{open ? (
				<div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-line bg-paper-2 p-3 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]">
					<div className="meta mb-1">Context window</div>
					<div className="mb-2 font-mono text-xs text-ink-2 tabular-nums">
						{known
							? `${formatTokens(tokens)} of ${formatTokens(usage.contextWindow)} tokens — ${percent.toFixed(1)}%`
							: `${formatTokens(usage.contextWindow)} window · usage refreshes after next turn`}
					</div>
					<label className="meta mb-1 block">Focus (optional)</label>
					<RichEditor
						value={focus}
						onChange={(v) => setFocus(v)}
						placeholder="e.g. keep details of the deck routes-fs.ts work"
						rows={2}
						disableRichText
						className={cn(
							"field w-full resize-none font-mono text-xs",
							"placeholder:text-ink-4",
						)}
					/>
					<div className="mt-1 font-mono text-2xs text-ink-3">
						The agent will preserve anything you describe here while compacting the rest.
					</div>
					{error ? (
						<div className="mt-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 font-mono text-2xs text-danger">
							{error}
						</div>
					) : null}
					<div className="mt-3 flex items-center justify-end gap-2">
						<button
							type="button"
							onClick={() => setOpen(false)}
							className="btn-ghost h-7 px-2 text-xs"
							disabled={submitting}
						>
							Cancel
						</button>
						<button
							type="button"
							onClick={() => void runCompact()}
							className="btn-primary h-7 px-3 text-xs"
							disabled={submitting}
						>
							{submitting ? "Compacting…" : "Compact now"}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}
