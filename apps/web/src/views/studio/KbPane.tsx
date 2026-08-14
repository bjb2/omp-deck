/**
 * Studio pane: KB (read-only embed of `<KbView />`).
 *
 * The KB view has its own Layout (tree + main + inspector + palette). The
 * studio embeds it whole; the command palette stays available so the user
 * can fuzzy-find files, but mutations through the inspector are scoped to
 * the same active session. In `readOnly` mode the pane sets the native
 * HTML `inert` attribute on the view's wrapper — this disables pointer,
 * focus, keyboard, and AT interaction across the whole subtree so users
 * cannot trigger edits (Create starter README, Edit/Save, wikilink
 * creates) without modifying KbView.tsx.
 */
import { KbView } from "@/views/KbView";

export function KbPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-pane-frame="kb"
			data-read-only={readOnly ? "true" : "false"}
		>
			<div className="min-h-0 flex-1" {...(readOnly ? { inert: "" } : {})}>
				<KbView />
			</div>
		</div>
	);
}