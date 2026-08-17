/**
 * /agent-config — browse and edit `OMP_AGENT_DIR`, and the import flow for
 * replacing it wholesale (subagents, skills, extensions, rules, MCP/model
 * config) from an uploaded archive, e.g. a `~/.omp/agent` exported from
 * another machine.
 *
 * The import UX mirrors the safety model in `agent-config-service.ts`: pick
 * a file, see the exact plan (what's added / changed / removed) before
 * anything happens, then apply. Nothing on disk changes until the operator
 * has seen the plan and clicked Apply.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	AlertTriangle,
	Archive,
	Database,
	Download,
	FileCode,
	History,
	Loader2,
	Minus,
	Plus,
	Save,
	Upload,
	X,
} from "lucide-react";
import type { AgentFileEntry, AgentImportMode, AgentImportPlan, FileEntry } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { CodeEditor } from "@/components/explorer/CodeEditor";
import { FileTree } from "@/components/explorer/FileTree";
import { agentConfigApi } from "@/lib/agent-config-api";
import { cn } from "@/lib/utils";

export function AgentConfigView(): JSX.Element {
	const [selected, setSelected] = useState<AgentFileEntry | null>(null);
	const [content, setContent] = useState("");
	const [savedContent, setSavedContent] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshKey, setRefreshKey] = useState(0);
	const [importOpen, setImportOpen] = useState(false);

	const dirty = content !== savedContent;

	async function open(entry: FileEntry): Promise<void> {
		if (entry.kind !== "file") return;
		const agentEntry = entry as AgentFileEntry;
		if (agentEntry.isDatabase) {
			setError("This is a live database file — use Export to download the whole directory, not the text editor.");
			return;
		}
		setSelected(agentEntry);
		setLoading(true);
		try {
			const result = await agentConfigApi.read(entry.path);
			setContent(result.content);
			setSavedContent(result.content);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setSelected(null);
		} finally {
			setLoading(false);
		}
	}

	async function save(): Promise<void> {
		if (!selected) return;
		try {
			await agentConfigApi.write(selected.path, content);
			setSavedContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function remove(entry: FileEntry): Promise<void> {
		const ok = window.confirm(`Delete "${entry.name}"? This cannot be undone.`);
		if (!ok) return;
		try {
			await agentConfigApi.remove(entry.path);
			setRefreshKey((k) => k + 1);
			if (selected?.path === entry.path) setSelected(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if ((e.ctrlKey || e.metaKey) && e.key === "s") {
				e.preventDefault();
				void save();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected, content]);

	return (
		<>
		<Layout
			topBar={
				<div className="flex items-center gap-1.5">
					<Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
						<Upload className="h-3.5 w-3.5" /> Import
					</Button>
					<a href={agentConfigApi.exportUrl()} download>
						<Button variant="ghost" size="sm">
							<Download className="h-3.5 w-3.5" /> Export
						</Button>
					</a>
				</div>
			}
			sidebar={
				<div className="flex h-full flex-col">
					<div className="border-b border-line px-3 py-2">
						<div className="meta">Agent Config</div>
						<p className="mt-0.5 text-2xs text-ink-3">~/.omp/agent</p>
					</div>
					<div className="min-h-0 flex-1 overflow-auto">
						<FileTree
							root="__agent_root__"
							selectedPath={selected?.path ?? null}
							onSelect={open}
							onDelete={remove}
							refreshKey={refreshKey}
							list={(p) => agentConfigApi.list(p === "__agent_root__" ? "" : p)}
						/>
					</div>
				</div>
			}
			main={
				<div className="flex h-full flex-col">
					{error ? (
						<div className="m-3 flex items-start justify-between gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
							<span>{error}</span>
							<button onClick={() => setError(null)}>
								<X className="h-3.5 w-3.5" />
							</button>
						</div>
					) : null}
					{!selected ? (
						<div className="flex h-full flex-col items-center justify-center gap-3 text-center text-ink-3">
							<Archive className="h-8 w-8 text-ink-4" />
							<div>
								<p className="text-sm">Browse or import your agent configuration.</p>
								<p className="mt-1 max-w-sm text-xs text-ink-4">
									Subagents, skills, extensions, rules, MCP servers and model routing — everything
									under <code className="rounded bg-paper-3 px-1">~/.omp/agent</code>.
								</p>
							</div>
						</div>
					) : loading ? (
						<div className="flex h-full items-center justify-center gap-2 text-ink-3">
							<Loader2 className="h-4 w-4 animate-spin" /> Loading…
						</div>
					) : (
						<>
							<div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-paper-2 px-3">
								<FileCode className="h-3.5 w-3.5 text-ink-4" />
								<span className="truncate font-mono text-xs text-ink">{selected.path}</span>
								<Button variant="ghost" size="sm" className="ml-auto" disabled={!dirty} onClick={() => void save()}>
									<Save className="h-3.5 w-3.5" /> Save
								</Button>
							</div>
							<div className="min-h-0 flex-1">
								<CodeEditor path={selected.path} value={content} onChange={setContent} onSave={() => void save()} />
							</div>
						</>
					)}
				</div>
			}
			inspector={<BackupsPanel refreshKey={refreshKey} />}
		/>
		<ImportModal
			open={importOpen}
			onClose={() => setImportOpen(false)}
			onApplied={() => {
				setImportOpen(false);
				setRefreshKey((k) => k + 1);
				setSelected(null);
			}}
		/>
		</>
	);
}

// ─── Import flow ────────────────────────────────────────────────────────────

interface ImportModalProps {
	open: boolean;
	onClose: () => void;
	onApplied: () => void;
}

type ImportPhase = "pick" | "planning" | "review" | "applying" | "applied" | "error";

function ImportModal({ open, onClose, onApplied }: ImportModalProps): JSX.Element {
	const [phase, setPhase] = useState<ImportPhase>("pick");
	const [mode, setMode] = useState<AgentImportMode>("merge");
	const [plan, setPlan] = useState<AgentImportPlan | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [restartInfo, setRestartInfo] = useState<string | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);

	const reset = useCallback(() => {
		setPhase("pick");
		setPlan(null);
		setError(null);
		setConfirmed(false);
		setRestartInfo(null);
	}, []);

	useEffect(() => {
		if (open) reset();
	}, [open, reset]);

	async function pickFile(file: File): Promise<void> {
		setPhase("planning");
		setError(null);
		try {
			const result = await agentConfigApi.stageImport(file, mode);
			setPlan(result);
			setPhase("review");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}

	async function apply(): Promise<void> {
		if (!plan) return;
		setPhase("applying");
		try {
			const result = await agentConfigApi.applyImport(plan.stagingId);
			setRestartInfo(result.restart.ok ? "Restarting to load the new configuration…" : result.restart.message);
			setPhase("applied");
			setTimeout(onApplied, 1200);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}

	async function discard(): Promise<void> {
		if (plan) await agentConfigApi.discardImport(plan.stagingId).catch(() => undefined);
		onClose();
	}

	return (
		<Modal open={open} onClose={() => void discard()} widthClass="max-w-xl">
			<div className="flex flex-col gap-4 p-5">
				<div>
					<h2 className="text-lg font-semibold text-ink">Import agent configuration</h2>
					<p className="mt-1 text-xs text-ink-3">
						Upload a <code>~/.omp/agent</code> export (a .zip). Nothing changes until you review the plan
						and apply it.
					</p>
				</div>

				{phase === "pick" ? (
					<>
						<div className="flex flex-col gap-2">
							<div className="meta">Mode</div>
							<label className="flex items-start gap-2 rounded-md border border-line p-2.5 hover:bg-paper-3">
								<input type="radio" checked={mode === "merge"} onChange={() => setMode("merge")} className="mt-0.5" />
								<div>
									<div className="text-sm text-ink">Merge (recommended)</div>
									<div className="text-xs text-ink-3">
										Overlays the archive on top of what's here. Files not in the archive — including
										your live databases — are untouched.
									</div>
								</div>
							</label>
							<label className="flex items-start gap-2 rounded-md border border-line p-2.5 hover:bg-paper-3">
								<input
									type="radio"
									checked={mode === "full-reset"}
									onChange={() => setMode("full-reset")}
									className="mt-0.5"
								/>
								<div>
									<div className="text-sm text-ink">Full reset</div>
									<div className="text-xs text-ink-3">
										The archive becomes the complete directory. Anything not in it — including
										databases — is removed (backed up first, always restorable).
									</div>
								</div>
							</label>
						</div>
						<input
							ref={fileRef}
							type="file"
							accept=".zip"
							className="hidden"
							onChange={(e) => {
								const file = e.target.files?.[0];
								if (file) void pickFile(file);
							}}
						/>
						<Button variant="primary" onClick={() => fileRef.current?.click()}>
							<Upload className="h-4 w-4" /> Choose .zip file
						</Button>
					</>
				) : null}

				{phase === "planning" ? (
					<div className="flex items-center gap-2 py-6 text-sm text-ink-3">
						<Loader2 className="h-4 w-4 animate-spin" /> Extracting and computing the plan…
					</div>
				) : null}

				{phase === "review" && plan ? (
					<>
						<div className="flex items-center gap-3 text-xs">
							<span className="flex items-center gap-1 text-success">
								<Plus className="h-3 w-3" /> {plan.addedCount} added
							</span>
							<span className="flex items-center gap-1 text-warn">
								<FileCode className="h-3 w-3" /> {plan.modifiedCount} changed
							</span>
							{plan.removedCount > 0 ? (
								<span className="flex items-center gap-1 text-danger">
									<Minus className="h-3 w-3" /> {plan.removedCount} removed
								</span>
							) : null}
						</div>
						<div className="max-h-64 overflow-auto rounded-md border border-line">
							{plan.entries.map((e) => (
								<div
									key={e.path}
									className={cn(
										"flex items-center gap-2 border-b border-line/60 px-2.5 py-1 font-mono text-2xs last:border-0",
										e.change === "add" && "text-success",
										e.change === "modify" && "text-warn",
										e.change === "remove" && "text-danger",
									)}
								>
									<span className="w-4 text-center">{e.change === "add" ? "+" : e.change === "remove" ? "−" : "~"}</span>
									<span className="min-w-0 flex-1 truncate">{e.path}</span>
									{e.isDatabase ? <Database className="h-3 w-3 shrink-0" /> : null}
								</div>
							))}
						</div>
						{plan.touchesDatabase ? (
							<div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-xs text-warn">
								<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
								<span>
									This plan touches a live database file (auth tokens, model cache). It will be
									backed up automatically — restorable from the panel on the right — but the server
									will restart to apply it, ending any active session.
								</span>
							</div>
						) : null}
						<label className="flex items-center gap-2 text-xs text-ink-2">
							<input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
							I've reviewed the plan above and want to apply it.
						</label>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => void discard()}>
								Cancel
							</Button>
							<Button variant="primary" disabled={!confirmed} onClick={() => void apply()}>
								Apply import
							</Button>
						</div>
					</>
				) : null}

				{phase === "applying" ? (
					<div className="flex items-center gap-2 py-6 text-sm text-ink-3">
						<Loader2 className="h-4 w-4 animate-spin" /> Applying…
					</div>
				) : null}

				{phase === "applied" ? (
					<div className="flex flex-col items-center gap-2 py-6 text-center">
						<Save className="h-6 w-6 text-success" />
						<p className="text-sm text-ink">Import applied.</p>
						{restartInfo ? <p className="text-xs text-ink-3">{restartInfo}</p> : null}
					</div>
				) : null}

				{phase === "error" && error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</div>
				) : null}

				{phase !== "pick" && phase !== "review" && phase !== "applying" && phase !== "applied" ? (
					<div className="flex justify-end">
						<Button variant="ghost" onClick={onClose}>
							Close
						</Button>
					</div>
				) : null}
			</div>
		</Modal>
	);
}

// ─── Backups sidebar ────────────────────────────────────────────────────────

function BackupsPanel({ refreshKey }: { refreshKey: number }): JSX.Element {
	const [backups, setBackups] = useState<Array<{ name: string; path: string; createdAt: string }>>([]);
	const [loading, setLoading] = useState(true);
	const [restoring, setRestoring] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function refresh(): Promise<void> {
		setLoading(true);
		try {
			const result = await agentConfigApi.backups();
			setBackups(result.backups);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [refreshKey]);

	async function restore(path: string): Promise<void> {
		const ok = window.confirm("Restore this backup? The current agent directory will itself be backed up first, then the server restarts.");
		if (!ok) return;
		setRestoring(path);
		try {
			await agentConfigApi.restoreBackup(path);
			await refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRestoring(null);
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
				<History className="h-3.5 w-3.5 text-accent" />
				<span className="meta">Backups</span>
			</div>
			{error ? <div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-2xs text-danger">{error}</div> : null}
			<div className="min-h-0 flex-1 overflow-auto p-2">
				{loading ? (
					<div className="flex items-center gap-2 p-3 text-xs text-ink-3">
						<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
					</div>
				) : backups.length === 0 ? (
					<p className="p-3 text-xs text-ink-3">No import backups yet. Every applied import creates one automatically.</p>
				) : (
					backups.map((b) => (
						<div key={b.path} className="mb-1.5 rounded-md border border-line p-2.5">
							<div className="font-mono text-2xs text-ink-2">{new Date(b.createdAt).toLocaleString()}</div>
							<Button
								variant="outline"
								size="sm"
								className="mt-1.5 w-full"
								disabled={restoring !== null}
								onClick={() => void restore(b.path)}
							>
								{restoring === b.path ? <Loader2 className="h-3 w-3 animate-spin" /> : <History className="h-3 w-3" />}
								Restore
							</Button>
						</div>
					))
				)}
			</div>
		</div>
	);
}
