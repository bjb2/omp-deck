import { selectActiveSession, useStore } from "@/lib/store";
import { useRef, useState } from "react";
import { UpdatePill } from "./UpdatePill";
import { McpChipPopover } from "@/components/mcp/McpChipPopover";
import { cn, formatTokens } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
	idle: "text-ink-3",
	streaming: "text-accent",
	compacting: "text-warn",
	retrying: "text-warn",
};

const STATE_RANK: Record<string, number> = {
	unreachable: 3,
	degraded: 2,
	disabled: 1,
	unknown: 0,
	healthy: 0,
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
			aria-hidden
			className={cn("inline-block rounded-full bg-current", className)}
		/>
	);
}

/**
 * Chrome chip. A real `<button>` that toggles the per-server popover.
 * When no MCP servers are configured we render a low-key "no mcp"
 * text-link to `/integrations` instead of a colored dot — keeps the
 * affordance visible without being noisy about a missing server list.
 */
function McpHealthBadge() {
	const response = useStore((s) => s.mcpHealth.response);
	const [open, setOpen] = useState(false);
	const buttonRef = useRef<HTMLButtonElement | null>(null);

	const status = response?.status ?? [];
	const worst = status.length > 0
		? status.reduce((acc, row) => (STATE_RANK[row.state] > STATE_RANK[acc.state] ? row : acc))
		: null;
	const tone = !worst
		? "text-ink-3"
		: worst.state === "healthy"
			? "text-success"
			: worst.state === "degraded"
				? "text-warn"
				: worst.state === "unreachable"
					? "text-danger"
					: "text-ink-3";
	const label = !worst
		? "no mcp"
		: worst.state === "healthy"
			? "mcp"
			: `mcp·${worst.state}`;

	if (status.length === 0) {
		return (
			<a
				href="/integrations"
				className="font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-accent"
				title="No MCP servers configured — open Integrations to add one"
			>
				{label}
			</a>
		);
	}

	const rect = open && buttonRef.current ? buttonRef.current.getBoundingClientRect() : null;

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				data-mcp-chip
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => setOpen((v) => !v)}
				title={`${status.length} MCP server${status.length === 1 ? "" : "s"} — ${worst?.state ?? "unknown"}`}
				className={cn(
					"flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-paper-2",
					tone,
				)}
			>
				<Dot className={cn("h-1.5 w-1.5", tone)} />
				{label}
			</button>
			<McpChipPopover
				open={open}
				onClose={() => setOpen(false)}
				anchorRect={
					rect
						? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
						: null
				}
			/>
		</>
	);
}