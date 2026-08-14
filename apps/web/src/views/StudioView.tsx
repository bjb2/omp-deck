/**
 * `/studio` — three-column surface composing the deck's views side-by-side.
 *
 * Per docs/STUDIO.md §1, the default layout is `wide` with the six panes
 * registered in v1:
 *   A (1/3)  kb           KbView (read-only embed, no top bar)
 *   B (2/3)  composer     ChatView body (no NavRail, no top bar)
 *   C (1/3)  tasks        TasksView
 *
 * The other 3 panes (gholam, prompts, storefront) are reachable through
 * the preset selector in the header and through deep links
 * (?pane=gholam). The `/studio/gholam` route focuses on the Gholam pane
 * and mounts the full `<GholamView />` outside the 3-col grid.
 *
 * Pane mounting is `IntersectionObserver`-guarded (see `<PaneMount />` in
 * StudioProvider) so off-screen panes don't fan out work.
 */
import { useEffect, useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { StudioStatusBar } from "@/components/studio/StatusBar";
import { PaneMount, StudioProvider, useStudio, type PaneCapability, type PaneDescriptor, type Preset } from "@/lib/studio/StudioProvider";
import { ComposerPane } from "@/views/studio/ComposerPane";
import { GholamPane } from "@/views/studio/GholamPane";
import { KbPane } from "@/views/studio/KbPane";
import { PromptsPane } from "@/views/studio/PromptsPane";
import { StorefrontPane } from "@/views/studio/StorefrontPane";
import { TasksPane } from "@/views/studio/TasksPane";

import { GholamView } from "./GholamView";

export function StudioView(): JSX.Element {
	const params = useParams<{ pane?: string }>();
	const paneParam = typeof params.pane === "string" ? params.pane : undefined;
	// /studio/gholam is a focused route — show the full GholamView, not the grid.
	if (paneParam === "gholam") {
		return (
			<StudioProvider>
				<StudioHeader hideGrid />
				<div className="min-h-0 flex-1">
					<GholamView />
				</div>
				<StudioStatusBar />
			</StudioProvider>
		);
	}

	return (
		<StudioProvider>
			<StudioGrid />
		</StudioProvider>
	);
}

function StudioGrid(): JSX.Element {
	const { panes, register, layout, setLayout, focusPane, focusedPane } = useStudio();
	const [searchParams] = useSearchParams();

	const all: PaneDescriptor[] = useMemo(
		() => (["kb", "composer", "tasks", "gholam", "prompts", "storefront"] as const).map((id): PaneDescriptor => {
			switch (id) {
				case "kb":
					return { id, title: "KB", render: () => <KbPane readOnly />, capabilities: ["edit"], defaultPreset: "wide" };
				case "composer":
					return { id, title: "Composer", render: () => <ComposerPane readOnly />, capabilities: ["edit"], defaultPreset: "wide" };
				case "tasks":
					return { id, title: "Tasks", render: () => <TasksPane readOnly />, capabilities: ["edit"], defaultPreset: "wide" };
				case "gholam":
					return { id, title: "Gholam", render: () => <GholamPane />, capabilities: ["edit", "danger"], defaultPreset: "sidebar-left" };
				case "prompts":
					return { id, title: "Prompts", render: () => <PromptsPane />, capabilities: ["edit"], defaultPreset: "wide" };
				case "storefront":
					return { id, title: "Storefront", render: () => <StorefrontPane />, capabilities: ["execute"], defaultPreset: "wide" };
			}
		}),
		[],
	);

	useEffect(() => {
		const unregisters = all.map((p) => register(p));
		return () => {
			for (const u of unregisters) u();
		};
	}, [all, register]);

	// Deep link: ?pane=kb (and ?focus=nodeId) drive focusPane.
	useEffect(() => {
		const want = searchParams.get("pane");
		if (want && panes[want]) focusPane(want);
	}, [searchParams, panes, focusPane]);

	// Default slot mapping per preset (1-col, 2-col, 3-col).
	const slots = useMemo(() => slotMap(layout), [layout]);

	return (
		<div className="flex h-full min-h-0 flex-col bg-paper text-ink">
			<StudioHeader />
			<div className={gridClass(layout)}>
				{slots.map((slot, i) => (
					<PaneMount key={`${layout}-${i}-${slot ?? "empty"}`} paneId={`slot-${i}`}>
						{slot ? <PaneSlot id={slot} /> : <EmptySlot />}
					</PaneMount>
				))}
			</div>
			<StudioStatusBar />
			{focusedPane ? <PaneFocusHint id={focusedPane} /> : null}
		</div>
	);
}

function PaneSlot({ id }: { id: string }): JSX.Element {
	const { panes } = useStudio();
	const desc = panes[id];
	if (!desc) return <EmptySlot />;
	return <>{desc.render()}</>;
}

function EmptySlot(): JSX.Element {
	return (
		<div className="flex h-full items-center justify-center font-mono text-2xs text-ink-4">
			empty slot
		</div>
	);
}

function PaneFocusHint({ id }: { id: string }): JSX.Element {
	return (
		<div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-accent px-2 py-0.5 font-mono text-2xs text-paper shadow-md">
			focused · {id}
		</div>
	);
}

function StudioHeader({ hideGrid = false }: { hideGrid?: boolean }): JSX.Element {
	const { layout, setLayout, resetLayout } = useStudio();
	return (
		<header className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
			<div className="meta">/studio</div>
			{!hideGrid ? (
				<>
					<div className="flex-1" />
					<PresetSelector value={layout} onChange={setLayout} />
					<button
						type="button"
						className="btn-ghost h-7 px-2 text-xs"
						data-tooltip-key="studio.reset"
						onClick={() => resetLayout()}
					>
						reset
					</button>
				</>
			) : null}
		</header>
	);
}

function PresetSelector({ value, onChange }: { value: Preset; onChange: (p: Preset) => void }): JSX.Element {
	return (
		<select
			data-tooltip-key="studio.preset"
			className="h-7 rounded-md border border-line bg-paper-2 px-2 text-xs"
			value={value}
			onChange={(e) => onChange(e.target.value as Preset)}
		>
			<option value="wide">wide</option>
			<option value="compact">compact</option>
			<option value="sidebar-left">sidebar-left</option>
		</select>
	);
}

function gridClass(preset: Preset): string {
	switch (preset) {
		case "compact":
			return "grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2";
		case "sidebar-left":
			return "grid min-h-0 flex-1 grid-cols-[minmax(220px,1fr)_minmax(0,2fr)] grid-rows-[minmax(0,2fr)_minmax(0,1fr)] gap-2 overflow-hidden p-2";
		case "wide":
		default:
			return "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] gap-2 overflow-hidden p-2";
	}
}

function slotMap(preset: Preset): (string | null)[] {
	switch (preset) {
		case "compact":
			return ["kb", "composer", "tasks", "gholam", "prompts", "storefront"];
		case "sidebar-left":
			return ["kb", "composer", null, "tasks", "gholam", "prompts"];
		case "wide":
		default:
			return ["kb", "composer", "tasks"];
	}
}
