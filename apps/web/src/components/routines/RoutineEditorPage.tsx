import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { Routine, RoutineActionKind } from "@omp-deck/protocol";

import { routinesApi } from "@/lib/routines-api";

import { RoutineBuilder } from "./RoutineBuilder";

import { RichEditor } from "@/components/RichEditor";

type Mode = "v0" | "v1";

interface Props {
	routine: Routine | "new";
	onBack: () => void;
	onSaved: (saved: Routine) => void;
	onDeleted: (id: string) => void;
}

export function RoutineEditorPage({ routine, onBack, onSaved, onDeleted }: Props) {
	const isNew = routine === "new";
	const existingMode: Mode = !isNew && routine.specVersion === 1 ? "v1" : "v0";
	const [mode, setMode] = useState<Mode>(isNew ? "v1" : existingMode);
	const [err, setErr] = useState<string | undefined>();

	useEffect(() => {
		setMode(isNew ? "v1" : existingMode);
		setErr(undefined);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [routine]);

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

	const title = isNew ? "New routine" : routine.name || "Untitled routine";
	const description = isNew ? "Create a multi-step pipeline or a legacy single-action cron job." : routine.description;

	return (
		<div className="flex h-full min-h-0 flex-col bg-paper">
			<header className="shrink-0 border-b border-line bg-paper px-3 py-3">
				<div className="flex items-center gap-2">
					<button type="button" onClick={onBack} className="btn-ghost h-7 px-2 text-xs">
						<ArrowLeft className="h-3.5 w-3.5" />
						All routines
					</button>
					<span className="chip bg-paper-3 text-ink-3">{mode === "v1" ? "pipeline" : "single-action"}</span>
					{isNew ? (
						<div className="flex items-center gap-0.5 rounded border border-line bg-paper-2 p-0.5">
							<button
								type="button"
								onClick={() => setMode("v1")}
								className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta ${mode === "v1" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink"}`}
							>
								Pipeline
							</button>
							<button
								type="button"
								onClick={() => setMode("v0")}
								className={`rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-meta ${mode === "v0" ? "bg-ink text-paper-2" : "text-ink-3 hover:text-ink"}`}
							>
								Single-action
							</button>
						</div>
					) : null}
					{!isNew ? (
						<button type="button" onClick={() => void remove()} className="btn-ghost ml-auto h-7 px-2 text-xs text-danger">
							<Trash2 className="h-3.5 w-3.5" />
							Delete
						</button>
					) : null}
				</div>
				<div className="mt-3">
					<h1 className="text-xl font-semibold tracking-tight text-ink">{title}</h1>
					{description ? <p className="mt-1 max-w-3xl text-sm text-ink-2">{description}</p> : null}
					{!isNew ? (
						<div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-2xs text-ink-3">
							<span>{routine.id}</span>
							<span>updated {new Date(routine.updatedAt).toLocaleString()}</span>
						</div>
					) : null}
				</div>
			</header>

			{err ? (
				<div className="border-b border-line bg-danger/10 px-3 py-1.5 font-mono text-xs text-danger">{err}</div>
			) : null}

			<div className="min-h-0 flex-1 bg-paper">
				{mode === "v1" ? (
					<div className="h-full px-3 py-3">
						<RoutineBuilder routine={isNew ? undefined : routine} onSaved={onSaved} onError={setErr} />
					</div>
				) : (
					<V0EditorPage routine={routine} onSaved={onSaved} onError={setErr} />
				)}
			</div>
		</div>
	);
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

function V0EditorPage({
	routine,
	onSaved,
	onError,
}: {
	routine: Routine | "new";
	onSaved: (saved: Routine) => void;
	onError: (msg: string) => void;
}) {
	const isNew = routine === "new";
	const initial = useMemo(
		() =>
			isNew
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
					},
		[routine, isNew],
	);

	const [form, setForm] = useState(initial);
	const [busy, setBusy] = useState(false);
	const [cronPreview, setCronPreview] = useState<
		| { valid: true; nextRuns: string[] }
		| { valid: false; error: string }
		| undefined
	>(undefined);
	const lastRoutineKey = useRef<string>(isNew ? "new" : routine.id);

	useEffect(() => {
		const key = isNew ? "new" : routine.id;
		if (lastRoutineKey.current === key) return;
		lastRoutineKey.current = key;
		setForm(initial);
	}, [routine, isNew, initial]);

	useEffect(() => {
		if (!form.cron.trim()) {
			setCronPreview(undefined);
			return;
		}
		const t = setTimeout(async () => {
			try {
				const r = await fetch(`/api/cron/validate?expr=${encodeURIComponent(form.cron)}`);
				setCronPreview(
					(await r.json()) as
						| { valid: true; nextRuns: string[] }
						| { valid: false; error: string },
				);
			} catch {
				/* keep prior */
			}
		}, 250);
		return () => clearTimeout(t);
	}, [form.cron]);

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

	return (
		<div className="mx-auto flex h-full max-w-3xl flex-col px-3 py-3">
			<div className="flex-1 space-y-4 overflow-y-auto rounded-lg border border-line bg-paper px-3 py-3">
				<Field label="Name">
					<input value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="daily inbox sweep" className="field h-8 w-full px-2 text-sm" />
				</Field>
				<Field label="Description">
					<input value={form.description} onChange={(e) => update("description", e.target.value)} placeholder="optional" className="field h-8 w-full px-2 text-sm" />
				</Field>
				<Field label="Cron">
					<input value={form.cron} onChange={(e) => update("cron", e.target.value)} placeholder="0 9 * * *" className="field h-8 w-full px-2 font-mono text-sm" />
					<div className="mt-1.5 flex flex-wrap gap-1">
						{PRESET_CRONS.map((p) => (
							<button key={p.expr} type="button" onClick={() => update("cron", p.expr)} className="rounded border border-line bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3 hover:bg-paper-3 hover:text-ink">
								{p.label}
							</button>
						))}
					</div>
					{cronPreview ? (
						cronPreview.valid ? (
							<div className="mt-2 rounded border border-success/30 bg-success/5 px-2 py-1.5">
								<div className="meta mb-0.5 text-success">Next {cronPreview.nextRuns.length}</div>
								<ul className="space-y-0.5 font-mono text-2xs text-ink-2">
									{cronPreview.nextRuns.map((iso) => <li key={iso}>{new Date(iso).toLocaleString()}</li>)}
								</ul>
							</div>
						) : (
							<div className="mt-2 rounded border border-danger/40 bg-danger/5 px-2 py-1.5 font-mono text-2xs text-danger">{cronPreview.error}</div>
						)
					) : null}
				</Field>
				<Field label="Action">
					<div className="flex gap-1">
						{KINDS.map((k) => (
							<button key={k.value} type="button" onClick={() => update("actionKind", k.value)} className={`rounded border px-2 py-0.5 font-mono text-2xs uppercase tracking-meta ${form.actionKind === k.value ? "border-ink bg-ink text-paper-2" : "border-line text-ink-3 hover:text-ink"}`}>
								{k.label}
							</button>
						))}
					</div>
					{form.actionKind === "prompt" ? (
						<RichEditor
							value={form.actionBody}
							onChange={(v) => update("actionBody", v)}
							rows={6}
							placeholder={KINDS.find((k) => k.value === form.actionKind)?.placeholder ?? ""}
							disableRichText={false}
							className="field mt-1.5 w-full resize-y px-2 py-1.5 font-mono text-xs leading-relaxed"
						/>
					) : (
						<textarea
							value={form.actionBody}
							onChange={(e) => update("actionBody", e.target.value)}
							rows={6}
							placeholder={KINDS.find((k) => k.value === form.actionKind)?.placeholder ?? ""}
							className="field mt-1.5 w-full resize-y px-2 py-1.5 font-mono text-xs leading-relaxed"
						/>
					)}
				</Field>
				<Field label="Working directory (optional)">
					<input value={form.actionCwd} onChange={(e) => update("actionCwd", e.target.value)} placeholder="defaults to server cwd" className="field h-8 w-full px-2 font-mono text-xs" />
				</Field>
				<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => update("enabled", e.target.checked)} /><span>Enabled</span></label>
			</div>
			<div className="flex shrink-0 justify-end border-t border-line bg-paper py-2">
				<button type="button" onClick={() => void save()} disabled={busy || !form.name.trim() || !form.cron.trim() || !form.actionBody.trim()} className="btn-primary px-3 py-1.5 text-xs">
					{isNew ? "Create" : "Save"}
				</button>
			</div>
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
