import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Search, Sparkles, Star } from "lucide-react";
import type { Prompt } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { promptsApi } from "@/lib/prompts-api";
import { useStore } from "@/lib/store";

interface DiscoveryRow {
	id: string;
	title: string;
	body: string;
	category: string;
	tags: string[];
	source: "github" | "web" | "kb" | "user";
	why?: string;
}

/**
 * Trending row at top (computed from the local library — usage decay sort
 * is the cheapest "trending" we can produce without crawling external
 * sources) + a search bar that filters the library by free text. Save-to-
 * library flow lands each row into the prompt library as a draft the user
 * can edit before confirming.
 *
 * Real discovery (web search, GitHub, KB) lands via Worker B's
 * `DiscoveryService` (Section §2). This view ships the library-derived
 * trending so the page is functional in v0 even before that work lands.
 */
export function PromptsDiscover() {
	const prompts = useStore((s) => s.promptsLibrary);
	const setPromptsLibrary = useStore((s) => s.setPromptsLibrary);
	const [search, setSearch] = useState("");
	const [saving, setSaving] = useState<string | undefined>();
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const resp = await promptsApi.list();
			setPromptsLibrary(resp.prompts);
		} catch (err) {
			setError(String((err as Error).message ?? err));
		}
	}, [setPromptsLibrary]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const trending: DiscoveryRow[] = prompts
		.filter((p) => p.usageCount > 0)
		.sort((a, b) => {
			const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
			const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
			const wa = Math.exp(-(Date.now() - ta) / (1000 * 60 * 60 * 24 * 30));
			const wb = Math.exp(-(Date.now() - tb) / (1000 * 60 * 60 * 24 * 30));
			return wb * b.usageCount - wa * a.usageCount;
		})
		.slice(0, 5)
		.map((p) => ({
			id: p.id,
			title: p.title,
			body: p.body,
			category: p.category,
			tags: p.tags,
			source: p.source?.kind ?? "user",
			why: `used ${p.usageCount}×`,
		}));

	const q = search.trim().toLowerCase();
	const results: DiscoveryRow[] = q
		? prompts
				.filter((p) => {
					const hay = `${p.title}\n${p.body}\n${p.tags.join(" ")}`.toLowerCase();
					return hay.includes(q);
				})
				.slice(0, 25)
				.map((p) => ({
					id: p.id,
					title: p.title,
					body: p.body,
					category: p.category,
					tags: p.tags,
					source: p.source?.kind ?? "user",
				}))
		: [];

	const onSave = useCallback(
		async (row: DiscoveryRow): Promise<void> => {
			setSaving(row.id);
			try {
				await promptsApi.create({
					title: row.title,
					body: row.body,
					category: row.category,
					tags: row.tags,
					source: { kind: row.source, url: "", capturedAt: new Date().toISOString() },
				});
				void refresh();
			} catch (err) {
				setError(String((err as Error).message ?? err));
			} finally {
				setSaving(undefined);
			}
		},
		[refresh],
	);

	const main = (
		<div className="flex h-full flex-col">
			<div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
				<Search className="h-3.5 w-3.5 text-ink-3" />
				<input
					className="flex-1 bg-transparent text-sm placeholder:text-ink-3 focus:outline-none"
					placeholder="Search prompts (library + trending)"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>
			</div>
			{error ? (
				<div className="border-b border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-2xs text-danger">
					{error}
				</div>
			) : null}
			<div className="min-h-0 flex-1 overflow-y-auto p-3">
				{trending.length > 0 ? (
					<section>
						<h2 className="mb-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
							<Sparkles className="mr-1 inline h-3 w-3" />
							trending
						</h2>
						<div className="grid gap-2 sm:grid-cols-2">
							{trending.map((row) => (
								<DiscoveryCard
									key={row.id}
									row={row}
									saving={saving === row.id}
									onSave={() => void onSave(row)}
								/>
							))}
						</div>
					</section>
				) : null}

				<section className="mt-4">
					<h2 className="mb-1 font-mono text-2xs uppercase tracking-meta text-ink-3">
						{q ? `results for "${q}"` : "all prompts"}
					</h2>
					{results.length === 0 ? (
						<div className="font-mono text-2xs text-ink-3">
							{q ? "no matches" : "library is empty — save your first prompt"}
						</div>
					) : (
						<div className="grid gap-2 sm:grid-cols-2">
							{results.map((row) => (
								<DiscoveryCard
									key={row.id}
									row={row}
									saving={saving === row.id}
									onSave={() => void onSave(row)}
								/>
							))}
						</div>
					)}
				</section>
			</div>
		</div>
	);

	return <Layout sidebar={<DiscoverSidebar />} main={main} inspector={null} />;
}

function DiscoveryCard({
	row,
	saving,
	onSave,
}: {
	row: DiscoveryRow;
	saving: boolean;
	onSave: () => void;
}) {
	return (
		<div className="rounded-md border border-line bg-paper-2 p-3">
			<div className="flex items-start justify-between gap-2">
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-medium text-ink">{row.title}</div>
					<div className="mt-0.5 font-mono text-2xs text-ink-3">
						{row.category} · {row.tags.join(" · ") || "no tags"}
					</div>
				</div>
				{row.source !== "user" ? (
					<span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2">
						{row.source}
					</span>
				) : null}
			</div>
			{row.why ? (
				<div className="mt-1 font-mono text-2xs text-accent">{row.why}</div>
			) : null}
			<div className="mt-2 flex items-center justify-between gap-2">
				<button
					type="button"
					className="btn-primary h-7 gap-1 px-2 text-xs"
					onClick={onSave}
					disabled={saving}
				>
					{saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
					save to library
				</button>
			</div>
		</div>
	);
}

function DiscoverSidebar() {
	return (
		<div className="flex h-full flex-col p-3 font-mono text-xs text-ink-3">
			<div className="uppercase tracking-meta text-2xs">discover</div>
			<div className="mt-2 text-2xs leading-relaxed">
				Web + GitHub discovery lands via Worker B (Section §2 of{" "}
				<code className="rounded bg-paper-3 px-1 text-ink-2">docs/STOREFRONT.md</code>).
				Trending here is computed from your local usage decay so the
				page is functional before the broader discovery feed wires up.
			</div>
			<div className="mt-3 flex items-center gap-1 text-2xs text-ink-2">
				<Star className="h-3 w-3" />
				Pin prompts in /prompts/library to keep them handy.
			</div>
		</div>
	);
}