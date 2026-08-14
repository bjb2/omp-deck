/**
 * Gholam control panel — manage the digital-twin sidecar.
 *
 * The view lets the user:
 *   • start/stop the sidecar (the running flag flips with one click),
 *   • tune the heartbeat interval,
 *   • add/remove priorities (what Gholam is allowed to act on),
 *   • see the live sidecar status (port, pid, last beat, KB stats).
 *
 * Priorities are user-controlled: Gholam never picks its own targets. Adding
 * a priority here lands it in the sidecar's queue file; the next heartbeat
 * picks it up.
 */
import { useCallback, useEffect, useState } from "react";
import { Heart, Pause, Play, Plus, Trash2 } from "lucide-react";

import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { DeployStatusBadge } from "@/components/DeployStatusBadge";
import { useStore } from "@/lib/store";

interface GholamState {
	running: boolean;
	pid?: number;
	startedAt?: string;
	heartbeatMs: number;
	lastBeatAt?: string;
	prioritiesCount: number;
	wsPort?: number;
}

interface Priority {
	id?: string;
	label: string;
	cwd: string;
	scope: string;
	addedAt?: string;
}

export function GholamView(): JSX.Element {
	const [state, setState] = useState<GholamState | null>(null);
	const [priorities, setPriorities] = useState<Priority[]>([]);
	const [draftLabel, setDraftLabel] = useState("");
	const [draftCwd, setDraftCwd] = useState("");
	const [draftScope, setDraftScope] = useState("session");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const [statusRes, priorRes] = await Promise.all([
				fetch("/api/gholam/status").then((r) => r.json() as Promise<GholamState>),
				fetch("/api/gholam/priorities").then((r) => r.json() as Promise<{ priorities: Priority[] }>),
			]);
			setState(statusRes);
			setPriorities(priorRes.priorities ?? []);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		}
	}, []);

	useEffect(() => {
		void refresh();
		const t = setInterval(refresh, 5_000);
		return () => clearInterval(t);
	}, [refresh]);

	async function call(path: string, init?: RequestInit): Promise<void> {
		setBusy(true);
		try {
			const res = await fetch(path, init);
			if (!res.ok) throw new Error(`${path} → ${res.status}`);
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}

	function addPriority(): void {
		const label = draftLabel.trim();
		// `process` is undefined in the browser bundle. Fall back to the user's
		// default cwd from the store; the server's /gholam/priorities route
		// resolves empty cwd to OMP_DECK_DEFAULT_CWD / process.cwd() server-side.
		const cwd = draftCwd.trim() || useStore.getState().defaultCwd || "";
		if (!label) return;
		const next: Priority = { label, cwd, scope: draftScope };
		setPriorities((prev) => [...prev, next]);
		setDraftLabel("");
		setDraftCwd("");
	}

	function removePriority(idx: number): void {
		setPriorities((prev) => prev.filter((_, i) => i !== idx));
	}

	async function savePriorities(): Promise<void> {
		await call("/api/gholam/priorities", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ priorities }),
		});
	}

	return (
		<Layout
			sidebar={
				<div className="flex h-full flex-col gap-3 p-3 text-sm">
					<div className="meta" data-tooltip-key="gholam.sidebar">Sidecar</div>
					<div data-tooltip-key="gholam.sidebar" className="rounded-md border border-line bg-paper-2 p-3 space-y-1">
						<div className="flex items-center gap-2">
							{state?.running ? (
								<span className="h-2 w-2 rounded-full bg-success animate-pulse" />
							) : (
								<span className="h-2 w-2 rounded-full bg-danger" />
							)}
							<span className="font-medium">{state?.running ? "running" : "stopped"}</span>
							<DeployStatusBadge />
						</div>
						<dl className="space-y-1 text-xs text-ink-3">
							{state?.pid ? (<><dt>pid</dt><dd className="font-mono">{state.pid}</dd></>) : null}
							{state?.wsPort ? (<><dt>ws</dt><dd className="font-mono">127.0.0.1:{state.wsPort}</dd></>) : null}
							{state?.lastBeatAt ? (<><dt>last beat</dt><dd className="font-mono">{state.lastBeatAt}</dd></>) : null}
						</dl>
					</div>
					{state?.running ? (
						<Button onClick={() => call("/api/gholam/stop", { method: "POST" })} disabled={busy} size="sm" variant="ghost" data-tooltip-key="gholam.sidebar.start">
							<Pause className="h-3.5 w-3.5" /> stop
						</Button>
					) : (
						<Button onClick={() => call("/api/gholam/start", { method: "POST" })} disabled={busy} size="sm" data-tooltip-key="gholam.sidebar.start">
							<Play className="h-3.5 w-3.5" /> start
						</Button>
					)}
					<div className="meta mt-3" data-tooltip-key="gholam.sidebar.heartbeat">Heartbeat</div>
					<select
						data-tooltip-key="gholam.sidebar.heartbeat"
						className="rounded-md border border-line bg-paper-2 px-2 py-1 text-sm"
						value={state?.heartbeatMs ?? 30000}
						onChange={(e) => call("/api/gholam/heartbeat", {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ intervalMs: Number(e.target.value) }),
						})}
					>
						<option value={5000}>5s</option>
						<option value={15000}>15s</option>
						<option value={30000}>30s</option>
						<option value={60000}>1min</option>
						<option value={300000}>5min</option>
					</select>
				</div>
			}
			inspector={
				<div className="flex h-full flex-col gap-2 p-3 text-xs text-ink-3">
					<div className="meta">Heartbeat payload</div>
					<pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-2xs">
						{state ? JSON.stringify(state, null, 2) : "no data yet"}
					</pre>
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Gholam</div>
						<div className="flex-1" />
						<Button onClick={() => void savePriorities()} disabled={busy} size="sm" data-tooltip-key="gholam.save">
							save priorities
						</Button>
					</div>
					{error ? (
						<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
					) : null}
					<div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-4">
						<section>
							<h3 className="mb-2 text-sm font-medium">Add a priority</h3>
							<div className="flex flex-col gap-2 rounded-md border border-line bg-paper-2 p-3">
								<input
									className="rounded-md border border-line bg-paper px-2 py-1 text-sm"
									placeholder="label — e.g. add github.com/kir/khar to the knowledgebase"
									value={draftLabel}
									onChange={(e) => setDraftLabel(e.target.value)}
								/>
								<input
									className="rounded-md border border-line bg-paper px-2 py-1 font-mono text-xs"
									placeholder="cwd (defaults to current)"
									value={draftCwd}
									onChange={(e) => setDraftCwd(e.target.value)}
								/>
								<select
									className="rounded-md border border-line bg-paper px-2 py-1 text-sm"
									value={draftScope}
									onChange={(e) => setDraftScope(e.target.value)}
								>
									<option value="session">session scope</option>
									<option value="project">project scope</option>
									<option value="global">global scope</option>
								</select>
								<Button onClick={addPriority} size="sm" variant="ghost" data-tooltip-key="gholam.priority.add">
									<Plus className="h-3.5 w-3.5" /> add
								</Button>
							</div>
						</section>
						<section>
							<h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
								<Heart className="h-3.5 w-3.5 text-accent" /> {priorities.length} priority{priorities.length === 1 ? "" : "ies"}
							</h3>
							{priorities.length === 0 ? (
								<em className="text-ink-3">No priorities yet. Add one above.</em>
							) : (
								<ul className="space-y-2">
									{priorities.map((p, i) => (
										<li key={p.id ?? i} data-context-key="gholam.priority" data-tooltip-key="gholam.priority" data-priority-idx={i} className="flex items-start gap-2 rounded-md border border-line bg-paper-2 p-2">
											<div className="flex-1">
												<div className="text-sm font-medium">{p.label}</div>
												<div className="font-mono text-2xs text-ink-3">{p.cwd} · {p.scope}</div>
											</div>
											<button
												type="button"
												className="btn-ghost"
												data-tooltip-key="gholam.priority.remove"
												onClick={() => removePriority(i)}
												aria-label="remove"
											>
												<Trash2 className="h-3.5 w-3.5" />
											</button>
										</li>
									))}
								</ul>
							)}
						</section>
					</div>
				</div>
			}
		/>
	);
}
