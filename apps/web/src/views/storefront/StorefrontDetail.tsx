import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, ExternalLink, Loader2, RefreshCw, Star, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { StoreItem, StoreSection } from "@omp-deck/protocol";
import { storefrontApi } from "@/lib/storefront-api";
import { marketplaceApi } from "@/lib/marketplace-api";
import { useStore } from "@/lib/store";
import { InstallButton } from "./InstallButton";

/** Safe number formatter — never throws even when the catalog serves a
 *  malformed row. Returns "0" for NaN/null/undefined. */
function safeInt(n: unknown): number {
	if (typeof n === "number" && Number.isFinite(n)) return n;
	return 0;
}
function safeStar(n: unknown): number {
	if (typeof n === "number" && Number.isFinite(n)) return n;
	return 0;
}
function safeStr(s: unknown, fallback = ""): string {
	return typeof s === "string" ? s : fallback;
}

/**
 * `/storefront/:section/:id` — single item detail page. Hero strip
 * (name + tagline + author), big "Get" button, description body,
 * ratings/installs row, and the version history list. Falls back to
 * "not found" if the server returns 404.
 */
export function StorefrontDetail() {
	const navigate = useNavigate();
	const { section: rawSection, id: rawId } = useParams<{ section: string; id: string }>();
	const section = (rawSection ?? "plugins") as StoreSection;
	const id = rawId ?? "";
	const [item, setItem] = useState<StoreItem | null>(null);
	const [state, setState] = useState<"loading" | "missing" | "ready" | "error">("loading");
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let alive = true;
		async function load() {
			setState("loading");
			setError(undefined);
			try {
				const r = await storefrontApi.item(section, id);
				if (!alive) return;
				if (r === null) {
					setState("missing");
				} else if (!r.item || typeof r.item !== "object") {
					setError("server returned a malformed item");
					setState("error");
				} else {
					setItem(r.item);
					setState("ready");
				}
			} catch (e) {
				if (!alive) return;
				setError((e as Error).message ?? String(e));
				setState("error");
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
	const back = (
		<div className="flex items-center gap-3">
			<button
				type="button"
				onClick={() => navigate("/storefront")}
				className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink-3 hover:text-ink"
			>
				<ArrowLeft className="h-3 w-3" />
				Back to storefront
			</button>
			<Link to={`/storefront/${section}`} className="inline-flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink">
				<ArrowLeft className="h-3 w-3" />
				{section}
			</Link>
		</div>
	);
	if (state === "error") {
		return (
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-10">
				{back}
				<div className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
					<div className="font-mono text-2xs uppercase tracking-meta">error</div>
					<p className="mt-1">Couldn’t load {section}/{id}.</p>
					{error ? (
						<pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-paper-2 px-2 py-1 font-mono text-2xs text-ink-2">
							{error}
						</pre>
					) : null}
					<button
						type="button"
						onClick={() => void (async () => {
							setState("loading");
							try {
								const r = await storefrontApi.item(section, id);
								if (r === null) setState("missing");
								else if (r.item) {
									setItem(r.item);
									setState("ready");
								} else setState("error");
							} catch (e) {
								setError((e as Error).message ?? String(e));
								setState("error");
							}
						})()}
						className="btn-ghost mt-3 inline-flex h-7 items-center gap-1 rounded-md border border-line bg-paper-2 px-2 text-2xs hover:bg-paper-3"
					>
						<RefreshCw className="h-3 w-3" /> Retry
					</button>
				</div>
			</div>
		);
	}
	if (state === "missing" || !item) {
		return (
			<div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-10">
				{back}
				<div className="rounded-xl border border-dashed border-line bg-paper-2 px-4 py-12 text-center">
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">404</div>
					<p className="mt-2 text-sm text-ink-2">No item at {section}/{id}.</p>
				</div>
			</div>
		);
	}

	const safeSection = safeStr(item.section, section);
	const safeAuthorName = safeStr(item.author?.name, "Unknown");
	const safeAuthorUrl = typeof item.author?.url === "string" ? item.author.url : undefined;
	const safeTagline = safeStr(item.tagline, "");
	const safeDescription = safeStr(item.description, safeTagline || "No description yet.");
	const safeInstalls = safeInt(item.installs);
	const safeRatingCount = safeInt(item.ratings?.count);
	const safeRatingStars = safeStar(item.ratings?.stars);
	const safeVersionHistory = Array.isArray(item.versionHistory) ? item.versionHistory : [];
	const safeCategories = Array.isArray(item.capabilities?.categories) ? item.capabilities.categories : [];
	const safeTools = Array.isArray(item.capabilities?.toolNames) ? item.capabilities.toolNames : [];
	const safeSourceUrl = typeof item.source?.url === "string" ? item.source.url : "";
	const safeSourceKind = safeStr(item.source?.kind, "");
	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6">
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={() => navigate("/storefront")}
					className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink-3 hover:text-ink"
				>
					<ArrowLeft className="h-3 w-3" />
					Back to storefront
				</button>
				<Link to={`/storefront/${safeSection}`} className="inline-flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink">
					<ArrowLeft className="h-3 w-3" />
					{safeSection}
				</Link>
			</div>

			<header className="flex flex-col gap-3 rounded-2xl border border-line bg-paper-2 px-6 py-5">
				<div className="flex items-start justify-between gap-4">
					<div className="min-w-0">
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{safeSection}</div>
						<h1 className="mt-1 text-2xl font-semibold tracking-tight text-ink">{safeStr(item.name, "Untitled")}</h1>
						<p className="mt-1 text-sm text-ink-2">{safeTagline}</p>
					</div>
					{item.installed ? (
						<RemoveButton item={item} onRemoved={() => setItem({ ...item, installed: false })} />
					) : (
						<InstallButton item={item} />
					)}
					{item.installed && item.updateAvailable ? (
					<UpdateButton item={item} onUpdated={() => setItem({ ...item, updateAvailable: false })} />
					) : null}
				</div>
				<div className="flex flex-wrap items-center gap-3 pt-2">
					<DetailLabel label="Author" value={safeAuthorName} href={safeAuthorUrl} />
					<DetailLabel label="Installs" value={safeInstalls.toLocaleString()} />
					{item.ratings.count > 0 ? (
						<DetailLabel
							label="Rating"
							value={
								<span className="inline-flex items-center gap-1">
									<Star className="h-3 w-3 fill-accent text-accent" />
									{safeRatingStars.toFixed(1)} ({safeRatingCount})
								</span>
							}
						/>
					) : null}
					{item.source.url ? (
						<DetailLabel
							label="Source"
							value={
								<a className="inline-flex items-center gap-1 text-accent hover:underline" href={safeSourceUrl} target="_blank" rel="noreferrer">
									{safeSourceKind}
									<ExternalLink className="h-3 w-3" />
								</a>
							}
						/>
					) : null}
				</div>
			</header>

			<section className="flex flex-col gap-2">
				<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">About</h2>
				<p className="whitespace-pre-wrap text-sm text-ink-2">{safeDescription}</p>
			</section>

			{safeVersionHistory.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Version history</h2>
					<ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper-2">
						{safeVersionHistory.map((v) => (
							<li key={v.version} className="flex items-baseline justify-between gap-3 px-4 py-2 text-xs">
								<span className="font-mono text-ink">{v.version}</span>
								<span className="font-mono text-2xs text-ink-3">{v.date}</span>
								<span className="flex-1 truncate text-ink-2">{v.notes || "—"}</span>
							</li>
						))}
					</ul>
				</section>
			) : null}

			{safeCategories.length > 0 || safeTools.length > 0 ? (
				<section className="flex flex-col gap-2">
					<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Capabilities</h2>
					<div className="flex flex-wrap gap-1.5">
						{safeCategories.map((c) => (
							<span key={c} className="rounded-md border border-line bg-paper-2 px-2 py-0.5 font-mono text-2xs text-ink-2">
								{c}
							</span>
						))}
						{safeTools.map((t) => (
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

function RemoveButton({ item, onRemoved }: { item: StoreItem; onRemoved: () => void }) {
	const [removing, setRemoving] = useState(false);

	async function handleRemove() {
		if (removing) return;
		setRemoving(true);
		try {
			await marketplaceApi.uninstallByPluginId(item.id);
			pushToast("info", `Removed ${item.name}`, `Uninstalled from deck marketplace.`);
			onRemoved();
		} catch (err) {
			setRemoving(false);
			const e = err as Error & { message?: string };
			pushToast("error", `Remove failed: ${item.name}`, e.message ?? String(err));
		}
	}

	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void handleRemove();
			}}
			disabled={removing}
			className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-4 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
		>
			{removing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
			{removing ? "Removing…" : "Remove"}
		</button>
	);
}

function UpdateButton({ item, onUpdated }: { item: StoreItem; onUpdated: () => void }) {
	const [updating, setUpdating] = useState(false);

	async function handleUpdate() {
		if (updating) return;
		setUpdating(true);
		try {
			await storefrontApi.marketplaceUpgrade(item.id);
			pushToast("info", `Updated ${item.name}`, "Reinstalled from the marketplace catalog.");
			onUpdated();
		} catch (err) {
			setUpdating(false);
			const e = err as Error & { message?: string };
			pushToast("error", `Update failed: ${item.name}`, e.message ?? String(err));
		}
	}

	return (
		<button
			type="button"
			onClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				void handleUpdate();
			}}
			disabled={updating}
			className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-4 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/15 disabled:opacity-50"
		>
			{updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
			{updating ? "Updating…" : "Update"}
		</button>
	);
}

function pushToast(level: "info" | "error", title: string, body: string): void {
	const id = `storefront-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
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
