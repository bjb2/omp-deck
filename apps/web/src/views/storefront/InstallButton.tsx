import { useMemo } from "react";
import { CheckCircle2, Download, Loader2, Plug } from "lucide-react";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { marketplaceApi } from "@/lib/marketplace-api";
import { useStorefrontStore } from "@/lib/storefront-store";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** Shape we expect on `installAction.payload` for kind=marketplace. Opaque
 *  in the protocol, but only the marketplace kind flows through `install()`
 *  here. mcp / skill / prompt have their own server endpoints out of scope. */
function readMarketplacePayload(payload: unknown): string | null {
	if (payload && typeof payload === "object" && "marketplace" in payload) {
		const m = payload.marketplace;
		if (typeof m === "string" && m.length > 0) return m;
	}
	return null;
}

/**
 * Animated "Get / Open" button. Pulses on hover (Apple-Store affordance);
 * `compact` shrinks the chip for use in cards. Click dispatches a real
 * `marketplaceApi.install()` round-trip for items with `installAction.kind`
 * === "marketplace". Confirmed installs flip to "Open" via the
 * `useStorefrontStore.installedAt` map; failures revert the chip and surface
 * the server message through an in-app toast.
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

	const verb = installActionVerb(item.installAction.kind);

	// Install endpoint wiring by kind. Only `marketplace` has a server
	// round-trip today (`POST /api/marketplace/install` via `marketplaceApi`).
	// `mcp` and `skill` would hit `/api/mcp/install` / `/api/skills/install`
	// — neither route is registered in `apps/server/src/routes.ts` yet, so
	// we render them as disabled "Install" placeholders. `prompt` doesn't
	// install at all (clones into the library instead).
	const endpointReady = isEndpointReady(item.installAction.kind);
	const marketplaceName = useMemo(
		() => marketplace ?? readMarketplacePayload(item.installAction.payload),
		[marketplace, item.installAction.payload],
	);
	const isLiveInstall =
		endpointReady && (item.installAction.kind === "marketplace" ? marketplaceName !== null : true);
	const isDone = installedAt !== undefined;
	const isPending = phase === "pending";

	function pushToast(level: "info" | "error", title: string, body: string): void {
		// Append directly to the existing notification queue so the in-app
		// toast renderer picks it up. Matches the shape produced by the WS
		// `notification` frame handler in store.ts.
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

	async function onClick(e: React.MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		if (isPending || isDone) return;
		if (!isLiveInstall || !marketplaceName) return;

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

	const Icon =
		isPending ? Loader2 : isDone ? CheckCircle2 : iconForKind(item.installAction.kind);
	const label = isDone ? "Open" : isPending ? "Installing…" : verb;
	const disabled = !isLiveInstall && !isDone;

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			title={
				disabled ? disabledTitleForKind(item.installAction.kind) : undefined
			}
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

// `section` is unused here but accepted implicitly through `item.section`.
// Re-exported via the signature for any future caller that wants to pin the
// section independently (handy for tests).
export type { StoreSection };

function iconForKind(kind: StoreItem["installAction"]["kind"]) {
	if (kind === "marketplace") return Download;
	return Plug;
}

function installActionVerb(kind: StoreItem["installAction"]["kind"]): string {
	if (kind === "marketplace") return "Get";
	return "Install";
}

/** Which install kinds have a wired server endpoint today.
 *  `mcp` / `skill` would need `/api/mcp/install` and `/api/skills/install`
 *  (currently absent from `apps/server/src/routes.ts`); `prompt` is not an
 *  install flow at all — prompts clone into the library. Keep these in sync
 *  when the corresponding routes land. */
function isEndpointReady(kind: StoreItem["installAction"]["kind"]): boolean {
	return kind === "marketplace";
}

function disabledTitleForKind(kind: StoreItem["installAction"]["kind"]): string {
	if (kind === "prompt") return "Prompts clone into your library — open the item to use it.";
	if (kind === "mcp") return "Coming soon — MCP install endpoint not wired yet.";
	if (kind === "skill") return "Coming soon — skills install endpoint not wired yet.";
	return "Install endpoint not wired for this item yet";
}
