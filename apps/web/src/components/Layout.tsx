import { useEffect, useRef, type ReactNode } from "react";
import { NavRail } from "./NavRail";
import { FoldVertical, Menu, PanelRight, UnfoldVertical, X } from "lucide-react";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { GholamOverlay } from "./GholamOverlay";
// Studio surfaces — global Tooltip + ContextMenu portals. Mounted at the
// layout root so the catalog seeds activate everywhere; the singleton
// hover/focus delegation lives in `Tooltip.ts` and attaches at module load.
import { TooltipSurface } from "@/lib/studio/Tooltip";
import { ContextMenuSurface } from "@/lib/studio/ContextMenu";

interface Props {
	sidebar: ReactNode;
	main: ReactNode;
	inspector: ReactNode;
	topBar?: ReactNode;
}

export function Layout({ sidebar, main, inspector, topBar }: Props) {
	const sidebarOpen = useStore((s) => s.sidebarOpen);
	const setSidebarOpen = useStore((s) => s.setSidebarOpen);
	const inspectorOpen = useStore((s) => s.inspectorOpen);
	const setInspectorOpen = useStore((s) => s.setInspectorOpen);
	const sidebarRef = useRef<HTMLElement | null>(null);
	const inspectorRef = useRef<HTMLElement | null>(null);

	// `aria-hidden` alone doesn't stop keyboard focus, and at lg+ the
	// collapsed panel is still in the DOM at zero width (clipped by
	// `lg:overflow-hidden`, not removed) — without `inert` its contents
	// stay fully tabbable even though nothing is visible. Toggling the
	// DOM property imperatively (rather than the JSX `inert` attribute,
	// which the installed React 18 type defs don't recognize) keeps this
	// correct across the actual open/closed state on every breakpoint.
	useEffect(() => {
		const el = sidebarRef.current as (HTMLElement & { inert: boolean }) | null;
		if (el) el.inert = !sidebarOpen;
	}, [sidebarOpen]);
	useEffect(() => {
		const el = inspectorRef.current as (HTMLElement & { inert: boolean }) | null;
		if (el) el.inert = !inspectorOpen;
	}, [inspectorOpen]);

	// Esc closes overlay panels on small screens, and closes the rightmost
	// open push-panel at lg+ for keyboard users. Skips while a Modal owns
	// the key (dialogs stopPropagation, but guard anyway for portal cases).
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key !== "Escape") return;
			const target = e.target as HTMLElement | null;
			// Real browsers always set `target` to an Element for window
			// keydowns; jsdom + some synthetic-event paths don't. Without
			// the `in` guard the panel-closer would throw on those runs.
			if (target && typeof target.closest === "function" && target.closest('[role="dialog"][aria-modal="true"]')) return;
			if (window.innerWidth < 1024) {
				if (sidebarOpen) setSidebarOpen(false);
				if (inspectorOpen) setInspectorOpen(false);
			} else if (inspectorOpen) {
				setInspectorOpen(false);
			} else if (sidebarOpen) {
				setSidebarOpen(false);
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setSidebarOpen, setInspectorOpen, sidebarOpen, inspectorOpen]);

	const showBackdrop = sidebarOpen || inspectorOpen;

	return (
		<div className="flex h-full w-full flex-col bg-paper text-ink">
			<GholamOverlay />
			<TooltipSurface />
			<ContextMenuSurface />
			<a
				href="#deck-main"
				className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-ink focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium focus:text-paper-2"
			>
				Skip to main content
			</a>
			<header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-paper px-3">
				<button
					type="button"
					className={cn("btn-ghost h-7 w-7 p-0", sidebarOpen && "lg:bg-paper-3")}
					onClick={() => setSidebarOpen(!sidebarOpen)}
					aria-label={sidebarOpen ? "Hide sessions" : "Show sessions"}
					aria-pressed={sidebarOpen}
					title={sidebarOpen ? "Hide sessions" : "Show sessions"}
				>
					<Menu className="h-4 w-4" />
				</button>
				<div className="font-mono text-[13px] font-medium tracking-tight text-ink">
					omp<span className="text-ink-3">·</span>deck
				</div>
				<div className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden">
					<div className="hidden min-w-0 truncate sm:block">{topBar}</div>
					<ConnectionIndicator />
					<ToolCardsToggle />
					<button
						type="button"
						className={cn("btn-ghost h-7 w-7 p-0", inspectorOpen && "lg:bg-paper-3")}
						onClick={() => setInspectorOpen(!inspectorOpen)}
						aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
						aria-pressed={inspectorOpen}
						title={inspectorOpen ? "Hide inspector" : "Show inspector"}
					>
						<PanelRight className="h-4 w-4" />
					</button>
				</div>
			</header>

			<div className="relative flex min-h-0 flex-1 overflow-hidden">
				<NavRail />
				{/* Backdrop — only renders on screens below lg, where panels are overlays. */}
				{showBackdrop ? (
					<button
						type="button"
						className="absolute inset-0 z-20 bg-ink/20 backdrop-blur-[1px] lg:hidden"
						aria-label="Dismiss panels"
						onClick={() => {
							setSidebarOpen(false);
							setInspectorOpen(false);
						}}
					/>
				) : null}

				{/* Sidebar — overlay drawer below lg, push layout at lg+. `inert` on
				    the collapsed state removes it AND its focusable descendants from
				    tab order and AT — `lg:overflow-hidden` only clips paint, it does
				    nothing for keyboard focus, so without `inert` a collapsed-but-
				    zero-width panel at lg+ was still fully tabbable. */}
				<aside
					ref={sidebarRef}
					className={cn(
						"absolute inset-y-0 left-0 z-30 w-[280px] max-w-[80%] bg-paper border-r border-line shadow-[1px_0_0_0_rgba(0,0,0,0.04)]",
						"transform transition-transform duration-200 ease-out",
						sidebarOpen ? "translate-x-0" : "-translate-x-full",
						// At lg+: lose the overlay shadow, become a width-animated flex item.
						"lg:static lg:translate-x-0 lg:max-w-none lg:shadow-none lg:transition-[width]",
						sidebarOpen ? "lg:w-[240px]" : "lg:w-0",
						"lg:overflow-hidden",
					)}
					aria-hidden={!sidebarOpen}
					aria-label="Sessions"
				>
					<div className="flex h-full w-[280px] flex-col lg:w-[240px]">
						<MobileCloseBar onClose={() => setSidebarOpen(false)} side="left" />
						<div className="min-h-0 flex-1">{sidebar}</div>
					</div>
				</aside>

				<main
					id="deck-main"
					tabIndex={-1}
					className="relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-paper focus:outline-none"
				>
					{main}
				</main>

				{/* Inspector — same overlay/push pattern, right side. */}
				<aside
					ref={inspectorRef}
					className={cn(
						"absolute inset-y-0 right-0 z-30 w-[300px] max-w-[85%] bg-paper border-l border-line shadow-[-1px_0_0_0_rgba(0,0,0,0.04)]",
						"transform transition-transform duration-200 ease-out",
						inspectorOpen ? "translate-x-0" : "translate-x-full",
						"lg:static lg:translate-x-0 lg:max-w-none lg:shadow-none lg:transition-[width]",
						inspectorOpen ? "lg:w-[260px]" : "lg:w-0",
						"lg:overflow-hidden",
					)}
					aria-hidden={!inspectorOpen}
					aria-label="Inspector"
				>
					<div className="flex h-full w-[300px] flex-col lg:w-[260px]">
						<MobileCloseBar onClose={() => setInspectorOpen(false)} side="right" />
						<div className="min-h-0 flex-1 overflow-y-auto">{inspector}</div>
					</div>
				</aside>
			</div>
		</div>
	);
}

function MobileCloseBar({ onClose, side }: { onClose: () => void; side: "left" | "right" }) {
	return (
		<div className="flex h-9 items-center border-b border-line px-2 lg:hidden">
			<button
				type="button"
				className="btn-ghost h-7 w-7 p-0"
				onClick={onClose}
				aria-label="Close"
			>
				<X className="h-3.5 w-3.5" />
			</button>
			{side === "right" ? (
				<span className="ml-2 font-mono text-2xs uppercase tracking-meta text-ink-3">
					Inspector
				</span>
			) : null}
		</div>
	);
}

function ToolCardsToggle() {
	const allCollapsed = useStore((s) => s.toolView.allCollapsed);
	const toggle = useStore((s) => s.toggleAllToolCards);
	const Icon = allCollapsed ? UnfoldVertical : FoldVertical;
	return (
		<button
			type="button"
			className={cn("btn-ghost h-7 w-7 p-0", allCollapsed && "lg:bg-paper-3")}
			onClick={toggle}
			aria-label={allCollapsed ? "Expand all tool cards" : "Collapse all tool cards"}
			title={allCollapsed ? "Expand all tool cards" : "Collapse all tool cards"}
		>
			<Icon className="h-4 w-4" />
		</button>
	);
}
