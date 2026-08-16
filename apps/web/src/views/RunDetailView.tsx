import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { ArrowLeft, Play, RefreshCcw, X } from "lucide-react";
import type { Routine, RoutineRun, RoutineStepRun, RoutineStepStatus } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { routinesApi } from "@/lib/routines-api";
import { cn, formatDurationMs } from "@/lib/utils";

/**
 * /routines/:id/runs/:runId — detailed view of a single routine run.
 *
 * Polls every 1.5s while the run is in flight; switches to no-poll once
 * `endedAt` is populated. WS-based live updates would be cheaper but the
 * polling path is robust and ships today.
 */
export function RunDetailView() {
	const { id, runId } = useParams<{ id: string; runId: string }>();
	const [routine, setRoutine] = useState<Routine | null>(null);
	const [run, setRun] = useState<RoutineRun | null>(null);
	const [steps, setSteps] = useState<RoutineStepRun[]>([]);
	const [err, setErr] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);

	// T-72: deep-link target. The inspector links to
	// `/routines/:id/runs/:runId#step-<stepId>` so a node-click in canvas mode
	// jumps straight to the matching step card. Re-read whenever `location.hash`
	// changes so back/forward + manual hash edits keep working.
	const location = useLocation();
	const targetStepId = location.hash.startsWith("#step-")
		? decodeURIComponent(location.hash.slice("#step-".length))
		: null;

	const refresh = useCallback(async () => {
		if (!id || !runId) return;
		setRefreshing(true);
		try {
			const [routineRes, runs, stepsRes] = await Promise.all([
				routinesApi.get(id),
				routinesApi.runs(id, 50),
				routinesApi.steps(id, runId),
			]);
			setRoutine(routineRes);
			const matching = runs.runs.find((r) => r.id === runId) ?? null;
			setRun(matching);
			setSteps(stepsRes.steps);
			setErr(undefined);
		} catch (e) {
			setErr(String(e));
		} finally {
			setRefreshing(false);
		}
	}, [id, runId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Live updates: poll while the run hasn't ended.
	useEffect(() => {
		if (!run) return;
		if (run.endedAt) return;
		const handle = setInterval(() => void refresh(), 1500);
		return () => clearInterval(handle);
	}, [run, refresh]);

	if (!id || !runId) return <div className="p-6 text-ink-3">Missing id/runId.</div>;

	const status: RoutineStepStatus | "running" = !run
		? "pending"
		: !run.endedAt
			? "running"
			: run.abortReason
				? "aborted"
				: run.exitCode === 0
					? "success"
					: "failed";

	const totalCostUsd = run ? run.totalLlmCostMicros / 1_000_000 : 0;
	const totalDurationMs =
		run?.startedAt && run.endedAt
			? new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime()
			: null;

	const budgetMaxUsd = routine?.budget?.max_llm_cost_usd;
	const hasBudget = typeof budgetMaxUsd === "number" && Number.isFinite(budgetMaxUsd) && budgetMaxUsd > 0;
	const budgetUsedUsd = totalCostUsd;
	const budgetRatio = hasBudget && budgetMaxUsd ? budgetUsedUsd / budgetMaxUsd : 0;
	const budgetPct = Math.min(999, Math.round(budgetRatio * 100));
	const budgetBarColor =
	budgetRatio >= 1 ? "bg-danger" : budgetRatio >= 0.8 ? "bg-warn" : "bg-accent";

	async function replay(): Promise<void> {
		if (!id) return;
		try {
			await routinesApi.runNow(id);
		} catch (e) {
			setErr(String(e));
		}
	}

	return (
		<Layout
			sidebar={
				<div className="flex h-full min-h-0 flex-col p-3">
					<Link to="/routines" className="meta mb-2 flex items-center gap-1 text-ink-3 hover:text-ink">
						<ArrowLeft className="h-3 w-3" />
						Back to routines
					</Link>
					<div className="meta">Routine</div>
					<div className="mt-1 truncate text-sm font-medium text-ink">{routine?.name ?? "…"}</div>
					{routine ? (
						<div className="mt-0.5 font-mono text-2xs text-ink-3">
							v{routine.specVersion} · {routine.concurrency}
						</div>
					) : null}
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Run</div>
						<div className="truncate font-mono text-xs text-ink-3">{runId}</div>
						<StatusPill status={status} />
						<button
							type="button"
							onClick={() => void refresh()}
							disabled={refreshing}
							className="btn-ghost ml-auto h-7 px-2 text-xs"
							title="Refresh"
						>
							<RefreshCcw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
						</button>
						<button
							type="button"
							onClick={() => void replay()}
							className="btn-primary h-7 px-2 text-xs"
							title="Re-run this routine"
						>
							<Play className="h-3.5 w-3.5" />
							Re-run
						</button>
					</div>

					{err ? (
						<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-2xs text-danger">
							{err}
						</div>
					) : null}

					<div className="grid grid-cols-2 gap-3 border-b border-line px-3 py-2 text-xs md:grid-cols-4">
						<MetaCell label="trigger" value={run?.trigger ?? "—"} />
						<MetaCell
							label="duration"
							value={totalDurationMs !== null ? formatDurationMs(totalDurationMs) : "—"}
						/>
						<MetaCell label="steps" value={run ? `${run.stepCountTotal} (${run.stepCountFailed} failed)` : "—"} />
						<MetaCell label="cost (est)" value={`$${totalCostUsd.toFixed(4)} · ${run?.totalLlmTokens ?? 0}tok`} />
					</div>

					{hasBudget ? (
						<div className="border-b border-line px-3 py-2">
							<div className="mb-1 flex items-center justify-between font-mono text-2xs text-ink-3">
								<span className="uppercase tracking-meta">budget</span>
								<span>
									${budgetUsedUsd.toFixed(4)} / ${(budgetMaxUsd ?? 0).toFixed(2)} · {budgetPct}%
								</span>
							</div>
							<div className="h-1.5 w-full overflow-hidden rounded bg-paper-3">
								<div
									className={cn("h-full transition-all", budgetBarColor)}
									style={{ width: `${Math.min(100, budgetPct)}%` }}
								/>
							</div>
						</div>
					) : null}

					<div className="flex-1 overflow-y-auto px-3 py-3">
						{steps.length === 0 ? (
							<div className="text-sm text-ink-3">
								{status === "running" ? "Waiting for first step…" : "No step records."}
							</div>
						) : (
							<ul className="space-y-2">
								{steps.map((s) => (
									<StepCard
										key={s.id}
										step={s}
										autoExpand={targetStepId === s.stepId}
									/>
								))}
							</ul>
						)}
					</div>
				</div>
			}
			inspector={null}
			topBar={null}
		/>
	);
}

function StatusPill({ status }: { status: RoutineStepStatus | "running" }) {
	const cls =
		status === "success"
			? "bg-success/10 text-success border-success/30"
			: status === "failed"
				? "bg-danger/10 text-danger border-danger/40"
				: status === "aborted"
					? "bg-warn/10 text-warn border-warn/40"
					: status === "running"
						? "bg-accent/10 text-accent border-accent/40"
						: "bg-paper-3 text-ink-3 border-line";
	return (
		<span className={cn("rounded border px-2 py-0.5 font-mono text-2xs uppercase tracking-meta", cls)}>
			{status}
		</span>
	);
}

function MetaCell({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="meta">{label}</div>
			<div className="mt-0.5 font-mono text-xs text-ink-2">{value}</div>
		</div>
	);
}

function StepCard({
	step,
	autoExpand,
}: {
	step: RoutineStepRun;
	autoExpand?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const dur =
		step.durationMs !== undefined && step.durationMs !== null
			? formatDurationMs(step.durationMs)
			: "—";
	// T-72: a deep-link arrival expands the card and scrolls it into view.
	// Tracked by `autoExpand` so the user can still collapse it after scroll.
	const rootRef = useRef<HTMLLIElement | null>(null);
	const expandedFromHashRef = useRef(false);
	useEffect(() => {
		if (!autoExpand) return;
		if (!expandedFromHashRef.current) {
			setOpen(true);
			expandedFromHashRef.current = true;
		}
		// Wait a tick for the layout to settle (parent list height grows when
		// the card opens) before scrolling.
		const handle = requestAnimationFrame(() => {
			rootRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
		return () => cancelAnimationFrame(handle);
	}, [autoExpand]);
	return (
		<li
			ref={rootRef}
			id={`step-${step.stepId}`}
			className="rounded border border-line bg-paper-2"
		>
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-paper-3"
			>
				<span className="meta w-6 shrink-0 text-right text-ink-3">{step.stepIndex}</span>
				<span
					className={cn(
						"h-2 w-2 shrink-0 rounded-full",
						step.status === "success"
							? "bg-success"
							: step.status === "failed"
								? "bg-danger"
								: step.status === "aborted"
									? "bg-warn"
									: step.status === "skipped"
										? "bg-line-strong"
										: "bg-accent animate-pulse",
					)}
				/>
				<span className="truncate text-sm font-medium text-ink">{step.stepId}</span>
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">{step.stepType}</span>
				<span className="ml-auto font-mono text-2xs text-ink-3">{dur}</span>
				{step.model ? (
					<span className="font-mono text-2xs text-ink-3">{step.model}</span>
				) : null}
				{step.llmTokensIn != null ? (
					<span className="font-mono text-2xs text-ink-3">
						{(step.llmTokensIn ?? 0) + (step.llmTokensOut ?? 0)}tok
					</span>
				) : null}
			</button>
			{open ? (
				<div className="border-t border-line px-3 py-2 space-y-2">
					{step.error ? (
						<div>
							<div className="meta mb-0.5 text-danger">error</div>
							<pre className="paper-code overflow-x-auto text-2xs">{step.error}</pre>
						</div>
					) : null}
					{step.outputJson ? (
						<div>
							<div className="meta mb-0.5">output (json)</div>
							<pre className="paper-code max-h-[300px] overflow-auto text-2xs">{prettyJson(step.outputJson)}</pre>
						</div>
					) : null}
					{step.stdoutExcerpt ? (
						<div>
							<div className="meta mb-0.5">stdout</div>
							<pre className="paper-code max-h-[300px] overflow-auto whitespace-pre-wrap text-2xs">
								{step.stdoutExcerpt}
							</pre>
						</div>
					) : null}
					{step.stderrExcerpt ? (
						<div>
							<div className="meta mb-0.5 text-warn">stderr</div>
							<pre className="paper-code max-h-[200px] overflow-auto whitespace-pre-wrap text-2xs">
								{step.stderrExcerpt}
							</pre>
						</div>
					) : null}
				</div>
			) : null}
		</li>
	);
}

function prettyJson(raw: string): string {
	try {
		return JSON.stringify(JSON.parse(raw), null, 2);
	} catch {
		return raw;
	}
}

export function NotFoundRun() {
	return (
		<div className="flex h-full items-center justify-center text-ink-3">
			<X className="mr-2 h-4 w-4" /> Run not found.
		</div>
	);
}
