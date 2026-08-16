/**
 * Pass-through helper for the deck-managed session metadata. Kept tiny and
 * side-effect free so reducer.ts stays a pure event reducer; the sidebar /
 * inspector use it to lift AI / dial fields off a `SessionSummary` row
 * onto the corresponding `SessionUi.meta` slot.
 */
import type { SessionImportance, SessionStatus, SessionSummary, SessionUrgency } from "@omp-deck/protocol";
import type { SessionUi } from "./types";

export interface SessionUiMeta {
	urgency?: SessionUrgency;
	importance?: SessionImportance;
	archived?: boolean;
	aiSummary?: string;
	aiTags?: string[];
	aiGeneratedAt?: string;
}

/** Build the meta-passthrough object from a persisted `SessionSummary` row. */
export function sessionUiMetaFromSummary(s: Pick<SessionSummary,
	"urgency" | "importance" | "status" | "archived" | "aiSummary" | "aiTags" | "aiGeneratedAt">): SessionUiMeta {
	return {
		urgency: s.urgency,
		importance: s.importance,
		archived: s.archived,
		aiSummary: s.aiSummary,
		aiTags: s.aiTags,
		aiGeneratedAt: s.aiGeneratedAt,
	};
}

/** Merge a meta-passthrough into a SessionUi without losing unrelated fields. */
export function applySessionUiMeta(ui: SessionUi, meta: SessionUiMeta): SessionUi {
	return {
		...ui,
		meta: {
			...ui.meta,
			urgency: meta.urgency ?? ui.meta?.urgency,
			importance: meta.importance ?? ui.meta?.importance,
			archived: meta.archived ?? ui.meta?.archived,
			aiSummary: meta.aiSummary ?? ui.meta?.aiSummary,
			aiTags: meta.aiTags ?? ui.meta?.aiTags,
			aiGeneratedAt: meta.aiGeneratedAt ?? ui.meta?.aiGeneratedAt,
		},
	};
}

/** Patch helper that replaces one dial on `SessionUi.meta` immutably. */
export function patchSessionUiMeta<K extends keyof SessionUiMeta>(
	ui: SessionUi,
	key: K,
	value: SessionUiMeta[K],
): SessionUi {
	return { ...ui, meta: { ...ui.meta, [key]: value } };
}