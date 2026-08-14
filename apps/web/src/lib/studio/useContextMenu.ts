/**
 * useContextMenu — React hook + element scanner.
 *
 * Returns the current menu state and a `show` / `close` pair. The scanner
 * (`scanDataContextKeys`) walks the DOM under a root, returning every
 * element with a `data-context-key` attribute — useful for panes that
 * want to attach per-element handlers programmatically rather than via
 * the global delegated listener.
 */
import { useEffect, useState } from "react";

import { ContextMenu, type MenuState } from "./ContextMenu";

export function useContextMenu(): {
	state: MenuState;
	show: typeof ContextMenu.show;
	close: typeof ContextMenu.close;
} {
	const [s, setS] = useState<MenuState>(ContextMenu.current());
	useEffect(() => ContextMenu.subscribe((next) => setS(next)), []);
	return { state: s, show: ContextMenu.show, close: ContextMenu.close };
}

export function scanDataContextKeys(root: ParentNode = document): HTMLElement[] {
	return Array.from(root.querySelectorAll<HTMLElement>("[data-context-key]"));
}
