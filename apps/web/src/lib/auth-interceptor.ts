/**
 * Global 401 detection.
 *
 * The deck's API calls are spread across thirteen `lib/*-api.ts` helpers plus a
 * handful of direct `fetch("/api/...")` call sites. Threading a shared client
 * through all of them would work, but it fails open: the one helper somebody
 * forgets to convert becomes a request whose 401 silently renders as an empty
 * list or a stuck spinner instead of a login prompt.
 *
 * Wrapping `fetch` once fails closed instead. Every same-origin `/api` response
 * passes through here no matter who issued it, so a session that expires
 * mid-use surfaces as the login screen rather than as a UI that quietly stops
 * updating.
 *
 * Authentication itself needs nothing from this file — the session cookie is
 * HttpOnly and same-origin, so the browser attaches it on its own. This only
 * observes.
 */

type UnauthorizedListener = () => void;

const listeners = new Set<UnauthorizedListener>();
let installed = false;

/** Subscribe to "the server just told us we're not signed in". */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify(): void {
	for (const listener of listeners) {
		try {
			listener();
		} catch {
			/* a broken listener must not break the request that triggered it */
		}
	}
}

/** Resolve a fetch input to a pathname, for same-origin requests only. */
function pathnameOf(input: RequestInfo | URL): string | null {
	try {
		const raw = input instanceof Request ? input.url : input.toString();
		const url = new URL(raw, window.location.origin);
		if (url.origin !== window.location.origin) return null;
		return url.pathname;
	} catch {
		return null;
	}
}

export function installAuthInterceptor(): void {
	if (installed) return;
	installed = true;

	const original = window.fetch.bind(window);
	window.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const res = await original(input, init);
		if (res.status !== 401) return res;

		const pathname = pathnameOf(input);
		if (!pathname?.startsWith("/api/")) return res;
		// The auth endpoints answer 401 as normal business logic — a wrong
		// password, or a `/session` probe for a signed-out visitor. Treating those
		// as "you were signed out" would fight the login form it's rendering.
		if (pathname.startsWith("/api/auth/login") || pathname.startsWith("/api/auth/session")) return res;


		notify();

		return res;
	}) as typeof fetch;
}
