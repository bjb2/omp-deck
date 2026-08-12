/**
 * Sign-in, and first-run account creation.
 *
 * One component covers both because they are the same form with a different
 * verb: on a deck that has no account yet, the first thing a person should see
 * is "choose a password", not "enter the password nobody has set".
 */
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { type AuthError, type AuthStatus, deckAuthApi } from "@/lib/deck-auth-api";

interface Props {
	status: AuthStatus;
	/** Called after a successful sign-in or setup so the shell can re-check. */
	onAuthenticated: () => void;
}

export function LoginView({ status, onAuthenticated }: Props): JSX.Element {
	const isSetup = status.needsSetup;
	const [username, setUsername] = useState(isSetup ? "admin" : "");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [setupToken, setSetupToken] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const firstFieldRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		firstFieldRef.current?.focus();
	}, []);

	async function submit(e: React.FormEvent): Promise<void> {
		e.preventDefault();
		if (busy) return;
		setError(null);

		if (isSetup && password !== confirm) {
			setError("The two passwords don't match.");
			return;
		}

		setBusy(true);
		try {
			if (isSetup) {
				await deckAuthApi.setup({
					username: username.trim(),
					password,
					...(setupToken.trim() ? { setupToken: setupToken.trim() } : {}),
				});
			} else {
				await deckAuthApi.login(username.trim(), password);
			}
			onAuthenticated();
		} catch (err) {
			setError((err as AuthError).message || "Sign-in failed.");
			setPassword("");
			setConfirm("");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-paper px-4 py-10">
			<div className="w-full max-w-sm">
				<div className="mb-6">
					<h1 className="text-lg font-medium text-ink">omp-deck</h1>
					<p className="mt-1 text-sm text-ink-3">
						{isSetup
							? "Nobody has claimed this deck yet. Create the account that will control it."
							: "Sign in to continue."}
					</p>
				</div>

				<form onSubmit={submit} className="flex flex-col gap-3">
					<label className="block">
						<div className="meta mb-1">Username</div>
						<input
							ref={firstFieldRef}
							className="field h-9 w-full px-2 text-sm"
							type="text"
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							required
						/>
					</label>

					<label className="block">
						<div className="meta mb-1">Password</div>
						<input
							className="field h-9 w-full px-2 text-sm"
							type="password"
							autoComplete={isSetup ? "new-password" : "current-password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
							minLength={isSetup ? 8 : undefined}
						/>
						{isSetup ? <p className="mt-1 text-2xs text-ink-3">At least 8 characters.</p> : null}
					</label>

					{isSetup ? (
						<label className="block">
							<div className="meta mb-1">Confirm password</div>
							<input
								className="field h-9 w-full px-2 text-sm"
								type="password"
								autoComplete="new-password"
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								required
							/>
						</label>
					) : null}

					{isSetup && status.setupTokenRequired ? (
						<label className="block">
							<div className="meta mb-1">Setup token</div>
							<input
								className="field h-9 w-full px-2 font-mono text-xs"
								type="password"
								value={setupToken}
								onChange={(e) => setSetupToken(e.target.value)}
								required
							/>
							<p className="mt-1 text-2xs text-ink-3">
								The value of <code>OMP_DECK_AUTH_SETUP_TOKEN</code> on the server.
							</p>
						</label>
					) : null}

					{error ? (
						<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
							{error}
						</div>
					) : null}

					<Button type="submit" variant="primary" disabled={busy} className="mt-1 w-full">
						{busy ? (isSetup ? "Creating account…" : "Signing in…") : isSetup ? "Create account" : "Sign in"}
					</Button>
				</form>

				{isSetup ? (
					<p className="mt-4 text-2xs leading-relaxed text-ink-3">
						This deck runs a coding agent with access to your workspace. Anyone who signs in can use it, so
						pick a password you'd use for a server — and set <code>OMP_DECK_PUBLIC_URL</code> so links it
						generates point at your domain.
					</p>
				) : null}
			</div>
		</div>
	);
}
