/**
 * OAuth login modal. Subscribes to the deck's WS event stream for the
 * lifetime of one flow and drives the user through:
 *
 *   awaiting-consent → consent-ready → (progress…|prompt?) → complete | failed
 *
 * The "Paste redirect URL or code" textbox is ALWAYS visible (collapsed by
 * default) because the SDK races `onManualCodeInput` against the loopback
 * listener. Mobile / Tailscale users can never reach the deck host's
 * 54545/1455 ports, so manual paste is the only path that works for them —
 * see docs/oauth-deck-sdk-findings.md.
 */
import { useEffect, useMemo, useState } from "react";
import type { ServerFrame } from "@omp-deck/protocol";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { authApi } from "@/lib/auth-api";
import { useStore } from "@/lib/store";

interface Props {
	open: boolean;
	provider: string | null;
	providerName: string | null;
	onClose: () => void;
	onComplete: () => void;
}

type Phase = "starting" | "consent" | "progress" | "prompting" | "complete" | "error";

interface PendingPrompt {
	promptId: string;
	message: string;
	placeholder?: string;
}

export function OAuthFlowModal({ open, provider, providerName, onClose, onComplete }: Props) {
	const ws = useStore((s) => s.ws);
	const [phase, setPhase] = useState<Phase>("starting");
	const [flowId, setFlowId] = useState<string | null>(null);
	const [consentUrl, setConsentUrl] = useState<string | null>(null);
	const [instructions, setInstructions] = useState<string | null>(null);
	const [progress, setProgress] = useState<string>("");
	const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
	const [promptAnswer, setPromptAnswer] = useState("");
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [manualCode, setManualCode] = useState("");
	const [submittingManual, setSubmittingManual] = useState(false);
	const [showManual, setShowManual] = useState(false);

	const title = useMemo(() => `Sign in to ${providerName ?? provider ?? "provider"}`, [providerName, provider]);

	// Kick off the flow when the modal opens.
	useEffect(() => {
		if (!open || !provider) return;
		let cancelled = false;
		setPhase("starting");
		setFlowId(null);
		setConsentUrl(null);
		setInstructions(null);
		setProgress("");
		setPrompt(null);
		setPromptAnswer("");
		setErrorMessage(null);
		setManualCode("");
		setShowManual(false);
		setSubmittingManual(false);

		void authApi
			.startOAuth(provider)
			.then((resp) => {
				if (cancelled) return;
				setFlowId(resp.flowId);
				setConsentUrl(resp.url);
				if (resp.instructions) setInstructions(resp.instructions);
				setPhase("consent");
			})
			.catch((err) => {
				if (cancelled) return;
				setErrorMessage(err instanceof Error ? err.message : String(err));
				setPhase("error");
			});
		return () => {
			cancelled = true;
		};
	}, [open, provider]);

	// Subscribe to WS frames for THIS flow.
	useEffect(() => {
		if (!open || !ws || !flowId) return;
		const unsub = ws.subscribe((frame: ServerFrame) => {
			if (!("flowId" in frame) || frame.flowId !== flowId) return;
			switch (frame.type) {
				case "oauth_consent":
					setConsentUrl(frame.url);
					if (frame.instructions) setInstructions(frame.instructions);
					setPhase("consent");
					return;
				case "oauth_progress":
					setProgress(frame.message);
					setPhase((p) => (p === "complete" || p === "error" ? p : "progress"));
					return;
				case "oauth_prompt":
					setPrompt({
						promptId: frame.promptId,
						message: frame.message,
						...(frame.placeholder ? { placeholder: frame.placeholder } : {}),
					});
					setPhase("prompting");
					return;
				case "oauth_complete":
					setPhase("complete");
					// Brief success state, then close.
					setTimeout(() => onComplete(), 1200);
					return;
				case "oauth_failed":
					setErrorMessage(frame.message);
					setPhase("error");
					return;
			}
		});
		return unsub;
	}, [open, ws, flowId, onComplete]);

	function closeAndCancel(): void {
		if (provider && flowId && phase !== "complete" && phase !== "error") {
			void authApi.cancelOAuth(provider).catch(() => {});
		}
		onClose();
	}

	async function submitManual(): Promise<void> {
		if (!flowId || !manualCode.trim()) return;
		setSubmittingManual(true);
		try {
			await authApi.submitManualCode(flowId, manualCode.trim());
			setManualCode("");
			setProgress("Exchanging authorization code…");
			setPhase("progress");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
			setPhase("error");
		} finally {
			setSubmittingManual(false);
		}
	}

	async function submitPrompt(): Promise<void> {
		if (!flowId || !prompt) return;
		try {
			await authApi.replyPrompt(flowId, prompt.promptId, promptAnswer);
			setPrompt(null);
			setPromptAnswer("");
			setPhase("progress");
		} catch (err) {
			setErrorMessage(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}

	return (
		<Modal open={open} onClose={closeAndCancel} widthClass="max-w-xl">
			<div className="flex flex-col gap-4 p-5">
				<div>
					<h2 className="text-lg font-semibold text-ink">{title}</h2>
					<p className="mt-1 text-xs text-ink-3">
						The deck talks to the omp SDK; the SDK opens a local callback listener and the
						provider's consent flow redirects to it. Credentials never leave this machine.
					</p>
				</div>

				{phase === "starting" ? (
					<div className="font-mono text-2xs text-ink-3">Preparing consent URL…</div>
				) : null}

				{phase === "consent" && consentUrl ? (
					<div className="flex flex-col gap-2">
						<a href={consentUrl} target="_blank" rel="noopener noreferrer">
							<Button variant="primary" className="w-full">Open consent screen in new tab</Button>
						</a>
						{instructions ? <p className="text-xs text-ink-3">{instructions}</p> : null}
						<p className="text-2xs text-ink-4">
							After approving in the provider's flow, the SDK's local listener picks up the
							redirect automatically. You can close this modal once the card flips to "signed in."
						</p>
					</div>
				) : null}

				{phase === "progress" ? (
					<div className="font-mono text-2xs text-ink-3">{progress || "Working…"}</div>
				) : null}

				{phase === "prompting" && prompt ? (
					<div className="flex flex-col gap-2">
						<label className="text-xs text-ink">{prompt.message}</label>
						<input
							type="text"
							value={promptAnswer}
							onChange={(e) => setPromptAnswer(e.target.value)}
							placeholder={prompt.placeholder ?? ""}
							className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-2xs"
							autoFocus
						/>
						<Button onClick={submitPrompt}>Submit</Button>
					</div>
				) : null}

				{phase === "complete" ? (
					<div className="text-sm text-success">✓ Signed in. Closing…</div>
				) : null}

				{phase === "error" && errorMessage ? (
					<div className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger">
						{errorMessage}
					</div>
				) : null}

				{/* Manual paste fallback — always available while a flow is live. The
				    SDK races onManualCodeInput against its loopback listener, so this is
				    the path that works for Tailscale/mobile users who can't reach
				    127.0.0.1:54545 / :1455 from their browser. */}
				{phase !== "complete" && phase !== "error" && flowId ? (
					<details
						open={showManual}
						onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}
					>
						<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
							Can't open the link? Paste the redirect URL or code
						</summary>
						<div className="mt-2 flex flex-col gap-2">
							<p className="text-2xs text-ink-3">
								For mobile or remote-deck users: complete the consent in any browser, then
								copy the full <code>http://localhost:.../callback?code=…&state=…</code> URL
								from your browser bar and paste it here.
							</p>
							<input
								type="text"
								value={manualCode}
								onChange={(e) => setManualCode(e.target.value)}
								placeholder="Paste redirect URL or raw code"
								className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-2xs"
							/>
							<Button onClick={submitManual} disabled={!manualCode.trim() || submittingManual}>
								{submittingManual ? "Submitting…" : "Submit code"}
							</Button>
						</div>
					</details>
				) : null}

				<div className="flex justify-end gap-2 border-t border-line pt-3">
					<Button variant="ghost" onClick={closeAndCancel}>
						{phase === "complete" || phase === "error" ? "Close" : "Cancel"}
					</Button>
				</div>
			</div>
		</Modal>
	);
}
