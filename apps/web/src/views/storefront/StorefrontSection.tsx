import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { storefrontApi } from "@/lib/storefront-api";
import { FilterChips } from "./FilterChips";
import { StoreCard } from "./StoreCard";

/**
 * `/storefront/:section` — section grid with sort filter. The section
 * chip row at the top is the same control as on the home page; this
 * view adds a three-way sort (recent, popular, name) and re-fetches
 * the section list when either changes.
 */
export function StorefrontSection() {
	const { section: raw } = useParams<{ section: string }>();
	const section = (raw ?? "plugins") as StoreSection;
	const [items, setItems] = useState<StoreItem[]>([]);
	const [sort, setSort] = useState<"recent" | "popular" | "name">("recent");
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let alive = true;
		async function load() {
			setLoading(true);
			const r = await storefrontApi.section(section);
			if (!alive) return;
			setItems(r.items);
			setLoading(false);
		}
		void load();
		return () => {
			alive = false;
		};
	}, [section]);

	const sorted = useMemo(() => {
		const copy = items.slice();
		if (sort === "recent") {
			copy.sort((a, b) => new Date(b.lastUpdated).getTime() - new Date(a.lastUpdated).getTime());
		} else if (sort === "popular") {
			copy.sort((a, b) => b.installs - a.installs);
		} else {
			copy.sort((a, b) => a.name.localeCompare(b.name));
		}
		return copy;
	}, [items, sort]);

	return (
		<div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
			<div className="flex items-center gap-2">
				<Link
					to="/storefront"
					className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink-3 hover:text-ink"
				>
					<ArrowLeft className="h-3 w-3" />
					Back
				</Link>
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">storefront</div>
			</div>
			<header className="flex flex-col gap-1">
				<h1 className="text-xl font-semibold tracking-tight text-ink capitalize">{section}</h1>
			</header>
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger" role="alert">
					{error}
				</div>
			) : null}
			<FilterChips active={section} />
			<div className="flex items-center gap-2">
				<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">Sort</span>
				{(
					[
						{ v: "recent", label: "Recent" },
						{ v: "popular", label: "Popular" },
						{ v: "name", label: "Name" },
					] as const
				).map((o) => (
					<button
						key={o.v}
						type="button"
						onClick={() => setSort(o.v)}
						className={
							sort === o.v
								? "rounded-full border border-accent bg-accent/10 px-3 py-1 font-mono text-2xs uppercase tracking-meta text-accent"
								: "rounded-full border border-line bg-paper px-3 py-1 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-ink/30"
						}
					>
						{o.label}
					</button>
				))}
			</div>
			{loading ? (
				<div className="font-mono text-2xs text-ink-3">loading…</div>
			) : sorted.length === 0 ? (
				<div className="rounded-xl border border-dashed border-line bg-paper-2 px-4 py-12 text-center">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{section}</div>
					<p className="mt-2 text-sm text-ink-2">No items in this section yet.</p>
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
					{sorted.map((item) => (
						<StoreCard key={`${item.section}:${item.id}`} item={item} />
					))}
				</div>
			)}
		</div>
	);
}
