import { Link } from "react-router-dom";
import type { StoreItem } from "@omp-deck/protocol";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";
import { InstallButton } from "./InstallButton";

/**
 * One catalog card — used by the home hero grid, section grid, and
 * search results. Apple-store aesthetic: image-free, typographic, with
 * a 4s insertion glow on items that arrived via `store_item_added` —
 * sourced from the global `storefrontPulse.byId` slice (stamped by the
 * WS reducer on every `store_item_added` frame), not a per-view
 * subscriber.
 */
export function StoreCard({ item, size = "regular" }: { item: StoreItem; size?: "regular" | "hero" }) {
	const pulseStartedAt = useStore((s) => s.storefrontPulse.byId[item.id]);
	const live = pulseStartedAt !== undefined && Date.now() - pulseStartedAt < 4000;

	return (
		<Link
			to={`/storefront/${item.section}/${encodeURIComponent(item.id)}`}
			className={cn(
				"group relative flex flex-col gap-2 rounded-xl border border-line bg-paper-2 p-4 transition-colors",
				"hover:border-ink/30",
				size === "hero" && "p-6",
				live && "ring-2 ring-accent/60 animate-pulse",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className={cn("truncate font-semibold text-ink", size === "hero" ? "text-base" : "text-sm")}>
						{item.name}
					</div>
					<div className="mt-0.5 truncate font-mono text-2xs uppercase tracking-meta text-ink-3">
						{item.section} · {item.author.name}
					</div>
				</div>
				{item.isNew ? (
					<span className="shrink-0 rounded-md bg-accent/15 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent">
						New
					</span>
				) : null}
			</div>
			<p className={cn("line-clamp-2 text-ink-2", size === "hero" ? "text-sm" : "text-xs")}>{item.tagline}</p>
			<div className="mt-auto flex items-center justify-between gap-2 pt-2">
				<div className="font-mono text-2xs text-ink-3">
					{item.installs > 0 ? `${formatInstalls(item.installs)} installs` : "New"}
				</div>
				<InstallButton item={item} compact />
			</div>
		</Link>
	);
}

function formatInstalls(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}