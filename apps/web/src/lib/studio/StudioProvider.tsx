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
import {
	Component,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ErrorInfo,
	type ReactNode,
} from "react";

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
	/** Marker true when returned by the safe fallback (no provider mounted). */
	__safe?: boolean;
	panes: Record<string, PaneDescriptor>;
	register: (p: PaneDescriptor) => () => void;
	layout: Preset;
	setLayout: (p: Preset) => void;
	resetLayout: () => void;
	focusPane: (id: string) => void;
	focusedPane: string | null;
};

const Ctx = createContext<StudioContextValue | null>(null);

/* ─── Safe default context ──────────────────────────────────────────────────
 * `useStudio()` used to throw when a pane mounted outside `<StudioProvider>`
 * (e.g. the gholam deep-link route before the provider mounted, or a pane
 * being rendered standalone in a Storybook/test). That hard throw was the
 * root cause of "unexpected application error" crashes that took the whole
 * Studio page down with no recovery. We now hand back a no-op context so
 * the pane renders (perhaps less featured) rather than the whole surface
 * unmounting. Callers that genuinely require registration can detect the
 * fallback via `ctx.__safe === true`.
 */
const SAFE_NOOP: StudioContextValue = Object.freeze({
	__safe: true,
	panes: {},
	register: () => () => undefined,
	layout: "wide" as Preset,
	setLayout: () => undefined,
	resetLayout: () => undefined,
	focusPane: () => undefined,
	focusedPane: null,
});

export function useStudio(): StudioContextValue {
	return useContext(Ctx) ?? SAFE_NOOP;
}

/**
 * Error boundary used by `<StudioProvider>` to isolate pane crashes. A
 * thrown render in any pane now shows a "Pane crashed" card with a
 * Recover button instead of taking the whole `/studio` route down.
 */
interface StudioBoundaryProps {
	children: ReactNode;
	boundaryKey: number;
	onReset: () => void;
}
interface StudioBoundaryState {
	err: Error | null;
}
class StudioErrorBoundary extends Component<StudioBoundaryProps, StudioBoundaryState> {
	override state: StudioBoundaryState = { err: null };
	static getDerivedStateFromError(err: Error): StudioBoundaryState {
		return { err };
	}
	override componentDidCatch(err: Error, info: ErrorInfo): void {
		console.error("[studio] pane crashed:", err, info.componentStack ?? "");
	}
	override render(): ReactNode {
		if (this.state.err) {
			const message = this.state.err.message || String(this.state.err);
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
					<div className="font-mono text-2xs uppercase tracking-meta text-danger">
						pane crashed
					</div>
					<div className="max-w-md break-words font-mono text-2xs text-ink-2">{message}</div>
					<button
						type="button"
						className="btn-ghost mt-2 h-7 rounded-md border border-line bg-paper-2 px-2 text-xs"
						onClick={() => {
							this.setState({ err: null });
							this.props.onReset();
						}}
					>
						Recover pane
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}

export function StudioProvider({ children }: { children: ReactNode }): JSX.Element {
	const [panes, setPanes] = useState<Record<string, PaneDescriptor>>({});
	const [layout, setLayoutState] = useState<Preset>(() => readPreset());
	const [focusedPane, setFocusedPane] = useState<string | null>(null);
	const [boundaryKey, setBoundaryKey] = useState(0);

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

	return (
		<Ctx.Provider value={value}>
			<StudioErrorBoundary boundaryKey={boundaryKey} onReset={() => setBoundaryKey((k) => k + 1)}>
				{children}
			</StudioErrorBoundary>
		</Ctx.Provider>
	);
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
