import { useEffect, useState } from "react";
import { Check, Loader2, Tag, Variable } from "lucide-react";

import type { Prompt } from "@omp-deck/protocol";

import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";

interface Props {
	value: Prompt;
	variables: string[];
	saving?: boolean;
	savedAt?: number;
	onChange: (patch: Partial<Prompt>) => void;
	onCommit?: () => void;
	className?: string;
}

/**
 * Prompt body editor + live preview. Title and category live in the parent
 * so this component focuses on the markdown body + variable chip readout.
 *
 * On every `value.body` change we recompute `variables` (passed in from the
 * parent which owns the source-of-truth). Saving is debounced in the parent
 * via the `onCommit` callback fired on blur / Cmd+Enter.
 */
export function PromptEditor({
	value,
	variables,
	saving,
	savedAt,
	onChange,
	onCommit,
	className,
}: Props) {
	const [tab, setTab] = useState<"edit" | "preview">("edit");
	const [title, setTitle] = useState(value.title);
	const [category, setCategory] = useState(value.category);
	const [tags, setTags] = useState((value.tags ?? []).join(", "));

	// Sync down on external updates (e.g. discovery-save import).
	useEffect(() => {
		setTitle(value.title);
		setCategory(value.category);
		setTags((value.tags ?? []).join(", "));
	}, [value.id, value.title, value.category, value.tags]);

	function commitMeta(): void {
		const nextTags = tags
			.split(",")
			.map((t) => t.trim())
			.filter((t) => t.length > 0);
		const trimmedTitle = title.trim();
		const patch: Partial<Prompt> = {
			...(trimmedTitle && trimmedTitle !== value.title ? { title: trimmedTitle } : {}),
			...(category !== value.category ? { category } : {}),
			...(tags !== (value.tags ?? []).join(", ") ? { tags: nextTags } : {}),
		};
		if (Object.keys(patch).length > 0) onChange(patch);
	}

	return (
		<div className={cn("flex h-full flex-col", className)}>
			<div className="flex items-center gap-2 border-b border-line px-3 py-2">
				<input
					className="flex-1 bg-transparent text-base font-semibold text-ink placeholder:text-ink-3 focus:outline-none"
					placeholder="Prompt title"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onBlur={commitMeta}
				/>
				<input
					className="w-32 bg-transparent text-xs text-ink-2 placeholder:text-ink-3 focus:outline-none"
					placeholder="category"
					value={category}
					onChange={(e) => setCategory(e.target.value)}
					onBlur={commitMeta}
				/>
				{saving ? (
					<span className="flex items-center gap-1 font-mono text-2xs text-ink-3">
						<Loader2 className="h-3 w-3 animate-spin" />
						saving
					</span>
				) : savedAt ? (
					<span className="flex items-center gap-1 font-mono text-2xs text-ink-3">
						<Check className="h-3 w-3 text-accent" />
						saved
					</span>
				) : null}
			</div>

			<div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-3">
				<Tag className="h-3 w-3" />
				<input
					className="flex-1 bg-transparent placeholder:text-ink-3 focus:outline-none"
					placeholder="comma-separated tags"
					value={tags}
					onChange={(e) => setTags(e.target.value)}
					onBlur={commitMeta}
				/>
				<Variable className="h-3 w-3" />
				<span className="font-mono text-2xs">
					{variables.length === 0 ? "no vars" : variables.join(", ")}
				</span>
			</div>

			<div className="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5 text-2xs uppercase tracking-meta text-ink-3">
				<button
					type="button"
					className={cn(
						"rounded px-2 py-0.5",
						tab === "edit" ? "bg-paper-3 text-ink" : "hover:text-ink-2",
					)}
					onClick={() => setTab("edit")}
				>
					edit
				</button>
				<button
					type="button"
					className={cn(
						"rounded px-2 py-0.5",
						tab === "preview" ? "bg-paper-3 text-ink" : "hover:text-ink-2",
					)}
					onClick={() => setTab("preview")}
				>
					preview
				</button>
			</div>

			<div className="min-h-0 flex-1 overflow-auto">
				{tab === "edit" ? (
					<textarea
						className="h-full w-full resize-none bg-transparent p-3 font-mono text-xs text-ink placeholder:text-ink-3 focus:outline-none"
						placeholder="Prompt body — markdown, {{variables}} get extracted"
						value={value.body}
						onChange={(e) => onChange({ body: e.target.value })}
						onKeyDown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
								e.preventDefault();
								onCommit?.();
							}
						}}
						onBlur={() => onCommit?.()}
					/>
				) : (
					<div className="p-3">
						{value.body.trim().length === 0 ? (
							<p className="text-xs text-ink-3">Nothing to preview yet.</p>
						) : (
							<Markdown>{value.body}</Markdown>
						)}
					</div>
				)}
			</div>
		</div>
	);
}