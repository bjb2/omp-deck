/**
 * ContextMenu singleton + portal surface.
 *
 * Resolution order (most specific wins):
 *   1. Item-scoped — exact key with element identity: `kb.commit-graph.vertex:cursor`
 *   2. Type-scoped — `kb.commit-graph.vertex`
 *   3. Family-scoped — `kb.commit-graph`
 *   4. Namespace fallback — `kb`
 *   5. Global fallback (ALWAYS non-empty) — Inspect / Copy ref / Copy MD /
 *      Open dev console / Reload / Toggle tooltips.
 *
 * The right-click listener lives at the `body` level and reads
 * `data-context-key` from the closest ancestor of the event target. If
 * nothing matches, the global fallback runs.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Tooltip } from "./Tooltip";
import { MENUS, type MenuEntry } from "./tooltip-catalog";

const VIEWPORT_MARGIN_PX = 8;

export type MenuActionCapability = "edit" | "change" | "execute" | "open" | "danger" | "gholam.action" | "kb.action" | "task.action";

export type MenuActionIcon = "edit" | "trash" | "copy" | "external-link" | "play" | "stop" | "refresh" | "plus";

export type MenuAction = {
	id: string;
	label: string;
	hint?: string;
	accelerator?: string;
	icon?: MenuActionIcon;
	danger?: boolean;
	capability: MenuActionCapability;
	handler: (ctx: unknown) => void | Promise<void>;
};

export type MenuState = {
	open: boolean;
	rect?: { x: number; y: number };
	scope?: string;
	actions: MenuAction[];
	filter: string;
};

type Subscriber = (state: MenuState) => void;

let state: MenuState = { open: false, actions: [], filter: "" };
const subscribers = new Set<Subscriber>();
let activeIdx = 0;
let listRef: HTMLDivElement | null = null;
let listenersAttached = false;

function notify(): void {
	for (const fn of subscribers) fn(state);
}

function reduceMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function resolveActions(scope: string, ctx: unknown): { actions: MenuAction[]; matchedScope: string } {
	// Item-scoped (key + identity) — v1 doesn't generate identity suffixes,
	// so this falls through to the type-scope.
	const typeScope = scope;
	const entry: MenuEntry | undefined = MENUS[typeScope];
	if (entry) return { actions: entry.actions(ctx), matchedScope: typeScope };
	// Walk up the dotted chain.
	const parts = typeScope.split(".");
	while (parts.length > 1) {
		parts.pop();
		const family = parts.join(".");
		const e = MENUS[family];
		if (e) return { actions: e.actions(ctx), matchedScope: family };
	}
	// Global fallback
	const g = MENUS["global.fallback"];
	return { actions: g ? g.actions(ctx) : [], matchedScope: "global" };
}

function buildCtx(target: HTMLElement | null): Record<string, unknown> {
	if (!target) return {};
	const out: Record<string, unknown> = {};
	const el = target as HTMLElement & Record<string, unknown>;
	if (el.id) out["id"] = el.id;
	if (el.dataset && typeof el.dataset === "object") Object.assign(out, el.dataset);
	return out;
}

export const ContextMenu = {
	register(key: string, build: (ctx: unknown) => MenuAction[] | { actions: MenuAction[] }): () => void {
		// Catalog-driven: registration happens via the static MENUS map in
		// tooltip-catalog.ts. This API exists for callers that want to add
		// per-element actions at runtime; the static map wins when keys collide.
		const existing = MENUS[key];
		if (existing) {
			// eslint-disable-next-line no-console
			console.warn(`ContextMenu.register: '${key}' already in static catalog; ignoring override`);
			return () => undefined;
		}
		(MENUS as unknown as Record<string, MenuEntry>)[key] = {
			scope: key,
			since: "0.6.1",
			actions: (ctx: unknown) => {
				const built = build(ctx);
				return Array.isArray(built) ? built : built.actions;
			},
		};
		return () => {
			delete (MENUS as unknown as Record<string, MenuEntry | undefined>)[key];
		};
	},

	show(target: HTMLElement, event: { clientX: number; clientY: number }): void {
		const scopeEl = target.closest<HTMLElement>("[data-context-key]");
		const scope = scopeEl?.getAttribute("data-context-key") ?? "global.fallback";
		const ctx = buildCtx(scopeEl);
		const { actions } = resolveActions(scope, ctx);
		state = {
			open: true,
			rect: { x: event.clientX, y: event.clientY },
			scope,
			actions,
			filter: "",
		};
		activeIdx = 0;
		Tooltip.suppressNext();
		Tooltip.dismiss("nav");
		notify();
	},

	close(reason?: "esc" | "click" | "nav"): void {
		if (!state.open) return;
		state = { open: false, actions: [], filter: "" };
		notify();
		void reason;
	},

	subscribe(fn: Subscriber): () => void {
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	},

	current(): MenuState {
		return state;
	},

	// Internals used by the surface.
	setFilter(filter: string): void {
		state = { ...state, filter };
		activeIdx = 0;
		notify();
	},

	setActiveIdx(idx: number): void {
		const max = Math.max(0, filteredActions(state).length - 1);
		activeIdx = Math.min(max, Math.max(0, idx));
		notify();
	},

	activeIdx(): number {
		return activeIdx;
	},

	executeAction(action: MenuAction, ctx: unknown): void {
		void action.handler(ctx);
		ContextMenu.close("click");
	},

	filteredActions(): MenuAction[] {
		return filteredActions(state);
	},
};

function filteredActions(s: MenuState): MenuAction[] {
	if (!s.filter) return s.actions;
	const f = s.filter.toLowerCase();
	return s.actions.filter((a) => a.label.toLowerCase().includes(f));
}

// ─── Surface portal ─────────────────────────────────────────────────────
export function ContextMenuSurface(): JSX.Element | null {
	const [mounted, setMounted] = useState(false);
	const [s, setS] = useState<MenuState>(state);

	useEffect(() => {
		setMounted(true);
		const unsub = ContextMenu.subscribe((next) => setS(next));
		const onKey = (e: KeyboardEvent): void => {
			if (!state.open) return;
			const visible = filteredActions(state);
			if (e.key === "Escape") {
				e.preventDefault();
				ContextMenu.close("esc");
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				ContextMenu.setActiveIdx(activeIdx + 1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				ContextMenu.setActiveIdx(activeIdx - 1);
			} else if (e.key === "Enter") {
				e.preventDefault();
				const a = visible[activeIdx];
				if (a) ContextMenu.executeAction(a, {});
			} else if (e.key === "Shift" || e.key === "Control" || e.key === "Meta" || e.key === "Alt") {
				return;
			} else if (e.key.length === 1) {
				const next = state.filter + e.key;
				ContextMenu.setFilter(next);
			}
		};
		const onClickOutside = (e: MouseEvent): void => {
			if (!state.open) return;
			const t = e.target as HTMLElement | null;
			if (t && listRef && listRef.contains(t)) return;
			ContextMenu.close("click");
		};
		const onScroll = (): void => {
			if (state.open) ContextMenu.close("nav");
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("mousedown", onClickOutside, true);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			unsub();
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("mousedown", onClickOutside, true);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, []);

	if (!mounted) return null;
	if (!s.open || !s.rect) return null;
	const visible = filteredActions(s);
	if (visible.length === 0) return null;
	const scaleMs = reduceMotion() ? 0 : 80;
	const margin = VIEWPORT_MARGIN_PX;
	const width = 240;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const left = Math.min(Math.max(s.rect.x, margin), vw - width - margin);
	const top = Math.min(Math.max(s.rect.y, margin), vh - 8 - margin);

	return createPortal(
		<div
			ref={(el) => {
				listRef = el;
			}}
			role="menu"
			aria-label={s.scope ?? "context menu"}
			style={{ position: "fixed", top, left, width, zIndex: 90, transformOrigin: "top left" }}
			className="rounded-xl border border-line bg-paper-2/95 p-1 font-sans text-xs shadow-[0_24px_48px_-16px_rgb(var(--ink)/0.35)]"
		>
			<ul className="flex flex-col">
				{visible.map((a, i) => {
					const isActive = i === activeIdx;
					return (
						<li key={a.id}>
							<button
								type="button"
								role="menuitem"
								aria-current={isActive ? "true" : undefined}
								data-context-action={a.id}
								onClick={(e) => {
									e.stopPropagation();
									ContextMenu.executeAction(a, {});
								}}
								onMouseEnter={() => ContextMenu.setActiveIdx(i)}
								className={
									"flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left " +
									(isActive ? "bg-paper-3 text-ink" : "text-ink-2 hover:bg-paper-3") +
									(a.danger ? " text-danger" : "")
								}
							>
								<span className="flex items-center gap-2">
									{a.icon ? <Icon name={a.icon} /> : null}
									<span>{a.label}</span>
								</span>
								{a.accelerator ? (
									<span className="font-mono text-2xs text-ink-3">{a.accelerator}</span>
								) : null}
							</button>
						</li>
					);
				})}
			</ul>
			<style>{`[role="menu"] { animation: ctxmenu-fade-in ${scaleMs}ms ease-out both; }
				@keyframes ctxmenu-fade-in { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }`}</style>
		</div>,
		document.body,
	);
}

function Icon({ name }: { name: MenuActionIcon }): JSX.Element {
	// Tiny inline glyphs so we don't pull a new icon dep.
	const path: Record<MenuActionIcon, string> = {
		edit: "M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7 M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z",
		trash: "M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6 M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2 M10 11v6 M14 11v6",
		copy: "M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2Z M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
		"external-link": "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6 M15 3h6v6 M10 14 21 3",
		play: "M5 3l14 9-14 9V3z",
		stop: "M6 6h12v12H6z",
		refresh: "M21 12a9 9 0 0 1-15 6.7L3 16 M3 12a9 9 0 0 1 15-6.7L21 8 M3 21v-5h5 M21 3v5h-5",
		plus: "M12 5v14 M5 12h14",
	};
	return (
		<svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<path d={path[name]} />
		</svg>
	);
}

// ─── Global contextmenu delegation ─────────────────────────────────────
function ensureListeners(): void {
	if (listenersAttached || typeof document === "undefined") return;
	listenersAttached = true;
	document.addEventListener(
		"contextmenu",
		(e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			// Always show the menu, but the scope comes from the closest
			// data-context-key ancestor. Without one → global fallback.
			e.preventDefault();
			ContextMenu.show(t, { clientX: e.clientX, clientY: e.clientY });
		},
		false,
	);
	// Shift+F10 / ContextMenu key on focused element
	document.addEventListener(
		"keydown",
		(e: KeyboardEvent) => {
			if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
			const t = (document.activeElement as HTMLElement | null) ?? null;
			if (!t) return;
			const r = t.getBoundingClientRect();
			ContextMenu.show(t, { clientX: r.left + r.width / 2, clientY: r.bottom });
		},
		true,
	);
	// Long-press on touch
	let touchTimer: number | null = null;
	document.addEventListener(
		"touchstart",
		(e: TouchEvent) => {
			const t = e.touches[0]?.target as HTMLElement | null;
			if (!t) return;
			if (touchTimer !== null) window.clearTimeout(touchTimer);
			touchTimer = window.setTimeout(() => {
				try {
					navigator.vibrate?.(15);
				} catch {
					/* no vibrate available */
				}
				ContextMenu.show(t, { clientX: e.touches[0]!.clientX, clientY: e.touches[0]!.clientY });
			}, 500);
		},
		{ passive: true },
	);
	document.addEventListener(
		"touchend",
		() => {
			if (touchTimer !== null) window.clearTimeout(touchTimer);
		},
		{ passive: true },
	);
}

if (typeof document !== "undefined") {
	ensureListeners();
}
