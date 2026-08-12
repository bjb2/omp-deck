/**
 * Service worker registration, install-prompt capture, and Web Push
 * subscription — the three pieces of "durable app on your phone."
 *
 * These are plain functions/hooks rather than store slices: none of this
 * state needs to be shared beyond the one or two settings components that
 * render it, and keeping it out of the global store avoids re-rendering the
 * whole app tree every time, say, the install-prompt availability flips.
 */
import { useEffect, useState } from "react";
import { pushApi } from "./push-api";

/** Register the service worker. Safe to call multiple times; no-ops if unsupported. */
export function registerServiceWorker(): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
	void navigator.serviceWorker.register("/sw.js").catch((err) => {
		// eslint-disable-next-line no-console
		console.warn("service worker registration failed:", err);
	});
}

// ─── Install prompt ─────────────────────────────────────────────────────────

/**
 * `beforeinstallprompt` fires once, early, and only on browsers that support
 * it (Chromium-family; not Safari). Capturing it globally at module scope —
 * not inside a component — is what lets a settings panel opened well after
 * the event fired still offer the "Install" button; a component-scoped
 * listener would miss it if the panel wasn't mounted yet when it fired.
 */
type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let capturedPrompt: BeforeInstallPromptEvent | null = null;
const promptListeners = new Set<() => void>();

if (typeof window !== "undefined") {
	window.addEventListener("beforeinstallprompt", (e) => {
		e.preventDefault();
		capturedPrompt = e as BeforeInstallPromptEvent;
		for (const listener of promptListeners) listener();
	});
	window.addEventListener("appinstalled", () => {
		capturedPrompt = null;
		for (const listener of promptListeners) listener();
	});
}

function isStandalone(): boolean {
	if (typeof window === "undefined") return false;
	return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
	if (typeof navigator === "undefined") return false;
	return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

export interface InstallPromptState {
	/** True once the app is already running as an installed PWA. */
	installed: boolean;
	/** True when the browser has offered an install prompt we can trigger. */
	available: boolean;
	/** iOS never fires beforeinstallprompt — Safari's Share-sheet flow is manual. */
	needsManualIosInstructions: boolean;
	promptInstall: () => Promise<"accepted" | "dismissed" | "unavailable">;
}

export function useInstallPrompt(): InstallPromptState {
	const [, forceRender] = useState(0);

	useEffect(() => {
		const listener = () => forceRender((n) => n + 1);
		promptListeners.add(listener);
		return () => {
			promptListeners.delete(listener);
		};
	}, []);

	async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
		if (!capturedPrompt) return "unavailable";
		await capturedPrompt.prompt();
		const { outcome } = await capturedPrompt.userChoice;
		capturedPrompt = null;
		return outcome;
	}

	return {
		installed: isStandalone(),
		available: capturedPrompt !== null,
		needsManualIosInstructions: isIos() && !isStandalone(),
		promptInstall,
	};
}

// ─── Push subscription ──────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64: string): BufferSource {
	const padding = "=".repeat((4 - (base64.length % 4)) % 4);
	const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(b64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes.buffer;
}

export type PushSupportState = "unsupported" | "unsubscribed" | "subscribed";

export interface PushState {
	state: PushSupportState;
	busy: boolean;
	error: string | null;
	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
	sendTest: () => Promise<string>;
}

export function usePushSubscription(): PushState {
	const [state, setState] = useState<PushSupportState>("unsupported");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) return;
		void navigator.serviceWorker.ready.then(async (reg) => {
			const existing = await reg.pushManager.getSubscription();
			setState(existing ? "subscribed" : "unsubscribed");
		});
	}, []);

	async function subscribe(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			if (Notification.permission === "default") {
				const permission = await Notification.requestPermission();
				if (permission !== "granted") throw new Error("Notification permission was not granted.");
			} else if (Notification.permission === "denied") {
				throw new Error("Notifications are blocked for this site in your browser settings.");
			}
			const reg = await navigator.serviceWorker.ready;
			const { publicKey } = await pushApi.vapidPublicKey();
			const subscription = await reg.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: urlBase64ToUint8Array(publicKey),
			});
			await pushApi.subscribe(subscription.toJSON() as PushSubscriptionJSON);
			setState("subscribed");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function unsubscribe(): Promise<void> {
		setBusy(true);
		setError(null);
		try {
			const reg = await navigator.serviceWorker.ready;
			const sub = await reg.pushManager.getSubscription();
			if (sub) {
				await pushApi.unsubscribe(sub.endpoint).catch(() => undefined);
				await sub.unsubscribe();
			}
			setState("unsubscribed");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function sendTest(): Promise<string> {
		const result = await pushApi.test();
		return `Sent to ${result.sent} device${result.sent === 1 ? "" : "s"}.`;
	}

	return { state, busy, error, subscribe, unsubscribe, sendTest };
}
