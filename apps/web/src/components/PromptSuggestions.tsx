import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import type { PromptRecommendation } from "@omp-deck/protocol";

import { promptsApi } from "@/lib/prompts-api";
import { cn } from "@/lib/utils";

interface Props {
	/** Active session cwd — surfaced as the project-signal source. */
	cwd?: string;
	/** Composer is currently focused / idle / empty (this is the gate). */
	visible: boolean;
	/** User-typed query — flows into the recommendation as `historyTerms`. */
	query: string;
	/** Click handler — receives the chosen recommendation. */
	onPick: (rec: PromptRecommendation) => void;
	onDismiss: () => void;
}

/**
 * Lazy suggestion panel — only fetches when `visible` flips true and the
 * composer has been idle for ≥ 5 seconds (the parent gates on `visible`).
 *
 * Fetches the top 5 from `/api/prompts/recommend`. The user's current
 * `query` text is layered in as `historyTerms` so partially-typed prompts
 * surface stronger matches.
 *
 * #ponytail: 60s polling on visible+empty. No debounced typing — the user
 * typing means the panel hides, so this never runs more than once per
 * idle window.
 */
export function PromptSuggestions({ cwd, visible, query, onPick, onDismiss }: Props) {
	const [recs, setRecs] = useState<PromptRecommendation[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const abortRef = useRef<AbortController | null>(null);

	const refresh = useCallback(async () => {
		abortRef.current?.abort();
		const ctrl = new AbortController();
		abortRef.current = ctrl;
		setLoading(true);
		setError(undefined);
		try {
			const resp = await promptsApi.recommend({
				limit: 5,
				historyTerms: query
					.split(/\s+/)
					.map((t) => t.trim())
					.filter((t) => t.length > 0)
					.slice(0, 20),
			});
			if (ctrl.signal.aborted) return;
			setRecs(resp.recommendations);
		} catch (err) {
			if (ctrl.signal.aborted) return;
			setError(String((err as Error).message ?? err));
		} finally {
			if (!ctrl.signal.aborted) setLoading(false);
		}
	}, [query]);

	useEffect(() => {
		if (!visible) return;
		void refresh();
		// Light polling: every 60s while the panel stays open. The composer
		// closes this panel on input, so the timer effectively refreshes
		// the recency ordering for a user who idles with the panel up.
		const t = window.setInterval(() => void refresh(), 60_000);
		return () => window.clearInterval(t);
	}, [visible, refresh]);

	if (!visible) return null;
	if (loading && recs.length === 0) {
		return (
			<SuggestionPanel onDismiss={onDismiss}>
				<div className="flex items-center gap-2 px-3 py-2 font-mono text-2xs text-ink-3">
					<Loader2 className="h-3 w-3 animate-spin" />
					loading suggestions
				</div>
			</SuggestionPanel>
		);
	}
	if (error) {
		return (
			<SuggestionPanel onDismiss={onDismiss}>
				<div className="px-3 py-2 font-mono text-2xs text-danger">{error}</div>
			</SuggestionPanel>
		);
	}
	if (recs.length === 0) {
		return (
			<SuggestionPanel onDismiss={onDismiss}>
				<div className="px-3 py-2 font-mono text-2xs text-ink-3">
					no suggestions — save your first prompt in /prompts/library
				</div>
			</SuggestionPanel>
		);
	}
	return (
		<SuggestionPanel onDismiss={onDismiss}>
			<div className="border-b border-line px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<Sparkles className="mr-1 inline h-3 w-3" />
				prompt suggestions · {cwd ? `cwd=${shorten(cwd)}` : "no project"}
			</div>
			{recs.map((r) => (
				<button
					key={r.prompt.id}
					type="button"
					className={cn(
						"block w-full border-b border-line/50 px-3 py-2 text-left",
						"hover:bg-paper-3 focus:bg-paper-3 focus:outline-none",
					)}
					onClick={() => onPick(r)}
				>
					<div className="flex items-center justify-between gap-2">
						<span className="truncate text-sm font-medium text-ink">{r.prompt.title}</span>
						<span className="shrink-0 font-mono text-2xs text-ink-3">
							{(r.score * 100).toFixed(0)}%
						</span>
					</div>
					{r.prompt.variables.length > 0 ? (
						<div className="mt-0.5 font-mono text-2xs text-ink-3">
							{r.prompt.variables.map((v) => `{{${v}}}`).join(" ")}
						</div>
					) : null}
					<div className="mt-0.5 text-2xs text-ink-3">{r.why}</div>
				</button>
			))}
		</SuggestionPanel>
	);
}

function SuggestionPanel({
	onDismiss,
	children,
}: {
	onDismiss: () => void;
	children: React.ReactNode;
}) {
	return (
		<div
			className={cn(
				"absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-lg border border-line bg-paper",
				"shadow-lg backdrop-blur",
			)}
			style={{ maxHeight: 280 }}
		>
			<button
				type="button"
				onClick={onDismiss}
				className="absolute right-1 top-1 z-10 rounded p-1 text-ink-3 hover:bg-paper-3 hover:text-ink"
				aria-label="Dismiss suggestions"
				title="Dismiss"
			>
				<X className="h-3 w-3" />
			</button>
			<div className="max-h-[280px] overflow-y-auto">{children}</div>
		</div>
	);
}

function shorten(s: string): string {
	if (s.length <= 32) return s;
	return `…${s.slice(-30)}`;
}