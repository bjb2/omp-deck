import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Clock, Plus, Power, Zap } from "lucide-react";
import type { Routine } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { EditorInspector } from "@/components/routines/EditorInspector";
import { RoutineEditorPage } from "@/components/routines/RoutineEditorPage";
import { routinesApi, type RoutineMetrics, type TemplateSummary } from "@/lib/routines-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

export function RoutinesView() {
	const [params, setParams] = useSearchParams();
	const editTarget = params.get("edit");
	const setInspectorOpen = useStore((s) => s.setInspectorOpen);

	const [routines, setRoutines] = useState<Routine[]>([]);
	const [metrics, setMetrics] = useState<Record<string, RoutineMetrics>>({});
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const res = await routinesApi.list();
			setRoutines(res.routines);
			setError(undefined);
			void loadMetrics(res.routines).then(setMetrics);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (editTarget) setInspectorOpen(true);
	}, [editTarget, setInspectorOpen]);

	const editingRoutine: Routine | "new" | undefined = useMemo(() => {
		if (!editTarget) return undefined;
		if (editTarget === "new") return "new";
		return routines.find((r) => r.id === editTarget);
	}, [editTarget, routines]);

	function openEditor(routine: Routine | "new"): void {
		setParams((p) => {
			const next = new URLSearchParams(p);
			next.set("edit", routine === "new" ? "new" : routine.id);
			return next;
		});
	}

	function closeEditor(): void {
		setParams((p) => {
			const next = new URLSearchParams(p);
			next.delete("edit");
			return next;
		});
	}

	async function toggleEnabled(r: Routine): Promise<void> {
		try {
			const updated = await routinesApi.update(r.id, { enabled: !r.enabled });
			setRoutines((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
		} catch (e) {
			setError(String(e));
		}
	}

	async function runNow(r: Routine): Promise<void> {
		try {
			await routinesApi.runNow(r.id);
			setTimeout(() => void refresh(), 800);
		} catch (e) {
			setError(String(e));
		}
	}

	function onSaved(saved: Routine): void {
		setRoutines((prev) => {
			const idx = prev.findIndex((x) => x.id === saved.id);
			if (idx === -1) return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
			const next = prev.slice();
			next[idx] = saved;
			return next;
		});
		void loadMetrics([saved]).then((m) => setMetrics((prev) => ({ ...prev, ...m })));
		if (editTarget === "new") {
			setParams((p) => {
				const next = new URLSearchParams(p);
				next.set("edit", saved.id);
				return next;
			});
		}
	}

	function onDeleted(id: string): void {
		setRoutines((prev) => prev.filter((x) => x.id !== id));
		setMetrics((prev) => {
			const next = { ...prev };
			delete next[id];
			return next;
		});
		closeEditor();
	}

	const isEditing = editTarget !== null;
	const mainPane = isEditing ? (
		editingRoutine ? (
			<RoutineEditorPage
				routine={editingRoutine}
				onBack={closeEditor}
				onSaved={onSaved}
				onDeleted={onDeleted}
			/>
		) : (
			<div className="flex h-full items-center justify-center px-6 text-center font-mono text-2xs text-ink-3">
				Loading routine...
			</div>
		)
	) : (
		<RoutinesIndex
			routines={routines}
			metrics={metrics}
			loading={loading}
			error={error}
			onNew={() => openEditor("new")}
			onOpen={openEditor}
			onToggleEnabled={toggleEnabled}
			onRunNow={runNow}
		/>
	);

	const sidebar = isEditing ? (
		<EditorSidebar onBack={closeEditor} onNew={() => openEditor("new")} />
	) : (
		<RoutinesSidebar
			routines={routines}
			onNew={() => openEditor("new")}
			onInstallTemplate={async (slug) => {
				try {
					const created = await routinesApi.templates.install(slug);
					await refresh();
					openEditor(created);
				} catch (e) {
					setError(String(e));
				}
			}}
		/>
	);

	const inspector = isEditing ? (
		<EditorInspector
			routine={editingRoutine === "new" ? undefined : editingRoutine}
			onChange={(r) => setRoutines((prev) => prev.map((x) => (x.id === r.id ? r : x)))}
			onDeleted={onDeleted}
			onError={setError}
		/>
	) : (
		<IndexInspector routines={routines} metrics={metrics} />
	);

	return <Layout sidebar={sidebar} main={mainPane} inspector={inspector} topBar={null} />;
}

async function loadMetrics(routines: Routine[]): Promise<Record<string, RoutineMetrics>> {
	const entries = await Promise.all(
		routines.map(async (r) => {
			try {
				return [r.id, await routinesApi.metrics(r.id)] as const;
			} catch {
				return null;
			}
		}),
	);
	const out: Record<string, RoutineMetrics> = {};
	for (const entry of entries) {
		if (entry) out[entry[0]] = entry[1];
	}
	return out;
}

function RoutinesIndex({
	routines,
	metrics,
	loading,
	error,
	onNew,
	onOpen,
	onToggleEnabled,
	onRunNow,
}: {
	routines: Routine[];
	metrics: Record<string, RoutineMetrics>;
	loading: boolean;
	error: string | undefined;
	onNew: () => void;
	onOpen: (r: Routine) => void;
	onToggleEnabled: (r: Routine) => void;
	onRunNow: (r: Routine) => void;
}) {
	const sorted = useMemo(() => {
		const copy = routines.slice();
		copy.sort((a, b) => {
			if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		return copy;
	}, [routines]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-paper">
			<header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3">
				<div>
					<div className="meta">Routines</div>
					<div className="font-mono text-2xs text-ink-3">
						{routines.length} total · {routines.filter((r) => r.enabled).length} enabled · {routines.filter((r) => r.specVersion === 1).length} pipelines
					</div>
				</div>
				<button type="button" onClick={onNew} className="btn-primary ml-auto h-7 px-2 text-xs">
					<Plus className="h-3.5 w-3.5" />
					New routine
				</button>
			</header>

			{error ? (
				<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			{loading ? (
				<div className="flex flex-1 items-center justify-center"><div className="meta">Loading…</div></div>
			) : routines.length === 0 ? (
				<div className="flex flex-1 items-center justify-center px-6 text-center">
					<div className="max-w-sm">
						<div className="meta mb-1.5">No routines yet</div>
						<p className="text-sm text-ink-2">Create a pipeline or install the daily briefing template.</p>
						<button type="button" onClick={onNew} className="btn-primary mt-3 h-8 px-3 text-sm">
							<Plus className="h-3.5 w-3.5" />
							New routine
						</button>
					</div>
				</div>
			) : (
				<div className="flex-1 overflow-y-auto">
					<ul className="divide-y divide-line">
						{sorted.map((routine) => (
							<RoutineListItem
								key={routine.id}
								routine={routine}
								metrics={metrics[routine.id]}
								onOpen={onOpen}
								onToggleEnabled={onToggleEnabled}
								onRunNow={onRunNow}
							/>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

function RoutineListItem({
	routine,
	metrics,
	onOpen,
	onToggleEnabled,
	onRunNow,
}: {
	routine: Routine;
	metrics: RoutineMetrics | undefined;
	onOpen: (r: Routine) => void;
	onToggleEnabled: (r: Routine) => void;
	onRunNow: (r: Routine) => void;
}) {
	const stepCount = countSteps(routine);
	const okPct = metrics && metrics.total > 0 ? Math.round(metrics.successRate30d * 100) : undefined;
	return (
		<li>
			<button
				type="button"
				onClick={() => onOpen(routine)}
				className="group flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-paper-3/60"
			>
				<span
					className={cn(
						"h-2.5 w-2.5 shrink-0 rounded-full",
						routine.enabled ? "bg-success" : "bg-line-strong",
					)}
				/>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-baseline gap-2">
						<span className="truncate text-sm font-medium text-ink">{routine.name}</span>
						<span className="chip bg-paper-3 text-ink-3">{routine.specVersion === 1 ? "pipeline" : routine.actionKind}</span>
						{stepCount !== undefined ? <span className="meta">{stepCount} steps</span> : null}
						{okPct !== undefined ? <span className="meta">{okPct}% ok</span> : null}
					</div>
					{routine.description ? (
						<div className="mt-0.5 line-clamp-1 text-xs text-ink-2">{routine.description}</div>
					) : null}
					<div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-2xs text-ink-3">
						{routine.cron ? <span>{routine.cron}</span> : <span>manual</span>}
						{routine.nextRunAt ? <span>next {new Date(routine.nextRunAt).toLocaleString()}</span> : null}
						{routine.lastRunAt ? <span>last {new Date(routine.lastRunAt).toLocaleString()}</span> : null}
					</div>
				</div>
				<div
					className="flex shrink-0 items-center gap-1"
					onClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
					role="group"
				>
					<button type="button" onClick={() => onRunNow(routine)} className="btn-ghost h-7 px-2 text-2xs" title="Run now">
						<Zap className="h-3.5 w-3.5" />
						Run
					</button>
					<button
						type="button"
						onClick={() => onToggleEnabled(routine)}
						className={cn("btn-ghost h-7 px-2 text-2xs", routine.enabled && "text-success")}
						title={routine.enabled ? "Disable" : "Enable"}
					>
						<Power className="h-3.5 w-3.5" />
						{routine.enabled ? "On" : "Off"}
					</button>
				</div>
			</button>
		</li>
	);
}

function countSteps(routine: Routine): number | undefined {
	if (routine.specVersion !== 1 || !routine.specYaml) return undefined;
	return routine.specYaml.split("\n").filter((line) => /^\s*-\s*id:/.test(line)).length;
}

function RoutinesSidebar({
	routines,
	onNew,
	onInstallTemplate,
}: {
	routines: Routine[];
	onNew: () => void;
	onInstallTemplate: (slug: string) => void;
}) {
	const [templates, setTemplates] = useState<TemplateSummary[] | undefined>();
	useEffect(() => {
		void routinesApi.templates
			.list()
			.then((r) => setTemplates(r.templates))
			.catch(() => setTemplates([]));
	}, []);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<section className="border-b border-line px-3 py-3">
				<div className="meta mb-1.5">Schedule</div>
				<div className="space-y-1 text-sm">
					<Stat label="enabled" value={routines.filter((r) => r.enabled).length} />
					<Stat label="disabled" value={routines.filter((r) => !r.enabled).length} />
					<Stat label="pipelines" value={routines.filter((r) => r.specVersion === 1).length} />
				</div>
			</section>
			<section className="border-b border-line px-3 py-3">
				<div className="meta mb-1.5">Templates</div>
				{templates === undefined ? (
					<div className="font-mono text-2xs text-ink-3">Loading...</div>
				) : templates.length === 0 ? (
					<div className="font-mono text-2xs text-ink-3">No templates.</div>
				) : (
					<ul className="space-y-1">
						{templates.map((t) => (
							<li key={t.slug}>
								<button
									type="button"
									onClick={() => onInstallTemplate(t.slug)}
									className="w-full rounded border border-line bg-paper-2 px-2 py-1.5 text-left hover:bg-paper-3"
								>
									<div className="text-sm font-medium text-ink">{t.name}</div>
									{t.description ? <div className="mt-0.5 line-clamp-2 text-2xs text-ink-3">{t.description}</div> : null}
									<div className="mt-1 font-mono text-2xs text-ink-4">{t.steps} steps · {t.triggers} triggers</div>
								</button>
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="border-b border-line px-3 py-3">
				<button type="button" onClick={onNew} className="btn-ghost h-7 w-full justify-start text-xs">
					<Plus className="h-3.5 w-3.5" />
					New routine
				</button>
			</section>
			<section className="px-3 py-3">
				<div className="meta mb-1.5">Cron format</div>
				<div className="space-y-1 font-mono text-2xs text-ink-3">
					<div>m h dom mon dow</div>
					<div>0 7 * * * = daily 7am</div>
					<div>0 9 * * 1-5 = weekdays 9am</div>
				</div>
			</section>
		</div>
	);
}

function EditorSidebar({ onBack, onNew }: { onBack: () => void; onNew: () => void }) {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto">
			<section className="border-b border-line px-3 py-3">
				<button type="button" onClick={onBack} className="btn-ghost h-7 w-full justify-start text-xs">
					All routines
				</button>
			</section>
			<section className="border-b border-line px-3 py-3">
				<div className="meta mb-1.5">Create</div>
				<button type="button" onClick={onNew} className="btn-ghost h-7 w-full justify-start text-xs">
					<Plus className="h-3.5 w-3.5" />
					New routine
				</button>
			</section>
			<section className="px-3 py-3">
				<div className="meta mb-1.5">Editor</div>
				<p className="text-xs leading-relaxed text-ink-3">
					The builder now uses the main canvas. Use the right inspector for runs and actions.
				</p>
			</section>
		</div>
	);
}

function IndexInspector({ routines, metrics }: { routines: Routine[]; metrics: Record<string, RoutineMetrics> }) {
	const next = routines
		.filter((r) => r.enabled && r.nextRunAt)
		.sort((a, b) => new Date(a.nextRunAt ?? 0).getTime() - new Date(b.nextRunAt ?? 0).getTime())[0];
	const totalRuns = Object.values(metrics).reduce((acc, m) => acc + m.total, 0);
	return (
		<div className="flex h-full flex-col overflow-y-auto p-3">
			<div className="meta mb-2">Overview</div>
			<div className="space-y-2 text-xs text-ink-2">
				<div className="flex items-center justify-between"><span>Total routines</span><span className="font-mono text-ink">{routines.length}</span></div>
				<div className="flex items-center justify-between"><span>Runs recorded</span><span className="font-mono text-ink">{totalRuns}</span></div>
			</div>
			<div className="mt-4 border-t border-line pt-3">
				<div className="meta mb-2">Next fire</div>
				{next ? (
					<div className="rounded border border-line bg-paper-2 px-2 py-1.5">
						<div className="text-sm font-medium text-ink">{next.name}</div>
						<div className="mt-0.5 flex items-center gap-1 font-mono text-2xs text-ink-3">
							<Clock className="h-3 w-3" />
							{new Date(next.nextRunAt as string).toLocaleString()}
						</div>
					</div>
				) : (
					<div className="font-mono text-2xs text-ink-3">No enabled scheduled routines.</div>
				)}
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="flex items-center justify-between">
			<span className="text-ink-2">{label}</span>
			<span className="font-mono text-2xs text-ink-3">{value}</span>
		</div>
	);
}
