/**
 * ContextMenuPortal — convenience re-export of `ContextMenuSurface` with
 * an a11y-focused wrapper. The real surface lives in `ContextMenu.ts`.
 */
import { ContextMenuSurface } from "./ContextMenu";

export function ContextMenuPortal(): JSX.Element | null {
	return <ContextMenuSurface />;
}
