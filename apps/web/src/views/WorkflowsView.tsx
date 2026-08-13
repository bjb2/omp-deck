/**
 * Workflowz view — fire-and-watch surface for parallel multi-agent workflows.
 *
 * The user types one or more prompts, picks a mode (`parallel`, `ultrathink`,
 * `workflowz`, `orchestrate`), and submits. The deck fires each task into its
 * own ephemeral session and streams the results back as they settle. Each
 * task shows its current status (running / ok / error) and the captured
 * assistant output.
 */
import { useCallback, useEffect, useState } from "react";
import { Loader2, Play, Plus, X } from "lucide-react";

import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";

interface TaskResult {
	taskId: string;
	role: string;
	status: "running" | "ok" | "error";
	output?: string;
	error?: string;
}

interface WorkflowStatus {
	workflowId: string;
	mode: string;
	startedAt: string;
	finishedAt?: string;
	results: TaskResult[];
}

const MODES = [
	{ id: "parallel", label: "Parallel", hint: "fire all prompts at once" },
	{ id: "ultrathink", label: "Ultrathink", hint: "deep, careful reasoning" },
	{ id: "workflowz", label: "Workflowz", hint: "primary + critique + alternate + synthesize" },
	{ id: "orchestrate", label: "Orchestrate", hint: "plan & delegate, no direct execution" },
] as const;

export function WorkflowsView(): JSX.Element {
	const [prompts, setPrompts] = useState<string[]>([""]);
	const [mode, setMode] = useState<typeof MODES[number]["id"]>("parallel");
	const [running, setRunning] = useState(false);
	const [workflow, setWorkflow] = useState<WorkflowStatus | null>(null);
	const [error, setError] = useState<string | undefined>();

	const dispatch = useCallback(async (): Promise<void> => {
		const cleaned = prompts.map((p) => p.trim()).filter((p) => p.length > 0);
		if (cleaned.length === 0) return;
		setRunning(true);
		setError(undefined);
		setWorkflow(null);
		try {
			const res = await fetch("/api/workflows", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode, tasks: cleaned.map((prompt) => ({ prompt })) }),
			});
			if (!res.ok) throw new Error(`workflows dispatch failed: ${res.status}`);
			const json = (await res.json()) as { workflowId: string };
			const poll = async (): Promise<void> => {
				const r = await fetch(`/api/workflows/${json.workflowId}`);
				if (r.ok) {
					const status = (await r.json()) as WorkflowStatus;
					setWorkflow(status);
					if (!status.finishedAt) {
						setTimeout(poll, 1_500);
					} else {
						setRunning(false);
					}
				} else {
					setRunning(false);
				}
			};
			void poll();
		} catch (e) {
			setError(String((e as Error).message ?? e));
			setRunning(false);
		}
	}, [prompts, mode]);

	return (
		<Layout
			sidebar={
				<div className="flex h-full flex-col gap-3 p-3 text-sm">
					<div className="meta">Mode</div>
					<div className="space-y-2">
						{MODES.map((m) => (
							<button
								key={m.id}
								type="button"
								onClick={() => setMode(m.id)}
								className={`block w-full rounded-md border px-2 py-1.5 text-left ${mode === m.id ? "border-accent bg-accent-soft/40" : "border-line bg-paper-2 hover:border-accent/60"}`}
							>
								<div className="font-medium">{m.label}</div>
								<div className="text-2xs text-ink-3">{m.hint}</div>
							</button>
						))}
					</div>
					<div className="meta mt-3">Tips</div>
					<ul className="space-y-1 text-xs text-ink-3">
						<li>Each task runs in its own ephemeral session.</li>
						<li>`workflowz` synthesizes three angles into one answer.</li>
						<li>`ultrathink` adds a "think deeply" preamble to every task.</li>
						<li>Results stream as each task settles.</li>
					</ul>
				</div>
			}
			inspector={
				<div className="flex h-full flex-col gap-2 p-3 text-xs text-ink-3">
					<div className="meta">Workflow</div>
					{workflow ? (
						<dl className="space-y-1">
							<dt className="text-ink-2">id</dt>
							<dd className="font-mono text-2xs break-all">{workflow.workflowId}</dd>
							<dt className="text-ink-2 mt-2">started</dt>
							<dd className="font-mono text-2xs">{workflow.startedAt}</dd>
							{workflow.finishedAt ? (
								<>
									<dt className="text-ink-2 mt-2">finished</dt>
									<dd className="font-mono text-2xs">{workflow.finishedAt}</dd>
								</>
							) : null}
						</dl>
					) : (
						<em>No workflow dispatched yet.</em>
					)}
				</div>
			}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Workflows</div>
						<div className="flex-1" />
						<Button onClick={() => setPrompts((prev) => [...prev, ""])} size="sm" variant="ghost">
							<Plus className="h-3.5 w-3.5" /> add task
						</Button>
						<Button onClick={() => void dispatch()} disabled={running} size="sm">
							{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
							dispatch
						</Button>
					</div>
					{error ? (
						<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">{error}</div>
					) : null}
					<div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
						<div className="space-y-2">
							{prompts.map((p, i) => (
								<div key={i} className="flex items-start gap-2">
									<span className="mt-2 font-mono text-2xs text-ink-3">{i + 1}.</span>
									<textarea
										className="min-h-[60px] flex-1 rounded-md border border-line bg-paper-2 p-2 text-sm"
										placeholder={`prompt ${i + 1}`}
										value={p}
										onChange={(e) => setPrompts((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
									/>
									{prompts.length > 1 ? (
										<button
											type="button"
											className="btn-ghost mt-1"
											onClick={() => setPrompts((prev) => prev.filter((_, j) => j !== i))}
											aria-label="remove"
										>
											<X className="h-3.5 w-3.5" />
										</button>
									) : null}
								</div>
							))}
						</div>
						{workflow ? (
							<div className="workflowz-grid">
								{workflow.results.map((r) => (
									<div key={r.taskId} className="workflowz-card">
										<div className={`status ${r.status}`}>
											<span className="dot" /> {r.role} · {r.status}
										</div>
										<pre>{r.output ?? r.error ?? "(running...)"}</pre>
									</div>
								))}
							</div>
						) : null}
					</div>
				</div>
			}
		/>
	);
}
