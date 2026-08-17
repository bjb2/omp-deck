/**
 * Component vocabulary for the deck's Generative UI surface (§3 of
 * docs/GENERATIVE.md). The discriminated union is the SINGLE SOURCE OF
 * TRUTH — it lives in `packages/protocol/src/index.ts` so server code
 * can reference the exact same shape without an import-alias dance.
 * This module re-exports it and adds the small renderer-side helpers
 * (`GENUI_TYPES`, `GenuiType`) that don't belong on the protocol layer.
 *
 * Any new vocabulary must be added to the `GenComponent` union in the
 * protocol file AND mirrored in `apps/server/src/genui-allowlist.ts`'s
 * prompt-context list. The renderer dispatches against this union; the
 * LLM is told about it via the server mirror.
 *
 * `GENUI_ALLOWLIST_VERSION` is bumped on breaking changes — clients
 * refuse to render frames tagged with a stale version.
 */

export { GENUI_ALLOWLIST_VERSION } from "@omp-deck/protocol";
export type { GenAction, GenComponent, GenField, GenFrame, GenNode } from "@omp-deck/protocol";

/** The set of valid `type` discriminators. Used by the renderer to detect
 *  unknown types without a full union narrowing pass, and exported to the
 *  server for prompt-context construction. */
export const GENUI_TYPES = [
	"GenStack",
	"GenRow",
	"GenGrid",
	"GenText",
	"GenMarkdown",
	"GenCode",
	"GenImage",
	"GenVideo",
	"GenButton",
	"GenAction",
	"GenTable",
	"GenKeyValue",
	"GenCard",
	"GenTabs",
	"GenModal",
	"GenForm",
] as const;

export type GenuiType = (typeof GENUI_TYPES)[number];