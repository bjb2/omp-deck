/**
 * Server-side mirror of the GenUI component vocabulary (see
 * `apps/web/src/lib/genui/components.ts` for the canonical definition).
 *
 * The server doesn't render React, but it does inject the vocabulary into the
 * LLM prompt so the model knows what shapes are valid. The whitelist must
 * stay byte-identical to the client version (same `GENUI_ALLOWLIST_VERSION`,
 * same `GENUI_TYPES`); a divergence is detected by the version mismatch on
 * the `genui_delta` WS frame.
 *
 * `genuiNodeVocabulary()` returns a stable JSON-stringified list of types
 * for prompt injection. The exact TS shapes are NOT included (the LLM only
 * needs the type names + a one-line description each, not full props
 * schemas) — the prompt would otherwise balloon and the model would emit
 * properties the renderer doesn't understand anyway.
 */

export const GENUI_ALLOWLIST_VERSION = "1.0.0";

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

export type ServerGenuiType = (typeof GENUI_TYPES)[number];

/** Returns a JSON-serializable vocabulary list used as LLM prompt context.
 *  Keep one-line descriptions short — they go directly into the system
 *  prompt and inflate token cost. */
export function genuiNodeVocabulary(): Array<{ type: ServerGenuiType; description: string }> {
	return [
		{ type: "GenStack", description: "Vertical flex container. props.gap (px)." },
		{ type: "GenRow", description: "Horizontal flex container. props.gap, props.align." },
		{ type: "GenGrid", description: "CSS grid. props.cols, props.gap." },
		{ type: "GenText", description: "Plain text. props.size (xs|sm|md|lg), props.tone." },
		{ type: "GenMarkdown", description: "Markdown body via the deck's markdown pipeline." },
		{ type: "GenCode", description: "Code block. props.lang." },
		{ type: "GenImage", description: "Image. props.src (URL), props.alt." },
		{ type: "GenVideo", description: "Video. props.src (URL)." },
		{ type: "GenButton", description: "Button. props.label, props.action (GenAction)." },
		{ type: "GenAction", description: "Standalone action descriptor (no UI); reuse inside button/form." },
		{ type: "GenTable", description: "Table. props.headers, rows[][]." },
		{ type: "GenKeyValue", description: "Definition-list style key/value rows." },
		{ type: "GenCard", description: "Card. props.title, children." },
		{ type: "GenTabs", description: "Tabbed view. props.default, tabs[]." },
		{ type: "GenModal", description: "Modal dialog. props.title, props.onClose, children." },
		{ type: "GenForm", description: "Form. props.submit (GenAction), props.fields[]." },
	];
}