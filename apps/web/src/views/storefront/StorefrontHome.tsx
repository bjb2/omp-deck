import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { StoreItem } from "@omp-deck/protocol";
import { storefrontApi } from "@/lib/storefront-api";
import { useStore } from "@/lib/store";
import { FilterChips } from "./FilterChips";
import { McpHealthStrip } from "./McpHealthStrip";
import { StoreCard } from "./StoreCard";

/**
 * `/storefront` — Apple Store-style home. Hero + three rows:
 * Featured → Trending → New. The global `storefrontPulse.byId` slice
 * (stamped by the reducer on `store_item_added`) drives the 4s
 * insertion glow via StoreCard. No local WS subscriber here.
 */
export function StorefrontHome() {
	const [featured, setFeatured] = useState<StoreItem[]>([]);
	const [trending, setTrending] = useState<StoreItem[]>([]);
	const [fresh, setFresh] = useState<StoreItem[]>([]);
	const [loading, setLoading] = useState(true);

	// Subscribe to the global pulse slice so this view re-renders on
	// `store_item_added` (and sibling frames). The pulse itself is
	// consumed by StoreCard.
	const pulseById = useStore((s) => s.storefrontPulse.byId);
	void pulseById;

	useEffect(() => {
		let alive = true;
		async function load() {
			const [f, t, n] = await Promise.all([
				storefrontApi.featured(8),
				storefrontApi.trending(8),
				storefrontApi.new(8),
			]);
			if (!alive) return;
			setFeatured(f.items);
			setTrending(t.items);
			setFresh(n.items);
			setLoading(false);
		}
		void load();
		return () => {
			alive = false;
		};
	}, []);

	// TODO(WP): seed `useStorefrontStore.installedAt` from a per-section
	// installed-flag endpoint. The server today exposes only the catalog
	// (`/storefront/featured|trending|new|section/:section` in
	// `apps/server/src/routes-storefront.ts`); no `/storefront/installed`
	// route returns per-section installed ids. Until that endpoint lands,
	// installs only flip locally on the marketplace round-trip — refresh
	// resets the chip back to "Get" until the user reinstalls.

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6">
			<StorefrontHero />
			<McpHealthStrip />
			<FilterChips active="all" />

			{loading ? (
				<div className="font-mono text-2xs text-ink-3">loading…</div>
			) : (
				<>
					<StoreRow title="Featured" items={featured} />
					<StoreRow title="Trending" items={trending} />
					<StoreRow title="New & Noteworthy" items={fresh} />
				</>
			)}
		</div>
	);
}

function StorefrontHero() {
	return (
		<div className="flex flex-col gap-2 rounded-2xl border border-line bg-paper-2 px-6 py-5">
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">storefront</div>
			<h1 className="text-2xl font-semibold tracking-tight text-ink">Build your deck</h1>
			<p className="max-w-2xl text-sm text-ink-2">
				Plugins, MCP servers, skills, and prompts — discover and install extensions the rest of the deck
				already speaks to.
			</p>
			<div className="mt-2 flex gap-3">
				<Link
					to="/storefront/plugins"
					className="rounded-full bg-accent px-4 py-1.5 text-xs font-medium text-paper transition-colors hover:bg-accent-2"
				>
					Browse plugins
				</Link>
				<Link
					to="/storefront/search"
					className="rounded-full border border-line bg-paper px-4 py-1.5 text-xs font-medium text-ink hover:border-ink/30"
				>
					Search
				</Link>
			</div>
		</div>
	);
}

function StoreRow({ title, items }: { title: string; items: StoreItem[] }) {
	if (items.length === 0) return null;
	return (
		<section className="flex flex-col gap-3">
			<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">{title}</h2>
			<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{items.map((item) => (
					<StoreCard key={`${item.section}:${item.id}`} item={item} />
				))}
			</div>
		</section>
	);
}
