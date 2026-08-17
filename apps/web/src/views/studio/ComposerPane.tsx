/**
 * Studio pane: Composer (embed of the chat composer + status).
 *
 * The pane wires the existing `<Composer />` component (the chat composer
 * used by `ChatView`) inside a minimal chrome. The composer's own state
 * is the global zustand store. In `readOnly` mode the pane sets the
 * native HTML `inert` attribute on the composer's wrapper — this disables
 * pointer, focus, keyboard, and AT interaction across the whole subtree
 * in a single attribute, so the composer cannot accept input without
 * touching Composer.tsx itself. The header chrome above stays interactive
 * so the `read-only` badge remains discoverable.
 */
import { Composer } from "@/components/Composer";

export function ComposerPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-pane-frame="composer"
			data-read-only={readOnly ? "true" : "false"}
		>
			<div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
				<div className="meta">Composer</div>
				{readOnly ? (
					<div className="ml-auto font-mono text-2xs text-ink-3">read-only</div>
				) : null}
			</div>
			<div className="min-h-0 flex-1" {...(readOnly ? { inert: "" } : {})}>
				<Composer />
			</div>
		</div>
	);
}