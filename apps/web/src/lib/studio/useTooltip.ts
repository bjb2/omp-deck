/**
 * React hook for the Tooltip singleton. Returns the current state and a
 * `show` / `dismiss` pair. Subscribers re-render on every state change.
 *
 * Usage:
 *   const { state, show, dismiss } = useTooltip();
 *   <button onMouseEnter={(e) => show(e.currentTarget)}>…</button>
 */
import { useEffect, useState } from "react";

import { Tooltip, type ShowOpts, type ShowTarget, type TooltipState } from "./Tooltip";

export function useTooltip(): {
	state: TooltipState;
	show: (target: ShowTarget, opts?: ShowOpts) => void;
	dismiss: (reason?: "esc" | "blur" | "nav" | "click") => void;
} {
	const [s, setS] = useState<TooltipState>(Tooltip.current());
	useEffect(() => Tooltip.subscribe((next) => setS(next)), []);
	return { state: s, show: Tooltip.show, dismiss: Tooltip.dismiss };
}
