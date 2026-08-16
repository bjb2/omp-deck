/**
 * `useGholamSuggestion` — listens to `gholam_text_suggest` frames on the
 * active WS connection and exposes the most recent pending suggestion for
 * the current session. Consumers (RichEditor) render the wavy underline
 * decoration from the suggestion's `range`; Tab calls `onTabApply` to
 * consume it; `apply()` performs the actual text replacement.
 */

import { useCallback, useEffect, useState } from "react";

import type { GholamTextSuggestion } from "@omp-deck/protocol";

import { useStore } from "./store";

export interface GholamSuggestion {
	id: string;
	replacement: string;
	token: string;
	range: [number, number];
	rationale?: string;
}

export interface GholamSuggestionApi {
	suggestion: GholamSuggestion | null;
	/** Drop the current suggestion (no server round-trip). */
	dismiss: () => void;
	/** Compute the next draft after applying the current suggestion.
	 *  Returns null when no suggestion is active. If the suggestion has a
	 *  range, the slice is replaced with the replacement; otherwise the
	 *  replacement is appended. */
	apply: (current: string) => string | null;
	/** Whether the editor should fire its Tab handler for the next key. */
	onPending: () => boolean;
}

/** Per-session suggestion cache, shared across all hook instances. Hook
 *  reads + writes here so multiple editors on the same session see the
 *  same pending suggestion. Keyed by session id. */
const pending = new Map<string, GholamSuggestion>();
const listeners = new Set<(s: GholamSuggestion | null, sessionId: string) => void>();

function broadcast(s: GholamSuggestion | null, sessionId: string) {
	for (const l of listeners) l(s, sessionId);
}

export function useGholamSuggestion(): GholamSuggestionApi {
	const ws = useStore((s) => s.ws);
	const activeId = useStore((s) => s.activeId);
	const [current, setCurrent] = useState<GholamSuggestion | null>(
		activeId ? (pending.get(activeId) ?? null) : null,
	);

	// Subscribe to WS frames.
	useEffect(() => {
		if (!ws) return;
		const unsub = ws.subscribe((frame) => {
			if (frame.type !== "gholam_text_suggest") return;
			const next: GholamSuggestion = {
				id: frame.suggestion.id,
				replacement: frame.suggestion.replacement,
				token: frame.suggestion.token,
				range: frame.suggestion.range,
				...(frame.suggestion.rationale !== undefined
					? { rationale: frame.suggestion.rationale }
					: {}),
			};
			pending.set(frame.sessionId, next);
			broadcast(next, frame.sessionId);
		});
		return unsub;
	}, [ws]);

	// Mirror the active-session entry.
	useEffect(() => {
		const handler = (s: GholamSuggestion | null, sessionId: string) => {
			if (sessionId !== activeId) return;
			setCurrent(s);
		};
		listeners.add(handler);
		if (activeId) setCurrent(pending.get(activeId) ?? null);
		return () => {
			listeners.delete(handler);
		};
	}, [activeId]);

	const dismiss = useCallback(() => {
		if (!activeId) return;
		pending.delete(activeId);
		broadcast(null, activeId);
	}, [activeId]);

	const apply = useCallback(
		(currentText: string): string | null => {
			if (!activeId) return null;
			const s = pending.get(activeId);
			if (!s) return null;
			const [start, end] = s.range;
			// Range can be [start,end) or [start,end] — clamp + splice.
			const lo = Math.max(0, Math.min(start, end));
			const hi = Math.max(0, Math.max(start, end));
			if (hi <= lo) {
				// No usable range — append.
				const next = currentText + s.replacement;
				pending.delete(activeId);
				broadcast(null, activeId);
				return next;
			}
			const next = currentText.slice(0, lo) + s.replacement + currentText.slice(hi);
			pending.delete(activeId);
			broadcast(null, activeId);
			return next;
		},
		[activeId],
	);

	const onPending = useCallback(() => current !== null, [current]);

	return { suggestion: current, dismiss, apply, onPending };
}

/** Re-export the wire type so callers can import a single suggestion shape. */
export type { GholamTextSuggestion };