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
import { useCallback, useEffect, useState } from "react";

import { LoginView } from "@/views/LoginView";
import { type AuthStatus, deckAuthApi } from "@/lib/deck-auth-api";
import { installAuthInterceptor, onUnauthorized } from "@/lib/auth-interceptor";

interface Props {
	children: React.ReactNode;
}

type GateState = { phase: "checking" } | { phase: "ready"; status: AuthStatus } | { phase: "error"; message: string };

export function AuthGate({ children }: Props): JSX.Element {
	const [state, setState] = useState<GateState>({ phase: "checking" });

	const check = useCallback(async () => {
		try {
			const status = await deckAuthApi.status();
			setState({ phase: "ready", status });
		} catch (err) {
			// A failed status probe means the server is unreachable, not that the
			// user is signed out — say so rather than showing a login form that
			// cannot possibly succeed.
			setState({
				phase: "error",
				message: err instanceof Error ? err.message : "Could not reach the deck server.",
			});
		}
	}, []);

	useEffect(() => {
		installAuthInterceptor();
		void check();
	}, [check]);

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
				<div className="max-w-sm text-center">
					<p className="text-sm text-ink">Can't reach the deck server.</p>
					<p className="mt-1 font-mono text-2xs text-ink-3">{state.message}</p>
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
