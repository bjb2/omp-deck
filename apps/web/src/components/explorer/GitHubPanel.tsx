/**
 * "Your GitHub repos, one click to work on them" — the panel that makes
 * that literal. Lists what the configured token can push to, clones with
 * one click, and opens the clone in the explorer. Also surfaces the
 * open-PR list, a create-PR form, and a confirm-then-merge action.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronDown, Clock, Download, ExternalLink, Github, GitPullRequest, Loader2, Lock, RefreshCw, Search, Star } from "lucide-react";
import type { GitHubRepoSummary } from "@omp-deck/protocol";
import { Button } from "@/components/ui/Button";
import { githubApi } from "@/lib/github-api";
import { gitApi } from "@/lib/git-api";
import { cn } from "@/lib/utils";

interface Props {
	onOpenRepo: (path: string) => void;
	/**
	 * Path of the workspace currently open in the explorer. Optional; when
	 * present, the PR form prefills `head` from the local git branch if the
	 * expanded repo's basename matches cwd. Without cwd the user types the
	 * head branch by hand.
	 */
	cwd?: string;
}

interface PullRequestSummary {
	number: number;
	title: string;
	head: { ref: string };
	base: { ref: string };
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

function basename(path: string): string {
	const m = path.replace(/\\/g, "/").split("/").filter(Boolean);
	return m[m.length - 1] ?? path;
}

export function GitHubPanel({ onOpenRepo, cwd }: Props): JSX.Element {
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [repos, setRepos] = useState<GitHubRepoSummary[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [cloning, setCloning] = useState<string | null>(null);
	const [expandedRepo, setExpandedRepo] = useState<string | null>(null);
	const [pulls, setPulls] = useState<Record<string, PullRequestSummary[]>>({});
	const [pullsLoading, setPullsLoading] = useState<Record<string, boolean>>({});
	const [prForm, setPrForm] = useState<{ title: string; head: string; base: string; body: string }>({
		title: "",
		head: "",
		base: "",
		body: "",
	});
	const [prCreating, setPrCreating] = useState(false);
	const [mergingPr, setMergingPr] = useState<number | null>(null);
	const [mergeConfirm, setMergeConfirm] = useState<{ owner: string; repo: string; number: number } | null>(null);
	const [currentBranch, setCurrentBranch] = useState<string | null>(null);

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

	useEffect(() => {
		if (!cwd) {
			setCurrentBranch(null);
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const status = await gitApi.status(cwd);
				if (!cancelled) setCurrentBranch(status.branch);
			} catch {
				if (!cancelled) setCurrentBranch(null);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [cwd]);

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

	async function loadPulls(owner: string, repo: string): Promise<void> {
		const key = `${owner}/${repo}`;
		setPullsLoading((prev) => ({ ...prev, [key]: true }));
		try {
			const list = (await githubApi.listPullRequests(owner, repo, "open")) as PullRequestSummary[];
			setPulls((prev) => ({ ...prev, [key]: list }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPullsLoading((prev) => ({ ...prev, [key]: false }));
		}
	}

	// Reset the PR form when the expanded repo changes so the prefill is
	// never stale — and never mutate the form mid-typing (only on switch).
	useEffect(() => {
		if (!expandedRepo || !repos) {
			setPrForm({ title: "", head: "", base: "", body: "" });
			return;
		}
		const repo = repos.find((r) => r.fullName === expandedRepo);
		if (!repo) return;
		const cwdMatches = cwd && basename(cwd) === repo.name;
		setPrForm({
			title: "",
			head: cwdMatches && currentBranch ? currentBranch : "",
			base: repo.defaultBranch,
			body: "",
		});
	}, [expandedRepo, repos, cwd, currentBranch]);

	async function createPR(owner: string, repo: string): Promise<void> {
		if (!prForm.title || !prForm.head || !prForm.base) {
			setError("Title, head branch, and base branch are required");
			return;
		}
		setPrCreating(true);
		try {
			await githubApi.createPullRequest(owner, repo, {
				title: prForm.title,
				head: prForm.head,
				base: prForm.base,
				body: prForm.body || undefined,
			});
			setError(null);
			await loadPulls(owner, repo);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setPrCreating(false);
		}
	}

	async function mergePR(owner: string, repo: string, number: number): Promise<void> {
		setMergingPr(number);
		try {
			await githubApi.mergePullRequest(owner, repo, number);
			setMergeConfirm(null);
			setError(null);
			await loadPulls(owner, repo);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setMergingPr(null);
		}
	}

	if (loading) {
		return (
			<div className="flex h-full items-center justify-center">
				<Loader2 className="h-5 w-5 animate-spin text-ink-3" />
			</div>
		);
	}

	if (configured === false) {
		return (
			<div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
				<Github className="h-10 w-10 text-ink-4" />
				<h3 className="font-semibold text-ink">GitHub not configured</h3>
				<p className="text-sm text-ink-3">Set GITHUB_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN in Settings → Env.</p>
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
				{filtered.map((repo) => {
					const owner = String(repo.owner);
					const key = `${owner}/${repo.name}`;
					return (
						<div key={repo.id} className="border-b border-line/60 px-3">
							<div className="group py-2.5 transition-colors hover:bg-paper-3">
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
											variant="ghost"
											size="sm"
											className="opacity-0 transition-opacity group-hover:opacity-100"
											onClick={() => {
												if (expandedRepo === repo.fullName) {
													setExpandedRepo(null);
												} else {
													setExpandedRepo(repo.fullName);
													void loadPulls(owner, repo.name);
												}
											}}
											title="View pull requests"
										>
											{expandedRepo === repo.fullName ? (
												<ChevronDown className="h-3.5 w-3.5" />
											) : (
												<GitPullRequest className="h-3.5 w-3.5" />
											)}
										</Button>
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
							{expandedRepo === repo.fullName ? (
								<div className="space-y-3 border-t border-line/60 bg-paper-2 p-3">
									{pullsLoading[key] ? (
										<div className="flex items-center justify-center py-4 text-ink-3">
											<Loader2 className="mr-2 h-4 w-4 animate-spin" />
											Loading pull requests…
										</div>
									) : (
										<>
											{pulls[key] && pulls[key]!.length > 0 ? (
												<div className="max-h-48 space-y-2 overflow-auto rounded border border-line/60 bg-paper p-2">
													{pulls[key]!.map((pr) => (
														<div key={pr.number} className="flex items-center justify-between rounded border border-line/40 bg-paper-2 p-2 text-xs">
															<div className="min-w-0 flex-1">
																<p className="truncate font-mono">{pr.title}</p>
																<p className="truncate text-ink-4">
																	{pr.head.ref} → {pr.base.ref}
																</p>
															</div>
															<Button
																variant="outline"
																size="sm"
																disabled={mergingPr !== null}
																onClick={() => setMergeConfirm({ owner, repo: repo.name, number: pr.number })}
															>
																{mergingPr === pr.number ? (
																	<Loader2 className="h-3 w-3 animate-spin" />
																) : (
																	"Merge"
																)}
															</Button>
														</div>
													))}
												</div>
											) : (
												<p className="text-xs text-ink-4">No open pull requests</p>
											)}
											<div className="space-y-2 rounded border border-line/60 bg-paper p-2">
												<p className="text-xs font-semibold text-ink">Create Pull Request</p>
												<input
													type="text"
													placeholder="Title"
													value={prForm.title}
													onChange={(e) => setPrForm((prev) => ({ ...prev, title: e.target.value }))}
													className="field w-full rounded border border-line/40 bg-paper-2 px-2 py-1 text-xs"
												/>
												<input
													type="text"
													placeholder={cwd && currentBranch ? `Head branch (current: ${currentBranch})` : "Head branch"}
													value={prForm.head}
													onChange={(e) => setPrForm((prev) => ({ ...prev, head: e.target.value }))}
													className="field w-full rounded border border-line/40 bg-paper-2 px-2 py-1 text-xs"
												/>
												<input
													type="text"
													placeholder={`Base branch (default: ${repo.defaultBranch})`}
													value={prForm.base}
													onChange={(e) => setPrForm((prev) => ({ ...prev, base: e.target.value }))}
													className="field w-full rounded border border-line/40 bg-paper-2 px-2 py-1 text-xs"
												/>
												<textarea
													placeholder="Description (optional)"
													value={prForm.body}
													onChange={(e) => setPrForm((prev) => ({ ...prev, body: e.target.value }))}
													className="field w-full rounded border border-line/40 bg-paper-2 px-2 py-1 text-xs"
													rows={2}
												/>
												<Button
													variant="primary"
													size="sm"
													disabled={prCreating}
													onClick={() => void createPR(owner, repo.name)}
												>
													{prCreating ? <Loader2 className="h-3 w-3 animate-spin" /> : "Create"}
												</Button>
											</div>
										</>
									)}
								</div>
							) : null}
							{mergeConfirm && mergeConfirm.owner === owner && mergeConfirm.repo === repo.name ? (
								<div className="border-t border-line/60 bg-paper-2 p-3">
									<p className="mb-2 text-xs text-ink">
										Confirm merge of PR #{mergeConfirm.number} into {repo.defaultBranch}? This cannot be undone.
									</p>
									<div className="flex gap-2">
										<Button
											variant="danger"
											size="sm"
											disabled={mergingPr !== null}
											onClick={() => void mergePR(mergeConfirm.owner, mergeConfirm.repo, mergeConfirm.number)}
										>
											{mergingPr === mergeConfirm.number ? <Loader2 className="h-3 w-3 animate-spin" /> : "Merge"}
										</Button>
										<Button
											variant="ghost"
											size="sm"
											disabled={mergingPr !== null}
											onClick={() => setMergeConfirm(null)}
										>
											Cancel
										</Button>
									</div>
								</div>
							) : null}
						</div>
					);
				})}
				{filtered.length === 0 ? (
					<div className="p-8 text-center text-sm text-ink-3">
						{query ? "No repos match." : "No repos found for this token."}
					</div>
				) : null}
			</div>
		</div>
	);
}
