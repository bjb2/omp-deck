/**
 * PreviewPane — three-mode right-rail toggle for pre-update previews (§4 of
 * docs/GENERATIVE.md). Per-route localStorage persistence so a user can pin
 * one mode on `/chat` and another on `/kb` independently.
 *
 * Modes:
 *   - "current"   — hide the preview entirely (default).
 *   - "updated"   — only the post-update preview.
 *   - "side-by-side" — both, in a split.
 *
 * The post-update tree is fed by a `frames: GenNode[]` prop (the caller
 * subscribes to `GET /api/preview/render` for the active route's in-flight
 * edits and pipes the resulting GenUI frames here). When the prop is empty
 * we fall back to an empty-state placeholder so the toggle still works.
 */

import { useEffect, useState } from "react";
import { ExternalLink, LayoutGrid, Maximize2, Minimize2 } from "lucide-react";
import { Link } from "react-router-dom";
import { GenuiStack } from "@/lib/genui/GenuiRenderer";
import type { GenNode } from "@/lib/genui/components";
import { cn } from "@/lib/utils";

export type PreviewMode = "current" | "updated" | "side-by-side";

const STORAGE_KEY = "omp-deck:genui:preview-mode";
const PER_ROUTE_KEY = (route: string) => `omp-deck:genui:preview-mode:${route}`;

function readMode(route: string): PreviewMode {
	if (typeof localStorage === "undefined") return "current";
	const per = localStorage.getItem(PER_ROUTE_KEY(route));
	if (per === "current" || per === "updated" || per === "side-by-side") return per;
	const fallback = localStorage.getItem(STORAGE_KEY);
	if (fallback === "current" || fallback === "updated" || fallback === "side-by-side") return fallback;
	return "current";
}

function writeMode(route: string, mode: PreviewMode): void {
	if (typeof localStorage === "undefined") return;
	localStorage.setItem(PER_ROUTE_KEY(route), mode);
	localStorage.setItem(STORAGE_KEY, mode);
}

export interface PreviewPaneProps {
	/** Active route key (e.g. "/chat"). Drives the per-route localStorage key. */
	route: string;
	/** Live preview frames streamed from `/api/preview/render`. When empty,
	 *  the right column shows an empty-state hint. */
	frames: GenNode[];
	/** Optional label above the right rail; defaults to "Preview". */
	label?: string;
}

const MODES: ReadonlyArray<{ id: PreviewMode; label: string; icon: typeof Minimize2 }> = [
	{ id: "current", label: "Current", icon: Minimize2 },
	{ id: "updated", label: "Updated", icon: Maximize2 },
	{ id: "side-by-side", label: "Split", icon: LayoutGrid },
];

export function PreviewPane({ route, frames, label = "Preview" }: PreviewPaneProps) {
	const [mode, setMode] = useState<PreviewMode>(() => readMode(route));

	useEffect(() => {
		setMode(readMode(route));
	}, [route]);

	function pick(next: PreviewMode): void {
		setMode(next);
		writeMode(route, next);
	}

	if (mode === "current") return null;

	return (
		<aside
			className={cn(
				"flex h-full min-h-0 w-full flex-col border-l border-line bg-paper-2",
				mode === "side-by-side" ? "max-w-[40%]" : "max-w-[33%]",
			)}
			aria-label="Preview pane"
		>
			<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-2">
				<span className="meta">{label}</span>
				<Link
					to={`/preview/${encodeURIComponent(route)}`}
					title="Open full-page preview"
					aria-label="Open full-page preview"
					className="inline-flex h-5 w-5 items-center justify-center rounded text-ink-3 hover:bg-paper-3 hover:text-ink"
				>
					<ExternalLink className="h-3 w-3" />
				</Link>
				<div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label="Preview mode">
					{MODES.map((m) => {
						const Icon = m.icon;
						const active = m.id === mode;
						return (
							<button
								key={m.id}
								type="button"
								role="radio"
								aria-checked={active}
								onClick={() => pick(m.id)}
								className={cn(
									"inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-2xs uppercase tracking-meta transition-colors",
									active
										? "border-accent text-accent"
										: "border-line text-ink-3 hover:bg-paper-3 hover:text-ink",
								)}
							>
								<Icon className="h-3 w-3" />
								{m.label}
							</button>
						);
					})}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-auto p-3">
				{frames.length === 0 ? (
					<div className="rounded-md border border-dashed border-line bg-paper p-3 font-mono text-2xs text-ink-3">
						No in-flight edits. The preview will populate when a gholam.edit lands.
					</div>
				) : (
					<GenuiStack nodes={frames} />
				)}
			</div>
		</aside>
	);
}