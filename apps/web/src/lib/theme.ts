import { useCallback, useEffect, useState } from "react";

/**
 * Theme runtime. The pre-paint script in `index.html` is the authoritative
 * first apply; this module is React's mirror — same id list, same storage key,
 * same `data-theme` mutation — so hot theme changes work without reload and a
 * reload still lands on the saved theme.
 */

export type ThemeId = "paper" | "slate" | "horizon" | "aurora";

export interface ThemeDefinition {
	id: ThemeId;
	label: string;
	description: string;
	/** Marketing-color preview swatches (token id → display label only). */
	swatchTokens: Array<{ token: string; label: string }>;
	metaThemeColor: string;
	colorScheme: "light" | "dark";
}

export const THEMES: ThemeDefinition[] = [
	{
		id: "paper",
		label: "Paper",
		description: "Engineer's-notebook palette. Warm cream surfaces, rust accent.",
		swatchTokens: [
			{ token: "paper", label: "Page" },
			{ token: "paper-3", label: "Inset" },
			{ token: "ink", label: "Ink" },
			{ token: "accent", label: "Accent" },
		],
		metaThemeColor: "#f7f4ee",
		colorScheme: "light",
	},
	{
		id: "slate",
		label: "Slate",
		description: "Deep slate surfaces, brighter rust accent, calm syntax colors.",
		swatchTokens: [
			{ token: "paper", label: "Page" },
			{ token: "paper-3", label: "Inset" },
			{ token: "ink", label: "Ink" },
			{ token: "accent", label: "Accent" },
		],
		metaThemeColor: "#0f131a",
		colorScheme: "dark",
	},
	{
		id: "horizon",
		label: "Horizon",
		description: "Pink-on-deep-navy with mint + peach. Ported from opus-extensions/horizon.",
		swatchTokens: [
			{ token: "paper", label: "Page" },
			{ token: "paper-3", label: "Inset" },
			{ token: "ink", label: "Ink" },
			{ token: "accent", label: "Accent" },
		],
		metaThemeColor: "#1c1e26",
		colorScheme: "dark",
	},
	{
		id: "aurora",
		label: "Aurora",
		description: "Near-black canvas, violet-to-cyan accent, glass panels. The new default.",
		swatchTokens: [
			{ token: "paper", label: "Page" },
			{ token: "paper-3", label: "Inset" },
			{ token: "ink", label: "Ink" },
			{ token: "accent", label: "Accent" },
		],
		metaThemeColor: "#0a0b10",
		colorScheme: "dark",
	},
];

export const THEME_IDS = THEMES.map((t) => t.id);
const STORAGE_KEY = "omp-deck:theme";

export function isThemeId(value: string | null | undefined): value is ThemeId {
	return typeof value === "string" && (THEME_IDS as string[]).includes(value);
}

function readStoredTheme(): ThemeId | undefined {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return isThemeId(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Aurora is the deck's actual design — not one option among several — so it
 * is the default for anyone who hasn't chosen otherwise, regardless of the
 * visitor's OS color-scheme preference. An earlier version of this function
 * gated the flagship look behind a dark-OS preference, which meant most
 * first-time visitors (light is still the common OS default) never saw it.
 * A saved choice in `localStorage` — including an explicit choice of Paper —
 * always wins; this only decides what a *first* visit looks like.
 */
function systemPreferredTheme(): ThemeId {
	return "aurora";
}

function activeAttribute(): ThemeId {
	const attr = document.documentElement.getAttribute("data-theme");
	return isThemeId(attr) ? attr : systemPreferredTheme();
}

function applyTheme(theme: ThemeId): void {
	document.documentElement.setAttribute("data-theme", theme);
	const def = THEMES.find((t) => t.id === theme);
	if (!def) return;
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", def.metaThemeColor);
	const scheme = document.querySelector('meta[name="color-scheme"]');
	if (scheme) scheme.setAttribute("content", def.colorScheme);
}

export interface UseThemeResult {
	active: ThemeId;
	stored: ThemeId | undefined;
	systemPreferred: ThemeId;
	usingSystem: boolean;
	set(theme: ThemeId): void;
	clear(): void;
}

export function useTheme(): UseThemeResult {
	const [active, setActive] = useState<ThemeId>(() =>
		typeof document === "undefined" ? "paper" : activeAttribute(),
	);
	const [stored, setStored] = useState<ThemeId | undefined>(() =>
		typeof window === "undefined" ? undefined : readStoredTheme(),
	);
	const [systemPreferred, setSystemPreferred] = useState<ThemeId>(() =>
		typeof window === "undefined" ? "paper" : systemPreferredTheme(),
	);

	// React to the OS toggling between light and dark while the app is open.
	// We only follow it when the user hasn't pinned a choice.
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) return;
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (): void => {
			const next: ThemeId = mql.matches ? "slate" : "paper";
			setSystemPreferred(next);
			if (!readStoredTheme()) {
				applyTheme(next);
				setActive(next);
			}
		};
		mql.addEventListener?.("change", onChange);
		return () => mql.removeEventListener?.("change", onChange);
	}, []);

	// Cross-tab sync: another tab flipping the theme propagates here too.
	useEffect(() => {
		if (typeof window === "undefined") return;
		const onStorage = (e: StorageEvent): void => {
			if (e.key !== STORAGE_KEY) return;
			const next = isThemeId(e.newValue) ? e.newValue : systemPreferredTheme();
			applyTheme(next);
			setActive(next);
			setStored(isThemeId(e.newValue) ? e.newValue : undefined);
		};
		window.addEventListener("storage", onStorage);
		return () => window.removeEventListener("storage", onStorage);
	}, []);

	const set = useCallback((theme: ThemeId) => {
		applyTheme(theme);
		setActive(theme);
		setStored(theme);
		try {
			window.localStorage.setItem(STORAGE_KEY, theme);
		} catch {
			// quota / disabled storage — theme still applied in-memory
		}
	}, []);

	const clear = useCallback(() => {
		try {
			window.localStorage.removeItem(STORAGE_KEY);
		} catch {
			// ignore
		}
		const fallback = systemPreferredTheme();
		applyTheme(fallback);
		setActive(fallback);
		setStored(undefined);
	}, []);

	return {
		active,
		stored,
		systemPreferred,
		usingSystem: stored === undefined,
		set,
		clear,
	};
}
