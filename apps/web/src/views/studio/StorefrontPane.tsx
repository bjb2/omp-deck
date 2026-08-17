/**
 * Studio pane: Storefront (read-only embed of `<StorefrontHome />`).
 *
 * `readOnly` suppresses the install/upgrade actions: click handlers are
 * intercepted at the capture phase and the user gets a toast pointing them
 * at the live `/storefront` surface. Navigation (`Link` clicks) is left
 * intact so a read-only embed still browses.
 */
import { StorefrontHome } from "@/views/storefront/StorefrontHome";
import { useStore } from "@/lib/store";

export function StorefrontPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div
			className="flex h-full min-h-0 flex-col overflow-y-auto"
			data-pane-frame="storefront"
			data-read-only={readOnly ? "true" : "false"}
			onClickCapture={readOnly ? readOnlyClickCapture : undefined}
		>
			<StorefrontHome />
		</div>
	);
}

/**
 * Capture-phase click interceptor: any `<button>` or anchor inside a
 * `<form>` action attribute gets swallowed and surfaces a toast. We
 * deliberately do NOT block plain `<a>` nav — the read-only embed can
 * still browse by link.
 */
function readOnlyClickCapture(e: React.MouseEvent<HTMLDivElement>): void {
	const target = e.target as HTMLElement | null;
	if (!target) return;
	if (target.closest("button")) {
		e.preventDefault();
		e.stopPropagation();
		const id = `storefront-readonly-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
		useStore.setState((s) => ({
			notifications: [
				...s.notifications,
				{
					id,
					level: "info",
					title: "Read-only mode",
					body: "Install actions are disabled here — open the Storefront tab to manage plugins.",
					timestamp: new Date().toISOString(),
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				},
			],
		}));
}
}
