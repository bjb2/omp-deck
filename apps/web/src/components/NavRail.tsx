import {
	BookOpen,
	Bot as GholamIcon,
	Clock,
	Compass,
	GitMerge,
	FolderGit2,
	LayoutDashboard,
	LayoutGrid,
	KanbanSquare,
	Library,
	MessagesSquare,
	Plug,
	SlidersHorizontal,
	Terminal,
	Settings,
	ShoppingBag,
	Sparkles,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import { cn } from "@/lib/utils";

// Remote-workstation nav. Every routed surface gets an entry here so nothing
// is reachable only by typing a URL — see docs audit in the pages-audit PR.
const ITEMS: ReadonlyArray<{
	to: string;
	label: string;
	icon: typeof MessagesSquare;
}> = [
	{ to: "/", label: "Overview", icon: LayoutDashboard },
	{ to: "/chat", label: "Chat", icon: MessagesSquare },
	{ to: "/shell", label: "Shell", icon: Terminal },
	{ to: "/explorer", label: "Explorer", icon: FolderGit2 },
	{ to: "/agent-config", label: "Agent Config", icon: SlidersHorizontal },
	{ to: "/tasks", label: "Tasks", icon: KanbanSquare },
	{ to: "/routines", label: "Routines", icon: Clock },
	{ to: "/workflows", label: "Workflows", icon: GitMerge },
	{ to: "/skills", label: "Skills", icon: Sparkles },
	{ to: "/storefront", label: "Storefront", icon: ShoppingBag },
	{ to: "/gholam", label: "Gholam", icon: GholamIcon },
	{ to: "/prompts/library", label: "Prompts", icon: BookOpen },
	{ to: "/prompts/discover", label: "Discover", icon: Compass },
	{ to: "/kb", label: "Knowledge Base", icon: Library },
	{ to: "/integrations", label: "Integrations", icon: Plug },
	{ to: "/studio", label: "Studio", icon: LayoutGrid },
];

/**
 * Vertical icon rail. 48px wide, fixed left edge. Active route gets the rust
 * accent + a thin left tab; inactive entries are muted ink-3 with a hover lift.
 */
export function NavRail() {
	return (
		<nav className="flex h-full min-h-0 w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-line bg-paper py-2">
			<NavLink
				to="/"
				title="Version 244 — Overview"
				aria-label="Version 244 home"
				className="mb-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-paper-2 text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink"
			>
				<span className="font-mono text-[10px] font-semibold leading-none tracking-tight">
					v244
				</span>
			</NavLink>
			<div className="h-px w-7 bg-line" aria-hidden="true" />
			{ITEMS.map((item) => (
				<NavLink
					key={item.to}
					to={item.to}
					end={item.to === "/"}
					title={item.label}
					aria-label={item.label}
					className={({ isActive }) =>
						cn(
							"relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
							isActive
								? "text-accent bg-accent-soft/40"
								: "text-ink-3 hover:bg-paper-3 hover:text-ink",
						)
					}
				>
					{({ isActive }) => (
						<>
							<item.icon className="h-[18px] w-[18px]" />
							{isActive ? (
								<span
									className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
									aria-hidden="true"
								/>
							) : null}
						</>
					)}
				</NavLink>
			))}
			<div className="mt-auto h-px w-7 bg-line" aria-hidden="true" />
			<NavLink
				to="/settings"
				title="Settings"
				aria-label="Settings"
				className={({ isActive }) =>
					cn(
						"relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md transition-colors",
						isActive
							? "text-accent bg-accent-soft/40"
							: "text-ink-3 hover:bg-paper-3 hover:text-ink",
					)
				}
			>
				{({ isActive }) => (
					<>
						<Settings className="h-[18px] w-[18px]" />
						{isActive ? (
							<span
								className="absolute left-0 top-1/2 h-5 w-[2px] -translate-y-1/2 rounded-r bg-accent"
								aria-hidden="true"
							/>
						) : null}
					</>
				)}
			</NavLink>
		</nav>
	);
}
