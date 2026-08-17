import { useEffect, useState } from "react";
import { Check, Pencil, X } from "lucide-react";

import { useStore } from "@/lib/store";
import type { SessionUi } from "@/lib/types";
import { Markdown } from "@/lib/markdown";
import { RichEditor } from "@/components/RichEditor";
import { cn } from "@/lib/utils";

/**
 * Inline plan-approval card (T-105 — Slice C).
 *
 * Renders when the active session has `pendingPlanApproval` set — i.e. the
 * agent submitted a plan via `resolve apply` while plan mode was active
 * and the deck bridge is awaiting the user's decision.
 *
 * Three actions:
 *   - Reject: `respondToPlanApproval({ approved: false })`. Server exits
 *     plan mode and surfaces a clear rejection to the agent. No rename.
 *   - Approve: `respondToPlanApproval({ approved: true, finalPath? })`.
 *     Server renames `local://PLAN.md` to the title-derived path and queues
 *     the synthetic execute prompt as a follow-up turn.
 *   - Edit & approve: includes `editedContent` so the bridge writes the
 *     replacement to PLAN.md before the rename.
 *
 * Optimistic-clear is handled in `store.respondToPlanApproval`; the
 * server's `plan_proposal_resolved` (or `plan_mode_changed{enabled:false}`)
 * is the canonical clearing signal. The bridge replays any still-pending
 * proposal on a fresh subscribe, so a stale optimistic clear self-heals.
 */
export function PlanApproval({ session }: { session: SessionUi }) {
	const approval = session.pendingPlanApproval;
	const respond = useStore((s) => s.respondToPlanApproval);

	const [title, setTitle] = useState<string>(approval?.suggestedTitle ?? "");
	const [editing, setEditing] = useState(false);
	const [editedContent, setEditedContent] = useState<string>(approval?.planContent ?? "");

	// Reset local state whenever a new proposal lands (proposalId is the key).
	useEffect(() => {
		if (!approval) return;
		setTitle(approval.suggestedTitle);
		setEditedContent(approval.planContent);
		setEditing(false);
	}, [approval?.proposalId, approval?.suggestedTitle, approval?.planContent]);

	// Cheap guard so the early-return below narrows for the closures.
	if (!approval) return null;
	const a = approval;
	const sessionId = session.sessionId;

	const trimmedTitle = title.trim();
	const titleChanged = trimmedTitle.length > 0 && trimmedTitle !== a.suggestedTitle;
	const finalPath = titleChanged
		? `local://${trimmedTitle.replace(/\s+/g, "-")}.md`
		: a.suggestedFinalPath;

	function reject(): void {
		respond({ sessionId, proposalId: a.proposalId, approved: false });
	}

	function approve(opts: { withEdits: boolean }): void {
		respond({
			sessionId,
			proposalId: a.proposalId,
			approved: true,
			...(titleChanged ? { finalPath } : {}),
			...(opts.withEdits && editedContent !== a.planContent ? { editedContent } : {}),
		});
	}

	return (
		<section
			aria-label="Plan ready for approval"
			className={cn(
				"rounded-lg border border-accent-plan/40 bg-accent-plan/[0.04] p-4",
				"shadow-sm",
			)}
		>
			<header className="mb-3 flex items-center gap-2">
				<span className="rounded border border-accent-plan/40 bg-accent-plan/10 px-1.5 py-0.5 font-mono text-2xs uppercase tracking-meta text-accent-plan">
					Plan ready
				</span>
				<span className="truncate font-mono text-2xs text-ink-3">→ {finalPath}</span>
			</header>

			<label className="mb-3 block">
				<span className="meta mb-1 block">Title</span>
				<input
					type="text"
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder={a.suggestedTitle}
					className={cn(
						"w-full rounded border border-line bg-paper px-2 py-1 text-[13px] text-ink",
						"placeholder:text-ink-4 focus:border-accent-plan/60 focus:outline-none",
					)}
				/>
				<span className="meta mt-1 block text-ink-4">
					Letters, numbers, hyphens, underscores. Spaces become hyphens.
				</span>
			</label>

			{editing ? (
				<RichEditor
					value={editedContent}
					onChange={(v) => setEditedContent(v)}
					rows={Math.min(24, Math.max(8, editedContent.split("\n").length + 1))}
					disableRichText={false}
					className={cn(
						"mb-3 w-full resize-y rounded border border-line bg-paper px-2 py-1.5 font-mono text-xs text-ink",
						"focus:border-accent-plan/60 focus:outline-none",
					)}
				/>
			) : (
				<div className="mb-3 max-h-[480px] overflow-y-auto rounded border border-line bg-paper p-3">
					<Markdown>{a.planContent}</Markdown>
				</div>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={reject}
					className="inline-flex items-center gap-1 rounded border border-line bg-paper px-2.5 py-1 text-xs text-ink-2 hover:border-danger/40 hover:text-danger"
					title="Reject the plan and exit plan mode"
				>
					<X className="h-3.5 w-3.5" />
					Reject
				</button>

				{editing ? (
					<>
						<button
							type="button"
							onClick={() => approve({ withEdits: true })}
							className="inline-flex items-center gap-1 rounded border border-accent-plan/60 bg-accent-plan/15 px-2.5 py-1 text-xs text-accent-plan hover:bg-accent-plan/25"
							title="Save edits, approve, and execute"
						>
							<Check className="h-3.5 w-3.5" />
							Save & approve
						</button>
						<button
							type="button"
							onClick={() => {
								setEditedContent(a.planContent);
								setEditing(false);
							}}
							className="ml-1 text-xs text-ink-3 underline-offset-2 hover:underline"
						>
							Discard edits
						</button>
					</>
				) : (
					<>
						<button
							type="button"
							onClick={() => setEditing(true)}
							className="inline-flex items-center gap-1 rounded border border-line bg-paper px-2.5 py-1 text-xs text-ink-2 hover:border-accent-plan/40 hover:text-accent-plan"
							title="Edit the plan before approving"
						>
							<Pencil className="h-3.5 w-3.5" />
							Edit
						</button>
						<button
							type="button"
							onClick={() => approve({ withEdits: false })}
							className="inline-flex items-center gap-1 rounded border border-accent-plan/60 bg-accent-plan/15 px-2.5 py-1 text-xs text-accent-plan hover:bg-accent-plan/25"
							title="Approve and execute"
						>
							<Check className="h-3.5 w-3.5" />
							Approve
						</button>
					</>
				)}
			</div>
		</section>
	);
}
