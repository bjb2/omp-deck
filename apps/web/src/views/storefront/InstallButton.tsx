import { useMemo } from "react";
import { CheckCircle2, Download, Loader2, Plug, Power, Trash2 } from "lucide-react";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { marketplaceApi } from "@/lib/marketplace-api";
import { useStorefrontStore } from "@/lib/storefront-store";
import { useStore } from "@/lib/store";
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
 *   - `mcp`         → already-installed record. Reads enabled state from
 *                     the global mcp-health slice and offers
 *                     Enable / Disable / Remove against the new CRUD routes.
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
	const clearInstall = useStorefrontStore((s) => s.clearInstall);

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
		if (!hit) return { name, enabled: true };
		return { name, enabled: hit.state !== "disabled" };
	}, [kind, item.installAction.payload, mcpStatus]);

	const isDone = installedAt !== undefined;
	const isPending = phase === "pending";

	function pushToast(level: "info" | "error", title: string, body: string): void {
		const id = `storefront-${item.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		useStore.setState((s) => ({
			notifications: [
				...s.notifications,
				{
					id,
					level,
					title,
					body,
					timestamp: new Date().toISOString(),
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				},
			],
		}));
	}

	async function onInstall(): Promise<void> {
		if (isPending || isDone) return;
		if (kind !== "marketplace" || !marketplaceName) return;
		beginInstall(item.id);
		try {
			await marketplaceApi.install({ name: item.name, marketplace: marketplaceName });
			confirmInstall(item.id);
			pushToast(
				"info",
				`Installed ${item.name}`,
				`From ${marketplaceName}. Restart sessions to pick up new commands.`,
			);
		} catch (err) {
			revertInstall(item.id);
			const e = err as Error & { code?: string; status?: number };
			const detail = e.code ? `${e.code}: ${e.message}` : e.message ?? String(err);
			pushToast("error", `Install failed: ${item.name}`, detail);
		}
	}

	async function onMcpToggle(): Promise<void> {
		if (!mcpState || isPending) return;
		beginInstall(item.id);
		try {
			const next = !mcpState.enabled;
			const path = `/api/mcp/${encodeURIComponent(mcpState.name)}/${next ? "enable" : "disable"}`;
			const res = await fetch(path, { method: "POST" });
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`${res.status}: ${body}`);
			}
			confirmInstall(item.id);
			pushToast("info", `${next ? "Enabled" : "Disabled"} ${mcpState.name}`, "");
		} catch (err) {
			revertInstall(item.id);
			pushToast("error", `Failed: ${item.name}`, (err as Error).message);
		}
	}

	async function onMcpRemove(): Promise<void> {
		if (!mcpState || isPending) return;
		beginInstall(item.id);
		try {
			const res = await fetch(`/api/mcp/${encodeURIComponent(mcpState.name)}`, { method: "DELETE" });
			if (!res.ok) {
				const body = await res.text().catch(() => "");
				throw new Error(`${res.status}: ${body}`);
			}
			clearInstall(item.id);
			pushToast("info", `Removed ${mcpState.name}`, "");
		} catch (err) {
			revertInstall(item.id);
			pushToast("error", `Failed: ${item.name}`, (err as Error).message);
		}
	}

	if (kind === "mcp" && mcpState) {
		const Icon = isPending ? Loader2 : mcpState.enabled ? CheckCircle2 : Power;
		const label = isPending
			? "Working…"
			: mcpState.enabled
				? "Installed"
				: "Enable";
		return (
			<div className={cn("flex items-center gap-1.5", compact && "text-2xs")}>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						void onMcpToggle();
					}}
					disabled={isPending}
					title={mcpState.enabled ? "Disable MCP server" : "Enable MCP server"}
					className={cn(
						"group/btn relative inline-flex items-center gap-1.5 rounded-full font-medium text-ink transition-colors",
						"border border-line bg-paper hover:border-accent hover:bg-accent/10",
						compact ? "px-3 py-1 text-2xs" : "px-4 py-1.5 text-xs",
						mcpState.enabled && "border-accent/40 bg-accent/10 text-accent hover:bg-accent/15",
					)}
				>
					<span className="absolute inset-0 -z-10 rounded-full opacity-0 transition-opacity group-hover/btn:opacity-100 group-hover/btn:ring-2 group-hover/btn:ring-accent/40" />
					<Icon className={cn("h-3 w-3", isPending && "animate-spin")} />
					{label}
				</button>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						void onMcpRemove();
					}}
					disabled={isPending}
					title="Remove MCP server from mcp.json"
					className={cn(
						"inline-flex items-center justify-center rounded-full border border-line bg-paper text-ink-3 transition-colors hover:border-danger hover:text-danger",
						compact ? "h-6 w-6" : "h-7 w-7",
						isPending && "opacity-50",
					)}
				>
					<Trash2 className="h-3 w-3" />
				</button>
			</div>
		);
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
