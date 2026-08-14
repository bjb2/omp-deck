/**
 * ContextMenu registry. The static catalog lives in `tooltip-catalog.ts`
 * under `MENUS`; this module re-exports the registry shape so panes can
 * import from a stable, intent-clear path.
 *
 * Runtime registration: `ContextMenu.register(key, build)` (see
 * `ContextMenu.ts`). The static map always wins when keys collide —
 * runtime adds are for per-element custom actions only.
 */
export { MENUS, TOOLTIP_CATALOG_VERSION, TOOLTIPS } from "./tooltip-catalog";
export type { MenuEntry, TooltipEntry } from "./tooltip-catalog";
