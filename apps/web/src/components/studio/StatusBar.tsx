/**
 * Studio status bar. Per the design doc §5, the bar (7h) shows:
 *   - bridges row (one pill per `BridgeName`)
 *   - deployments badge (clicking opens the latest log tail)
 *   - inbox count badge
 *   - shortcut hint
 *
 * The bridges row is the headline. The deployments and inbox badges reuse
 * the existing `DeployStatusBadge` + the store's `notifications` slice.
 * The shortcut hint is text-only (the full command palette ships later).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { DeployStatusBadge } from "@/components/DeployStatusBadge";
import { bridgesApi } from "@/lib/bridges-api";
import { useStore } from "@/lib/store";
import type { BridgeInfo, McpHealthStatus } from "@omp-deck/protocol";

const BRIDGE_POLL_MS = 8_000;

const STATUS_TONE: Record<string, string> = {
	running: "bg-success/20 text-success",
	stopped: "bg-paper-3 text-ink-3",
	starting: "bg-warn/20 text-warn",
	crashed: "bg-danger/20 text-danger",
};

const MCP_TONE: Record<McpHealthStatus["state"], string> = {
	healthy: "bg-success/20 text-success",
	degraded: "bg-warn/20 text-warn",
	unreachable: "bg-danger/20 text-danger",
	unknown: "bg-paper-3 text-ink-3",
	disabled: "bg-paper-3 text-ink-3",
};

/**
 * One pill per MCP server. Reads from the global `mcpHealth.response`
 * slice (stamped by the reducer on every `mcp_health` frame).
 */
function McpPillRow(): JSX.Element {
	const status = useStore((s) => s.mcpHealth.response?.status ?? []);
	if (status.length === 0) {
		return <span className="text-ink-4">no mcp</span>;
	}
	return (
		<div className="flex items-center gap-1" data-tooltip-key="studio.statusbar.mcp">
			{status.map((m) => (
				<span
					key={m.id}
					data-tooltip-key={`mcp.${m.name}`}
					className={`rounded-full px-1.5 py-0.5 ${MCP_TONE[m.state]}`}
				>
					{m.name} · {m.state}
				</span>
			))}
		</div>
	);
}

export function StudioStatusBar(): JSX.Element {
	const [bridges, setBridges] = useState<BridgeInfo[]>([]);
	const workspace = useStore((s) => s.workspaces[0]?.label ?? s.workspaces[0]?.cwd ?? "default");
	const inboxUnread = useStore((s) => s.notifications.filter((n) => !n.dismissed).length);

	useEffect(() => {
		let cancelled = false;
		const refresh = (): void => {
			bridgesApi
				.list()
				.then((r) => {
					if (!cancelled) setBridges(r.bridges);
				})
				.catch(() => {
					if (!cancelled) setBridges([]);
				});
		};
		refresh();
		const t = window.setInterval(refresh, BRIDGE_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(t);
		};
	}, []);

	return (
		<div
			data-tooltip-key="studio.statusbar.badge"
			data-context-key="studio.statusbar.badge"
			className="flex h-7 shrink-0 items-center gap-x-3 border-t border-line bg-paper-2 px-3 font-mono text-2xs uppercase tracking-meta text-ink-3"
		>
			<div className="flex items-center gap-1" data-tooltip-key="studio.statusbar.bridges">
				{bridges.length === 0 ? (
					<span className="text-ink-4">no bridges</span>
				) : (
					bridges.map((b) => (
						<span
							key={b.name}
							data-tooltip-key={`bridge.${b.name}`}
							data-context-key={`bridge.${b.name}`}
							className={`rounded-full px-1.5 py-0.5 ${STATUS_TONE[b.status] ?? STATUS_TONE.stopped}`}
						>
							{b.name} · {b.status}
						</span>
					))
				)}
			</div>
			<span className="text-ink-4">·</span>
			<span data-tooltip-key="studio.statusbar.deploy">
				<DeployStatusBadge />
			</span>
			<span className="text-ink-4">·</span>
			<Link
				to="/inbox"
				data-tooltip-key="studio.statusbar.inbox"
				className="text-ink-3 hover:text-ink"
			>
				inbox · {inboxUnread}
			</Link>
			<div className="flex-1" />
			<span className="text-ink-4">·</span>
			<McpPillRow />
			<span data-tooltip-key="studio.statusbar.shortcut" className="font-mono text-2xs normal-case text-ink-3">
				workspace: {workspace}
			</span>
		</div>
	);
}
