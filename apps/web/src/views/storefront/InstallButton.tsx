import { useMemo } from "react";
import { CheckCircle2, Download, Loader2, Plug } from "lucide-react";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { marketplaceApi } from "@/lib/marketplace-api";
import { useStorefrontStore } from "@/lib/storefront-store";
import { useStore, pushMcpToast } from "@/lib/store";
import { McpServerActions } from "@/components/mcp/McpServerActions";
import { McpToolsPopover } from "@/components/mcp/McpToolsPopover";
import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Shape we expect on `installAction.payload` for kind=marketplace. Opaque
 * in the protocol, but only the marketplace kind flows through `install()`
 * here — MCP and skill are handled by their own server endpoints out of
 * the storefront button (the storefront MCP entries are *already-installed*
 * records read straight from mcp.json, and there is no skill listing path
 * in the catalog today).
 */
function readMarketplacePayload(payload: unknown): string | null {
	if (payload && typeof payload === "object" && "marketplace" in payload) {
		const m = (payload as Record<string, unknown>).marketplace;
		if (typeof m === "string" && m.trim()) return m;
	}
	return null;
}

function readName(payload: unknown): string | null {
	if (payload && typeof payload === "object" && "name" in payload) {
		const n = (payload as Record<string, unknown>).name;
		if (typeof n === "string" && n.trim()) return n;
	}
	return null;
}

/**
 * Animated install/manage button. Behavior by `kind`:
 *   - `marketplace` → POST /api/marketplace/install
 *   - `mcp`         → already-installed record. Delegates to the shared
 *                     `McpServerActions` for enable/disable/delete so the
 *                     storefront, chrome chip popover, and `/integrations`
 *                     share one optimistic path + toast shape.
 *   - `skill`, `prompt` → unreachable (the catalog emits no such items).
 */
export function InstallButton({
	item,
	compact = false,
	marketplace,
}: {
	item: StoreItem;
	compact?: boolean;
	/** Optional override for the marketplace source. Falls back to
	 *  `item.installAction.payload.marketplace` when omitted. */
	marketplace?: string;
}) {
	const installedAt = useStorefrontStore((s) => s.installedAt[item.id]);
	const phase = useStorefrontStore((s) => s.installPhase[item.id]);
	const beginInstall = useStorefrontStore((s) => s.beginInstall);
	const confirmInstall = useStorefrontStore((s) => s.confirmInstall);
	const revertInstall = useStorefrontStore((s) => s.revertInstall);

	const mcpStatus = useStore((s) => s.mcpHealth.response?.status ?? []);
	const kind = item.installAction.kind;

	const verb = installActionVerb(kind);

	const marketplaceName = useMemo(
		() => marketplace ?? readMarketplacePayload(item.installAction.payload),
		[marketplace, item.installAction.payload],
	);

	// MCP items are always already-installed (they're sourced from mcp.json
	// directly). Decide the chip from the live probe instead of a round-trip.
	const mcpState = useMemo(() => {
		if (kind !== "mcp") return null;
		const name = readName(item.installAction.payload);
		if (!name) return null;
		const hit = mcpStatus.find((s) => s.name === name);
		if (!hit) return { name, enabled: true, toolCount: undefined as number | undefined };
		return { name, enabled: hit.state !== "disabled", toolCount: hit.toolCount };
	}, [kind, item.installAction.payload, mcpStatus]);

	const isDone = installedAt !== undefined;
	const isPending = phase === "pending";

	async function onInstall(): Promise<void> {
		if (isPending || isDone) return;
		if (kind !== "marketplace" || !marketplaceName) return;
		beginInstall(item.id);
		try {
			await marketplaceApi.install({ name: item.name, marketplace: marketplaceName });
			confirmInstall(item.id);
			pushMcpToast(
				"info",
				`Installed ${item.name}`,
				`From ${marketplaceName}. Restart sessions to pick up new commands.`,
			);
		} catch (err) {
			revertInstall(item.id);
			const e = err as Error & { code?: string; status?: number };
			const detail = e.code ? `${e.code}: ${e.message}` : e.message ?? String(err);
			pushMcpToast("error", `Install failed: ${item.name}`, detail);
		}
	}

	if (kind === "mcp" && mcpState) {
		return <McpInstalledRow item={item} mcpState={mcpState} compact={compact} />;
	}

	const isLiveInstall = kind === "marketplace" && marketplaceName !== null;
	const disabled = !isLiveInstall && !isDone;
	const Icon = isPending ? Loader2 : isDone ? CheckCircle2 : iconForKind(kind);
	const label = isDone ? "Open" : isPending ? "Installing…" : verb;

	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void onInstall();
			}}
			disabled={disabled}
			className={cn(
				"group/btn relative inline-flex items-center gap-1.5 rounded-full font-medium text-ink transition-colors",
				"border border-line bg-paper hover:border-accent hover:bg-accent/10",
				compact ? "px-3 py-1 text-2xs" : "px-4 py-1.5 text-xs",
				disabled && "cursor-not-allowed opacity-50 hover:border-line hover:bg-paper",
				isDone && "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15",
			)}
		>
			<span className="absolute inset-0 -z-10 rounded-full opacity-0 transition-opacity group-hover/btn:opacity-100 group-hover/btn:ring-2 group-hover/btn:ring-accent/40" />
			<Icon className={cn("h-3 w-3", isPending && "animate-spin")} />
			{label}
		</button>
	);
}

export type { StoreSection };

function iconForKind(kind: StoreItem["installAction"]["kind"]) {
	if (kind === "marketplace") return Download;
	return Plug;
}

function installActionVerb(kind: StoreItem["installAction"]["kind"]): string {
	if (kind === "marketplace") return "Get";
	return "Install";
}

/**
 * The MCP kind of `InstallButton` collapses into a status pill + the
 * shared `<McpServerActions>`. Pulled out so the main component stays
 * a marketplace-focused install handler.
 */
function McpInstalledRow({
	item: _item,
	mcpState,
	compact,
}: {
	item: StoreItem;
	mcpState: { name: string; enabled: boolean; toolCount: number | undefined };
	compact: boolean;
}) {
	const [toolsOpen, setToolsOpen] = useState(false);
	const liveRow = useStore((s) =>
		s.mcpHealth.response?.status.find((row) => row.name === mcpState.name),
	);
	const state = liveRow?.state ?? (mcpState.enabled ? "healthy" : "disabled");
	const toolCount = liveRow?.toolCount ?? mcpState.toolCount;
	return (
		<div className={cn("flex items-center gap-1.5", compact && "text-2xs")}>
			<McpServerActions
				name={mcpState.name}
				state={state}
				{...(toolCount !== undefined ? { toolCount } : {})}
				variant="compact"
				onOpenTools={() => setToolsOpen((v) => !v)}
			/>
			{toolsOpen ? (
				<div className="absolute z-40 mt-32">
					<McpToolsPopover name={mcpState.name} onClose={() => setToolsOpen(false)} />
				</div>
			) : null}
		</div>
	);
}

/**
 * Placeholder comment block — `installActionVerb` already exported above.
 * Kept as a tail comment so the file parses; no behavior attached.
 */
void installActionVerb;

/** stub */