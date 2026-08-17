/**
 * Decides whether to render the deck or the sign-in screen.
 *
 * Wraps the entire app rather than sitting inside the router, because the
 * expensive side effects happen outside routing: `store.bootstrap()` opens the
 * WebSocket and fetches sessions and workspaces. Gating at the router would let
 * all of that fire — and fail with 401s — behind the login form.
 *
 * The server is the only authority here. This component asks `/api/auth/status`
 * and renders what it's told; there is no client-side "am I logged in" flag to
 * fall out of sync, and a session that expires mid-use is caught by the global
 * 401 interceptor, which flips this back to the login screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { LoginView } from "@/views/LoginView";
import { type AuthStatus, deckAuthApi } from "@/lib/deck-auth-api";
import { installAuthInterceptor, onUnauthorized } from "@/lib/auth-interceptor";

interface Props {
	children: React.ReactNode;
}

type GateState =
	| { phase: "checking" }
	| { phase: "ready"; status: AuthStatus }
	| { phase: "error"; message: string; attempt: number };

/** Backoff schedule for a failed status probe, in ms. Caps rather than grows forever. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

export function AuthGate({ children }: Props): JSX.Element {
	const [state, setState] = useState<GateState>({ phase: "checking" });
	const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const attemptRef = useRef(0);

	const clearRetry = useCallback(() => {
		if (retryTimer.current !== null) {
			clearTimeout(retryTimer.current);
			retryTimer.current = null;
		}
	}, []);

	/**
	 * Probe the server for auth state.
	 *
	 * A failure here means the server is unreachable, not that the user is signed
	 * out, so it must not fall through to a login form that cannot succeed. But
	 * it must not become a dead end either: this gate sits in front of the whole
	 * app, so one dropped request at boot would otherwise strand the user on an
	 * error screen until they thought to reload. Failures retry on a backoff, and
	 * the screen offers a manual retry for anyone who doesn't want to wait.
	 */
	const check = useCallback(async () => {
		clearRetry();
		try {
			const status = await deckAuthApi.status();
			attemptRef.current = 0;
			setState({ phase: "ready", status });
		} catch (err) {
			const attempt = attemptRef.current + 1;
			attemptRef.current = attempt;
			setState({
				phase: "error",
				message: err instanceof Error ? err.message : "Could not reach the deck server.",
				attempt,
			});
			const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]!;
			retryTimer.current = setTimeout(() => {
				void check();
			}, delay);
		}
	}, [clearRetry]);

	useEffect(() => {
		installAuthInterceptor();
		void check();
		return clearRetry;
	}, [check, clearRetry]);

	useEffect(
		() =>
			onUnauthorized(() => {
				// Re-probe rather than assuming: the 401 might be a genuine sign-out,
				// or a race against a just-completed login in another tab.
				void check();
			}),
		[check],
	);

	if (state.phase === "checking") {
		return (
			<div className="flex min-h-screen items-center justify-center bg-paper">
				<div className="font-mono text-2xs text-ink-3">Loading …</div>
			</div>
		);
	}

	if (state.phase === "error") {
		return (
			<div className="flex min-h-screen items-center justify-center bg-paper px-4">
				<div className="flex max-w-sm flex-col items-center text-center">
					<p className="text-sm text-ink">Can't reach the deck server.</p>
					<p className="mt-1 font-mono text-2xs text-ink-3">{state.message}</p>
					<p className="mt-1 font-mono text-2xs text-ink-4">
						Retrying automatically — attempt {state.attempt}.
					</p>
					<Button variant="outline" className="mt-3" onClick={() => void check()}>
						Try again
					</Button>
				</div>
			</div>
		);
	}

	const { status } = state;
	if (status.authRequired && !status.authenticated) {
		return <LoginView status={status} onAuthenticated={check} />;
	}

	return <>{children}</>;
}
