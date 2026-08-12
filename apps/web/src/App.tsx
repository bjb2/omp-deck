import { useEffect } from "react";
import { AppRouter } from "./router";
import { selectActiveSession, useStore } from "./lib/store";
import { useNotificationBridge } from "./lib/notifications";
import { NotificationToast } from "./components/NotificationToast";
import { NotificationPermissionBanner } from "./components/NotificationPermissionBanner";
import { AuthGate } from "./components/auth/AuthGate";

export function App() {
	return (
		<AuthGate>
			<AuthedApp />
		</AuthGate>
	);
}

/**
 * The deck proper.
 *
 * Kept separate from `App` so that none of it — least of all `bootstrap()`,
 * which opens the WebSocket and fetches sessions and workspaces — mounts until
 * the server confirms the visitor is allowed in. Rendering this behind the gate
 * rather than gating inside the router is what keeps a signed-out visitor from
 * firing a burst of requests that can only 401.
 */
function AuthedApp() {
	const bootstrap = useStore((s) => s.bootstrap);
	useNotificationBridge();
	useGlobalAbortShortcut();

	useEffect(() => {
		void bootstrap();
	}, [bootstrap]);

	return (
		<>
			<NotificationPermissionBanner />
			<AppRouter />
			<NotificationToast />
		</>
	);
}

/**
 * Window-level `Ctrl+.` (Cmd+. on macOS) → abort the active session if it's
 * mid-turn. Bound at the App level so the shortcut works from any view
 * (composer, kanban, KB) without the user having to focus the Stop button
 * the composer renders. Matches ChatGPT / VS Code's "stop generating"
 * convention so it's discoverable.
 *
 * Ignored while the user is composing text in a contenteditable surface
 * EXCEPT when the active session is actually busy — pressing it during a
 * long-running turn is exactly the case we want to support, and the
 * composer textarea is the most likely place to be when you decide to
 * stop.
 */
function useGlobalAbortShortcut(): void {
	const abort = useStore((s) => s.abort);
	const status = useStore((s) => selectActiveSession(s)?.status);
	useEffect(() => {
		function onKey(e: KeyboardEvent): void {
			const isStop = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === ".";
			if (!isStop) return;
			if (status !== "streaming" && status !== "retrying") return;
			e.preventDefault();
			abort();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [abort, status]);
}
