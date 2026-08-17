/**
 * Studio pane: Prompts (read-only embed of `<PromptsDiscover />`).
 *
 * The discover surface has its own Layout (sidebar + main); the studio
 * embeds it whole. The `readOnly` flag is currently a no-op — discover is
 * browse-by-design. Save-to-library is left in place so users can still
 * land interesting prompts into their library from the studio.
 */
import { PromptsDiscover } from "@/views/PromptsDiscover";

export function PromptsPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div className="flex h-full min-h-0 flex-col" data-pane-frame="prompts" data-read-only={readOnly ? "true" : "false"}>
			<PromptsDiscover />
		</div>
	);
}
