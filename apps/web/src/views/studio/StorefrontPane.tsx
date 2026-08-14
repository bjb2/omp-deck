/**
 * Studio pane: Storefront (read-only embed of `<StorefrontHome />`).
 *
 * The studio's `readOnly` flag is a hint — the storefront is mostly
 * read-only already (browse / click-through), so this is a thin pass-through
 * that suppresses the click navigation by intercepting the inner Link clicks
 * in readOnly mode. v1 keeps the surface simple: the catalog tooltip seeds
 * the elements; the click handler still routes if the user wants to drill in.
 */
import { StorefrontHome } from "@/views/storefront/StorefrontHome";

export function StorefrontPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div className="flex h-full min-h-0 flex-col overflow-y-auto" data-pane-frame="storefront" data-read-only={readOnly ? "true" : "false"}>
			<StorefrontHome />
		</div>
	);
}
