import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search as SearchIcon } from "lucide-react";
import type { DiscoveryHit, StoreSection } from "@omp-deck/protocol";
import { storefrontApi } from "@/lib/storefront-api";
import { cn } from "@/lib/utils";

type SectionFilter = "all" | StoreSection;

/**
 * `/storefront/search?q=&section=` — discovery-backed search. The
 * server fans the query across all configured providers (§2 of
 * docs/STOREFRONT.md) and returns scored hits; this view renders the
 * result list and lets the user narrow by section.
 */
export function StorefrontSearch() {
	const [params, setParams] = useSearchParams();
	const q = params.get("q") ?? "";
	const section = (params.get("section") ?? "all") as SectionFilter;
	const [hits, setHits] = useState<DiscoveryHit[]>([]);
	const [meta, setMeta] = useState<{ providers: string[]; tookMs: number }>({ providers: [], tookMs: 0 });
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		let alive = true;
		async function run() {
			if (!q.trim()) {
				setHits([]);
				setMeta({ providers: [], tookMs: 0 });
				return;
			}
			setSearching(true);
			const r = await storefrontApi.discover(q, section, 30);
			if (!alive) return;
			setHits(r.hits);
			setMeta({ providers: [], tookMs: 0 });
			setSearching(false);
		}
		void run();
		return () => {
			alive = false;
		};
	}, [q, section]);

	function setQuery(next: string) {
		const p = new URLSearchParams(params);
		if (next) p.set("q", next);
		else p.delete("q");
		setParams(p, { replace: true });
	}

	function setSection(next: SectionFilter) {
		const p = new URLSearchParams(params);
		if (next === "all") p.delete("section");
		else p.set("section", next);
		setParams(p, { replace: true });
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
			<header className="flex flex-col gap-1">
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">storefront</div>
				<h1 className="text-xl font-semibold tracking-tight text-ink">Search</h1>
			</header>
			<label className="flex items-center gap-2 rounded-full border border-line bg-paper-2 px-4 py-2">
				<SearchIcon className="h-4 w-4 text-ink-3" />
				<input
					type="search"
					placeholder="Search plugins, MCPs, skills, prompts…"
					defaultValue={q}
					onChange={(e) => setQuery(e.target.value)}
					className="flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
				/>
			</label>
			<div className="flex flex-wrap gap-2">
				{(["all", "plugins", "mcps", "skills", "prompts"] as const).map((s) => (
					<button
						key={s}
						type="button"
						onClick={() => setSection(s)}
						className={cn(
							"rounded-full border px-3 py-1 font-mono text-2xs uppercase tracking-meta transition-colors",
							section === s
								? "border-accent bg-accent/10 text-accent"
								: "border-line bg-paper text-ink-3 hover:border-ink/30 hover:text-ink",
						)}
					>
						{s}
					</button>
				))}
			</div>
			{searching ? (
				<div className="font-mono text-2xs text-ink-3">searching…</div>
			) : hits.length === 0 ? (
				<div className="rounded-xl border border-dashed border-line bg-paper-2 px-4 py-12 text-center">
					<p className="text-sm text-ink-2">{q.trim() ? "No hits." : "Type to search across the catalog."}</p>
					{meta.tookMs > 0 ? (
						<p className="mt-1 font-mono text-2xs text-ink-3">{meta.tookMs}ms · {meta.providers.length} providers</p>
					) : null}
				</div>
			) : (
				<ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper-2">
					{hits.map((hit) => (
						<li key={hit.id}>
							<Link
								to={hit.url}
								className="flex flex-col gap-1 px-4 py-3 transition-colors hover:bg-paper-3"
							>
								<div className="flex items-baseline justify-between gap-2">
									<span className="truncate text-sm font-semibold text-ink">{hit.title}</span>
									<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
										{hit.section}
									</span>
								</div>
								{hit.tagline ? <p className="line-clamp-1 text-2xs text-ink-3">{hit.tagline}</p> : null}
								{hit.snippet ? <p className="line-clamp-2 text-xs text-ink-2">{hit.snippet}</p> : null}
								{hit.signals.length > 0 ? (
									<div className="flex flex-wrap gap-1 pt-1">
										{hit.signals.map((sig) => (
											<span key={sig} className="rounded-md border border-line bg-paper px-1.5 py-0.5 font-mono text-2xs text-ink-3">
												{sig}
											</span>
										))}
									</div>
								) : null}
							</Link>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
