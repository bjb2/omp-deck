/**
 * /shell — captured-output terminal surface over the server's `/api/shell/*`
 * routes. Left rail (Layout sidebar slot) lists recent shells; right pane
 * (Layout main slot) shows the create form when nothing is selected, or
 * the live terminal — SSE-attached, ANSI colors preserved — when something is.
 *
 * Transport: native `EventSource` for the stream, regular `fetch` for the
 * rest. The server emits a one-shot tail of buffered output at the start of
 * the SSE stream, so we don't fetch `/tail` separately on attach — but we
 * DO fall back to a single `/tail` GET if the user lands on a still-running
 * shell via deep link (browser refresh on /shell?id=...): the SSE tail
 * covers mid-run attach but `/tail` is the canonical re-attach path. We
 * call it once on selection so re-attached views get prior output even
 * after a quick refresh.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Terminal, Plus, Trash2 } from "lucide-react";
import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { shellApi, ShellApiError, type ShellSummary } from "@/lib/shell-api";

export function ShellView() {
	const [params, setParams] = useSearchParams();
	const selectedId = params.get("id") ?? undefined;

	const [shells, setShells] = useState<ShellSummary[]>([]);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const res = await shellApi.list();
			// Newest first to match the assignment's "newest first" rail.
			setShells(
				res.shells.slice().sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()),
			);
		} catch {
			// Soft-fail: list errors just freeze the rail in place. The create
			// form will surface its own errors on POST.
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const t = window.setInterval(() => void refresh(), 3000);
		return () => window.clearInterval(t);
	}, [refresh]);

	// Keep the rail's "exited" badges fresh while the right pane is open —
	// a shell that exits after selection needs to flip style in the rail too.
	const liveStatus = useLiveStatuses(shells.map((s) => s.id));

	// Functional updaters — none of these depend on `params`, so unrelated
	// query-string changes don't churn the reattach effect downstream.
	const selectId = useCallback((id: string | undefined) => {
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				if (id) next.set("id", id);
				else next.delete("id");
				return next;
			},
			{ replace: false },
		);
	}, [setParams]);

	const onCreate = useCallback(async (command: string, cwd: string): Promise<void> => {
		const res = await shellApi.create({
			command,
			cwd: cwd.trim() ? cwd.trim() : undefined,
		});
		await refresh();
		selectId(res.process.id);
	}, [refresh, selectId]);

	const onGone = useCallback(() => {
		setParams(
			(prev) => {
				const next = new URLSearchParams(prev);
				next.delete("id");
				return next;
			},
			{ replace: false },
		);
		void refresh();
	}, [setParams, refresh]);

	const sidebar = (
		<ShellList
			shells={shells}
			loading={loading}
			selectedId={selectedId}
			liveStatus={liveStatus}
			onSelect={selectId}
			onNew={() => selectId(undefined)}
		/>
	);

	const main = selectedId ? (
		<ShellPane
			id={selectedId}
			onChange={refresh}
			onGone={onGone}
		/>
	) : (
		<ShellCreateForm onCreate={onCreate} />
	);

	return <Layout sidebar={sidebar} main={main} inspector={null} />;
}

// ─── Sidebar ─────────────────────────────────────────────────────────────

function ShellList({
	shells,
	loading,
	selectedId,
	liveStatus,
	onSelect,
	onNew,
}: {
	shells: ShellSummary[];
	loading: boolean;
	selectedId: string | undefined;
	liveStatus: Record<string, "running" | "exited">;
	onSelect: (id: string | undefined) => void;
	onNew: () => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
				<div className="meta flex-1">Shells</div>
				<button
					type="button"
					onClick={onNew}
					className="btn-ghost h-7 px-2 text-xs"
					title="New shell"
					aria-label="New shell"
				>
					<Plus className="h-3.5 w-3.5" />
				</button>
			</header>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{loading && shells.length === 0 ? (
					<div className="px-3 py-4 font-mono text-2xs text-ink-3">loading…</div>
				) : shells.length === 0 ? (
					<div className="px-3 py-4 font-mono text-2xs text-ink-3">
						No shells yet. Use the + button to start one.
					</div>
				) : (
					<ul>
						{shells.map((s) => (
							<ShellListRow
								key={s.id}
								shell={s}
								active={selectedId === s.id}
								liveStatus={liveStatus[s.id] ?? s.status}
								onSelect={() => onSelect(s.id)}
							/>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function ShellListRow({
	shell,
	active,
	liveStatus,
	onSelect,
}: {
	shell: ShellSummary;
	active: boolean;
	liveStatus: "running" | "exited";
	onSelect: () => void;
}) {
	const commandPreview = shell.command.length > 60 ? `${shell.command.slice(0, 59)}…` : shell.command;
	return (
		<li>
			<button
				type="button"
				onClick={onSelect}
				className={cn(
					"group flex w-full items-center gap-2 border-l-2 border-transparent px-3 py-2 text-left transition hover:bg-paper-3/60",
					active && "border-accent bg-accent-soft/30",
				)}
			>
				<StatusDot status={liveStatus} />
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-2xs text-ink" title={shell.command}>
						{commandPreview || "(empty)"}
					</div>
					<div className="mt-0.5 font-mono text-2xs text-ink-3">
						{relativeTime(shell.startedAt)}
						{shell.exitCode !== undefined ? ` · exit ${shell.exitCode}` : ""}
					</div>
				</div>
			</button>
		</li>
	);
}

function StatusDot({ status }: { status: "running" | "exited" }) {
	if (status === "running") {
		return (
			<span
				className="h-2 w-2 shrink-0 rounded-full bg-accent"
				aria-label="running"
				title="running"
			/>
		);
	}
	return (
		<span
			className="h-2 w-2 shrink-0 rounded-full bg-ink-3"
			aria-label="exited"
			title="exited"
		/>
	);
}

// ─── Create form ─────────────────────────────────────────────────────────

function ShellCreateForm({ onCreate }: { onCreate: (command: string, cwd: string) => Promise<void> }) {
	const [command, setCommand] = useState("");
	const [cwd, setCwd] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function submit(e: FormEvent<HTMLFormElement>): Promise<void> {
		e.preventDefault();
		if (!command.trim() || submitting) return;
		setSubmitting(true);
		setError(undefined);
		try {
			await onCreate(command, cwd);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 flex-col items-center justify-center px-6">
			<form
				onSubmit={submit}
				className="w-full max-w-xl rounded-xl border border-line bg-paper-2 p-5 shadow-sm"
			>
				<div className="mb-3 flex items-center gap-2">
					<Terminal className="h-4 w-4 text-ink-2" />
					<div className="meta">New shell</div>
				</div>
				<label className="mb-3 block">
					<span className="meta mb-1 block">Command</span>
					<input
						autoFocus
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						placeholder="echo hello && date"
						spellCheck={false}
						className="field h-9 w-full px-2 font-mono text-sm"
					/>
				</label>
				<label className="mb-4 block">
					<span className="meta mb-1 block">Working directory (optional)</span>
					<input
						value={cwd}
						onChange={(e) => setCwd(e.target.value)}
						placeholder="defaults to server cwd"
						spellCheck={false}
						className="field h-9 w-full px-2 font-mono text-xs"
					/>
				</label>
				{error ? (
					<div className="mb-3 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 font-mono text-2xs text-danger">
						{error}
					</div>
				) : null}
				<div className="flex justify-end gap-2">
					<Button type="submit" variant="primary" disabled={!command.trim() || submitting}>
						{submitting ? "Starting…" : "Run"}
					</Button>
				</div>
			</form>
		</div>
	);
}

// ─── Pane: created shell ─────────────────────────────────────────────────

function ShellPane({
	id,
	onChange,
	onGone,
}: {
	id: string;
	onChange: () => void;
	onGone: () => void;
}) {
	const [summary, setSummary] = useState<ShellSummary | undefined>();
	const [body, setBody] = useState("");
	const [input, setInput] = useState("");
	const [sendingInput, setSendingInput] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const bodyRef = useRef<HTMLPreElement>(null);
	const esRef = useRef<EventSource | null>(null);
	const stickyRef = useRef(true); // user-stayed-near-bottom flag

	// Reattach effect — single effect keyed on `id` so it tears down cleanly
	// when the user switches shells. The two viable server transports are:
	//
	//   - SSE stream (`/api/shell/:id/stream`) for running shells. The server
	//     re-emits the buffered tail at handshake, so we DON'T also fetch
	//     `/tail` — that would duplicate output. `withCredentials: true` is
	//     required so the global auth gate (cookie-based on non-loopback
	//     deployments) sees the session.
	//   - GET `/tail` for shells that are already exited. For purged
	//     processes the route returns 404 (caught as `ShellApiError.isGone`);
	//     `tail.status === "unknown"` with an empty buffer is the alternate
	//     "exited and gone" signal.
	//
	// Only a 404 (process purged) or `tail.status === "unknown"` triggers
	// `onGone()`. Transient 401/500/network failures keep the pane mounted
	// and surface the error inline, so a server hiccup never silently
	// replaces the terminal with the create form.
	//
	// Resetting body/summary/input/error on `[id]` change prevents the
	// previous shell's output from briefly flashing in the new pane.
	useEffect(() => {
		setBody("");
		setSummary(undefined);
		setInput("");
		setError(undefined);

		let alive = true;
		let es: EventSource | null = null;

		(async (): Promise<void> => {
			let s: ShellSummary;
			try {
				s = await shellApi.get(id);
			} catch (err) {
				if (!alive) return;
				if (err instanceof ShellApiError && err.isGone) {
					onGone();
					return;
				}
				setError(err instanceof Error ? err.message : String(err));
				return;
			}
			if (!alive) return;
			setSummary(s);

			if (s.status === "exited") {
				try {
					const t = await shellApi.tail(id);
					if (!alive) return;
					if (t.status === "unknown") {
						onGone();
						return;
					}
					if (t.text) setBody(t.text);
				} catch (err) {
					if (!alive) return;
					if (err instanceof ShellApiError && err.isGone) {
						onGone();
						return;
					}
					setError(err instanceof Error ? err.message : String(err));
				}
				return;
			}

			es = new EventSource(`/api/shell/${encodeURIComponent(id)}/stream`, {
				withCredentials: true,
			});
			esRef.current = es;
			es.onmessage = (ev) => {
				const chunk = ev.data ?? "";
				if (!chunk) return;
				setBody((prev) => prev + chunk);
				if (chunk.includes("[exit ")) {
					es?.close();
					esRef.current = null;
					void shellApi
						.get(id)
						.then((next) => {
							if (alive) {
								setSummary(next);
								onChange();
							}
						})
						.catch(() => undefined);
				}
			};
			es.onerror = () => {
				// EventSource auto-retries. Only intervene if the shell is
				// already exited — the server closes the stream deliberately
				// and a retry would just bounce. Network/401 blips fall
				// through; EventSource's own backoff handles them.
				void shellApi
					.get(id)
					.then((s2) => {
						if (s2.status === "exited" && es) {
							es.close();
							esRef.current = null;
							if (alive) setSummary(s2);
						}
					})
					.catch(() => undefined);
			};
		})();

		return () => {
			alive = false;
			es?.close();
			esRef.current = null;
		};
	}, [id, onGone, onChange]);

	// Auto-scroll only when the user is near the bottom (within 30px). If
	// they've scrolled up to read a previous burst, we don't yank them.
	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		const onScroll = (): void => {
			const dist = el.scrollHeight - el.clientHeight - el.scrollTop;
			stickyRef.current = dist <= 30;
		};
		el.addEventListener("scroll", onScroll);
		return () => el.removeEventListener("scroll", onScroll);
	}, []);

	useEffect(() => {
		const el = bodyRef.current;
		if (!el) return;
		if (stickyRef.current) {
			el.scrollTop = el.scrollHeight;
		}
	}, [body]);

	async function onSendInput(): Promise<void> {
		if (!input || sendingInput) return;
		setSendingInput(true);
		setError(undefined);
		try {
			// Server expects the raw line; appending "\n" matches expected
			// TTY semantics for any line-buffered stdin consumer.
			await shellApi.input(id, `${input}\n`);
			setInput("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSendingInput(false);
		}
	}

	async function onKill(): Promise<void> {
		try {
			await shellApi.kill(id);
			// Server emits `[exit N]` asynchronously after SIGTERM; the SSE
			// handler will pick that up and flip the status. No need to
			// re-fetch here.
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	const isRunning = summary?.status === "running";

	return (
		<div className="flex h-full min-h-0 flex-col">
			<header className="flex shrink-0 items-center gap-3 border-b border-line bg-paper px-3 py-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<span
							className={cn(
								"h-2 w-2 shrink-0 rounded-full",
								isRunning ? "bg-accent" : "bg-ink-3",
							)}
							aria-hidden="true"
						/>
						<span className="font-mono text-2xs text-ink-3">
							{summary?.status === "exited"
								? `exited${summary.exitCode !== undefined ? ` (${summary.exitCode})` : ""}`
								: "running"}
						</span>
					</div>
					<div className="mt-0.5 truncate font-mono text-xs text-ink" title={summary?.command}>
						{summary?.command ?? id}
					</div>
					{summary?.cwd ? (
						<div className="truncate font-mono text-2xs text-ink-3" title={summary.cwd}>
							{summary.cwd}
						</div>
					) : null}
				</div>
				<Button
					variant="danger"
					size="sm"
					onClick={() => void onKill()}
					disabled={!isRunning}
					title="Send SIGTERM"
				>
					<Trash2 className="h-3.5 w-3.5" />
					Kill
				</Button>
			</header>

			{error ? (
				<div className="border-b border-line bg-danger/10 px-3 py-1.5 font-mono text-2xs text-danger">
					{error}
				</div>
			) : null}

			<pre
				ref={bodyRef}
				className="shell-body min-h-0 flex-1 overflow-y-auto bg-paper-2 px-3 py-2 font-mono text-2xs text-ink"
			>
				{body}
			</pre>

			<form
				onSubmit={(e) => {
					e.preventDefault();
					void onSendInput();
				}}
				className="flex shrink-0 items-center gap-2 border-t border-line bg-paper px-3 py-2"
			>
				<span className="font-mono text-2xs text-ink-3">stdin</span>
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={isRunning ? "send a line of input" : "shell has exited"}
					disabled={!isRunning}
					spellCheck={false}
					className="field h-8 flex-1 px-2 font-mono text-xs disabled:opacity-50"
				/>
				<Button type="submit" variant="primary" size="sm" disabled={!isRunning || !input || sendingInput}>
					Send
				</Button>
			</form>
		</div>
	);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Quietly poll each shell's status so the rail badges stay in sync even
 * while the user is busy reading the right pane. Polling is cheap (single
 * GET per shell) and the alternative is teaching the rail to subscribe
 * to N EventSources — not worth it.
 */
function useLiveStatuses(ids: string[]): Record<string, "running" | "exited"> {
	const [statuses, setStatuses] = useState<Record<string, "running" | "exited">>({});
	const key = useMemo(() => ids.slice().sort().join(","), [ids]);
	useEffect(() => {
		if (ids.length === 0) return;
		let alive = true;
		const tick = async (): Promise<void> => {
			const updates: Record<string, "running" | "exited"> = {};
			await Promise.all(
				ids.map(async (id) => {
					try {
						const s = await shellApi.get(id);
						updates[id] = s.status;
					} catch {
						// shell gone — don't crash the rail; omit from map
					}
				}),
			);
			if (alive) setStatuses((prev) => ({ ...prev, ...updates }));
		};
		void tick();
		const t = window.setInterval(() => void tick(), 3000);
		return () => {
			alive = false;
			window.clearInterval(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return statuses;
}

/**
 * Brief relative time formatter (no shared util — each view keeps its own
 * to stay decoupled from `time.ts`).
 */
function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	if (ms < 5_000) return "just now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
	if (ms < 60 * 60_000) return `${Math.floor(ms / 60_000)}m ago`;
	if (ms < 24 * 60 * 60_000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
	return `${Math.floor(ms / (24 * 60 * 60_000))}d ago`;
}
