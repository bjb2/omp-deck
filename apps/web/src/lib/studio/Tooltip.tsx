/**
 * Tooltip singleton + surface portal.
 *
 * Resolution order (a → e, first non-empty wins):
 *   a. data-tooltip="..." attribute (explicit inline copy)
 *   b. data-tooltip-key="kb.commit-graph" → catalog lookup
 *   c. Heuristic — aria-label → title → data-testid → textContent
 *      Heuristic never returns empty: the literal fallback is
 *      "No description available yet — [edit this tooltip]" with the key in
 *      brackets so a maintainer can grep for it.
 *   d. Async detail via the expanded variant (the surface reads from
 *      `Tooltip.expanded(key)` — calls into the catalog's `docUrl` and
 *      optional related-cross-references).
 *   e. Dismiss — Esc, blur, click-elsewhere, scroll, navigation. Long-press
 *      500ms on touch pins the tooltip in place.
 *
 * Catalog version drift: at boot we read `lastSeenCatalogVersion` from
 * localStorage. If it differs from `TOOLTIP_CATALOG_VERSION` we log a
 * single console line ("tooltip catalog version drift: local=N server=M —
 * refresh to view new copy") and keep the old keys rendering. Never
 * block render on mismatch.
 *
 * Singleton API: `Tooltip.show(target, opts?)`, `Tooltip.dismiss(reason?)`,
 * `Tooltip.subscribe(fn)`, `Tooltip.current()`. The surface portal
 * (`<TooltipSurface />`) is mounted once at the app root.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { TOOLTIP_CATALOG_VERSION, TOOLTIPS, type TooltipEntry } from "./tooltip-catalog";

const STORAGE_KEY = "omp-deck:studio:catalog-version-seen";
const HOVER_DELAY_MS = 300;
const FADE_IN_MS = 80;
const TOUCH_LONGPRESS_MS = 500;
const VIEWPORT_MARGIN_PX = 8;
const SUBSCRIBER_LIMIT = 32;

export type TooltipContent = {
	title: string;
	body: string;
	docUrl?: string;
	related?: string[];
	capabilities?: string[];
	key?: string;
};

export type TooltipState = {
	open: boolean;
	rect?: DOMRect;
	content?: TooltipContent;
	expanded?: boolean;
	pinned?: boolean;
};

export type ShowTarget =
	| HTMLElement
	| { rect: DOMRect; key?: string; explicit?: string; element?: HTMLElement };

export type ShowOpts = { expanded?: boolean; pinned?: boolean };

type Subscriber = (state: TooltipState) => void;

let state: TooltipState = { open: false };
// Dynamic add/remove at runtime; Set is the right tool.
const subscribers = new Set<Subscriber>();
let hoverTimer: number | null = null;
let activeTarget: HTMLElement | null = null;
let activeElement: HTMLElement | null = null;
let touchTimer: number | null = null;
let suppressNextHover = false;
let listenersAttached = false;

function notify(): void {
	for (const fn of subscribers) fn(state);
}

function clearHoverTimer(): void {
	if (hoverTimer !== null) {
		window.clearTimeout(hoverTimer);
		hoverTimer = null;
	}
}

function clearTouchTimer(): void {
	if (touchTimer !== null) {
		window.clearTimeout(touchTimer);
		touchTimer = null;
	}
}

function reduceMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Catalog drift check. Runs once at module load. Safe to call again. */
export function checkCatalogDrift(): void {
	if (typeof localStorage === "undefined") return;
	const seen = localStorage.getItem(STORAGE_KEY);
	const seenN = seen === null ? null : Number(seen);
	if (seenN !== null && !Number.isNaN(seenN) && seenN !== TOOLTIP_CATALOG_VERSION) {
		// eslint-disable-next-line no-console
		console.warn(`tooltip catalog version drift: local=${seenN} server=${TOOLTIP_CATALOG_VERSION} — refresh to view new copy`);
	}
	localStorage.setItem(STORAGE_KEY, String(TOOLTIP_CATALOG_VERSION));
}

function heuristic(target: HTMLElement, key?: string): TooltipContent {
	const aria = target.getAttribute("aria-label");
	if (aria && aria.trim().length > 0) return { title: aria, body: aria, key };
	const title = target.getAttribute("title");
	if (title && title.trim().length > 0) return { title, body: title, key };
	const tid = target.getAttribute("data-testid");
	if (tid && tid.trim().length > 0) return { title: tid, body: tid, key };
	const text = (target.textContent ?? "").trim();
	if (text.length > 0 && text.length < 80) return { title: text, body: text, key };
	return {
		title: key ? `Unknown · ${key}` : "Unknown",
		body: `No description available yet — [edit this tooltip${key ? `: ${key}` : ""}]`,
		key,
	};
}

function resolveContent(target: HTMLElement, keyHint?: string): TooltipContent {
	// a. Explicit inline copy
	const inline = target.getAttribute("data-tooltip");
	if (inline && inline.trim().length > 0) return { title: inline, body: inline, key: keyHint };
	// b. Catalog lookup
	const key = keyHint ?? target.getAttribute("data-tooltip-key") ?? undefined;
	if (key) {
		const entry: TooltipEntry | undefined = TOOLTIPS[key];
		if (entry) {
			return {
				title: entry.title,
				body: entry.body,
				docUrl: entry.docUrl,
				related: entry.related,
				capabilities: entry.capabilities,
				key,
			};
		}
	}
	// c. Heuristic
	return heuristic(target, key);
}

function showFromElement(target: HTMLElement, opts?: ShowOpts): void {
	const rect = target.getBoundingClientRect();
	const content = resolveContent(target);
	state = { open: true, rect, content, expanded: opts?.expanded, pinned: opts?.pinned };
	notify();
}

function showFromRect(spec: { rect: DOMRect; key?: string; element?: HTMLElement }, opts?: ShowOpts): void {
	let content: TooltipContent | undefined;
	if (spec.element) content = resolveContent(spec.element, spec.key);
	else if (spec.key) {
		const entry = TOOLTIPS[spec.key];
		if (entry)
			content = {
				title: entry.title,
				body: entry.body,
				docUrl: entry.docUrl,
				related: entry.related,
				capabilities: entry.capabilities,
				key: spec.key,
			};
	}
	state = { open: true, rect: spec.rect, content, expanded: opts?.expanded, pinned: opts?.pinned };
	activeElement = spec.element ?? null;
	notify();
}

export const Tooltip = {
	show(target: ShowTarget, opts?: ShowOpts): void {
		clearHoverTimer();
		clearTouchTimer();
		suppressNextHover = false;
		if (target instanceof HTMLElement) {
			activeTarget = target;
			activeElement = target;
			hoverTimer = window.setTimeout(() => showFromElement(target, opts), HOVER_DELAY_MS);
		} else {
			activeElement = target.element ?? null;
			activeTarget = null;
			showFromRect(target, opts);
		}
	},

	dismiss(reason?: "esc" | "blur" | "nav" | "click"): void {
		if (!state.open) return;
		clearHoverTimer();
		clearTouchTimer();
		activeTarget = null;
		activeElement = null;
		state = { open: false };
		notify();
		void reason;
	},

	subscribe(fn: Subscriber): () => void {
		if (subscribers.size >= SUBSCRIBER_LIMIT) {
			// eslint-disable-next-line no-console
			console.warn("Tooltip subscriber cap reached; ignoring new subscriber");
			return () => undefined;
		}
		subscribers.add(fn);
		return () => {
			subscribers.delete(fn);
		};
	},

	current(): TooltipState {
		return state;
	},

	// For tests / future programmatic show: bypass the hover delay.
	showImmediate(target: ShowTarget, opts?: ShowOpts): void {
		clearHoverTimer();
		clearTouchTimer();
		if (target instanceof HTMLElement) showFromElement(target, opts);
		else showFromRect(target, opts);
	},

	/** Suppress the next hover (e.g. after a touch tap that opened the menu). */
	suppressNext(): void {
		suppressNextHover = true;
	},

	// Internal: surface re-asks for content when the rect changes.
	resolveContent(): TooltipContent | undefined {
		if (!state.open) return undefined;
		const existingKey = state.content?.key;
		if (state.content && !existingKey) return state.content;
		if (activeElement) return resolveContent(activeElement, existingKey);
		return undefined;
	},

	// Internal: surface asks for layout hints.
	constants() {
		return { HOVER_DELAY_MS, FADE_IN_MS, TOUCH_LONGPRESS_MS, VIEWPORT_MARGIN_PX, reduceMotion: reduceMotion() };
	},
};

// ─── Surface portal ─────────────────────────────────────────────────────
export function TooltipSurface(): JSX.Element | null {
	const [mounted, setMounted] = useState(false);
	const [s, setS] = useState<TooltipState>(state);

	useEffect(() => {
		checkCatalogDrift();
		setMounted(true);
		const unsub = Tooltip.subscribe((next) => setS(next));
		const dismissOnScroll = (): void => {
			if (state.open && !state.pinned) Tooltip.dismiss("nav");
		};
		const dismissOnKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape" && state.open) Tooltip.dismiss("esc");
		};
		const dismissOnClick = (): void => {
			if (state.open && !state.pinned) Tooltip.dismiss("click");
		};
		window.addEventListener("scroll", dismissOnScroll, true);
		window.addEventListener("keydown", dismissOnKey);
		document.addEventListener("click", dismissOnClick, true);
		return () => {
			unsub();
			window.removeEventListener("scroll", dismissOnScroll, true);
			window.removeEventListener("keydown", dismissOnKey);
			document.removeEventListener("click", dismissOnClick, true);
		};
	}, []);

	if (!mounted) return null;
	if (!s.open || !s.rect) return null;
	const content = s.content ?? Tooltip.resolveContent();
	if (!content) return null;

	const fadeMs = Tooltip.constants().reduceMotion ? 0 : FADE_IN_MS;
	const rect = s.rect;
	const vw = window.innerWidth;
	const vh = window.innerHeight;
	const margin = VIEWPORT_MARGIN_PX;
	const surfaceWidth = Math.min(320, Math.max(180, vw - margin * 2));
	const spaceAbove = rect.top;
	const spaceBelow = vh - rect.bottom;
	const positionAbove = spaceAbove >= 120 || spaceAbove > spaceBelow;
	const left = Math.min(Math.max(rect.left, margin), vw - surfaceWidth - margin);

	return createPortal(
		<div
			role="tooltip"
			data-tooltip-surface="true"
			style={{
				position: "fixed",
				top: positionAbove ? rect.top - 8 : rect.bottom + 8,
				left,
				maxWidth: surfaceWidth,
				transform: positionAbove ? "translateY(-100%)" : "translateY(0)",
				zIndex: 80,
				pointerEvents: s.pinned ? "auto" : "none",
			}}
			className="rounded-xl border border-line bg-paper-2/95 px-3 py-2 font-sans text-xs text-ink shadow-[0_24px_48px_-16px_rgb(var(--ink)/0.35)]"
			onMouseEnter={() => {
				if (!state.pinned) state = { ...state, pinned: true };
			}}
		>
			<div className="font-medium text-ink">{content.title}</div>
			{content.body && content.body !== content.title ? (
				<div className="mt-1 text-ink-2">{content.body}</div>
			) : null}
			{content.related && content.related.length > 0 ? (
				<div className="mt-1 font-mono text-2xs text-ink-3">
					see also: {content.related.slice(0, 3).join(", ")}
				</div>
			) : null}
			<style>{`[data-tooltip-surface="true"] { animation: tooltip-fade-in ${fadeMs}ms ease-out both; }
				@keyframes tooltip-fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
		</div>,
		document.body,
	);
}

// ─── Global hover/focus delegation ─────────────────────────────────────
function ensureListeners(): void {
	if (listenersAttached || typeof document === "undefined") return;
	listenersAttached = true;

	document.addEventListener(
		"mouseover",
		(e: MouseEvent) => {
			if (suppressNextHover) {
				suppressNextHover = false;
				return;
			}
			const t = e.target as HTMLElement | null;
			if (!t) return;
			const node = t.closest<HTMLElement>("[data-tooltip],[data-tooltip-key]");
			if (!node || node === activeTarget) return;
			activeTarget = node;
			clearHoverTimer();
			hoverTimer = window.setTimeout(() => showFromElement(node), HOVER_DELAY_MS);
		},
		true,
	);
	document.addEventListener(
		"mouseout",
		(e: MouseEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			const node = t.closest<HTMLElement>("[data-tooltip],[data-tooltip-key]");
			if (!node) return;
			const related = e.relatedTarget as HTMLElement | null;
			if (related && node.contains(related)) return;
			clearHoverTimer();
			if (!state.pinned) {
				Tooltip.dismiss("blur");
				activeTarget = null;
			}
		},
		true,
	);
	document.addEventListener(
		"focusin",
		(e: FocusEvent) => {
			const t = e.target as HTMLElement | null;
			if (!t) return;
			const node = t.closest<HTMLElement>("[data-tooltip],[data-tooltip-key]");
			if (!node) return;
			showFromElement(node);
		},
		true,
	);
	document.addEventListener(
		"focusout",
		() => {
			if (!state.pinned) {
				Tooltip.dismiss("blur");
				activeTarget = null;
			}
		},
		true,
	);

	// Touch long-press → pinned tooltip
	document.addEventListener(
		"touchstart",
		(e: TouchEvent) => {
			const t = e.touches[0]?.target as HTMLElement | null;
			if (!t) return;
			const node = t.closest<HTMLElement>("[data-tooltip],[data-tooltip-key]");
			if (!node) return;
			clearTouchTimer();
			touchTimer = window.setTimeout(() => {
				showFromElement(node, { pinned: true });
				try {
					navigator.vibrate?.(15);
				} catch {
					/* no vibrate available */
				}
			}, TOUCH_LONGPRESS_MS);
		},
		{ passive: true },
	);
	document.addEventListener(
		"touchmove",
		() => {
			clearTouchTimer();
		},
		{ passive: true },
	);
	document.addEventListener(
		"touchend",
		() => {
			clearTouchTimer();
		},
		{ passive: true },
	);
}

if (typeof document !== "undefined") {
	ensureListeners();
}
