import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, ExternalLink, Loader2, Plus, Plug, X } from "lucide-react";
import type { McpHealthStatus } from "@omp-deck/protocol";
import { Layout } from "@/components/Layout";
import { OpenShipPanel } from "@/views/openship/OpenShipPanel";
import { McpServerActions } from "@/components/mcp/McpServerActions";
import { McpToolsPopover } from "@/components/mcp/McpToolsPopover";
import { storefrontApi } from "@/lib/storefront-api";
import { useStore, pushMcpToast } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * /integrations — one-screen MCP manager.
 *
 * Three responsibilities:
 *   1. List every server in `mcpHealth.response.status[]` with the live
 *      state, latency, and tool count.
 *   2. Wire the shared `McpServerActions` (enable/disable/refresh/delete)
 *      and `McpToolsPopover` (per-tool toggle) so this page stays in
 *      lock-step with the chrome chip popover and the storefront strip.
 *   3. Offer an "Add MCP server" form that posts to `/api/mcp/install`
 *      with name + type + command/url.
 */
export function IntegrationsView() {
	const response = useStore((s) => s.mcpHealth.response);
	const [addOpen, setAddOpen] = useState(false);
	const [toolsFor, setToolsFor] = useState<string | null>(null);

	useEffect(() => {
		if (response) return;
		void storefrontApi.mcpHealth().then((next) => {
			useStore.setState((s) =>
				s.mcpHealth.response
					? {}
					: { mcpHealth: { ...s.mcpHealth, response: next, lastReceivedAtMs: Date.now() } },
			);
		});
	}, [response]);

	const status = response?.status ?? [];

	return (
		<>
			<Layout
				sidebar={
					<div className="p-3">
						<div className="meta mb-2">Integrations</div>
						<div className="text-sm text-ink-3">
							Manage MCP servers — the action group is shared with the chrome
							chip popover and the storefront strip.
						</div>
					</div>
				}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">Integrations</div>
							<span className="rounded border border-accent/40 bg-accent/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
								MCP
							</span>
							<button
								type="button"
								onClick={() => setAddOpen(true)}
								className="ml-auto inline-flex items-center gap-1 rounded border border-line bg-paper px-2 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-accent hover:text-accent"
							>
								<Plus className="h-3 w-3" />
								Add MCP server
							</button>
						</div>
						<div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
							{status.length === 0 ? <EmptyHint /> : (
								<ServerTable
									rows={status}
									toolsFor={toolsFor}
									setToolsFor={setToolsFor}
								/>
							)}
							<div className="mx-auto w-full max-w-5xl">
								<OpenShipPanel />
							</div>
						</div>
					</div>
				}
				inspector={null}
				topBar={null}
			/>
			{addOpen && typeof document !== "undefined"
				? createPortal(
						<AddMcpDialog onClose={() => setAddOpen(false)} />,
						document.body,
					)
				: null}
			{toolsFor && typeof document !== "undefined"
				? createPortal(
						<div
							style={{ position: "fixed", right: 24, top: 80, zIndex: 70 }}
						>
							<McpToolsPopover name={toolsFor} onClose={() => setToolsFor(null)} />
						</div>,
						document.body,
					)
				: null}
		</>
	);
}

function EmptyHint() {
	return (
		<div className="mx-auto w-full max-w-2xl rounded border border-line bg-paper-2 p-4">
			<div className="mb-1.5 flex items-center gap-2">
				<Plug className="h-4 w-4 text-ink-3" />
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
					No MCP servers configured
				</span>
			</div>
			<p className="text-sm text-ink-2">
				Install a server from the catalog or paste a Smithery URL — every server you
				add lands here, in the chrome chip popover, and in the storefront strip.{" "}
				<a
					href="https://github.com/bjb2/omp-deck/blob/main/docs/proposals/routines-v1-plan.md#5-integrations-via-mcp-v15"
					target="_blank"
					rel="noreferrer"
					className="inline-flex items-center gap-1 text-accent hover:underline"
				>
					Setup guide
					<ExternalLink className="h-3 w-3" />
				</a>
			</p>
		</div>
	);
}

function ServerTable({
	rows,
	toolsFor,
	setToolsFor,
}: {
	rows: McpHealthStatus[];
	toolsFor: string | null;
	setToolsFor: (name: string | null) => void;
}) {
	return (
		<div className="overflow-hidden rounded border border-line">
			<table className="w-full text-sm">
				<thead>
					<tr className="bg-paper-2 text-left font-mono text-2xs uppercase tracking-meta text-ink-3">
						<th className="px-3 py-2">Name</th>
						<th className="px-3 py-2">State</th>
						<th className="px-3 py-2">Latency</th>
						<th className="px-3 py-2">Tools</th>
						<th className="px-3 py-2 text-right">Actions</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id} className="border-t border-line">
							<td className="px-3 py-2 font-mono text-2xs text-ink">{row.name}</td>
							<td className="px-3 py-2">
								<StatePill state={row.state} />
							</td>
							<td className="px-3 py-2 font-mono text-2xs text-ink-3">
								{row.lastLatencyMs != null ? `${row.lastLatencyMs}ms` : "—"}
							</td>
							<td className="px-3 py-2">
								{row.toolCount != null ? (
									<button
										type="button"
										onClick={() => setToolsFor(toolsFor === row.name ? null : row.name)}
										className="font-mono text-2xs text-accent hover:underline"
									>
										{row.toolCount} tool{row.toolCount === 1 ? "" : "s"}
									</button>
								) : (
									<span className="font-mono text-2xs text-ink-3">—</span>
								)}
							</td>
							<td className="px-3 py-2">
								<div className="flex justify-end">
									<McpServerActions
										name={row.name}
										state={row.state}
										{...(row.toolCount !== undefined ? { toolCount: row.toolCount } : {})}
										variant="compact"
										onOpenTools={() => setToolsFor(toolsFor === row.name ? null : row.name)}
									/>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

const STATE_PILL: Record<string, string> = {
	healthy: "bg-success/15 text-success",
	degraded: "bg-warn/15 text-warn",
	unreachable: "bg-danger/15 text-danger",
	disabled: "bg-ink-4/15 text-ink-3",
	unknown: "bg-ink-3/15 text-ink-3",
};

function StatePill({ state }: { state: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta",
				STATE_PILL[state] ?? STATE_PILL.unknown,
			)}
		>
			{state}
		</span>
	);
}

/**
 * Tiny install dialog. Posts to `/api/mcp/install` with the protocol
 * `McpServerEntry` shape, then re-probes so the row appears in the
 * table without waiting for the next 30s probe cycle.
 */
function AddMcpDialog({ onClose }: { onClose: () => void }) {
	const [name, setName] = useState("");
	const [kind, setKind] = useState<"stdio" | "http">("stdio");
	const [command, setCommand] = useState("");
	const [url, setUrl] = useState("");
	const [busy, setBusy] = useState(false);

	async function submit(): Promise<void> {
		const trimmedName = name.trim();
		if (!trimmedName || busy) return;
		if (kind === "stdio" && !command.trim()) return;
		if (kind === "http" && !url.trim()) return;
		setBusy(true);
		try {
			const config =
				kind === "stdio"
					? {
							type: "stdio" as const,
							command: command.trim(),
							args: command.trim().split(/\s+/).slice(1),
						}
					: { type: "http" as const, url: url.trim() };
			const res = await storefrontApi.installMcpServer(trimmedName, config);
			if (!res?.ok) {
				pushMcpToast("error", `Install failed: ${trimmedName}`, res?.error ?? "Unknown error");
				return;
			}
			pushMcpToast("info", `Installed ${trimmedName}`, "Probing…");
			await storefrontApi.probeMcpServers();
			onClose();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div
			role="dialog"
			aria-label="Add MCP server"
			style={{ position: "fixed", inset: 0, zIndex: 80 }}
			className="flex items-center justify-center bg-ink/40"
		>
			<div className="w-[420px] max-w-[90vw] rounded-md border border-line bg-paper shadow-xl">
				<header className="flex items-center gap-2 border-b border-line px-3 py-2">
					<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
						Add MCP server
					</span>
					<button
						type="button"
						onClick={onClose}
						className="ml-auto btn-ghost h-6 w-6 p-0"
						aria-label="Close"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</header>
				<form
					className="flex flex-col gap-3 px-3 py-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<label className="flex flex-col gap-1">
						<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">Name</span>
						<input
							type="text"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="github"
							className="rounded border border-line bg-paper-2 px-2 py-1 text-sm"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">Type</span>
						<select
							value={kind}
							onChange={(e) => setKind(e.target.value as "stdio" | "http")}
							className="rounded border border-line bg-paper-2 px-2 py-1 text-sm"
						>
							<option value="stdio">stdio (local command)</option>
							<option value="http">http (remote URL)</option>
						</select>
					</label>
					{kind === "stdio" ? (
						<label className="flex flex-col gap-1">
							<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
								Command (incl. args)
							</span>
							<input
								type="text"
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="npx -y @modelcontextprotocol/server-github"
								className="rounded border border-line bg-paper-2 px-2 py-1 text-sm"
							/>
						</label>
					) : (
						<label className="flex flex-col gap-1">
							<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">URL</span>
							<input
								type="text"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								placeholder="https://mcp.example.com"
								className="rounded border border-line bg-paper-2 px-2 py-1 text-sm"
							/>
						</label>
					)}
					<div className="flex justify-end gap-2">
						<button
							type="button"
							onClick={onClose}
							className="rounded border border-line bg-paper px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3"
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={busy}
							className="inline-flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-accent disabled:opacity-60"
						>
							{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
							Install
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}