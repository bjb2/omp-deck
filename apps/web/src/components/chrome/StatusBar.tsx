import { selectActiveSession, useStore } from "@/lib/store";
import { useEffect, useState } from "react";
import { UpdatePill } from "./UpdatePill";
import { cn, formatTokens } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
	idle: "text-ink-3",
	streaming: "text-accent",
	compacting: "text-warn",
	retrying: "text-warn",
};

export function StatusBar() {
	const wsStatus = useStore((s) => s.wsStatus);
	const session = useStore(selectActiveSession);

	const wsTone =
		wsStatus === "open"
			? "text-success"
			: wsStatus === "connecting"
				? "text-warn"
				: "text-danger";

	return (
		<div className="flex items-center gap-x-3 font-mono text-2xs uppercase tracking-meta">
			<span className={cn("flex items-center gap-1.5", wsTone)}>
				<Dot className={cn("h-1.5 w-1.5", wsTone)} />
				{wsStatus}
			</span>
			{session ? (
				<>
					<span className="text-ink-4">·</span>
					<span className={STATUS_TONE[session.status] ?? "text-ink-3"}>
						{session.status === "idle" ? "ready" : session.status}
					</span>
					{session.retry ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">
								retry {session.retry.attempt}/{session.retry.maxAttempts}
							</span>
						</>
					) : null}
					{session.compaction ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-warn">compact·{session.compaction.action}</span>
						</>
					) : null}
					{session.ttsr && Date.now() - session.ttsr.at < 8000 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-thinking">ttsr·{session.ttsr.rules.length}</span>
						</>
					) : null}
					{session.usage.totalTokens > 0 ? (
						<>
							<span className="text-ink-4">·</span>
							<span className="text-ink-3 normal-case tracking-normal">
								{formatTokens(session.usage.totalTokens)} tok
							</span>
						</>
					) : null}
				</>
			) : null}
			<UpdatePill />
			<McpHealthBadge />
		</div>
	);
}

function Dot({ className }: { className?: string }) {
	return (
		<span
			className={cn("inline-block rounded-full bg-current", className)}
			aria-hidden="true"
		/>
	);
}

/**
 * Small dot in the chrome header that reports the worst current MCP-server
 * state. Green when every server is healthy, yellow when any are degraded,
 * red when any are unreachable, gray while unknown. Hovering reveals the
 * per-server breakdown + relative last-checked time. Self-contained —
 * reads from the existing `mcpHealth` slice, no new state.
 */
function McpHealthBadge() {
	const response = useStore((s) => s.mcpHealth.response);
	const lastReceivedAtMs = useStore((s) => s.mcpHealth.lastReceivedAtMs);
	// Tick once a second so the relative timestamp + staleness flip
	// without waiting for the next probe to land.
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(id);
	}, []);

	if (!response || response.status.length === 0) return null;

	const ranks = { unreachable: 3, degraded: 2, disabled: 1, unknown: 0, healthy: 0 } as const;
	const worst = response.status.reduce((acc, row) => (ranks[row.state] > ranks[acc.state] ? row : acc));
	const tone =
		worst.state === "healthy"
			? "text-success"
			: worst.state === "degraded"
				? "text-warn"
				: worst.state === "unreachable"
					? "text-danger"
					: "text-ink-3";
	const label = worst.state === "healthy" ? "mcp" : `mcp·${worst.state}`;
	const stale = lastReceivedAtMs == null || now - lastReceivedAtMs > 60_000;
	const tooltip = [
		`worst: ${worst.state}${stale ? " (stale)" : ""}`,
		...response.status.map((s) => `${s.name} · ${s.state} · ${relativeTime(now, s.probedAt)}`),
	].join("\n");

	return (
		<span
			title={tooltip}
			aria-label={`MCP servers: ${response.status.length} configured, worst state ${worst.state}`}
			className={cn("flex items-center gap-1.5", tone)}
		>
			<Dot className={cn("h-1.5 w-1.5", tone)} />
			{label}
		</span>
	);
}

function relativeTime(now: number, iso: string): string {
	const ms = now - new Date(iso).getTime();
	if (ms < 5_000) return "just now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
	return `${Math.floor(ms / 3_600_000)}h ago`;
}
