import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, Loader2, Plus } from "lucide-react";
import type { McpHealthStatus } from "@omp-deck/protocol";
import { useStore } from "@/lib/store";
import { McpServerActions } from "./McpServerActions";
import { McpToolsPopover } from "./McpToolsPopover";
import { cn } from "@/lib/utils";

type McpHealthState = McpHealthStatus["state"];

interface AnchorRect {
	left: number;
	top: number;
	bottom: number;
	right: number;
}

interface Props {
	anchorRect: AnchorRect | null;
	open: boolean;
	onClose: () => void;
}

const STATE_DOT: Record<McpHealthState, string> = {
	healthy: "bg-success",
	degraded: "bg-warn",
	unreachable: "bg-danger",
	disabled: "bg-ink-4",
	unknown: "bg-ink-3",
};

/**
 * Floating panel pinned beneath the chrome MCP chip. Renders one row
 * per server from the live `mcpHealth.response.status[]` so the chip
 * stops being a passive state indicator and becomes the entry point for
 * every per-server action.
 *
 * Mounts into `document.body` via a portal so it floats over the
 * Layout panels + the rest of the chrome. Click-outside and Escape
 * close it.
 */
export function McpChipPopover({ anchorRect, open, onClose }: Props) {
	const status = useStore((s) => s.mcpHealth.response?.status ?? []);
	const [toolsFor, setToolsFor] = useState<string | null>(null);
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		function onPointer(e: PointerEvent): void {
			const target = e.target as Node | null;
			if (!target) return;
			if (ref.current?.contains(target)) return;
			const chip = document.querySelector("[data-mcp-chip]");
			if (chip?.contains(target)) return;
			onClose();
		}
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") onClose();
		}
		document.addEventListener("pointerdown", onPointer);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer);
			document.removeEventListener("keydown", onKey);
		};
	}, [open, onClose]);

	if (!open || typeof document === "undefined") return null;

	const panelWidth = 320;
	const margin = 8;
	const left = anchorRect
		? Math.min(
				Math.max(margin, anchorRect.right - panelWidth),
				(typeof window !== "undefined" ? window.innerWidth : 1200) - panelWidth - margin,
			)
		: margin;
	const top = anchorRect ? anchorRect.bottom + 6 : margin;

	return createPortal(
		<div
			ref={ref}
			role="dialog"
			aria-label="MCP servers"
			style={{ position: "fixed", left, top, width: panelWidth, zIndex: 60 }}
			className="rounded-md border border-line bg-paper shadow-xl"
		>
			<header className="flex items-center gap-2 border-b border-line px-3 py-2">
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">MCP servers</span>
				<a
					href="/integrations"
					className="ml-auto inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-meta text-accent hover:underline"
					onClick={onClose}
				>
					Manage
					<ExternalLink className="h-3 w-3" />
				</a>
			</header>
			{status.length === 0 ? (
				<div className="flex items-center gap-2 px-3 py-3 text-2xs text-ink-3">
					<Loader2 className="h-3 w-3 animate-spin" />
					probing…
				</div>
			) : (
				<ul className="divide-y divide-line">
					{status.map((s) => (
						<li key={s.id} className="flex items-center gap-2 px-3 py-2">
							<span
								className={cn("h-2 w-2 shrink-0 rounded-full", STATE_DOT[s.state])}
								aria-label={s.state}
							/>
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-mono text-2xs text-ink">{s.name}</span>
								<span className="font-mono text-2xs text-ink-3">
									{s.state}
									{s.lastLatencyMs != null ? ` · ${s.lastLatencyMs}ms` : ""}
									{s.toolCount != null ? ` · ${s.toolCount} tools` : ""}
								</span>
							</div>
							<McpServerActions
								name={s.name}
								state={s.state}
								{...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {})}
								variant="compact"
								onOpenTools={() => setToolsFor((cur) => (cur === s.name ? null : s.name))}
							/>
						</li>
					))}
				</ul>
			)}
			<footer className="flex items-center gap-2 border-t border-line px-3 py-2">
				<a
					href="/integrations"
					className="inline-flex items-center gap-1 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-accent"
					onClick={onClose}
				>
					<Plus className="h-3 w-3" />
					Add server
				</a>
			</footer>
			{toolsFor ? (
				<div
					style={{
						position: "fixed",
						left: Math.min(left + panelWidth + 6, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340),
						top,
						zIndex: 70,
					}}
				>
					<McpToolsPopover name={toolsFor} onClose={() => setToolsFor(null)} />
				</div>
			) : null}
		</div>,
		document.body,
	);
}