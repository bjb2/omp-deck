import { useEffect, useState } from "react";
import { ArrowLeft, Copy, Loader2 } from "lucide-react";
import { Link } from "react-router-dom";
import type { Prompt } from "@omp-deck/protocol";

import { Markdown } from "@/lib/markdown";
import { promptsApi } from "@/lib/prompts-api";
import { cn } from "@/lib/utils";

/**
 * Read-only public share page. The `:slug` route param maps 1:1 to the
 * prompt's `shareSlug`. Anyone with the URL can read; only the owner (via
 * the library view) can mutate.
 */
export function PromptsShare() {
	const slug = readSlug();
	const [prompt, setPrompt] = useState<Prompt | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		if (!slug) {
			setError("missing slug");
			setLoading(false);
			return;
		}
		let cancelled = false;
		setLoading(true);
		promptsApi
			.getBySlug(slug)
			.then((p) => {
				if (cancelled) return;
				setPrompt(p);
				setError(undefined);
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setError(String((err as Error).message ?? err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [slug]);

	return (
		<div className="mx-auto flex h-full w-full max-w-[760px] flex-col px-6 py-8">
			<Link
				to="/prompts/library"
				className="mb-4 inline-flex items-center gap-1 font-mono text-2xs text-ink-3 hover:text-ink"
			>
				<ArrowLeft className="h-3 w-3" />
				back to library
			</Link>

			{loading ? (
				<div className="flex items-center gap-2 font-mono text-2xs text-ink-3">
					<Loader2 className="h-3 w-3 animate-spin" />
					loading
				</div>
			) : error ? (
				<div className="font-mono text-sm text-danger">{error}</div>
			) : prompt ? (
				<article>
					<header className="border-b border-line pb-3">
						<h1 className="text-2xl font-semibold text-ink">{prompt.title}</h1>
						<div className="mt-1 font-mono text-2xs text-ink-3">
							{prompt.category} · {prompt.tags.join(" · ") || "no tags"}
						</div>
						{prompt.variables.length > 0 ? (
							<div className="mt-1 font-mono text-2xs text-ink-3">
								<span className="text-ink-2">variables:</span>{" "}
								{prompt.variables.map((v) => `{{${v}}}`).join(" ")}
							</div>
						) : null}
						<button
							type="button"
							className="btn-ghost mt-2 h-7 gap-1 px-2 text-xs"
							onClick={() => {
								const url = window.location.href;
								void navigator.clipboard.writeText(url).catch(() => {});
							}}
						>
							<Copy className="h-3 w-3" />
							copy URL
						</button>
					</header>
					<section className="py-4">
						<Markdown>{prompt.body}</Markdown>
					</section>
					<footer
						className={cn(
							"border-t border-line pt-3 font-mono text-2xs text-ink-3",
						)}
					>
						read-only share · saved {prompt.createdAt.slice(0, 10)}
					</footer>
				</article>
			) : (
				<div className="font-mono text-sm text-ink-3">prompt not found</div>
			)}
		</div>
	);
}

/**
 * Read the `:slug` route param off `window.location.pathname` so this view
 * can mount without a typed `useParams()` dependency on the route path.
 * Worker C owns the route declaration; the React Router hook would couple
 * the view to the route name.
 */
function readSlug(): string | undefined {
	if (typeof window === "undefined") return undefined;
	const m = /^\/prompts\/share\/([^/?#]+)/.exec(window.location.pathname);
	return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}