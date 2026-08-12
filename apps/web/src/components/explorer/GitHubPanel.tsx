/**
 * "Your GitHub repos, one click to work on them" — the panel that makes
 * that literal. Lists what the configured token can push to, clones with
 * one click, and opens the clone in the explorer.
 */
import { useEffect, useMemo, useState } from "react";
import { Clock, Download, ExternalLink, Github, Loader2, Lock, RefreshCw, Search, Star } from "lucide-react";
import type { GitHubRepoSummary } from "@omp-deck/protocol";
import { Button } from "@/components/ui/Button";
import { githubApi } from "@/lib/github-api";
import { cn } from "@/lib/utils";

interface Props {
	onOpenRepo: (path: string) => void;
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const days = Math.floor(ms / 86_400_000);
	if (days < 1) return "today";
	if (days === 1) return "yesterday";
	if (days < 30) return `${days}d ago`;
	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo ago`;
	return `${Math.floor(months / 12)}y ago`;
}

export function GitHubPanel({ onOpenRepo }: Props): JSX.Element {
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [cloning, setCloning] = useState<string | null>(null);

	async function refresh(): Promise<void> {
		setLoading(true);
		setError(null);
		try {
			const status = await githubApi.status();
			setConfigured(status.configured);
			if (status.configured) {
				const { repos: list } = await githubApi.repos();
				setRepos(list);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		void refresh();
	}, []);

	const filtered = useMemo(() => {
		if (!repos) return [];
		const q = query.trim().toLowerCase();
		if (!q) return repos;
		return repos.filter((r) => r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q));
	}, [repos, query]);

	async function clone(repo: GitHubRepoSummary): Promise<void> {
		setCloning(repo.fullName);
		try {
			const result = await githubApi.clone({ fullName: repo.fullName });
			onOpenRepo(result.path);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setCloning(null);
		}
	}

	if (loading) {
		return (
			<div className="flex items-center gap-2 p-4 text-sm text-ink-3">
				<Loader2 className="h-4 w-4 animate-spin" /> Loading GitHub…
			</div>
		);
	}

	if (configured === false) {
		return (
			<div className="flex flex-col items-center gap-3 p-8 text-center">
				<Github className="h-8 w-8 text-ink-4" />
				<div>
					<p className="text-sm text-ink">No GitHub token configured.</p>
					<p className="mt-1 max-w-xs text-xs text-ink-3">
						Set <code className="rounded bg-paper-3 px-1 py-0.5">GITHUB_PERSONAL_ACCESS_TOKEN</code> in
						Settings → Env to browse and clone your repos from here.
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={() => window.location.assign("/settings?section=env")}>
					Open Settings
				</Button>
			</div>
		);
	}

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b border-line px-3 py-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-4" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Filter repos…"
						className="field h-8 w-full pl-7 pr-2 text-xs"
					/>
				</div>
				<Button variant="ghost" size="sm" onClick={() => void refresh()} title="Refresh">
					<RefreshCw className="h-3.5 w-3.5" />
				</Button>
			</div>

			{error ? (
				<div className="mx-3 mt-2 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1.5 font-mono text-2xs text-danger">
					{error}
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-auto">
				{filtered.map((repo) => (
					<div key={repo.id} className="group border-b border-line/60 px-3 py-2.5 transition-colors hover:bg-paper-3">
						<div className="flex items-start justify-between gap-2">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-1.5">
									<span className="truncate font-mono text-[13px] text-ink">{repo.fullName}</span>
									{repo.private ? <Lock className="h-3 w-3 shrink-0 text-ink-4" /> : null}
								</div>
								{repo.description ? (
									<p className="mt-0.5 truncate text-xs text-ink-3">{repo.description}</p>
								) : null}
								<div className="mt-1 flex items-center gap-3 text-2xs text-ink-4">
									<span className="flex items-center gap-1">
										<Clock className="h-3 w-3" /> {relativeTime(repo.pushedAt)}
									</span>
									{repo.stargazersCount > 0 ? (
										<span className="flex items-center gap-1">
											<Star className="h-3 w-3" /> {repo.stargazersCount}
										</span>
									) : null}
									<span className="font-mono">{repo.defaultBranch}</span>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<a
									href={`https://github.com/${repo.fullName}`}
									target="_blank"
									rel="noopener noreferrer"
									title="Open on GitHub"
									className="rounded p-1 text-ink-4 opacity-0 transition-opacity hover:bg-paper hover:text-ink group-hover:opacity-100"
									onClick={(e) => e.stopPropagation()}
								>
									<ExternalLink className="h-3.5 w-3.5" />
								</a>
								<Button
									variant="outline"
									size="sm"
									disabled={cloning !== null}
									className={cn(cloning === repo.fullName && "opacity-70")}
									onClick={() => void clone(repo)}
								>
									{cloning === repo.fullName ? (
										<Loader2 className="h-3.5 w-3.5 animate-spin" />
									) : (
										<Download className="h-3.5 w-3.5" />
									)}
									Clone
								</Button>
							</div>
						</div>
					</div>
				))}
				{filtered.length === 0 ? (
					<div className="p-8 text-center text-sm text-ink-3">
						{query ? "No repos match." : "No repos found for this token."}
					</div>
				) : null}
			</div>
		</div>
	);
}
