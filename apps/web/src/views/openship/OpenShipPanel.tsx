import { useEffect, useState } from "react";
import { ExternalLink, Plug, RefreshCw, Rocket, ScrollText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	asOpenshipErrorBody,
	openshipApi,
	isNoTokenError,
	type OpenshipDeployment,
	type OpenshipProject,
} from "@/lib/openship-api";

/**
 * OpenShip panel — renders inside `/integrations`. Visual language matches
 * OverviewView: paper surfaces, `meta`/`tracking-meta` mono labels,
 * accent pill, mono metric values.
 *
 * Empty state is the 503/no-token connect hint (not an error). Real errors
 * from the upstream OpenShip server collapse into the inline error strip
 * so a transient blip never blanks the whole panel.
 */
export function OpenShipPanel() {
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [projects, setProjects] = useState<OpenshipProject[] | null>(null);
	const [error, setError] = useState<PanelError | null>(null);
	const [loadingProjects, setLoadingProjects] = useState(false);

	async function refresh() {
		setLoadingProjects(true);
		setError(null);
		try {
			const [status, list] = await Promise.all([openshipApi.status(), openshipApi.listProjects()]);
			setConfigured(status.configured);
			setProjects(list.items);
		} catch (err) {
			setProjects(null);
			if (!isNoTokenError(err)) setError(describeError(err));
		} finally {
			setLoadingProjects(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	if (configured === false) {
		return <NoTokenHint />;
	}

	return (
		<section className="flex flex-col gap-6 rounded-2xl border border-line bg-paper-2 px-6 py-6">
			<header className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Plug className="h-4 w-4 text-accent" />
					<h2 className="text-lg font-medium text-ink">OpenShip</h2>
					<span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
						ship.v244.net
					</span>
				</div>
				<button
					type="button"
					onClick={() => void refresh()}
					disabled={loadingProjects}
					className="flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 text-sm text-ink hover:border-ink/30 disabled:opacity-50"
					title="Refresh projects"
				>
					<RefreshCw className={cn("h-3.5 w-3.5", loadingProjects && "animate-spin")} />
					Refresh
				</button>
			</header>

			{error ? (
				<ErrorStrip error={error} onRetry={() => void refresh()} />
			) : null}

			{loadingProjects && !projects ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{[0, 1, 2].map((i) => (
						<div key={i} className="h-32 animate-pulse rounded-xl border border-line bg-paper" aria-hidden="true" />
					))}
				</div>
			) : projects && projects.length > 0 ? (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{projects.map((p) => (
						<ProjectCard key={p.id} project={p} onChanged={refresh} />
					))}
				</div>
			) : (
				<div className="rounded border border-line bg-paper px-4 py-6 text-center text-sm text-ink-3">
					No projects yet on this OpenShip account.
				</div>
			)}
		</section>
	);
}

function NoTokenHint() {
	return (
		<section className="flex flex-col gap-3 rounded-2xl border border-line bg-paper-2 px-6 py-6">
			<div className="flex items-center gap-2">
				<Plug className="h-5 w-5 text-accent" />
				<h2 className="text-lg font-medium text-ink">Connect OpenShip</h2>
			</div>
			<p className="text-sm text-ink-2">
				Set <code className="paper-code px-1 py-0.5 text-xs">MCP_OPENSHIP_TOKEN</code> in the deck's environment, then restart the
				server. The same token powers the gholam sidecar's OpenShip bridge — one credential covers chat-driven and first-class REST calls.
			</p>
			<div className="rounded border border-line bg-paper px-3 py-2 text-xs text-ink-3">
				<p>
					Token scopes:{" "}
					<code className="paper-code px-1 py-0.5">get_projects</code>,{" "}
					<code className="paper-code px-1 py-0.5">post_deployments</code>,{" "}
					<code className="paper-code px-1 py-0.5">get_deployments_by_id_logs</code> (read + deploy).
				</p>
			</div>
		</section>
	);
}

function ProjectCard({ project, onChanged }: { project: OpenshipProject; onChanged: () => void }) {
	const [expanded, setExpanded] = useState(false);
	const [deployments, setDeployments] = useState<OpenshipDeployment[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [confirmDeploy, setConfirmDeploy] = useState(false);
	const [deployBusy, setDeployBusy] = useState(false);
	const [error, setError] = useState<PanelError | null>(null);
	const [logsFor, setLogsFor] = useState<string | null>(null);

	async function loadDeployments() {
		setLoading(true);
		setError(null);
		try {
			const res = await openshipApi.getProject(project.id);
			setDeployments(res.deployments);
		} catch (err) {
			setError(describeError(err));
		} finally {
			setLoading(false);
		}
	}

	async function doDeploy() {
		setDeployBusy(true);
		setError(null);
		setConfirmDeploy(false);
		try {
			await openshipApi.triggerDeploy(project.id);
			// Re-fetch deployments so the new deployment shows up immediately.
			await loadDeployments();
			onChanged();
		} catch (err) {
			setError(describeError(err));
		} finally {
			setDeployBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-2 rounded-xl border border-line bg-paper px-3 py-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-ink">{project.name ?? project.id}</div>
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{project.status ?? "unknown"}</div>
				</div>
				{project.url ? (
					<a
						href={project.url}
						target="_blank"
						rel="noreferrer"
						className="shrink-0 text-ink-3 hover:text-ink"
						title={project.url}
					>
						<ExternalLink className="h-3.5 w-3.5" />
					</a>
				) : null}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => {
						setExpanded((cur) => {
							const next = !cur;
							if (next && !deployments && !loading) void loadDeployments();
							return next;
						});
					}}
					className="rounded-full border border-line bg-paper px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-2 hover:border-ink/30"
				>
					{expanded ? "Hide" : "Deployments"}
				</button>
				<button
					type="button"
					onClick={() => setConfirmDeploy(true)}
					disabled={deployBusy}
					className="flex items-center gap-1 rounded-full bg-accent px-3 py-1 font-mono text-2xs uppercase tracking-meta text-paper hover:bg-accent-2 disabled:opacity-50"
				>
					<Rocket className="h-3 w-3" />
					{deployBusy ? "Triggering…" : "Deploy"}
				</button>
			</div>

			{error ? (
				<div className="rounded border border-line bg-paper-2 px-2 py-1 text-xs text-ink-2">
					<ErrorLine error={error} />
				</div>
			) : null}

			{expanded ? (
				<div className="mt-1 flex flex-col gap-1 border-t border-line pt-2">
					{loading ? (
						<div className="h-4 w-1/2 animate-pulse rounded bg-paper-3" aria-hidden="true" />
					) : deployments && deployments.length > 0 ? (
						<ul className="flex flex-col gap-1">
							{deployments.slice(0, 5).map((d) => (
								<li key={d.id} className="flex items-center gap-2 text-xs text-ink-2">
									<span className="font-mono uppercase tracking-meta text-ink-4">{d.status ?? "—"}</span>
									<span className="flex-1 truncate font-mono text-2xs text-ink-3" title={d.id}>{d.id}</span>
									{d.commit ? <span className="font-mono text-2xs text-ink-4">{d.commit.slice(0, 7)}</span> : null}
									<button
										type="button"
										onClick={() => setLogsFor(d.id)}
										className="text-ink-3 hover:text-ink"
										title="View logs"
									>
										<ScrollText className="h-3 w-3" />
									</button>
								</li>
							))}
						</ul>
					) : (
						<div className="font-mono text-2xs text-ink-3">no deployments</div>
					)}
				</div>
			) : null}

			{confirmDeploy ? (
				<div className="mt-1 flex items-center justify-between gap-2 rounded border border-accent/40 bg-accent/10 px-2 py-1.5 text-xs text-ink-2">
					<span>Trigger a redeploy for this project?</span>
					<div className="flex gap-1">
						<button
							type="button"
							onClick={doDeploy}
							disabled={deployBusy}
							className="rounded bg-accent px-2 py-0.5 text-paper hover:bg-accent-2 disabled:opacity-50"
						>
							Confirm
						</button>
						<button
							type="button"
							onClick={() => setConfirmDeploy(false)}
							disabled={deployBusy}
							className="rounded border border-line bg-paper px-2 py-0.5 text-ink-2 hover:text-ink"
						>
							Cancel
						</button>
					</div>
				</div>
			) : null}

			{logsFor ? (
				<LogsDrawer deploymentId={logsFor} onClose={() => setLogsFor(null)} />
			) : null}
		</div>
	);
}

function LogsDrawer({ deploymentId, onClose }: { deploymentId: string; onClose: () => void }) {
	const [lines, setLines] = useState<string[] | null>(null);
	const [error, setError] = useState<PanelError | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(null);
		openshipApi
			.deploymentLogs(deploymentId, 200)
			.then((res) => {
				if (!alive) return;
				setLines(res.lines);
				setLoading(false);
			})
			.catch((err) => {
				if (!alive) return;
				setError(describeError(err));
				setLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [deploymentId]);

	return (
		<div className="fixed inset-0 z-40 flex justify-end bg-ink/40" onClick={onClose}>
			<div
				className="flex h-full w-full max-w-xl flex-col gap-3 bg-paper-2 p-4 shadow-xl"
				onClick={(e) => e.stopPropagation()}
				role="dialog"
				aria-label="Deployment logs"
			>
				<header className="flex items-center justify-between gap-2 border-b border-line pb-2">
					<div className="min-w-0">
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">logs</div>
						<div className="truncate font-mono text-xs text-ink" title={deploymentId}>{deploymentId}</div>
					</div>
					<button type="button" onClick={onClose} className="text-ink-3 hover:text-ink" title="Close">
						<X className="h-4 w-4" />
					</button>
				</header>
				{loading ? (
					<div className="text-sm text-ink-3">Loading logs…</div>
				) : error ? (
					<div className="text-sm text-ink-3">
						<ErrorLine error={error} />
					</div>
				) : lines && lines.length > 0 ? (
					<pre className="flex-1 overflow-auto rounded border border-line bg-paper p-3 font-mono text-2xs leading-relaxed text-ink-2">
						{lines.join("\n")}
					</pre>
				) : (
					<div className="text-sm text-ink-3">No log output.</div>
				)}
			</div>
		</div>
	);
}

interface PanelError {
	message: string;
	kind: OpenshipErrorKind;
	retryable: boolean;
	endpoint?: string;
	upstreamStatus?: number;
}

type OpenshipErrorKind = "auth" | "timeout" | "unreachable" | "upstream" | "internal" | "unknown";

function describeError(err: unknown): PanelError {
	const body = asOpenshipErrorBody(err);
	const message = body?.error ?? messageOf(err);
	return {
		message,
		kind: body?.kind ?? "unknown",
		retryable: Boolean(body?.retryable),
		endpoint: body?.endpoint,
		upstreamStatus: body?.upstreamStatus,
	};
}

function messageOf(err: unknown): string {
	if (err && typeof err === "object" && "message" in err) {
		const m: unknown = err.message;
		if (typeof m === "string") return m;
	}
	return String(err);
}

function ErrorStrip({ error, onRetry }: { error: PanelError; onRetry: () => void }): JSX.Element {
	const tone = toneFor(error.kind);
	return (
		<div className={cn("flex flex-col gap-1 rounded border px-3 py-2 text-sm", tone.box)}>
			<div className="flex items-center justify-between gap-2">
				<div className={cn("flex items-center gap-2", tone.text)}>
					{labelFor(error.kind)}
				</div>
				{error.retryable ? (
					<button
						type="button"
						onClick={onRetry}
						className="flex items-center gap-1 rounded border border-line bg-paper px-2 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-2 hover:border-ink/30"
					>
						<RefreshCw className="h-3 w-3" />
						Retry
					</button>
				) : null}
			</div>
			<div className="text-ink-2">{error.message}</div>
			{error.endpoint ? (
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					endpoint: {error.endpoint}
					{error.upstreamStatus ? ` · upstream HTTP ${error.upstreamStatus}` : ""}
				</div>
			) : null}
		</div>
	);
}

function ErrorLine({ error }: { error: PanelError }): JSX.Element {
	return (
		<span>
			<span className="font-mono uppercase tracking-meta text-ink-3">{labelText(error.kind)}:</span>{" "}
			{error.message}
		</span>
	);
}

function labelText(kind: OpenshipErrorKind): string {
	switch (kind) {
		case "auth":
			return "auth";
		case "timeout":
			return "timeout";
		case "unreachable":
			return "unreachable";
		case "upstream":
			return "upstream";
		case "internal":
			return "internal";
		default:
			return "error";
	}
}

function labelFor(kind: OpenshipErrorKind): JSX.Element {
	return <span className="font-mono text-2xs uppercase tracking-meta">{labelText(kind)}</span>;
}

function toneFor(kind: OpenshipErrorKind): { box: string; text: string } {
	switch (kind) {
		case "auth":
			return { box: "border-accent/40 bg-accent/10", text: "text-accent" };
		case "timeout":
		case "unreachable":
			return { box: "border-warn/40 bg-warn/10", text: "text-warn" };
		case "upstream":
			return { box: "border-line bg-paper", text: "text-ink-2" };
		case "internal":
			return { box: "border-danger/40 bg-danger/10", text: "text-danger" };
		default:
			return { box: "border-line bg-paper", text: "text-ink-2" };
	}
}
