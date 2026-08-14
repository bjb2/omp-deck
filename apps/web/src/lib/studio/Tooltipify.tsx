/**
 * `<Tooltipify>` — thin React wrapper around the Tooltip singleton.
 *
 * Copies `key` / `data-tooltip-key` onto the child, attaches hover / focus /
 * keydown listeners, and calls `Tooltip.show({ rect, key, element })` with
 * the resolved key. Renders nothing itself — the singleton owns the portal.
 *
 * Default: pass-through (clone child). Opt-out via `disabled`.
 */
import { Children, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { Tooltip } from "./Tooltip";

type Props = {
	key?: string;
	inline?: boolean;
	disabled?: boolean;
	expanded?: ReactNode;
	children: ReactNode;
};

export function Tooltipify({ key: tooltipKey, disabled, children }: Props): ReactNode {
	if (disabled) return children;
	const only = Children.only(children);
	if (!isValidElement(only)) return children;

	const childEl = only as ReactElement<Record<string, unknown>>;
	const existing = childEl.props;
	const nextProps: Record<string, unknown> = { ...existing };
	if (tooltipKey) nextProps["data-tooltip-key"] = tooltipKey;
	if (existing["data-tooltip"] == null && existing["aria-label"] == null) {
		// Don't strip an existing title — `<Tooltipify>` layers on top of it.
	}
	nextProps["data-tooltipify"] = "true";
	return cloneElement(childEl, nextProps);
}
