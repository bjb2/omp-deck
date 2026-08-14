import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Search, Sparkles } from "lucide-react";
import type {
	ListSkillsResponse,
	SkillDetailResponse,
	SkillSummary,
} from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Markdown } from "@/lib/markdown";
import { skillsApi } from "@/lib/skills-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type LevelFilter = "all" | "user" | "project";

/**
 * Cockpit for every skill `omp` discovers — across `native`, `claude-plugins`,
 * `claude`, `codex`, and the other discovery providers. Native sits at the top
 * by default; the source filter rail surfaces all other providers.
 */
export function SkillsView() {
	const [data, setData] = useState<ListSkillsResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();
	const [search, setSearch] = useState("");
	const [providerFilter, setProviderFilter] = useState<string | "all">("all");
	const [levelFilter, setLevelFilter] = useState<LevelFilter>("all");
	const [selectedId, setSelectedId] = useState<string | undefined>();
	const [detail, setDetail] = useState<SkillDetailResponse | null>(null);
	const [detailLoading, setDetailLoading] = useState(false);
	const [detailError, setDetailError] = useState<string | undefined>();
	// On narrow screens (< lg) the list and detail can't share a column, so
	// they stack as a master/detail navigation: list visible until the user
	// picks a row, then we slide to detail with a back affordance. At lg+ the
	// CSS grid renders them side-by-side and this flag is inert.
	const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const next = await skillsApi.list();
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

	const skillsChangeCounter = useStore((s) => s.skillsChangeCounter);
	useEffect(() => {
		if (skillsChangeCounter === 0) return;
		void refresh();
	}, [skillsChangeCounter, refresh]);

	const [busy, setBusy] = useState(false);
	const [actionError, setActionError] = useState<string | undefined>();

	const filtered = useMemo(() => {
		const skills = data?.skills ?? [];
		const q = search.trim().toLowerCase();
		return skills.filter((s) => {
			if (providerFilter !== "all" && s.provider !== providerFilter) return false;
			if (levelFilter !== "all" && s.level !== levelFilter) return false;
			if (!q) return true;
			const hay = [
				s.name,
				s.dirName,
				s.providerLabel,
				s.pluginName ?? "",
				s.frontmatter.description ?? "",
				(s.frontmatter.triggers ?? []).join(" "),
				(s.frontmatter.tags ?? []).join(" "),
			]
				.join(" ")
				.toLowerCase();
			return hay.includes(q);
		});
	}, [data, search, providerFilter, levelFilter]);

	const selected = filtered.find((s) => s.id === selectedId) ?? filtered[0];

	const [confirmRemove, setConfirmRemove] = useState(false);

	const handleEnable = useCallback(async (): Promise<void> => {
		if (!selected || busy) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await skillsApi.enable(selected.id);
			await refresh();
		} catch (e) {
			setActionError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [selected, busy, refresh]);

	const handleDisable = useCallback(async (): Promise<void> => {
		if (!selected || busy) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await skillsApi.disable(selected.id);
			await refresh();
		} catch (e) {
			setActionError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [selected, busy, refresh]);

	const handleRemove = useCallback(async (): Promise<void> => {
		if (!selected || busy) return;
		setBusy(true);
		setActionError(undefined);
		try {
			await skillsApi.remove(selected.id);
			setConfirmRemove(false);
			await refresh();
			setSelectedId(undefined);
		} catch (e) {
			setActionError(String((e as Error).message ?? e));
		} finally {
			setBusy(false);
		}
	}, [selected, busy, refresh]);

	useEffect(() => {
		if (!selected) {
			setDetail(null);
			setDetailError(undefined);
			return;
		}
		let cancelled = false;
		setDetailLoading(true);
		setDetailError(undefined);
		skillsApi
			.detail(selected.id)
			.then((d) => {
				if (cancelled) return;
				setDetail(d);
			})
			.catch((e) => {
				if (cancelled) return;
				setDetailError(String((e as Error).message ?? e));
			})
			.finally(() => {
				if (cancelled) return;
				setDetailLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selected?.id, skillsChangeCounter]);

	return (
		<>
		<Layout
			sidebar={
				<SkillsSidebar
					skills={data?.skills ?? []}
					providerFilter={providerFilter}
					onProviderFilter={setProviderFilter}
					levelFilter={levelFilter}
					onLevelFilter={setLevelFilter}
				/>
			}
			inspector={<SkillInspector skill={selected} detail={detail} />}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Skills</div>
						<div className="text-xs text-ink-3">
							{loading ? "loading..." : `${filtered.length} / ${data?.skills.length ?? 0}`}
						</div>
						<div className="flex-1" />
						<div className="flex items-center gap-2 rounded-md border border-line bg-paper-2 px-2 py-1 text-xs">
							<Search className="h-3.5 w-3.5 text-ink-3" />
							<input
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search name, description, triggers, tags"
								className="w-full bg-transparent text-ink placeholder:text-ink-4 focus:outline-none sm:w-72"
							/>
						</div>
					</div>

					{error ? (
						<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
							{error}
						</div>
					) : null}

					<div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
						<div
							className={cn(
								"min-h-0 overflow-y-auto border-line lg:block lg:border-r",
								mobileDetailOpen ? "hidden" : "block",
							)}
						>
							{loading && !data ? (
								<div className="px-3 py-6 text-center text-sm text-ink-3">Loading skills...</div>
							) : null}
							{!loading && filtered.length === 0 ? (
								<EmptyState total={data?.skills.length ?? 0} />
							) : null}
							{filtered.map((s) => (
								<SkillRow
									key={s.id}
									skill={s}
									active={selected?.id === s.id}
									onClick={() => {
										setSelectedId(s.id);
										setMobileDetailOpen(true);
									}}
								/>
							))}
						</div>

						<div
							className={cn(
								"min-h-0 overflow-y-auto lg:block",
								mobileDetailOpen ? "block" : "hidden",
							)}
						>
							{!selected ? null : (
								<SkillDetailPane
									skill={selected}
									detail={detail}
									loading={detailLoading}
									error={detailError}
						busy={busy}
						onEnable={handleEnable}
						onDisable={handleDisable}
						onRemove={() => setConfirmRemove(true)}
									onBack={() => setMobileDetailOpen(false)}
								/>
							)}
						</div>
					</div>
				</div>
			}
		/>
		<Modal
			open={confirmRemove}
			onClose={() => (busy ? undefined : setConfirmRemove(false))}
		>
			<div className="flex flex-col gap-4 p-2">
				<h2 className="text-base font-medium text-ink">Remove skill?</h2>
				<p className="text-sm text-ink-2">
					This deletes <span className="font-mono">{selected?.name}</span> and its directory. The change is
					not reversible — re-installing will pull a fresh copy from the original source.
				</p>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={() => setConfirmRemove(false)} disabled={busy}>
						Cancel
					</Button>
					<Button variant="danger" onClick={() => void handleRemove()} disabled={busy}>
						{busy ? "Removing…" : "Remove"}
					</Button>
				</div>
			</div>
		</Modal>
		</>
	);
}

function SkillRow({ skill, active, onClick }: { skill: SkillSummary; active: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full flex-col items-start gap-1 border-b border-line px-3 py-2 text-left transition-colors",
				active ? "bg-accent-soft/30" : "hover:bg-paper-3",
				!skill.enabled && "opacity-60",
			)}
		>
			<div className="flex w-full items-center gap-2">
				<Sparkles className="h-3.5 w-3.5 shrink-0 text-accent" />
				<span className="truncate text-sm font-medium text-ink">{skill.name}</span>
				{!skill.enabled ? (
					<span className="ml-auto rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-3">
						hidden
					</span>
				) : null}
			</div>
			<div className="flex w-full items-center gap-2 font-mono text-2xs text-ink-3">
				<ProviderBadge provider={skill.provider} label={skill.providerLabel} />
				<span className="uppercase tracking-meta">{skill.level}</span>
				{skill.pluginName ? (
					<>
						<span className="text-ink-4">·</span>
						<span className="truncate">{skill.pluginName}</span>
					</>
				) : null}
			</div>
			{skill.frontmatter.description ? (
				<div className="line-clamp-2 text-xs text-ink-3">{skill.frontmatter.description}</div>
			) : null}
		</button>
	);
}

function ProviderBadge({ provider, label }: { provider: string; label: string }) {
	// Color tag native distinctly; everything else gets a muted treatment.
	const tone = provider === "native" ? "bg-accent-soft/50 text-accent" : "bg-paper-3 text-ink-2";
	return (
		<span className={cn("rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta", tone)}>
			{label}
		</span>
	);
}

function SkillDetailPane({
	skill,
	detail,
	loading,
	error,
	onBack,
	busy,
	onEnable,
	onDisable,
	onRemove,
}: {
	skill: SkillSummary;
	detail: SkillDetailResponse | null;
	loading: boolean;
	error: string | undefined;
	onBack?: () => void;
	busy: boolean;
	onEnable: () => void;
	onDisable: () => void;
	onRemove: () => void;
}) {
	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-4 py-3">
				<div className="flex items-center gap-2">
					{onBack ? (
						<button
							type="button"
							onClick={onBack}
							aria-label="Back to skill list"
							className="-ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink lg:hidden"
						>
							<ArrowLeft className="h-4 w-4" />
						</button>
					) : null}
					<Sparkles className="h-4 w-4 text-accent" />
					<h1 className="text-base font-medium text-ink">{skill.name}</h1>
					<div className="ml-auto flex items-center gap-2">
						{skill.provider !== "claude-plugins" ? (
							skill.enabled ? (
								<button
									type="button"
									onClick={onDisable}
									disabled={busy}
									className="rounded-md border border-line bg-paper-2 px-2 py-1 text-2xs text-ink-2 transition-colors hover:border-ink/30 hover:text-ink disabled:opacity-50"
								>
									Disable
								</button>
							) : (
								<button
									type="button"
									onClick={onEnable}
									disabled={busy}
									className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-2xs text-accent transition-colors hover:bg-accent/15 disabled:opacity-50"
								>
									Enable
								</button>
							)
						) : null}
						{skill.provider !== "claude-plugins" ? (
							<button
								type="button"
								onClick={onRemove}
								disabled={busy}
								className="rounded-md border border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
							>
								Remove
							</button>
						) : null}
						<ProviderBadge provider={skill.provider} label={skill.providerLabel} />
						<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">
							{skill.level}
						</span>
					</div>
				</div>
				<div className="mt-1 font-mono text-2xs text-ink-3">
					{skill.pluginId ? (
						<>
							<span className="text-ink-4">from plugin</span> {skill.pluginId}
						</>
					) : (
						<>
							<span className="text-ink-4">from</span> {skill.providerLabel}
							<span className="text-ink-4"> · dir</span> {skill.dirName}
						</>
					)}
				</div>
				{skill.frontmatter.description ? (
					<p className="mt-2 text-sm text-ink-2">{skill.frontmatter.description}</p>
				) : null}
				{(skill.frontmatter.triggers?.length ?? 0) > 0 ? (
					<TagRow label="triggers" values={skill.frontmatter.triggers ?? []} />
				) : null}
				{(skill.frontmatter.tags?.length ?? 0) > 0 ? (
					<TagRow label="tags" values={skill.frontmatter.tags ?? []} />
				) : null}
			</div>

			{error ? (
				<div className="m-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
					{error}
				</div>
			) : null}

			{loading && !detail ? (
				<div className="flex items-center gap-2 px-4 py-3 text-sm text-ink-3">
					<Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading SKILL.md...
				</div>
			) : null}

			{detail ? (
				<div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
					<Markdown>{detail.body}</Markdown>
				</div>
			) : null}
		</div>
	);
}

function TagRow({ label, values }: { label: string; values: readonly string[] }) {
	return (
		<div className="mt-2 flex flex-wrap items-center gap-1">
			<span className="font-mono text-2xs uppercase tracking-meta text-ink-4">{label}</span>
			{values.map((v) => (
				<span
					key={v}
					className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
				>
					{v}
				</span>
			))}
		</div>
	);
}

function EmptyState({ total }: { total: number }) {
	return (
		<div className="flex h-full flex-col items-center justify-center px-6 py-10 text-center">
			<Sparkles className="h-6 w-6 text-ink-4" />
			<div className="mt-3 text-sm text-ink-2">
				{total === 0 ? "No skills discovered" : "No skills match the current filters"}
			</div>
			<div className="mt-1 max-w-xs text-xs text-ink-3">
				{total === 0
					? "Drop a SKILL.md into ~/.omp/agent/skills/<name>/, or install a marketplace plugin."
					: "Try clearing the source / level filters or the search box."}
			</div>
		</div>
	);
}

function SkillsSidebar({
	skills,
	providerFilter,
	onProviderFilter,
	levelFilter,
	onLevelFilter,
}: {
	skills: SkillSummary[];
	providerFilter: string | "all";
	onProviderFilter: (p: string | "all") => void;
	levelFilter: LevelFilter;
	onLevelFilter: (l: LevelFilter) => void;
}) {
	const providers = useMemo(() => {
		const m = new Map<string, { label: string; count: number; priority: number }>();
		for (const s of skills) {
			const cur = m.get(s.provider);
			if (cur) cur.count += 1;
			else m.set(s.provider, { label: s.providerLabel, count: 1, priority: providerPriority(s.provider) });
		}
		return Array.from(m.entries())
			.map(([id, v]) => ({ id, ...v }))
			.sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label));
	}, [skills]);

	const levelCounts = useMemo(
		() => ({
			all: skills.length,
			user: skills.filter((s) => s.level === "user").length,
			project: skills.filter((s) => s.level === "project").length,
		}),
		[skills],
	);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Skills</div>
				<div className="mt-0.5 text-xs text-ink-3">
					Every skill <span className="text-ink-2">omp</span> can reach — native, marketplace, and
					sibling agent-tool configs. Enable/disable lives on the owning plugin or provider.
				</div>
			</div>

			<div className="border-b border-line px-3 py-2">
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">Source</div>
				<FilterRow
					label="all"
					count={skills.length}
					active={providerFilter === "all"}
					onClick={() => onProviderFilter("all")}
				/>
				{providers.map((p) => (
					<FilterRow
						key={p.id}
						label={p.label}
						count={p.count}
						active={providerFilter === p.id}
						onClick={() => onProviderFilter(p.id)}
						highlight={p.id === "native"}
					/>
				))}
			</div>

			<div className="min-h-0 px-3 py-2">
				<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">Level</div>
				<FilterRow label="all" count={levelCounts.all} active={levelFilter === "all"} onClick={() => onLevelFilter("all")} />
				<FilterRow label="user" count={levelCounts.user} active={levelFilter === "user"} onClick={() => onLevelFilter("user")} />
				<FilterRow label="project" count={levelCounts.project} active={levelFilter === "project"} onClick={() => onLevelFilter("project")} />
			</div>
		</div>
	);
}

function FilterRow({
	label,
	count,
	active,
	onClick,
	highlight,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
	highlight?: boolean;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-sm transition-colors",
				active
					? "bg-accent-soft/40 text-ink"
					: highlight
						? "text-accent hover:bg-paper-3"
						: "text-ink-2 hover:bg-paper-3",
			)}
		>
			<span className="truncate">{label}</span>
			<span className={cn("font-mono text-2xs", active ? "text-ink-2" : "text-ink-3")}>{count}</span>
		</button>
	);
}

function SkillInspector({
	skill,
	detail,
}: {
	skill: SkillSummary | undefined;
	detail: SkillDetailResponse | null;
}) {
	if (!skill) {
		return <div className="px-3 py-4 text-xs text-ink-3">Pick a skill to inspect.</div>;
	}
	return (
		<div className="flex h-full flex-col">
			<div className="border-b border-line px-3 py-2">
				<div className="meta">Inspector</div>
				<div className="mt-0.5 text-xs text-ink-3">SKILL.md frontmatter + co-located files.</div>
			</div>
			<div className="space-y-3 overflow-y-auto px-3 py-3 text-xs">
				<DefRow k="name" v={<span className="font-mono">{skill.name}</span>} />
				<DefRow k="dir" v={<span className="font-mono">{skill.dirName}</span>} />
				<DefRow k="provider" v={<span className="font-mono">{skill.providerLabel} ({skill.provider})</span>} />
				<DefRow k="level" v={<span className="font-mono uppercase">{skill.level}</span>} />
				{skill.pluginId ? (
					<DefRow k="plugin" v={<span className="font-mono">{skill.pluginId}</span>} />
				) : null}
				<DefRow
					k="enabled"
					v={
						<span className={cn("font-mono", skill.enabled ? "text-success" : "text-ink-3")}>
							{skill.enabled ? "yes" : "hidden (frontmatter)"}
						</span>
					}
				/>
				{skill.frontmatter.model ? (
					<DefRow k="model" v={<span className="font-mono">{skill.frontmatter.model}</span>} />
				) : null}
				<DefRow k="path" v={<span className="break-all font-mono text-2xs">{skill.skillPath}</span>} />

				{detail && detail.files.length > 0 ? (
					<div>
						<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">
							Bundled files ({detail.files.filter((f) => f.kind === "file").length})
						</div>
						<div className="mt-1 text-2xs text-ink-4">
							Reachable on demand — not auto-injected into the agent's context.
						</div>
						<ul className="mt-2 space-y-0.5 font-mono text-2xs">
							{detail.files.map((f) => (
								<li
									key={f.relPath}
									className={cn(
										"flex items-baseline gap-2",
										f.kind === "dir" ? "text-ink-2" : "text-ink-3",
									)}
								>
									<span className="truncate">{f.relPath}</span>
									{f.kind === "file" && typeof f.size === "number" ? (
										<span className="ml-auto shrink-0 text-ink-4">{formatBytes(f.size)}</span>
									) : null}
								</li>
							))}
						</ul>
					</div>
				) : null}
			</div>
		</div>
	);
}

function DefRow({ k, v }: { k: string; v: React.ReactNode }) {
	return (
		<div>
			<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">{k}</div>
			<div className="mt-0.5 text-ink-2">{v}</div>
		</div>
	);
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
	return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

function providerPriority(provider: string): number {
	switch (provider) {
		case "native":
			return 0;
		case "claude-plugins":
			return 1;
		case "claude":
			return 2;
		case "codex":
			return 3;
		case "opencode":
			return 4;
		case "cursor":
			return 5;
		case "windsurf":
			return 6;
		case "cline":
			return 7;
		case "gemini":
			return 8;
		case "agents":
			return 9;
		case "custom":
			return 10;
		default:
			return 100;
	}
}
