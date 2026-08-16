import { useEffect, useState, type KeyboardEvent } from "react";
import { Check, Pencil, X } from "lucide-react";

import type { QueuedPrompt } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { useStore } from "@/lib/store";
import { RichEditor } from "@/components/RichEditor";
import { cn } from "@/lib/utils";

/**
 * Renders a prompt the user sent while the agent was mid-turn. The SDK has
 * queued it and will run it as a fresh turn once the current one finishes,
 * so the bubble carries a "queued" badge until the SDK fires the real
 * user message_start (at which point the reducer drops it). Mirrors the
 * normal user-message shape so the chat doesn't feel like a different
 * surface — the difference is just the badge and a softer ink colour.
 *
 * Edit + cancel actions target the server-assigned `id` so two queued
 * prompts with identical text remain individually controllable. Submit
 * goes over the WS as `edit_queued` / `cancel_queued`; the bridge echoes
 * a `queue_state` frame and the reducer replaces the queue wholesale —
 * no optimistic update needed.
 */
export function QueuedMessage({ msg }: { msg: QueuedPrompt }) {
	const cancelQueued = useStore((s) => s.cancelQueued);
	const editQueued = useStore((s) => s.editQueued);

	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(msg.text);

	// Keep the draft in sync with server-driven text changes (a concurrent
	// edit from another tab, or the bridge re-aligning the text against the
	// SDK's post-expansion store) — but only while the user isn't actively
	// editing, so we don't yank their cursor.
	useEffect(() => {
		if (!editing) setDraft(msg.text);
	}, [msg.text, editing]);

	function startEdit(): void {
		setDraft(msg.text);
		setEditing(true);
		// RichEditor renders a <textarea> internally; locate it via the
		// queued-bubble attribute. Falls back to no-op if not yet mounted.
		queueMicrotask(() => {
			const ta = document.querySelector<HTMLTextAreaElement>(
				`textarea[data-queued-edit="${msg.id}"]`,
			);
			if (!ta) return;
			autoresize(ta);
			ta.focus();
			ta.setSelectionRange(ta.value.length, ta.value.length);
		});
	}

	function commit(): void {
		const next = draft.trim();
		if (next.length === 0) {
			// Empty edit means "cancel". Mirrors the bridge's refusal to accept
			// an empty edit_queued so the user sees the same answer either way.
			cancelQueued(msg.id);
			setEditing(false);
			return;
		}
		if (next === msg.text) {
			// No-op edit — just close the editor without round-tripping.
			setEditing(false);
			return;
		}
		editQueued(msg.id, next, msg.images);
		setEditing(false);
	}

	function cancelEdit(): void {
		setDraft(msg.text);
		setEditing(false);
	}

	function handleKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
		if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancelEdit();
		}
	}

	return (
		<div className={cn("group space-y-1.5", editing ? "opacity-100" : "opacity-70")}>
			<div className="meta flex items-center gap-2">
				<span>
					you
					<span className="ml-1.5 text-thinking">
						· queued{msg.behavior === "steer" ? " · steer" : ""}
					</span>
				</span>
				{!editing ? (
					<span className="ml-auto flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
						<button
							type="button"
							onClick={startEdit}
							className="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-accent/40 hover:text-accent"
							title="Edit queued prompt"
							aria-label="Edit queued prompt"
						>
							<Pencil className="h-3 w-3" />
						</button>
						<button
							type="button"
							onClick={() => cancelQueued(msg.id)}
							className="rounded border border-line bg-paper px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-ink-3 hover:border-danger/40 hover:text-danger"
							title="Cancel queued prompt"
							aria-label="Cancel queued prompt"
						>
							<X className="h-3 w-3" />
						</button>
					</span>
				) : null}
			</div>

			{msg.images && msg.images.length > 0 ? (
				<div className="flex flex-wrap gap-1.5">
					{msg.images.map((img, i) => (
						<img
							key={i}
							src={`data:${img.mimeType};base64,${img.data}`}
							alt={`queued ${i + 1}`}
							className="h-28 w-28 rounded border border-line object-cover"
						/>
					))}
				</div>
			) : null}

			{editing ? (
				<div className="space-y-1.5">
					<RichEditor
						value={draft}
						onChange={(v) => setDraft(v)}
						onKeyDown={handleKey}
						rows={1}
						data-queued-edit={msg.id}
						placeholder="Edit queued prompt (empty = cancel)"
						className={cn(
							"w-full resize-none rounded-md border border-accent/40 bg-paper-2 px-2 py-1.5",
							"text-[14px] text-ink placeholder:text-ink-4 focus:border-accent focus:outline-none",
						)}
					/>
					<div className="flex items-center gap-2 font-mono text-2xs text-ink-3">
						<button
							type="button"
							onClick={commit}
							className="inline-flex items-center gap-1 rounded border border-accent/40 bg-paper px-1.5 py-0.5 uppercase tracking-meta text-accent hover:bg-accent-soft/30"
							title="Save edit (Enter)"
						>
							<Check className="h-3 w-3" />
							save
						</button>
						<button
							type="button"
							onClick={cancelEdit}
							className="inline-flex items-center gap-1 rounded border border-line bg-paper px-1.5 py-0.5 uppercase tracking-meta text-ink-3 hover:text-ink"
							title="Discard edit (Esc)"
						>
							<X className="h-3 w-3" />
							discard
						</button>
						<span className="ml-auto">enter save · esc discard · shift+enter newline</span>
					</div>
				</div>
			) : msg.text ? (
				<Markdown>{msg.text}</Markdown>
			) : (
				<span className="font-mono text-2xs text-ink-3">(empty prompt)</span>
			)}
		</div>
	);
}

function autoresize(ta: HTMLTextAreaElement): void {
	ta.style.height = "auto";
	ta.style.height = `${Math.min(280, ta.scrollHeight)}px`;
}
