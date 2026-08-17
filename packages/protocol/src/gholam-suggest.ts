/**
 * Gholam text-suggestion WS frames.
 *
 * The gholam sidecar watches a rich-text editor session and proposes a
 * replacement for a token range; the server forwards the proposal to the
 * client (`gholam_text_suggest`). The client either accepts (which the
 * server translates into a `gholam_text_apply` echo back to the sidecar so
 * the suggestion row can be marked resolved) or ignores the proposal.
 *
 * Both frames are appended onto the existing `ServerFrame` / `ClientFrame`
 * unions in `./index.ts` without touching the base unions, matching the
 * pattern used for `GholamCommandFrame` / `ReloadAvailableFrame` /
 * `DeployStateFrame`.
 */

/**
 * One text-suggestion proposal from the gholam sidecar.
 *
 * - `id` is a server-generated unique handle; clients echo it back on apply.
 * - `token` is the original substring the suggestion replaces (for diff UI).
 * - `replacement` is the proposed replacement text.
 * - `range` is `[start, end]` codepoint offsets into the editor buffer.
 * - `rationale` is optional sidecar commentary ("ambiguous word", etc).
 */
export interface GholamTextSuggestion {
	id: string;
	token: string;
	replacement: string;
	range: [number, number];
	rationale?: string;
}

/** Server → Client. A new suggestion has arrived. */
export interface GholamTextSuggestFrame {
	type: "gholam_text_suggest";
	sessionId: string;
	suggestion: GholamTextSuggestion;
}

/** Client → Server. The user accepted `suggestionId`. */
export interface GholamTextApplyFrame {
	type: "gholam_text_apply";
	sessionId: string;
	suggestionId: string;
}