import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Maximize2, Trash2, X } from "lucide-react";
import type { Routine, RoutineActionKind, RoutineRun } from "@omp-deck/protocol";

import { routinesApi } from "@/lib/routines-api";
import { RichEditor } from "@/components/RichEditor";
import { formatDurationMs } from "@/lib/utils";

import { RoutineBuilder } from "./RoutineBuilder";

interface Props {
	routine: Routine | "new";
	onClose: () => void;
	onSaved: (routine: Routine) => void;
	onDeleted: (id: string) => void;
}

const KINDS: ReadonlyArray<{ value: RoutineActionKind; label: string; placeholder: string }> = [
	{ value: "bash", label: "bash", placeholder: "echo hello" },
	{ value: "script", label: "script", placeholder: "C:/path/to/script.ps1 --flag" },
	{ value: "prompt", label: "prompt", placeholder: "Summarize my inbox" },
];

const PRESET_CRONS: ReadonlyArray<{ label: string; expr: string }> = [
	{ label: "every minute", expr: "* * * * *" },
	{ label: "hourly :00", expr: "0 * * * *" },
	{ label: "daily 9am", expr: "0 9 * * *" },
	{ label: "weekdays 9am", expr: "0 9 * * 1-5" },
	{ label: "weekly Sun 9am", expr: "0 9 * * 0" },
];

type Mode = "v0" | "v1";

export function RoutineEditor({ routine, onClose, onSaved, onDeleted }: Props) {
	const isNew = routine === "new";
	const existingMode: Mode = !isNew && routine.specVersion === 1 ? "v1" : "v0";
	// New routines start in V1 (multi-step builder) by default; users can
	// toggle to legacy V0 single-action mode for trivial cron jobs.
	const [mode, setMode] = useState<Mode>(isNew ? "v1" : existingMode);
	const [err, setErr] = useState<string | undefined>();

	// Reset mode when switching to a different routine.
	useEffect(() => {
		setMode(isNew ? "v1" : existingMode);
		setErr(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routine]);

	// Existing V1 routines MUST stay in V1 mode (you can't downgrade a spec).
	const canSwitchMode = isNew;

	async function remove(): Promise<void> {
		if (isNew) return;
		if (!confirm(`Delete routine "${routine.name}"?`)) return;
		try {
			await routinesApi.remove(routine.id);
			onDeleted(routine.id);
		} catch (e) {
			setErr(String(e));
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">{isNew ? "New routine" : "Edit routine"}</div>
				{!isNew ? (
					<span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
						{routine.specVersion === 1 ? "v1 pipeline" : "v0 single-action"}
					</span>
				) : null}
				{canSwitchMode ? (
					<div className="ml-2 flex items-center gap-0.5 rounded border border-line bg-paper-2 p-0.5">
						<button
							type="button"
							onClick={() => setMode("v1")}
							className={
								"rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
								(mode === "v1" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink")
							}
						>
							pipeline
						</button>
						<button
							type="button"
							onClick={() => setMode("v0")}
							className={
								"rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
								(mode === "v0" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink")
							}
						>
							single-action
						</button>
					</div>
				) : null}
				<button
					type="button"
					onClick={onClose}
					className="btn-ghost ml-auto h-7 w-7 p-0"
					aria-label="Close"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			{err ? (
				<div className="border-b border-line bg-danger/10 px-3 py-1 font-mono text-2xs text-danger">{err}</div>
			) : null}

			{mode === "v1" ? (
				<RoutineBuilder
					routine={isNew ? undefined : routine}
					onSaved={onSaved}
					onError={setErr}
				/>
			) : (
				<V0Editor
					routine={isNew ? "new" : routine}
					onSaved={onSaved}
					onRemove={() => void remove()}
					onError={setErr}
				/>
			)}
		</div>
	);
}

// ─── Legacy V0 single-action editor ─────────────────────────────────────────

function V0Editor({
	routine,
	onSaved,
	onRemove,
	onError,
}: {
	routine: Routine | "new";
	onSaved: (saved: Routine) => void;
	onRemove: () => void;
	onError: (msg: string) => void;
}) {
	const isNew = routine === "new";
	const initial = isNew
		? {
				name: "",
				description: "",
				cron: "0 9 * * *",
				actionKind: "bash" as RoutineActionKind,
				actionBody: "",
				actionCwd: "",
				enabled: true,
			}
		: {
				name: routine.name,
				description: routine.description,
				cron: routine.cron,
				actionKind: routine.actionKind,
				actionBody: routine.actionBody,
				actionCwd: routine.actionCwd ?? "",
				enabled: routine.enabled,
			};

	const [form, setForm] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [runs, setRuns] = useState<RoutineRun[]>([]);
	const [cronPreview, setCronPreview] = useState<
		| { valid: true; nextRuns: string[] }
		| { valid: false; error: string }
		| undefined
	>(undefined);
	const [ompOnPath, setOmpOnPath] = useState<boolean | undefined>(undefined);
	const [expandedRunId, setExpandedRunId] = useState<string | undefined>(undefined);

	useEffect(() => {
		if (!form.cron.trim()) {
			setCronPreview(undefined);
			return;
		}
		const handle = setTimeout(async () => {
			try {
				const r = await fetch(`/api/cron/validate?expr=${encodeURIComponent(form.cron)}`);
				const data = (await r.json()) as
					| { valid: true; nextRuns: string[] }
					| { valid: false; error: string };
				setCronPreview(data);
			} catch {
				/* keep previous */
			}
		}, 250);
		return () => clearTimeout(handle);
	}, [form.cron]);

	useEffect(() => {
		if (form.actionKind !== "prompt") return;
		if (ompOnPath !== undefined) return;
		void fetch("/api/binary/which?name=omp")
			.then((r) => r.json())
			.then((d) => setOmpOnPath(Boolean(d.found)))
			.catch(() => setOmpOnPath(false));
	}, [form.actionKind, ompOnPath]);

	useEffect(() => {
		setForm(initial);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routine]);

	useEffect(() => {
		if (isNew) return;
		void routinesApi.runs(routine.id, 10).then((r) => setRuns(r.runs));
	}, [isNew, routine]);

	function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]): void {
		setForm((f) => ({ ...f, [key]: value }));
	}

	async function save(): Promise<void> {
		setBusy(true);
		try {
			const payload = {
				name: form.name,
				description: form.description,
				cron: form.cron,
				actionKind: form.actionKind,
				actionBody: form.actionBody,
				actionCwd: form.actionCwd || undefined,
				enabled: form.enabled,
			};
			const saved = isNew
				? await routinesApi.create(payload)
				: await routinesApi.update(routine.id, payload);
			onSaved(saved);
		} catch (e) {
			onError(String(e));
		} finally {
			setBusy(false);
		}
	}

	async function runNow(): Promise<void> {
		if (isNew) return;
		try {
			await routinesApi.runNow(routine.id);
			await new Promise((r) => setTimeout(r, 600));
			const r = await routinesApi.runs(routine.id, 10);
			setRuns(r.runs);
		} catch (e) {
			onError(String(e));
		}
	}

	return (
		<>
			<div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 text-sm">
				<Field label="Name">
					<input
						value={form.name}
						onChange={(e) => update("name", e.target.value)}
						placeholder="daily inbox sweep"
						className="field h-8 w-full px-2 text-sm"
					/>
				</Field>

				<Field label="Description">
					<input
						value={form.description}
						onChange={(e) => update("description", e.target.value)}
						placeholder="optional, helps you remember why"
						className="field h-8 w-full px-2 text-sm"
					/>
				</Field>

				<Field label="Cron">
					<input
						value={form.cron}
						onChange={(e) => update("cron", e.target.value)}
						placeholder="0 9 * * *"
						className="field h-8 w-full px-2 font-mono text-sm"
					/>
					<div className="mt-1.5 flex flex-wrap gap-1">
						{PRESET_CRONS.map((p) => (
							<button
								key={p.expr}
								type="button"
								onClick={() => update("cron", p.expr)}
								className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink"
							>
								{p.label}
							</button>
						))}
					</div>
					{cronPreview ? (
						cronPreview.valid ? (
							<div className="mt-2 rounded border border-success/30 bg-success/5 px-2 py-1.5">
								<div className="meta mb-0.5 text-success">
									Next {cronPreview.nextRuns.length} run{cronPreview.nextRuns.length === 1 ? "" : "s"}
								</div>
								<ul className="space-y-0.5 font-mono text-2xs text-ink-2">
									{cronPreview.nextRuns.map((iso) => (
										<li key={iso}>{new Date(iso).toLocaleString()}</li>
									))}
								</ul>
							</div>
						) : (
							<div className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 font-mono text-2xs text-danger">
								Invalid: {cronPreview.error}
							</div>
						)
					) : null}
				</Field>

				<Field label="Action">
					<div className="flex gap-1">
						{KINDS.map((k) => (
							<button
								key={k.value}
								type="button"
								onClick={() => update("actionKind", k.value)}
								className={
									"rounded border px-2 py-0.5 font-mono text-2xs uppercase tracking-meta " +
									(form.actionKind === k.value
										? "border-ink bg-ink text-paper-2"
										: "border-line text-ink-3 hover:text-ink")
								}
							>
								{k.label}
							</button>
						))}
					</div>
					{form.actionKind === "prompt" ? (
						<RichEditor
							value={form.actionBody}
							onChange={(v) => update("actionBody", v)}
							rows={5}
							placeholder={KINDS.find((k) => k.value === form.actionKind)?.placeholder ?? ""}
							disableRichText={false}
							className="field mt-1.5 w-full resize-y px-2 py-1.5 font-mono text-xs leading-relaxed"
						/>
					) : (
						<textarea
							value={form.actionBody}
							onChange={(e) => update("actionBody", e.target.value)}
							rows={5}
							placeholder={KINDS.find((k) => k.value === form.actionKind)?.placeholder ?? ""}
							className="field mt-1.5 w-full resize-y px-2 py-1.5 font-mono text-xs leading-relaxed"
						/>
					)}
					{form.actionKind === "prompt" ? (
						ompOnPath === false ? (
							<div className="mt-1.5 rounded border border-warn/40 bg-warn/5 px-2 py-1.5 font-mono text-2xs text-warn">
								<code>omp</code> not on the server's PATH. This routine will fail at run time.
							</div>
						) : (
							<p className="mt-1 font-mono text-2xs text-ink-3">
								Runs <code>omp -p &quot;&lt;body&gt;&quot;</code> headless
								{ompOnPath === true ? <span className="text-success"> · omp found on PATH</span> : null}.
							</p>
						)
					) : null}
				</Field>

				<Field label="Working directory (optional)">
					<input
						value={form.actionCwd}
						onChange={(e) => update("actionCwd", e.target.value)}
						placeholder="defaults to the server's cwd"
						className="field h-8 w-full px-2 font-mono text-xs"
					/>
				</Field>

				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={form.enabled}
						onChange={(e) => update("enabled", e.target.checked)}
					/>
					<span>Enabled</span>
				</label>

				{!isNew ? (
					<section>
						<div className="meta mb-1.5">Last runs</div>
						{runs.length === 0 ? (
							<div className="font-mono text-2xs text-ink-3">No runs yet.</div>
						) : (
							<ul className="space-y-1">
								{runs.map((r) => {
									const dur =
										r.endedAt && r.startedAt
											? new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime()
											: undefined;
									const ok = r.error == null && (r.exitCode === 0 || r.exitCode === undefined);
									const expanded = expandedRunId === r.id;
									const hasDetail =
										Boolean(r.stdoutExcerpt) || Boolean(r.stderrExcerpt) || Boolean(r.error);
									return (
										<li key={r.id} className="border-l-2 border-line pl-2">
											<button
												type="button"
												onClick={() => setExpandedRunId(expanded ? undefined : r.id)}
												className="flex w-full items-center gap-2 text-left font-mono text-2xs hover:text-ink"
											>
												<span
													className={
														"h-1.5 w-1.5 rounded-full shrink-0 " +
														(r.endedAt ? (ok ? "bg-success" : "bg-danger") : "bg-accent")
													}
												/>
												<span className="text-ink-3">{new Date(r.startedAt).toLocaleString()}</span>
												<span className="text-ink-4">{r.trigger}</span>
												{dur !== undefined ? <span className="text-ink-4">{formatDurationMs(dur)}</span> : null}
												{r.exitCode !== undefined ? (
													<span className="text-ink-4">exit {r.exitCode}</span>
												) : null}
												{!r.endedAt ? <span className="text-accent">running</span> : null}
												<Link
													to={`/routines/${(routine as Routine).id}/runs/${r.id}`}
													onClick={(e) => e.stopPropagation()}
													className="ml-auto flex items-center gap-1 text-ink-3 hover:text-accent"
													title="Open run detail"
												>
													<Maximize2 className="h-3 w-3" />
													<span className="text-2xs uppercase tracking-meta">detail</span>
												</Link>
												{hasDetail ? (
													<span className="text-ink-4">{expanded ? "▾" : "▸"}</span>
												) : null}
											</button>
											{expanded && hasDetail ? (
												<div className="mt-1.5 space-y-1.5 pl-3">
													{r.error ? <RunPane label="error" tone="danger" body={r.error} /> : null}
													{r.stdoutExcerpt ? (
														<RunPane label="stdout" tone="default" body={r.stdoutExcerpt} />
													) : null}
													{r.stderrExcerpt ? (
														<RunPane label="stderr" tone="warn" body={r.stderrExcerpt} />
													) : null}
												</div>
											) : null}
										</li>
									);
								})}
							</ul>
						)}
					</section>
				) : null}
			</div>

			<div className="flex shrink-0 items-center justify-between gap-2 border-t border-line bg-paper px-3 py-2">
				{!isNew ? (
					<button type="button" onClick={onRemove} className="btn-ghost text-danger text-xs">
						<Trash2 className="h-3.5 w-3.5" />
						Delete
					</button>
				) : (
					<span />
				)}
				<div className="flex items-center gap-1.5">
					{!isNew ? (
						<button
							type="button"
							onClick={() => void runNow()}
							className="btn-ghost h-7 px-2.5 text-xs"
							title="Run now (out of schedule)"
						>
							Run now
						</button>
					) : null}
					<button
						type="button"
						onClick={() => void save()}
						disabled={busy || !form.name.trim() || !form.cron.trim() || !form.actionBody.trim()}
						className="btn-primary h-7 px-2.5 text-xs"
					>
						{isNew ? "Create" : "Save"}
					</button>
				</div>
			</div>
		</>
	);
}

function RunPane({ label, tone, body }: { label: string; tone: "default" | "warn" | "danger"; body: string }) {
	const toneClass =
		tone === "danger"
			? "text-danger border-danger/30"
			: tone === "warn"
				? "text-warn border-warn/30"
				: "text-ink-2 border-line";
	return (
		<div>
			<div className={`meta mb-0.5 ${toneClass.split(" ")[0]}`}>{label}</div>
			<pre
				className={`max-h-48 overflow-auto whitespace-pre-wrap break-words bg-paper-code border ${toneClass.split(" ")[1] ?? "border-line"} px-2 py-1.5 font-mono text-2xs leading-relaxed`}
			>
				{body}
			</pre>
		</div>
	);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="meta mb-1">{label}</div>
			{children}
		</div>
	);
}
