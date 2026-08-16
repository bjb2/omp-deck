import { useEffect, useMemo, useState } from "react";
import { Activity, Loader2, XCircle } from "lucide-react";
import type { McpHealthResponse } from "@omp-deck/protocol";
import { useStore } from "@/lib/store";
import { storefrontApi } from "@/lib/storefront-api";
import { McpServerActions } from "@/components/mcp/McpServerActions";
import { McpToolsPopover } from "@/components/mcp/McpToolsPopover";
import { cn } from "@/lib/utils";

/**
 * Live MCP health row. Reads from the global store's `mcpHealth` slice,
 * which is hydrated by successive `mcp_health` WS frames (one per probed
 * server; merged into a `McpHealthResponse` keyed by server id). Falls
 * back to a one-shot `storefrontApi.mcpHealth()` fetch on mount so the
 * strip isn't empty until the next probe lands, and marks itself stale
 * after 60s without a frame so a silently-disconnected WS doesn't show
 * frozen "healthy" forever.
 */
const STALE_AFTER_MS = 60_000;

export function McpHealthStrip() {
	const response = useStore((s) => s.mcpHealth.response);
	const lastReceivedAtMs = useStore((s) => s.mcpHealth.lastReceivedAtMs);
	const markStale = useStore((s) => s.markMcpHealthStale);
	const [toolsFor, setToolsFor] = useState<string | null>(null);

	// Initial hydration + staleness watchdog.
	useEffect(() => {
		if (!response) {
			void storefrontApi.mcpHealth().then((next) => {
				useStore.setState((s) =>
					s.mcpHealth.response
						? {}
						: { mcpHealth: { response: next, lastReceivedAtMs: Date.now() } },
				);
			});
		}
		// ponytail: setInterval(10s) staleness watchdog for a 60s budget; tighten
		// only if a frame is observed arriving later than expected in the wild.
		const id = setInterval(() => {
			const last = useStore.getState().mcpHealth.lastReceivedAtMs;
			if (last == null || Date.now() - last > STALE_AFTER_MS) {
				markStale();
			}
		}, 10_000);
		return () => clearInterval(id);
	}, [response, markStale]);

	const data = useMemo(() => {
		if (!response) return null;
		const stale = lastReceivedAtMs == null || Date.now() - lastReceivedAtMs > STALE_AFTER_MS;
		return { status: response.status, probedAt: response.probedAt, stale };
	}, [response, lastReceivedAtMs]);

	if (!data) {
		return (
			<div className="flex items-center gap-2 font-mono text-2xs text-ink-3">
				<Loader2 className="h-3 w-3 animate-spin" />
				probing MCP servers…
			</div>
		);
	}

	if (data.status.length === 0) {
		return (
			<div className="flex items-center gap-2 font-mono text-2xs text-ink-3">
				<Activity className="h-3 w-3" />
				no MCP servers configured
			</div>
		);
	}

	return (
		<div className="flex flex-wrap items-center gap-3">
			<div className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-meta text-ink-3">
				<Activity className={cn("h-3 w-3", data.stale ? "text-warn" : undefined)} />
				MCP{data.stale ? " · stale" : ""}
			</div>
			{data.status.map((s) => (
				<div
					key={s.id}
					className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1"
				>
					<span className="flex items-center gap-1.5">
						<ServerDot state={s.state} />
						<span className="font-mono text-2xs text-ink">{s.name}</span>
						{s.lastLatencyMs != null ? (
							<span className="font-mono text-2xs text-ink-3">{s.lastLatencyMs}ms</span>
						) : null}
					</span>
					<McpServerActions
						name={s.name}
						state={s.state}
						{...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {})}
						variant="compact"
						onOpenTools={() => setToolsFor((cur) => (cur === s.name ? null : s.name))}
					/>
				</div>
			))}
			{toolsFor ? (
				<div className="relative">
					<McpToolsPopover name={toolsFor} onClose={() => setToolsFor(null)} />
				</div>
			) : null}
		</div>
	);
}

const STATE_DOT: Record<string, string> = {
	healthy: "text-success",
	degraded: "text-warn",
	unreachable: "text-danger",
	disabled: "text-ink-4",
	unknown: "text-ink-3",
};

function ServerDot({ state }: { state: McpHealthResponse["status"][number]["state"] }) {
	if (state === "healthy") {
		return <span className={cn("h-1.5 w-1.5 rounded-full bg-current", STATE_DOT[state])} aria-hidden />;
	}
	if (state === "unreachable") {
		return <XCircle className={cn("h-3 w-3", STATE_DOT[state])} />;
	}
	return <Activity className={cn("h-3 w-3", STATE_DOT[state])} />;
}