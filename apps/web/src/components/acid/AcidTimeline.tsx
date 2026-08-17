import type { OverviewEvent } from "@/lib/overview-api";
import { cn } from "@/lib/utils";

/**
 * AcidTimeline — GitHub-changes-in-time-period direction.
 *
 * Layout: a left rail of day/hour buckets, a vertical hairline spine, and
 * one cut-corner card per event with its kind rendered as an acid label.
 * Designed to slot into the Overview as the primary "what changed" panel;
 * the rest of the page wraps it in chrome.
 *
 * Visual language is fully Acid Lab: hairline 1px rules, `[data-shape="cut"]`
 * corners, monospace data, single accent. Degrades gracefully when the theme
 * isn't Acid — the underlying utilities are theme-token-driven.
 */
export function AcidTimeline({
	events,
	className,
}: {
	events: OverviewEvent[];
	className?: string;
}) {
	if (events.length === 0) {
		return (
			<div
				data-shape="cut"
				className={cn(
					"flex items-center justify-between border border-line bg-paper-2 px-4 py-3",
					className,
				)}
			>
				<div className="flex items-center gap-2">
					<span className="acid-section">Timeline</span>
					<span className="acid-mono text-xs text-ink-3">no events in window</span>
				</div>
				<span className="acid-mono text-2xs uppercase tracking-meta text-ink-4">empty</span>
			</div>
		);
	}

	// Group events by day so we can stamp a day rail on the left.
	const groups = groupByDay(events);

	return (
		<section
			className={cn(
				"flex flex-col border border-line bg-paper-2",
				"[&_[data-shape='cut']]:bg-paper-3",
				className,
			)}
			aria-label="Activity timeline"
		>
			<header className="flex items-baseline justify-between border-b border-line px-4 py-2">
				<div className="flex items-baseline gap-3">
					<span className="acid-section">Timeline</span>
					<span className="acid-mono text-xs text-ink-2">
						{events.length} event{events.length === 1 ? "" : "s"}
					</span>
				</div>
				<span className="acid-mono text-2xs uppercase tracking-meta text-ink-3">
					most recent first
				</span>
			</header>

			<ol className="relative flex flex-col">
				{/* Vertical spine — pure hairline 1px, theme-driven via --line */}
				<span
					aria-hidden
					className="pointer-events-none absolute left-[7.25rem] top-0 h-full w-px bg-line"
				/>
				{groups.map((g) => (
					<li key={g.dayLabel} className="border-b border-line last:border-b-0">
						<div className="flex">
							{/* Day rail */}
							<div className="flex w-28 shrink-0 flex-col items-end justify-start border-r border-line bg-paper-2 px-3 py-3">
								<span className="acid-mono text-xs uppercase tracking-meta text-ink">
									{g.dayLabel}
								</span>
								<span className="acid-mono text-2xs uppercase tracking-meta text-ink-3">
									{g.events.length} evt
								</span>
							</div>
							{/* Day column */}
							<div className="relative flex-1 py-2 pl-8 pr-3">
								{g.events.map((ev, idx) => (
									<article
										key={ev.id}
										data-shape="cut"
										className={cn(
											"mb-2 flex items-center gap-3 border border-line bg-paper px-3 py-2 last:mb-0",
											"transition-colors hover:border-accent",
										)}
									>
										{/* Spine node — small acid dot */}
										<span
											aria-hidden
											className="absolute -left-[1.45rem] mt-0 inline-block h-2 w-2 bg-accent"
											style={{
												clipPath: "polygon(0 0, 100% 0, 100% 70%, 70% 100%, 0 100%)",
											}}
										/>
										<span
											className={cn(
												"acid-badge shrink-0",
												badgeClassForKind(ev.kind),
											)}
										>
											{ev.kind}
										</span>
										<div className="min-w-0 flex-1">
											<a
												href={ev.href ?? "#"}
												className="block truncate text-sm text-ink hover:text-accent"
											>
												{ev.title}
											</a>
										</div>
										<span className="acid-mono shrink-0 text-2xs uppercase tracking-meta text-ink-3">
											{formatTime(ev.at)}
											{idx === 0 && g === groups[0] ? (
												<span className="ml-2 acid-badge acid-badge-accent">new</span>
											) : null}
										</span>
									</article>
								))}
							</div>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

function badgeClassForKind(kind: string): string {
	const k = kind.toLowerCase();
	if (k.includes("error") || k.includes("fail")) return "acid-badge-danger";
	if (k.includes("warn") || k.includes("review") || k.includes("attn")) return "acid-badge-warn";
	if (k.includes("merge") || k.includes("ok") || k.includes("success") || k.includes("ship"))
		return "acid-badge-success";
	if (k.includes("think") || k.includes("plan")) return "acid-badge-thinking";
	return "acid-badge-accent";
}

function groupByDay(events: OverviewEvent[]): Array<{ dayLabel: string; events: OverviewEvent[] }> {
	const groups = new Map<string, OverviewEvent[]>();
	for (const ev of events) {
		const day = new Date(ev.at);
		const key = day.toISOString().slice(0, 10);
		const bucket = groups.get(key);
		if (bucket) bucket.push(ev);
		else groups.set(key, [ev]);
	}
	return [...groups.entries()]
		.sort((a, b) => (a[0] < b[0] ? 1 : -1))
		.map(([k, v]) => ({ dayLabel: formatDayLabel(k), events: v }));
}

function formatDayLabel(isoDay: string): string {
	const d = new Date(`${isoDay}T00:00:00Z`);
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const yesterday = new Date(today);
	yesterday.setUTCDate(today.getUTCDate() - 1);
	if (d.getTime() === today.getTime()) return "today";
	if (d.getTime() === yesterday.getTime()) return "yest";
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(iso: string): string {
	const d = new Date(iso);
	const now = Date.now();
	const diffMs = now - d.getTime();
	const mins = Math.round(diffMs / 60_000);
	if (mins < 1) return "now";
	if (mins < 60) return `${mins}m`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs}h`;
	const days = Math.round(hrs / 24);
	if (days < 7) return `${days}d`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
