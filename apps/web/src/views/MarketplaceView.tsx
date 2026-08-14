import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Download, Loader2, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { FlaskConical } from "lucide-react";
import type {
	ListMarketplaceResponse,
	MarketplaceCatalogEntry,
	MarketplaceSource,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { marketplaceApi } from "@/lib/marketplace-api";
import { marketplaceExtrasApi, type ScoredMarketplaceEntry } from "@/lib/marketplace-api";
import { cn } from "@/lib/utils";
import type { DryRunInstallResponse, InstallPluginErrorResponse } from "@omp-deck/protocol";

type ScopeFilter = "all" | "installed" | "available";

export function MarketplaceView() {
	const [data, setData] = useState<ListMarketplaceResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [scope, setScope] = useState<ScopeFilter>("all");
	const [marketplaceFilter, setMarketplaceFilter] = useState<string | "all">("all");
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [busyId, setBusyId] = useState<string | undefined>();
	const [refreshing, setRefreshing] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [featured, setFeatured] = useState<ScoredMarketplaceEntry[]>([]);
	const [popular, setPopular] = useState<ScoredMarketplaceEntry[]>([]);
	const [dryRun, setDryRun] = useState<{ entryId: string; busy: boolean; result?: DryRunInstallResponse; error?: InstallPluginErrorResponse | { error: string } } | undefined>();
	useEffect(() => {
		void marketplaceExtrasApi.featured(8).then((r) => setFeatured(r.results)).catch(() => setFeatured([]));
		void marketplaceExtrasApi.popular(12).then((r) => setPopular(r.results)).catch(() => setPopular([]));
	}, [data]);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await marketplaceApi.list();
			setData(next);
			setError(undefined);
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const catalog = data?.catalog ?? [];
		const q = search.trim().toLowerCase();
		return catalog
			.filter((entry) => {
				if (marketplaceFilter !== "all" && entry.marketplace !== marketplaceFilter) return false;
				if (scope === "installed" && !entry.installed) return false;
				if (scope === "available" && entry.installed) return false;
				if (!q) return true;
				const haystack = [
					entry.name,
					entry.marketplace,
					entry.description ?? "",
					entry.author ?? "",
					(entry.tags ?? []).join(" "),
				]
					.join(" ")
					.toLowerCase();
				return haystack.includes(q);
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}, [data, search, scope, marketplaceFilter]);

	const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0];

	async function install(entry: MarketplaceCatalogEntry, installScope: "user" | "project" = "user"): Promise<void> {
		setBusyId(entry.id);
		setError(undefined);
		try {
			await marketplaceApi.install({ name: entry.name, marketplace: entry.marketplace, scope: installScope });
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusyId(undefined);
		}
	}

	async function uninstall(info: { id: string; scope: "user" | "project" }): Promise<void> {
		setBusyId(info.id);
		setError(undefined);
		try {
			await marketplaceApi.uninstall({ id: info.id, scope: info.scope });
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusyId(undefined);
		}
	}

	async function toggleEnabled(info: { id: string; scope: "user" | "project"; enabled: boolean }): Promise<void> {
		setBusyId(info.id);
		setError(undefined);
		try {
			await marketplaceApi.setPluginEnabled(info.id, info.enabled, info.scope);
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusyId(undefined);
		}
	}

	async function refreshSources(): Promise<void> {
		setRefreshing(true);
		setError(undefined);
		try {
			await marketplaceApi.refresh();
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setRefreshing(false);
		}
	}

	async function removeSource(name: string): Promise<void> {
		setError(undefined);
		try {
			await marketplaceApi.removeMarketplace(name);
			await refresh();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		}
	}

	async function runDryRun(entry: MarketplaceCatalogEntry): Promise<void> {
		setDryRun({ entryId: entry.id, busy: true });
		try {
			const resp = await marketplaceApi.dryRun({ name: entry.name, marketplace: entry.marketplace });
			setDryRun((prev) => (prev?.entryId === entry.id ? { entryId: entry.id, busy: false, result: resp } : prev));
		} catch (e) {
			const raw = String((e as Error).message ?? e);
			const parsed = parseDryRunError(raw);
			setDryRun((prev) => (prev?.entryId === entry.id ? { entryId: entry.id, busy: false, error: parsed ?? { error: raw } } : prev));
		}
	}

	return (
		<>
			<Layout
				sidebar={
					<MarketplaceSidebar
						sources={data?.sources ?? []}
						counts={{
							all: data?.catalog.length ?? 0,
							installed: data?.installed.length ?? 0,
							available: (data?.catalog.length ?? 0) - (data?.installed.length ?? 0),
						}}
						scope={scope}
						onScope={setScope}
						marketplaceFilter={marketplaceFilter}
						onMarketplaceFilter={setMarketplaceFilter}
						onAdd={() => setAddOpen(true)}
						onRefresh={() => void refreshSources()}
						refreshing={refreshing}
						onRemoveSource={(name) => void removeSource(name)}
					/>
				}
				inspector={<MarketplaceInspector entry={selected} dryRun={dryRun} onDryRun={(entry) => void runDryRun(entry)} />}
				main={
					<div className="flex h-full min-h-0 flex-col">
						<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
							<div className="meta">Marketplace</div>
							<div className="text-xs text-ink-3">
								{loading ? "loading..." : `${filtered.length} / ${data?.catalog.length ?? 0}`}
							</div>
							<Link
								to="/storefront"
								className="rounded-md border border-line bg-paper-2 px-2 py-1 text-xs text-ink-2 hover:border-ink/30 hover:text-ink"
							>
								Storefront →
							</Link>
							<div className="flex-1" />
							<div data-tooltip-key="marketplace.search" className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1 text-xs">
								<Search className="h-3.5 w-3.5 text-ink-3" />
								<input
									value={search}
									onChange={(e) => setSearch(e.target.value)}
									placeholder="Search by name, tag, description"
									className="w-56 bg-transparent text-ink placeholder:text-ink-4 focus:outline-none"
								/>
							</div>
						</div>
						{error ? (
							<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							{loading && !data ? (
								<div className="px-3 py-6 text-center text-sm text-ink-3">Loading marketplace catalog...</div>
							) : null}
							{!loading && (data?.sources.length ?? 0) === 0 ? (
								<EmptySources onAdd={() => setAddOpen(true)} onAdded={() => void refresh()} />
							) : null}
							{filtered.length === 0 && !loading && (data?.sources.length ?? 0) > 0 ? (
								<div className="px-3 py-6 text-center text-sm text-ink-3">
									No catalog entries match the current filters.
								</div>
							) : null}
							{(featured.length > 0 || popular.length > 0) ? (
						<div className="mb-3 space-y-3">
							{featured.length > 0 ? (
								<section data-tooltip-key="marketplace.featured" className="rounded-md border border-accent/30 bg-accent-soft/40 p-3">
									<div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-meta text-accent">
										<span>Featured</span>
										<span className="text-ink-3">· curated picks</span>
									</div>
									<div className="flex flex-wrap gap-2">
										{featured.map((entry) => (
											<button
												key={entry.id}
												type="button"
												onClick={() => setSelectedId(entry.id)}
												data-tooltip-key="marketplace.install"
												className="rounded-md border border-line bg-paper px-2.5 py-1 text-left text-xs hover:border-accent"
											>
												<div className="font-medium">{entry.name}</div>
												<div className="text-ink-3 text-2xs">{entry.marketplace}</div>
											</button>
										))}
									</div>
								</section>
							) : null}
							{popular.length > 0 ? (
								<section data-tooltip-key="marketplace.popular" className="rounded-md border border-line bg-paper-2 p-3">
									<div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-meta text-ink-3">
										<span>Popular</span>
										<span className="text-ink-3">· this week</span>
									</div>
									<div className="flex flex-wrap gap-2">
										{popular.map((entry) => (
											<button
												key={entry.id}
												type="button"
												onClick={() => setSelectedId(entry.id)}
												data-tooltip-key="marketplace.install"
												className="rounded-md border border-line bg-paper px-2.5 py-1 text-left text-xs hover:border-accent"
											>
												<div className="font-medium">{entry.name}</div>
												<div className="text-ink-3 text-2xs">{entry.marketplace}</div>
											</button>
										))}
									</div>
								</section>
							) : null}
						</div>
					) : null}
					<div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
								{filtered.map((entry) => (
									<EntryCard
										key={entry.id}
										entry={entry}
										isSelected={selected?.id === entry.id}
										busy={busyId === entry.id}
										onSelect={() => setSelectedId(entry.id)}
										onInstall={() => void install(entry)}
										onUninstall={() =>
											entry.installed ? void uninstall({ id: entry.id, scope: entry.installed.scope }) : undefined
										}
									onToggleEnabled={() =>
										entry.installed
											? void toggleEnabled({
													id: entry.id,
													scope: entry.installed.scope,
													enabled: entry.installed.enabled === false,
												})
											: undefined
										}
									/>
								))}
							</div>
						</div>
					</div>
				}
			/>
			<AddMarketplaceModalHost
				open={addOpen}
				onClose={() => setAddOpen(false)}
				onAdded={() => void refresh()}
			/>
		</>
	);
}

function MarketplaceSidebar({
	sources,
	counts,
	scope,
	onScope,
	marketplaceFilter,
	onMarketplaceFilter,
	onAdd,
	onRefresh,
	refreshing,
	onRemoveSource,
}: {
	sources: MarketplaceSource[];
	counts: { all: number; installed: number; available: number };
	scope: ScopeFilter;
	onScope: (s: ScopeFilter) => void;
	marketplaceFilter: string | "all";
	onMarketplaceFilter: (s: string | "all") => void;
	onAdd: () => void;
	onRefresh: () => void;
	refreshing: boolean;
	onRemoveSource: (name: string) => void;
}) {
	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
				<div className="meta">Catalog</div>
			</div>
			<div className="space-y-2 px-2 pt-2">
				<ScopeRow label="All" count={counts.all} active={scope === "all"} onClick={() => onScope("all")} />
				<ScopeRow
					label="Installed"
					count={counts.installed}
					active={scope === "installed"}
					onClick={() => onScope("installed")}
				/>
				<ScopeRow
					label="Available"
					count={counts.available}
					active={scope === "available"}
					onClick={() => onScope("available")}
				/>
			</div>
			<div className="mt-4 flex h-7 items-center justify-between px-3">
				<div className="meta">Sources</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						className="text-ink-3 hover:text-ink"
						onClick={onRefresh}
						title="Refresh marketplaces"
						disabled={refreshing}
					>
						{refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
					</button>
					<button type="button" className="text-ink-3 hover:text-ink" onClick={onAdd} title="Add marketplace">
						<Plus className="h-3.5 w-3.5" />
					</button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
				<button
					type="button"
					onClick={() => onMarketplaceFilter("all")}
					className={cn(
						"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
						marketplaceFilter === "all" ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
					)}
				>
					<span className="truncate">All marketplaces</span>
				</button>
				{sources.map((source) => (
					<div
						key={source.name}
						className={cn(
							"group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-sm",
							marketplaceFilter === source.name ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
						)}
					>
						<button
							type="button"
							onClick={() => onMarketplaceFilter(source.name)}
							className="min-w-0 flex-1 truncate text-left"
							title={source.sourceUri}
						>
							{source.name}
						</button>
						<button
							type="button"
							className="opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
							title={`Remove ${source.name}`}
							onClick={() => onRemoveSource(source.name)}
						>
							<X className="h-3.5 w-3.5" />
						</button>
					</div>
				))}
			</div>
		</div>
	);
}

function ScopeRow({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm",
				active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-paper-3",
			)}
		>
			<span>{label}</span>
			<span className="font-mono text-2xs text-ink-3">{count}</span>
		</button>
	);
}

const SUGGESTED_MARKETPLACES: ReadonlyArray<{ source: string; label: string; description: string }> = [
	{
		source: "anthropics/claude-plugins-official",
		label: "Anthropic official",
		description: "Anthropic's first-party catalog. Curated plugins, commands, and skills — the SDK's recommended starter.",
	},
];

function EmptySources({ onAdd, onAdded }: { onAdd: () => void; onAdded: () => void }) {
	const [adding, setAdding] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();
	const [addedName, setAddedName] = useState<string | undefined>();

	async function addSuggested(source: string): Promise<void> {
		setAdding(source);
		setError(undefined);
		try {
			const resp = await marketplaceApi.addMarketplace(source);
			setAddedName(resp.marketplace.name);
			onAdded();
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setAdding(undefined);
		}
	}
	return (
		<div className="mx-auto max-w-xl space-y-3 rounded-md border border-dashed border-line bg-paper-2 p-6">
			<div className="text-center">
				<div className="meta">No marketplaces yet</div>
				<p className="mt-1 text-sm text-ink-3">
					Add a marketplace catalog (GitHub repo, git URL, or local path) to browse and install plugins.
				</p>
			</div>
			<div className="space-y-2">
				<div className="meta">Suggested</div>
				{SUGGESTED_MARKETPLACES.map((m) => (
					<div
						key={m.source}
						className="flex items-start gap-3 rounded-md border border-line bg-paper px-3 py-2"
					>
						<div className="min-w-0 flex-1">
							<div className="text-sm font-medium text-ink">{m.label}</div>
							<div className="mt-0.5 font-mono text-2xs text-ink-3">{m.source}</div>
							<div className="mt-1 text-xs text-ink-3">{m.description}</div>
						</div>
						<Button
							variant="primary"
							size="sm"
							disabled={adding !== undefined}
							onClick={() => void addSuggested(m.source)}
						>
							{adding === m.source ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
							Add
						</Button>
					</div>
				))}
			</div>
			{addedName ? (
				<div className="rounded-md border border-success/30 bg-success/10 px-3 py-2 font-mono text-xs text-success">
					Added {addedName}. Refresh below to fetch its catalog.
				</div>
			) : null}
			{error ? (
				<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}
			<div className="flex justify-center pt-1">
				<Button variant="outline" size="sm" onClick={onAdd}>
					<Plus className="h-3.5 w-3.5" />
					Add custom marketplace
				</Button>
			</div>
		</div>
	);
}

function EntryCard({
	entry,
	isSelected,
	busy,
	onSelect,
	onInstall,
	onUninstall,
	onToggleEnabled,
}: {
	entry: MarketplaceCatalogEntry;
	isSelected: boolean;
	busy: boolean;
	onSelect: () => void;
	onInstall: () => void;
	onUninstall: () => void;
	onToggleEnabled: () => void;
}) {
	const caps = [
		entry.capabilities.commands && "cmds",
		entry.capabilities.agents && "agents",
		entry.capabilities.hooks && "hooks",
		entry.capabilities.mcpServers && "mcp",
		entry.capabilities.lspServers && "lsp",
	].filter(Boolean) as string[];
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"flex flex-col gap-2 rounded-md border bg-paper p-3 text-left transition-colors",
				isSelected ? "border-accent ring-1 ring-accent/40" : "border-line hover:border-ink/30",
			)}
		>
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0">
					<div className="truncate text-sm font-semibold text-ink">{entry.name}</div>
					<div className="mt-0.5 truncate font-mono text-2xs text-ink-3">{entry.marketplace}</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{entry.installed ? (
						<>
							<Badge tone="success">installed</Badge>
							<button
								type="button"
								className={cn(
									"rounded-md px-1.5 py-0.5 text-2xs uppercase tracking-meta transition-colors",
									entry.installed.enabled === false
										? "border border-accent/40 bg-accent/10 text-accent hover:bg-accent/15"
										: "border border-line bg-paper-2 text-ink-3 hover:border-ink/30 hover:text-ink",
								)}
								title={entry.installed.enabled === false ? "Enable plugin" : "Disable plugin"}
								onClick={(e) => {
									e.stopPropagation();
									onToggleEnabled();
								}}
								disabled={busy}
							>
								{entry.installed.enabled === false ? "Enable" : "Disable"}
							</button>
							<button
								type="button"
								className="text-ink-3 hover:text-danger"
								title="Uninstall"
								onClick={(e) => {
									e.stopPropagation();
									onUninstall();
								}}
								disabled={busy}
							>
								{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
							</button>
						</>
					) : (
						<button
							type="button"
							className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 text-2xs uppercase tracking-meta text-ink hover:border-ink/30"
							onClick={(e) => {
								e.stopPropagation();
								onInstall();
							}}
							disabled={busy}
						>
							{busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
							Install
						</button>
					)}
				</div>
			</div>
			{entry.description ? <div className="line-clamp-2 text-xs text-ink-3">{entry.description}</div> : null}
			{caps.length > 0 ? (
				<div className="flex flex-wrap gap-1">
					{caps.map((cap) => (
						<Badge key={cap} tone="muted">
							{cap}
						</Badge>
					))}
				</div>
			) : null}
		</button>
	);
}

type DryRunState = { entryId: string; busy: boolean; result?: DryRunInstallResponse; error?: InstallPluginErrorResponse | { error: string } };

function parseDryRunError(raw: string): InstallPluginErrorResponse | undefined {
	const brace = raw.indexOf("{");
	if (brace < 0) return undefined;
	const slice = raw.slice(brace);
	try {
		const parsed = JSON.parse(slice) as { error?: string };
		if (typeof parsed.error === "string" && parsed.error.length > 0) {
			return parsed as InstallPluginErrorResponse;
		}
	} catch {
		// Not JSON — fall through.
	}
	return undefined;
}

function MarketplaceInspector({ entry, dryRun, onDryRun }: { entry: MarketplaceCatalogEntry | undefined; dryRun?: DryRunState; onDryRun: (entry: MarketplaceCatalogEntry) => void }) {
	if (!entry) {
		return (
			<div className="space-y-2 p-3 text-xs text-ink-3">
				<div className="meta">Plugin details</div>
				<p>Select a plugin to see its full metadata.</p>
			</div>
		);
	}
	return (
		<div className="space-y-3 p-3">
			<div>
				<div className="meta">{entry.marketplace}</div>
				<div className="mt-0.5 text-sm font-semibold text-ink">{entry.name}</div>
				{entry.version ? <div className="font-mono text-2xs text-ink-3">v{entry.version}</div> : null}
			</div>
			{entry.description ? <p className="text-xs text-ink-2">{entry.description}</p> : null}
			<dl className="space-y-1.5 text-xs">
				{entry.author ? <DefRow k="author" v={entry.author} /> : null}
				{entry.homepage ? (
					<DefRow
						k="homepage"
						v={
							<a className="text-accent underline" href={entry.homepage} target="_blank" rel="noreferrer">
								{entry.homepage}
							</a>
						}
					/>
				) : null}
				{entry.category ? <DefRow k="category" v={entry.category} /> : null}
				{entry.tags && entry.tags.length > 0 ? (
					<DefRow
						k="tags"
						v={
							<span className="flex flex-wrap gap-1">
								{entry.tags.map((t) => (
									<Badge key={t} tone="muted">
										{t}
									</Badge>
								))}
							</span>
						}
					/>
				) : null}
				{entry.installed ? (
					<DefRow
						k="installed"
						v={
							<span>
								<Badge tone="success">{entry.installed.scope}</Badge>
								<span className="ml-1 font-mono text-2xs text-ink-3">v{entry.installed.version}</span>
							</span>
						}
					/>
				) : null}
			{dryRun?.entryId === entry.id ? (
				<div className="space-y-2 pt-1">
					<button
						type="button"
						onClick={() => onDryRun(entry)}
						disabled={dryRun.busy}
						className="inline-flex h-7 items-center gap-1.5 rounded-md border border-line bg-paper-2 px-2 text-xs font-medium text-ink-2 hover:border-accent hover:text-accent disabled:opacity-50"
					>
						{dryRun.busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
						{dryRun.busy ? "Testing…" : "Test Install"}
					</button>
					{!dryRun.busy && dryRun.result ? (
						<div className="space-y-0.5 rounded-md border border-success/30 bg-success/5 p-2 font-mono text-2xs text-ink-2">
							<div className="text-success">✓ would install</div>
							<div>name: {dryRun.result.manifest.name}</div>
							{dryRun.result.manifest.version ? <div>version: {dryRun.result.manifest.version}</div> : null}
							<div>clone: {dryRun.result.cloneUrl}</div>
							{dryRun.result.ref ? <div>ref: {dryRun.result.ref}</div> : null}
							<div>cache: {dryRun.result.wouldCacheTo}</div>
						</div>
					) : null}
					{!dryRun.busy && dryRun.error ? (
						<div className="space-y-0.5 rounded-md border border-danger/30 bg-danger/5 p-2 font-mono text-2xs text-ink-2">
							<div className="text-danger">✗ {(dryRun.error as { error: string }).error}</div>
							{(dryRun.error as { message?: string }).message ? <div>{(dryRun.error as { message?: string }).message}</div> : null}
							{(dryRun.error as { hint?: string }).hint ? (
								<div className="text-ink-3">hint: {(dryRun.error as { hint?: string }).hint}</div>
							) : null}
						</div>
					) : null}
				</div>
			) : null}
		</dl>
	</div>
);
}

function DefRow({ k, v }: { k: string; v: ReactNode }) {
	return (
		<div className="grid grid-cols-[80px_1fr] gap-2">
			<dt className="meta">{k}</dt>
			<dd className="min-w-0 break-words text-ink-2">{v}</dd>
		</div>
	);
}

export function AddMarketplaceModalHost({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
	const [source, setSource] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function submit(): Promise<void> {
		if (!source.trim()) return;
		setBusy(true);
		setError(undefined);
		try {
			await marketplaceApi.addMarketplace(source.trim());
			onAdded();
			onClose();
			setSource("");
		} catch (e) {
			setError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal open={open} onClose={onClose} widthClass="max-w-lg">
			<div className="flex h-11 items-center gap-2 border-b border-line px-3">
				<div className="meta">Add marketplace</div>
				<div className="flex-1" />
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
					<X className="h-4 w-4" />
				</Button>
			</div>
			<div className="space-y-3 p-3">
				<p className="text-xs text-ink-3">
					Source can be a GitHub <code className="font-mono">owner/repo</code>, a git URL, an https URL pointing at a
					catalog json, or an absolute path to a local catalog directory.
				</p>
				<input
					value={source}
					onChange={(e) => setSource(e.target.value)}
					placeholder="owner/repo or https://… or /absolute/path"
					className="field h-9 w-full px-2 font-mono text-sm"
				/>
				{error ? (
					<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
						{error}
					</div>
				) : null}
			</div>
			<div className="flex items-center justify-end gap-2 border-t border-line px-3 py-3">
				<Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
					Cancel
				</Button>
				<Button variant="primary" size="sm" onClick={() => void submit()} disabled={busy || !source.trim()}>
					{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
					Add
				</Button>
			</div>
		</Modal>
	);
}
