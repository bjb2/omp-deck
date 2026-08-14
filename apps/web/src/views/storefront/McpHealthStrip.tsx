import { useEffect, useMemo } from "react";
import { Activity, AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { McpHealthResponse } from "@omp-deck/protocol";
import { useStore } from "@/lib/store";
import { storefrontApi } from "@/lib/storefront-api";
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
			{data.status.map((s) => {
				const Icon = iconForState(s.state);
				const tone = toneForState(s.state);
				return (
					<div
						key={s.id}
						title={`${s.name} · ${s.state}${s.lastLatencyMs != null ? ` · ${s.lastLatencyMs}ms` : ""}`}
						className={cn("flex items-center gap-1.5 rounded-md border border-line bg-paper-2 px-2 py-1", tone)}
					>
						<Icon className={cn("h-3 w-3", s.state === "healthy" && "animate-pulse")} />
						<span className="font-mono text-2xs text-ink">{s.name}</span>
					</div>
				);
			})}
		</div>
	);
}

function iconForState(state: McpHealthResponse["status"][number]["state"]) {
	if (state === "healthy") return CheckCircle2;
	if (state === "degraded") return AlertCircle;
	if (state === "unreachable") return XCircle;
	return Loader2;
}

function toneForState(state: McpHealthResponse["status"][number]["state"]) {
	if (state === "healthy") return "text-success";
	if (state === "degraded") return "text-warn";
	if (state === "unreachable") return "text-danger";
	return "text-ink-3";
}
