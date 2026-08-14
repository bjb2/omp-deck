/**
 * Studio pane: Gholam (full embed of `<GholamView />`).
 *
 * Unlike the other panes this one IS writable — the studio is where the
 * user drives sidecar priorities. The `readOnly` prop is exposed so a
 * future guest-mode studio can suppress sidecar mutations (start/stop,
 * save priorities, add/remove priority) without touching GholamView.tsx.
 * When `readOnly` is true, the pane sets the native HTML `inert`
 * attribute on the view's wrapper — this disables pointer, focus,
 * keyboard, and AT interaction across the whole subtree.
 */
import { GholamView } from "@/views/GholamView";

export function GholamPane({ readOnly = false }: { readOnly?: boolean }): JSX.Element {
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-pane-frame="gholam"
			data-read-only={readOnly ? "true" : "false"}
		>
			<div className="min-h-0 flex-1" {...(readOnly ? { inert: "" } : {})}>
				<GholamView />
			</div>
		</div>
	);
}