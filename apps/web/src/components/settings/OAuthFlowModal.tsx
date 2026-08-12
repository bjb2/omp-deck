/**
 * OAuth login modal. Subscribes to the deck's WS event stream for the
 * lifetime of one flow and drives the user through:
 *
 *   awaiting-consent → consent-ready → (progress…|prompt?) → complete | failed
 *
 * The shape of this modal is decided by one question: can the browser reach the
 * loopback listener the SDK opened?
 *
 * On a laptop deck it can, the redirect completes on its own, and the manual
 * paste box is a folded-away fallback. On a self-hosted deck it cannot — the
 * provider's redirect URI is pinned to `localhost:54545` by the provider's own
 * app registration, so it resolves against the *user's* machine and dies there.
 * The listener can never win that race, which makes bringing the code back by
 * hand the only route that finishes, so it is shown expanded with the reason
 * spelled out. See docs/oauth-deck-sdk-findings.md.
 */
import { useEffect, useMemo, useState } from "react";
import type { ServerFrame } from "@omp-deck/protocol";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { CopyButton } from "@/lib/CopyButton";
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
	const [publicUrl, setPublicUrl] = useState<string | null>(null);

	const title = useMemo(() => `Sign in to ${providerName ?? provider ?? "provider"}`, [providerName, provider]);

	/**
	 * Is the deck somewhere the browser's own loopback isn't?
	 *
	 * A configured public URL says so outright. Failing that, the page's own
	 * hostname is the tell: if the deck is being viewed at anything other than
	 * localhost, the SDK's listener is on a different machine than this browser.
	 */
	const isRemoteDeck = useMemo(() => {
		if (publicUrl) return true;
		const host = window.location.hostname;
		return host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1";
	}, [publicUrl]);

	/** What the user should rewrite the dead redirect URL's prefix to. */
	const callbackBase = useMemo(
		() => `${(publicUrl ?? window.location.origin).replace(/\/+$/, "")}/oauth`,
		[publicUrl],
	);

	// The providers list carries the server's configured public URL; fetch it
	// once per opened flow so the copy above can be specific instead of hedging.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void authApi
			.listProviders()
			.then((resp) => {
				if (!cancelled) setPublicUrl((resp as { publicUrl?: string | null }).publicUrl ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open]);

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
						{isRemoteDeck
							? "This deck runs on a server, so the provider's redirect lands on your own computer instead of reaching it. Approve the consent screen, then bring the code back here — the two routes below both do that. Credentials are stored on the server, never in your browser."
							: "The deck drives the omp SDK, which opens a local callback listener for the provider to redirect to. Credentials never leave this machine."}
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
						{/* The URL itself, copyable: someone approving on a different
						    device (phone, another laptop) cannot follow a link that only
						    exists as an href in this tab. */}
						<div className="flex items-start gap-2">
							<code className="min-w-0 flex-1 break-all rounded border border-line bg-paper-code px-2 py-1 text-2xs text-ink-3">
								{consentUrl}
							</code>
							<CopyButton text={consentUrl} />
						</div>
						{instructions ? <p className="text-xs text-ink-3">{instructions}</p> : null}
						{isRemoteDeck ? (
							<div className="rounded border border-line bg-paper-3 p-3 text-2xs leading-relaxed text-ink-2">
								<p className="mb-1 font-medium text-ink">After you approve, the tab will fail to load.</p>
								<p>
									That is expected: the provider sends you to{" "}
									<code>http://localhost:54545/callback?code=…</code>, which only exists on the machine
									running the deck. Your browser still has the code in its address bar. Either:
								</p>
								<ul className="mt-1 list-disc pl-4">
									<li>
										copy that whole URL and paste it below, or
									</li>
									<li>
										edit just the beginning of it to{" "}
										<code className="break-all">{callbackBase}</code> and press Enter — the deck
										finishes the sign-in itself.
									</li>
								</ul>
							</div>
						) : (
							<p className="text-2xs text-ink-4">
								After approving in the provider's flow, the SDK's local listener picks up the redirect
								automatically. You can close this modal once the card flips to "signed in."
							</p>
						)}
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

				{/* Bring the code back by hand. The SDK races onManualCodeInput
				    against its loopback listener, so this works whether or not the
				    listener ever sees the redirect.

				    On a remote deck the listener is on the wrong machine and can
				    never win that race, which makes this the only path that
				    finishes the flow — so it is shown expanded rather than folded
				    into a disclosure the user has to think to open. */}
				{phase !== "complete" && phase !== "error" && flowId ? (
					isRemoteDeck ? (
						<div className="flex flex-col gap-2 border-t border-line pt-3">
							<div className="meta">Paste the redirect URL or code</div>
							<input
								type="text"
								value={manualCode}
								onChange={(e) => setManualCode(e.target.value)}
								placeholder="http://localhost:54545/callback?code=… — or just the code"
								className="rounded border border-line bg-paper px-2 py-1.5 font-mono text-2xs"
							/>
							<Button
								variant="primary"
								onClick={submitManual}
								disabled={!manualCode.trim() || submittingManual}
							>
								{submittingManual ? "Submitting…" : "Finish sign-in"}
							</Button>
						</div>
					) : (
						<details
							open={showManual}
							onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}
						>
							<summary className="cursor-pointer font-mono text-2xs uppercase tracking-meta text-ink-3 hover:text-ink">
								Can't open the link? Paste the redirect URL or code
							</summary>
							<div className="mt-2 flex flex-col gap-2">
								<p className="text-2xs text-ink-3">
									Approving on another device (a phone, or a browser that can't reach this
									machine) leaves the code in that browser's address bar. Copy the whole
									<code> http://localhost:.../callback?code=…&state=…</code> URL and paste it
									here.
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
					)
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
