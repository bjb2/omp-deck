import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Star } from "lucide-react";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { storefrontApi } from "@/lib/storefront-api";
import { InstallButton } from "./InstallButton";

/**
 * `/storefront/:section/:id` — single item detail page. Hero strip
 * (name + tagline + author), big "Get" button, description body,
 * ratings/installs row, and the version history list. Falls back to
 * "not found" if the server returns 404.
 */
export function StorefrontDetail() {
	const { section: rawSection, id: rawId } = useParams<{ section: string; id: string }>();
	const section = (rawSection ?? "plugins") as StoreSection;
	const id = rawId ?? "";
	const [item, setItem] = useState<StoreItem | null>(null);
	const [state, setState] = useState<"loading" | "missing" | "ready">("loading");

	useEffect(() => {
		let alive = true;
		async function load() {
			setState("loading");
			const r = await storefrontApi.item(section, id);
			if (!alive) return;
			if (r === null) {
				setState("missing");
			} else {
				setItem(r.item);
				setState("ready");
			}
		}
		void load();
		return () => {
			alive = false;
		};
	}, [section, id]);

	if (state === "loading") {
		return (
			<div className="mx-auto w-full max-w-3xl px-4 py-10">
				<div className="font-mono text-2xs text-ink-3">loading…</div>
			</div>
		);
	}
	if (state === "missing" || !item) {
		return (
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-10">
				<Link to="/storefront" className="inline-flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink">
					<ArrowLeft className="h-3 w-3" />
					storefront
				</Link>
				<div className="rounded-xl border border-dashed border-line bg-paper-2 px-4 py-12 text-center">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">404</div>
					<p className="mt-2 text-sm text-ink-2">No item at {section}/{id}.</p>
				</div>
			</div>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
			<Link to={`/storefront/${item.section}`} className="inline-flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink">
				<ArrowLeft className="h-3 w-3" />
				{item.section}
			</Link>

			<header className="flex flex-col gap-3 rounded-2xl border border-line bg-paper-2 px-6 py-5">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{item.section}</div>
						<h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{item.name}</h1>
						<p className="mt-1 text-sm text-ink-2">{item.tagline}</p>
					</div>
					<InstallButton item={item} />
				</div>
				<div className="flex flex-wrap items-center gap-3 pt-2">
					<DetailLabel label="Author" value={item.author.name} href={item.author.url} />
					<DetailLabel label="Installs" value={item.installs.toLocaleString()} />
					{item.ratings.count > 0 ? (
						<DetailLabel
							label="Rating"
							value={
								<span className="inline-flex items-center gap-1">
									<Star className="h-3 w-3 fill-accent text-accent" />
									{item.ratings.stars.toFixed(1)} ({item.ratings.count})
								</span>
							}
						/>
					) : null}
					{item.source.url ? (
						<DetailLabel
							label="Source"
							value={
								<a className="inline-flex items-center gap-1 text-accent hover:underline" href={item.source.url} target="_blank" rel="noreferrer">
									{item.source.kind}
									<ExternalLink className="h-3 w-3" />
								</a>
							}
						/>
					) : null}
				</div>
			</header>

			<section className="flex flex-col gap-2">
				<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">About</h2>
				<p className="whitespace-pre-wrap text-sm text-ink-2">{item.description || item.tagline}</p>
			</section>

			{item.versionHistory.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Version history</h2>
					<ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper-2">
						{item.versionHistory.map((v) => (
							<li key={v.version} className="flex items-baseline justify-between gap-3 px-4 py-2 text-xs">
								<span className="font-mono text-ink">{v.version}</span>
								<span className="font-mono text-2xs text-ink-3">{v.date}</span>
								<span className="flex-1 truncate text-ink-2">{v.notes || "—"}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{item.capabilities.categories.length > 0 || item.capabilities.toolNames.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Capabilities</h2>
					<div className="flex flex-wrap gap-1.5">
						{item.capabilities.categories.map((c) => (
							<span key={c} className="rounded-md border border-line bg-paper-2 px-2 py-0.5 font-mono text-2xs text-ink-2">
								{c}
							</span>
						))}
						{item.capabilities.toolNames.map((t) => (
							<span key={t} className="rounded-md border border-line bg-paper-2 px-2 py-0.5 font-mono text-2xs text-ink-2">
								{t}
							</span>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
}

function DetailLabel({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
	const inner = typeof value === "string" ? <span className="text-ink">{value}</span> : value;
	return (
		<div className="flex items-center gap-1.5 font-mono text-2xs">
			<span className="uppercase tracking-meta text-ink-3">{label}</span>
			{href ? (
				<a href={href} target="_blank" rel="noreferrer" className="text-accent hover:underline">
					{inner}
				</a>
			) : (
				inner
			)}
		</div>
	);
}
