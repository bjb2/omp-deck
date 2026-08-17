/**
 * Studio pane: Tasks (read-only embed of `<TasksView />`).
 *
 * In `readOnly` mode the pane sets the native HTML `inert` attribute on
 * the view's wrapper — this disables pointer, focus, keyboard, and AT
 * interaction across the whole subtree so users cannot trigger edits
 * (the "New task" button, modal column editor, drag-to-reorder) without
 * modifying TasksView.tsx. The studio focuses on observability not
 * editing; the outer wrapper keeps `data-read-only="true"` for any CSS
 * consumer.
 */
import { TasksView } from "@/views/TasksView";

export function TasksPane({ readOnly = true }: { readOnly?: boolean }): JSX.Element {
	return (
		<div
			className="flex h-full min-h-0 flex-col"
			data-pane-frame="tasks"
			data-read-only={readOnly ? "true" : "false"}
		>
			<div className="min-h-0 flex-1" {...(readOnly ? { inert: "" } : {})}>
				<TasksView />
			</div>
		</div>
	);
}