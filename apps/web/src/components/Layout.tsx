import { useEffect, type ReactNode } from "react";
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

	// Esc closes both overlays on small screens.
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			if (e.key === "Escape") {
				if (window.innerWidth < 1024) {
					setSidebarOpen(false);
					setInspectorOpen(false);
				}
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [setSidebarOpen, setInspectorOpen]);

	const showBackdrop = sidebarOpen || inspectorOpen;

	return (
		<div className="flex h-full w-full flex-col bg-paper text-ink">
			<GholamOverlay />
			<TooltipSurface />
			<ContextMenuSurface />
			<header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-paper px-3">
				<button
					type="button"
					className={cn("btn-ghost h-7 w-7 p-0", sidebarOpen && "lg:bg-paper-3")}
					onClick={() => setSidebarOpen(!sidebarOpen)}
					aria-label="Toggle sessions"
					title="Toggle sessions"
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
						aria-label="Toggle inspector"
						title="Toggle inspector"
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
						aria-label="Close panels"
						onClick={() => {
							setSidebarOpen(false);
							setInspectorOpen(false);
						}}
					/>
				) : null}

				{/* Sidebar — overlay drawer below lg, push layout at lg+. */}
				<aside
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
				>
					<div className="flex h-full w-[280px] flex-col lg:w-[240px]">
						<MobileCloseBar onClose={() => setSidebarOpen(false)} side="left" />
						<div className="min-h-0 flex-1">{sidebar}</div>
					</div>
				</aside>

				<main className="relative flex min-w-0 flex-1 flex-col bg-paper">{main}</main>

				{/* Inspector — same overlay/push pattern, right side. */}
				<aside
					className={cn(
						"absolute inset-y-0 right-0 z-30 w-[300px] max-w-[85%] bg-paper border-l border-line shadow-[-1px_0_0_0_rgba(0,0,0,0.04)]",
						"transform transition-transform duration-200 ease-out",
						inspectorOpen ? "translate-x-0" : "translate-x-full",
						"lg:static lg:translate-x-0 lg:max-w-none lg:shadow-none lg:transition-[width]",
						inspectorOpen ? "lg:w-[260px]" : "lg:w-0",
						"lg:overflow-hidden",
					)}
					aria-hidden={!inspectorOpen}
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
