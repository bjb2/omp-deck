import { useState } from "react";
import { Loader2, Power, RefreshCw, Trash2, Wrench } from "lucide-react";
import type { McpHealthStatus, McpServerEntry } from "@omp-deck/protocol";
import { useStore, pushMcpToast } from "@/lib/store";
import { storefrontApi } from "@/lib/storefront-api";
import { cn } from "@/lib/utils";

type McpHealthState = McpHealthStatus["state"];

interface Props {
	name: string;
	state: McpHealthState;
	/** Optional `toolCount` from the live probe — when >0 the "Open tools"
	 *  button is rendered. Pulled from `McpHealthStatus.toolCount`. */
	toolCount?: number;
	/** Compact rendering (chrome chip popover row) drops the icon padding
	 *  and labels; full mode (storefront strip + /integrations) shows them. */
	variant?: "compact" | "full";
	/** Lets the host render an inline tools popover instead of a button. */
	onOpenTools?: () => void;
}

/**
 * Shared per-server action group — power toggle, refresh probe, delete,
 * and an "Open tools" affordance when the server advertises any. All
 * three call sites (chrome chip popover, storefront strip,
 * `/integrations`) compose this so optimistic updates + toasts stay
 * consistent.
 */
export function McpServerActions({
	name,
	state,
	toolCount,
	variant = "full",
	onOpenTools,
}: Props) {
	const [busy, setBusy] = useState<null | "toggle" | "refresh" | "delete">(null);
	const setEnabled = useStore((s) => s.setMcpServerEnabled);
	const removeServer = useStore((s) => s.removeMcpServer);

	const enabled = state !== "disabled";

	async function toggle(): Promise<void> {
		if (busy) return;
		setBusy("toggle");
		const next = !enabled;
		// Optimistic — the next `mcp_health` frame will reconcile.
		setEnabled(name, next);
		try {
			const res = await fetch(`/api/mcp/${encodeURIComponent(name)}/${next ? "enable" : "disable"}`, {
				method: "POST",
			});
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`${res.status}: ${body}`);
			}
			pushMcpToast("info", `${next ? "Enabled" : "Disabled"} ${name}`);
		} catch (err) {
			setEnabled(name, !next); // revert
			pushMcpToast("error", `Failed: ${name}`, (err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	async function refresh(): Promise<void> {
		if (busy) return;
		setBusy("refresh");
		try {
			await storefrontApi.probeMcpServers();
			// The probe itself broadcasts `mcp_health`; nothing to do here.
		} catch {
			/* probe failure already surfaced via the chip dot */
		} finally {
			setBusy(null);
		}
	}

	async function remove(): Promise<void> {
		if (busy) return;
		if (!window.confirm(`Remove MCP server "${name}" from mcp.json?`)) return;
		setBusy("delete");
		try {
			const res = await fetch(`/api/mcp/${encodeURIComponent(name)}`, { method: "DELETE" });
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`${res.status}: ${body}`);
			}
			removeServer(name);
			pushMcpToast("info", `Removed ${name}`);
		} catch (err) {
			pushMcpToast("error", `Failed: ${name}`, (err as Error).message);
		} finally {
			setBusy(null);
		}
	}

	const compact = variant === "compact";
	const iconSize = compact ? "h-3 w-3" : "h-3.5 w-3.5";
	const btnBase = cn(
		"inline-flex items-center justify-center rounded border border-line bg-paper transition-colors",
		compact ? "h-6 w-6" : "h-7 w-7",
	);

	return (
		<div className={cn("flex items-center gap-1.5", compact && "gap-1")}>
			{onOpenTools || (toolCount !== undefined && toolCount > 0) ? (
				<button
					type="button"
					onClick={onOpenTools}
					title="Toggle tools"
					className={cn(btnBase, "text-ink-3 hover:border-accent hover:text-accent")}
				>
					<Wrench className={iconSize} />
				</button>
			) : null}
			<button
				type="button"
				onClick={() => void toggle()}
				disabled={busy !== null}
				title={enabled ? "Disable server" : "Enable server"}
				className={cn(
					btnBase,
					enabled ? "text-accent hover:border-danger hover:text-danger" : "text-ink-3 hover:border-accent hover:text-accent",
				)}
			>
				{busy === "toggle" ? <Loader2 className={cn(iconSize, "animate-spin")} /> : <Power className={iconSize} />}
			</button>
			<button
				type="button"
				onClick={() => void refresh()}
				disabled={busy !== null}
				title="Probe now"
				className={cn(btnBase, "text-ink-3 hover:border-accent hover:text-accent")}
			>
				{busy === "refresh" ? <Loader2 className={cn(iconSize, "animate-spin")} /> : <RefreshCw className={iconSize} />}
			</button>
			<button
				type="button"
				onClick={() => void remove()}
				disabled={busy !== null}
				title="Remove from mcp.json"
				className={cn(btnBase, "text-ink-3 hover:border-danger hover:text-danger")}
			>
				{busy === "delete" ? <Loader2 className={cn(iconSize, "animate-spin")} /> : <Trash2 className={iconSize} />}
			</button>
		</div>
	);
}

/** Re-export of `McpHealthStatus["state"]` so consumers don't have to
 *  reach into the protocol types just to type a prop. */
export type { McpHealthState };