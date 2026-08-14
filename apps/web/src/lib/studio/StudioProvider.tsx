/**
 * StudioProvider — context that tracks the registered panes + layout preset
 * + per-pane focus state. Per the design doc §1:
 *
 *   type PaneDescriptor = {
 *     id: string;
 *     title: string;
 *     render: () => ReactNode;   // function form, not component, so we can lazy-mount
 *     capabilities: ("edit" | "execute" | "danger")[];
 *     defaultPreset: "wide" | "compact" | "sidebar-left";
 *   };
 *
 *   type StudioContextValue = {
 *     panes: Record<string, PaneDescriptor>;
 *     register: (p: PaneDescriptor) => () => void;   // returns unregister
 *     layout: PresetLayout;                          // mutable via header control
 *     focusPane: (id: string) => void;               // for ?pane= deep-link
 *   };
 *
 * Pane mounting uses `IntersectionObserver` (via `<PaneMount />` below) so
 * off-screen panes don't burn CPU. Preset persists in localStorage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

const PRESET_KEY = "omp-deck:studio:layout-preset";

export type PaneCapability = "edit" | "execute" | "danger";
export type Preset = "wide" | "compact" | "sidebar-left";

export type PaneDescriptor = {
	id: string;
	title: string;
	render: () => ReactNode;
	capabilities: PaneCapability[];
	defaultPreset: Preset;
};

export type StudioContextValue = {
	panes: Record<string, PaneDescriptor>;
	register: (p: PaneDescriptor) => () => void;
	layout: Preset;
	setLayout: (p: Preset) => void;
	resetLayout: () => void;
	focusPane: (id: string) => void;
	focusedPane: string | null;
};

const Ctx = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
	const v = useContext(Ctx);
	if (!v) throw new Error("useStudio() outside <StudioProvider>");
	return v;
}

export function StudioProvider({ children }: { children: ReactNode }): JSX.Element {
	const [panes, setPanes] = useState<Record<string, PaneDescriptor>>({});
	const [layout, setLayoutState] = useState<Preset>(() => readPreset());
	const [focusedPane, setFocusedPane] = useState<string | null>(null);

	const register = useCallback((p: PaneDescriptor) => {
		setPanes((prev) => ({ ...prev, [p.id]: p }));
		return () => {
			setPanes((prev) => {
				const next = { ...prev };
				delete next[p.id];
				return next;
			});
		};
	}, []);

	const setLayout = useCallback((p: Preset) => {
		setLayoutState(p);
		if (typeof localStorage !== "undefined") localStorage.setItem(PRESET_KEY, p);
	}, []);

	const resetLayout = useCallback(() => {
		setLayout("wide");
	}, [setLayout]);

	const focusPane = useCallback((id: string) => {
		setFocusedPane(id);
		if (typeof window === "undefined") return;
		const el = document.querySelector<HTMLElement>(`[data-pane-id="${id}"]`);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "nearest" });
			el.classList.add("studio-pane-focus");
			window.setTimeout(() => el.classList.remove("studio-pane-focus"), 1200);
		}
	}, []);

	const value = useMemo<StudioContextValue>(
		() => ({ panes, register, layout, setLayout, resetLayout, focusPane, focusedPane }),
		[panes, register, layout, setLayout, resetLayout, focusPane, focusedPane],
	);

	return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function readPreset(): Preset {
	if (typeof localStorage === "undefined") return "wide";
	const v = localStorage.getItem(PRESET_KEY);
	if (v === "compact" || v === "wide" || v === "sidebar-left") return v;
	return "wide";
}

/**
 * PaneMount — IntersectionObserver-guarded wrapper. The pane only renders
 * when at least 1px of it intersects the viewport; off-screen panes stay
 * mounted but their render output is null, so their state slices don't
 * fan out work (per §5 of the design doc).
 */
export function PaneMount({ paneId, children }: { paneId: string; children: ReactNode }): JSX.Element {
	const [visible, setVisible] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el || typeof IntersectionObserver === "undefined") {
			setVisible(true);
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) {
					if (e.isIntersecting) {
						setVisible(true);
						io.disconnect();
						break;
					}
				}
			},
			{ threshold: 0.01 },
		);
		io.observe(el);
		return () => io.disconnect();
	}, []);

	return (
		<div ref={ref} data-pane-id={paneId} className="studio-pane h-full min-h-0">
			{visible ? children : <div className="flex h-full items-center justify-center text-2xs text-ink-3">idle</div>}
		</div>
	);
}
