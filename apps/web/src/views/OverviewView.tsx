import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ExternalLink, FileText, Flame, Star, Zap } from "lucide-react";
import { Layout } from "@/components/Layout";
import {
	overviewApi,
	type OverviewNewsItem,
	type OverviewResponse,
	type OverviewWindow,
} from "@/lib/overview-api";
import { cn } from "@/lib/utils";

const WINDOWS: readonly OverviewWindow[] = ["24h", "7d", "30d"];

function SpendCard({ costByDay }: { costByDay?: Array<{ date: string; costMicrocents: number }> }) {
	const days = costByDay ?? [];
	const recent7 = days.slice(-7);
	const total7dMicros = recent7.reduce((acc, c) => acc + (c.costMicrocents || 0), 0);
	const total7dUsd = total7dMicros / 1_000_000;

	const maxDayMicros = Math.max(1, ...days.map((c) => c.costMicrocents || 0));

	return (
		<section className="flex flex-col gap-3 rounded-2xl border border-line bg-paper px-6 py-5">
			<div className="flex items-center justify-between gap-3">
				<div>
					<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">Spend (7-Day Total)</div>
					<div className="font-mono text-2xl font-semibold text-ink">${total7dUsd.toFixed(2)}</div>
				</div>
				<div className="font-mono text-2xs text-ink-3">30-day breakdown</div>
			</div>
			{days.length === 0 ? (
				<div className="font-mono text-2xs text-ink-4">No cost data logged yet</div>
			) : (
				<div className="flex h-12 items-end gap-1 pt-2">
					{days.map((entry) => {
						const heightPercent = Math.max(8, Math.round((entry.costMicrocents / maxDayMicros) * 100));
						const usdVal = (entry.costMicrocents / 1_000_000).toFixed(2);
						return (
							<div
								key={entry.date}
								className="group relative flex-1"
								title={`${entry.date}: $${usdVal}`}
							>
								<div
									className="w-full rounded-t bg-accent/80 transition-all group-hover:bg-accent"
									style={{ height: `${heightPercent}%` }}
								/>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

/**
 * `/` — the ADHD-oriented home. The whole page is arranged around a single
 * unmissable next action: everything below it is context, never a competing
 * to-do list. Fetches are best-effort (see overview-api), so a dead server
 * degrades to skeleton-free empty sections rather than a blank route.
 */
export function OverviewView() {
	const navigate = useNavigate();
	const [range, setRange] = useState<OverviewWindow>("7d");
	const [data, setData] = useState<OverviewResponse | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		let alive = true;
		setLoading(true);
		setError(undefined);
		void overviewApi.get(range).then((res) => {
			if (!alive) return;
			setData(res);
			setLoading(false);
		}).catch((err) => {
			if (!alive) return;
			setError(String((err as Error).message ?? err));
			setLoading(false);
		});
		return () => {
			alive = false;
		};
	}, [range]);

	const newsBySource = useMemo(() => {
		const map = new Map<string, OverviewNewsItem[]>();
		for (const item of data?.news ?? []) {
			const bucket = map.get(item.source);
			if (bucket) bucket.push(item);
			else map.set(item.source, [item]);
		}
		return [...map.entries()];
	}, [data]);

	const focusTask = data?.focus.activeTasks[0] ?? null;
	const nextAction = data?.focus.nextAction ?? focusTask?.title ?? null;

	return (
		<Layout
			sidebar={<OverviewSidebar streakDays={data?.focus.streakDays ?? 0} events={data?.events.length ?? 0} />}
			inspector={null}
			main={
					<div className="mx-auto flex w-full max-w-6xl flex-col gap-8 overflow-y-auto px-4 py-6">
						<header className="flex flex-wrap items-center justify-between gap-3">
							<div className="flex items-center gap-2">
								<div className="meta">Overview</div>
								{data?.stale ? (
									<span className="rounded-full border border-line px-2 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-3">
										cached
									</span>
								) : null}
							</div>
							<div className="flex items-center gap-1 rounded-full border border-line bg-paper p-0.5">
								{WINDOWS.map((w) => (
									<button
										key={w}
										type="button"
										onClick={() => setRange(w)}
										aria-pressed={w === range}
										className={cn(
											"rounded-full px-3 py-1 font-mono text-2xs uppercase tracking-meta transition-colors",
											w === range ? "bg-accent-soft/40 text-accent" : "text-ink-3 hover:text-ink",
										)}
									>
										{w}
									</button>
								))}
							</div>
						</header>

						{error ? (
							<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}

						{/* Right now — one thing. */}
						<section className="flex flex-col gap-4 rounded-2xl border border-line bg-paper-2 px-6 py-6">
							<div className="flex items-center justify-between gap-3">
								<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">right now</div>
								<div className="flex items-center gap-3">
									<button
										type="button"
										onClick={() => navigate("/receipts")}
										className="flex items-center gap-1.5 rounded-full border border-line bg-paper px-3 py-1 font-mono text-2xs text-ink hover:border-ink/30 transition-colors"
										title="View session receipts"
									>
										<FileText className="h-3.5 w-3.5 text-accent" />
										<span>Receipts ({data?.receiptsTodayCount ?? 0})</span>
									</button>
									<div className="flex items-center gap-1.5 text-ink-2" title="Consecutive active days">
									<Flame className="h-4 w-4 text-accent" />
									<span className="font-mono text-sm text-ink">{data?.focus.streakDays ?? 0}</span>
									<span className="font-mono text-2xs uppercase tracking-meta text-ink-3">day streak</span>
									</div>
								</div>
							</div>
							{loading ? (
								<Skeleton className="h-10 w-3/4" />
							) : nextAction ? (
								<>
									<h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
										{nextAction}
									</h1>
									<div>
										<button
											type="button"
											onClick={() =>
												navigate(focusTask ? `/tasks?open=${encodeURIComponent(focusTask.id)}` : "/tasks")
											}
											className="rounded-full bg-accent px-5 py-2 text-sm font-medium text-paper transition-colors hover:bg-accent-2"
										>
											Start this
										</button>
									</div>
								</>
							) : (
								<>
									<h1 className="text-3xl font-semibold leading-tight tracking-tight text-ink sm:text-4xl">
										Nothing queued.
									</h1>
									<p className="text-sm text-ink-2">Pick the smallest thing on the board and start there.</p>
									<div>
										<button
											type="button"
											onClick={() => navigate("/tasks")}
											className="rounded-full border border-line bg-paper px-5 py-2 text-sm font-medium text-ink hover:border-ink/30"
										>
											Open board
										</button>
									</div>
								</>
							)}
						</section>

						{/* Stats strip */}
						<section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
							{loading
								? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[68px] rounded-xl" />)
								: data?.stats.map((stat) => (
										<div
											key={stat.label}
											className="flex flex-col gap-1 rounded-xl border border-line bg-paper px-3 py-2.5"
											title={stat.hint}
										>
											<div className="font-mono text-2xs uppercase tracking-meta text-ink-3">
												{stat.label}
											</div>
											<div className="flex items-baseline gap-2">
												<span className="font-mono text-xl text-ink">{stat.value}</span>
												{typeof stat.delta === "number" && stat.delta !== 0 ? (
													<span
														className={cn(
															"font-mono text-2xs",
															stat.delta > 0 ? "text-accent" : "text-ink-3",
														)}
													>
														{stat.delta > 0 ? "+" : ""}
														{stat.delta}
													</span>
												) : null}
											</div>
										</div>
									))}
						</section>

						{/* Spend card (trailing 7d total + 30d sparkline) */}
						<SpendCard costByDay={data?.costByDay} />

						{/* Sharp Hours (ADHD peak focus hours) */}
						{data?.sharpHours && data.sharpHours.length > 0 ? (
							<section className="flex flex-col gap-3 rounded-2xl border border-line bg-paper px-6 py-5">
								<div className="flex items-center gap-2">
									<Zap className="h-4 w-4 text-accent" />
									<h2 className="font-mono text-2xs uppercase tracking-meta text-ink">Sharp Hours (Peak Productivity)</h2>
								</div>
								<p className="text-xs text-ink-3">
									Hours of the day when you consistently complete energy-tagged tasks (3+ completions in past 30 days).
								</p>
								<div className="flex flex-wrap gap-2 pt-1">
									{data.sharpHours.map((sh) => (
										<div
											key={sh.hour}
											className="flex items-center gap-2 rounded-lg border border-accent/20 bg-accent-soft/20 px-3 py-1.5 font-mono text-xs text-ink"
										>
											<span className="font-semibold text-accent">
												{String(sh.hour).padStart(2, "0")}:00 - {String((sh.hour + 1) % 24).padStart(2, "0")}:00
											</span>
											<span className="rounded bg-paper px-1.5 py-0.5 text-2xs text-ink-3">
												{sh.count} done
											</span>
										</div>
									))}
								</div>
							</section>
						) : null}

						<div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
							{/* News */}
							<section className="flex flex-col gap-3">
								<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">News</h2>
								{loading ? (
									<div className="flex flex-col gap-2">
										{[0, 1, 2, 3].map((i) => (
											<Skeleton key={i} className="h-9" />
										))}
									</div>
								) : newsBySource.length === 0 ? (
									<div className="font-mono text-2xs text-ink-3">no headlines for this window</div>
								) : (
									newsBySource.map(([source, items]) => (
										<div key={source} className="flex flex-col gap-1.5">
											<div className="font-mono text-2xs uppercase tracking-meta text-ink-4">{source}</div>
											<ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper">
												{items.map((item) => (
													<li key={item.id}>
														<a
															href={item.url}
															target="_blank"
															rel="noreferrer"
															className="group flex items-start gap-2 px-3 py-2 text-sm text-ink-2 hover:text-ink"
														>
															<span className="flex-1">
																{item.title}
																{item.summary ? (
																	<span className="mt-0.5 block text-xs text-ink-3">
																		{item.summary}
																	</span>
																) : null}
															</span>
															<ExternalLink className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-4 group-hover:text-ink-3" />
														</a>
													</li>
												))}
											</ul>
										</div>
									))
								)}
							</section>

							{/* Trending repos */}
							<section className="flex flex-col gap-3">
								<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Trending repos</h2>
								{loading ? (
									<div className="flex flex-col gap-2">
										{[0, 1, 2, 3].map((i) => (
											<Skeleton key={i} className="h-9" />
										))}
									</div>
								) : (data?.trending.length ?? 0) === 0 ? (
									<div className="font-mono text-2xs text-ink-3">no repos for this window</div>
								) : (
									<ul className="flex flex-col divide-y divide-line rounded-xl border border-line bg-paper">
										{data?.trending.map((repo) => (
											<li key={repo.id}>
												<a
													href={repo.url}
													target="_blank"
													rel="noreferrer"
													className="flex flex-col gap-1 px-3 py-2 hover:bg-paper-3"
												>
													<div className="flex items-center justify-between gap-2">
														<span className="truncate font-mono text-sm text-ink">{repo.name}</span>
														{typeof repo.stars === "number" ? (
															<span className="flex shrink-0 items-center gap-1 font-mono text-2xs text-ink-3">
																<Star className="h-3 w-3" />
																{repo.stars.toLocaleString()}
															</span>
														) : null}
													</div>
													{repo.description ? (
														<span className="line-clamp-2 text-xs text-ink-2">{repo.description}</span>
													) : null}
													{repo.language ? (
														<span className="font-mono text-2xs uppercase tracking-meta text-ink-4">
															{repo.language}
														</span>
													) : null}
												</a>
											</li>
										))}
									</ul>
								)}
							</section>
						</div>

						{/* Recent activity */}
						<section className="flex flex-col gap-3">
							<h2 className="font-mono text-2xs uppercase tracking-meta text-ink-3">Recent activity</h2>
							{loading ? (
								<div className="flex flex-col gap-2">
									{[0, 1, 2].map((i) => (
										<Skeleton key={i} className="h-6" />
									))}
								</div>
							) : (data?.events.length ?? 0) === 0 ? (
								<div className="font-mono text-2xs text-ink-3">nothing logged yet</div>
							) : (
								<ol className="flex flex-col border-l border-line pl-4">
									{data?.events.map((event) => (
										<li key={event.id} className="relative py-1.5">
											<span
												className="absolute -left-[21px] top-3 h-1.5 w-1.5 rounded-full bg-line"
												aria-hidden="true"
											/>
											<div className="flex flex-wrap items-baseline gap-2">
												<span className="font-mono text-2xs uppercase tracking-meta text-ink-4">
													{event.kind}
												</span>
												{event.href ? (
													<a href={event.href} className="text-sm text-ink-2 hover:text-ink">
														{event.title}
													</a>
												) : (
													<span className="text-sm text-ink-2">{event.title}</span>
												)}
												<span className="font-mono text-2xs text-ink-4">
													{new Date(event.at).toLocaleString()}
												</span>
											</div>
										</li>
									))}
								</ol>
							)}
						</section>
					</div>
			}
		/>
	);
}

function OverviewSidebar({ streakDays, events }: { streakDays: number; events: number }) {
	return (
		<div className="flex h-full flex-col gap-3 p-3 text-sm">
			<div className="meta">Today</div>
			<div className="flex items-center justify-between">
				<span className="text-ink-2">Streak</span>
				<span className="font-mono text-2xs text-ink">{streakDays}d</span>
			</div>
			<div className="flex items-center justify-between">
				<span className="text-ink-2">Events</span>
				<span className="font-mono text-2xs text-ink">{events}</span>
			</div>
			<p className="mt-2 text-xs text-ink-3">
				One thing at a time. The board keeps the rest — start what the header says and ignore everything
				below it.
			</p>
		</div>
	);
}

function Skeleton({ className }: { className?: string }) {
	return <div className={cn("animate-pulse rounded-md bg-paper-3", className)} aria-hidden="true" />;
}
