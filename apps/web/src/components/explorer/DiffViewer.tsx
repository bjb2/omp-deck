/**
 * Unified-diff renderer. Reads the patch text straight from `git diff`
 * output rather than diffing content client-side — the server already ran
 * git's own diff algorithm, so re-deriving it in the browser would be both
 * slower and a second source of truth that could disagree with what a
 * commit actually contains.
 */
import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface Props {
	patch: string;
	binary: boolean;
}

type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

interface DiffLine {
	kind: DiffLineKind;
	text: string;
	/** Line numbers in the old/new file, when known — blank for hunk/meta lines. */
	oldNo: number | null;
	newNo: number | null;
}

function parsePatch(patch: string): DiffLine[] {
	const lines: DiffLine[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (const raw of patch.split("\n")) {
		if (raw.startsWith("@@")) {
			const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
			if (m) {
				oldNo = Number(m[1]);
				newNo = Number(m[2]);
			}
			lines.push({ kind: "hunk", text: raw, oldNo: null, newNo: null });
		} else if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("---") || raw.startsWith("+++")) {
			lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
		} else if (raw.startsWith("+")) {
			lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo: newNo++ });
		} else if (raw.startsWith("-")) {
			lines.push({ kind: "remove", text: raw.slice(1), oldNo: oldNo++, newNo: null });
		} else if (raw.startsWith("\\")) {
			// "\ No newline at end of file" — cosmetic, still worth a row.
			lines.push({ kind: "meta", text: raw, oldNo: null, newNo: null });
		} else {
			lines.push({ kind: "context", text: raw.replace(/^ /, ""), oldNo: oldNo++, newNo: newNo++ });
		}
	}
	return lines;
}

const KIND_ROW_CLASS: Record<DiffLineKind, string> = {
	add: "bg-success/10",
	remove: "bg-danger/10",
	context: "",
	hunk: "bg-accent-soft/40 text-accent",
	meta: "text-ink-4",
};

const KIND_MARKER: Record<DiffLineKind, string> = {
	add: "+",
	remove: "−",
	context: " ",
	hunk: "",
	meta: "",
};

export function DiffViewer({ patch, binary }: Props): JSX.Element {
	const lines = useMemo(() => parsePatch(patch), [patch]);

	if (binary) {
		return (
			<div className="flex h-full items-center justify-center p-8 text-center">
				<div>
					<p className="text-sm text-ink-2">Binary file — no text diff to show.</p>
				</div>
			</div>
		);
	}

	if (lines.every((l) => l.kind === "meta")) {
		return (
			<div className="flex h-full items-center justify-center p-8 text-center">
				<p className="text-sm text-ink-3">No changes.</p>
			</div>
		);
	}

	return (
		<div className="h-full min-h-0 overflow-auto bg-paper-code font-mono text-xs leading-5">
			<table className="w-full border-collapse">
				<tbody>
					{lines.map((line, i) => (
						<tr key={i} className={cn(KIND_ROW_CLASS[line.kind], "align-top")}>
							<td className="w-10 select-none border-r border-line/60 px-2 text-right text-ink-4 tabular-nums">
								{line.oldNo ?? ""}
							</td>
							<td className="w-10 select-none border-r border-line/60 px-2 text-right text-ink-4 tabular-nums">
								{line.newNo ?? ""}
							</td>
							<td className="w-4 select-none pl-1 text-ink-4">
								{line.kind === "add" ? (
									<span className="text-success">{KIND_MARKER.add}</span>
								) : line.kind === "remove" ? (
									<span className="text-danger">{KIND_MARKER.remove}</span>
								) : (
									KIND_MARKER[line.kind]
								)}
							</td>
							<td className="whitespace-pre px-2 py-0">{line.text || " "}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
