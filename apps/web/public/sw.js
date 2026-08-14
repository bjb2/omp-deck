/**
 * omp-deck service worker.
 *
 * Cache strategy (must match the architect's §6 Offline Support table):
 *
 *  - `/` and `/index.html`           network-first, fall back to last good
 *  - `/assets/*` (vite-hashed)       cache-first, immutable
 *  - `/icon.svg`, `/apple-touch-*`   cache-first
 *  - `/manifest.webmanifest`         network-first, fall back to cached
 *  - `/api/*` GET                    stale-while-revalidate
 *  - `/api/*` POST/PATCH/DELETE      network only
 *  - `/api/auth/*`, `/api/settings/*` network only
 *  - `/ws`, `wss://`                 never intercepted
 *  - everything else                 default `fetch(event.request)`
 *
 * Online behavior is unchanged. The `push` and `notificationclick` handlers
 * are preserved verbatim — they are the foreground-tab relay that the
 * WebPush channel in `apps/web/src/lib/pwa.ts` depends on.
 */
const SW_VERSION = "v2";
const SHELL_CACHE = `omp-deck-shell-${SW_VERSION}`;
const STATIC_CACHE = `omp-deck-static-${SW_VERSION}`;
const API_CACHE = `omp-deck-api-${SW_VERSION}`;
const MANIFEST_CACHE = `omp-deck-manifest-${SW_VERSION}`;

const SHELL_URLS = [
	"/",
	"/index.html",
	"/manifest.webmanifest",
	"/icon.svg",
	"/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
	event.waitUntil((async () => {
		const cache = await caches.open(SHELL_CACHE);
		await cache.addAll(SHELL_URLS).catch(() => {
			// addAll rejects as a unit if any URL fails. SW install should
			// not brick the app because one icon is missing — install later
			// on first use.
		});
		await self.skipWaiting();
	})());
});

self.addEventListener("activate", (event) => {
	event.waitUntil((async () => {
		const names = await caches.keys();
		await Promise.all(
			names
				.filter((n) => !n.endsWith(SW_VERSION))
				.map((n) => caches.delete(n)),
		);
		await self.clients.claim();
	})());
});

function isApiAuthOrSettings(url) {
	return url.pathname.startsWith("/api/auth/") || url.pathname.startsWith("/api/settings/");
}

function isApiMutation(req) {
	return req.method === "POST" || req.method === "PATCH" || req.method === "PUT" || req.method === "DELETE";
}

function isHtmlRequest(url, req) {
	if (url.pathname === "/" || url.pathname.endsWith("/index.html")) return true;
	if (url.pathname.endsWith(".html")) return true;
	const accept = req.headers.get("accept") || "";
	return accept.includes("text/html") && !url.pathname.startsWith("/api/");
}

function isStaticAsset(url) {
	return url.pathname.startsWith("/assets/");
}

function isIcon(url) {
	return /\.(svg|png|ico|webp)$/.test(url.pathname);
}

function isManifest(url) {
	return url.pathname.endsWith("/manifest.webmanifest");
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET" && !isApiMutation(req)) {
		// Non-GET, non-mutation: pass through unchanged.
		event.respondWith(fetch(req));
		return;
	}

	const url = new URL(req.url);

	// WS / WSS — never intercept. The reconnect discipline in
	// apps/web/src/lib/ws.ts handles offline.
	if (url.protocol === "ws:" || url.protocol === "wss:") {
		return; // browser default behaviour
	}

	// API writes: network only.
	if (url.pathname.startsWith("/api/") && isApiMutation(req)) {
		event.respondWith(fetch(req));
		return;
	}

	// Auth / settings: network only.
	if (isApiAuthOrSettings(url)) {
		event.respondWith(fetch(req));
		return;
	}

	// HTML / shell: network-first, fall back to cached.
	if (isHtmlRequest(url, req)) {
		event.respondWith((async () => {
			try {
				const resp = await fetch(req);
				if (resp.ok) {
					const cache = await caches.open(SHELL_CACHE);
					cache.put(req, resp.clone()).catch(() => {});
				}
				return resp;
			} catch {
				const cached = await caches.match(req);
				if (cached) return cached;
				const fallback = await caches.match("/index.html");
				if (fallback) return fallback;
				return new Response("offline", { status: 503 });
			}
		})());
		return;
	}

	// API reads: stale-while-revalidate.
	if (url.pathname.startsWith("/api/")) {
		event.respondWith((async () => {
			const cache = await caches.open(API_CACHE);
			const cached = await cache.match(req);
			const fetchPromise = fetch(req)
				.then(async (resp) => {
					if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
					return resp;
				})
				.catch(() => cached ?? new Response("offline", { status: 503 }));
			return cached ?? fetchPromise;
		})());
		return;
	}

	// Static assets (vite-hashed /assets/*): cache-first, immutable.
	if (isStaticAsset(url) || isIcon(url)) {
		event.respondWith((async () => {
			const cache = await caches.open(STATIC_CACHE);
			const cached = await cache.match(req);
			if (cached) return cached;
			const resp = await fetch(req);
			if (resp.ok) cache.put(req, resp.clone()).catch(() => {});
			return resp;
		})());
		return;
	}

	// Manifest: network-first, fall back to cached.
	if (isManifest(url)) {
		event.respondWith((async () => {
			try {
				const resp = await fetch(req);
				if (resp.ok) {
					const cache = await caches.open(MANIFEST_CACHE);
					cache.put(req, resp.clone()).catch(() => {});
				}
				return resp;
			} catch {
				const cached = await caches.match(req);
				return cached ?? new Response("offline", { status: 503 });
			}
		})());
		return;
	}

	// Default: passthrough.
	event.respondWith(fetch(req));
});

self.addEventListener("push", (event) => {
	let payload = { title: "omp-deck", body: "" };
	try {
		if (event.data) payload = { ...payload, ...event.data.json() };
	} catch {
		if (event.data) payload.body = event.data.text();
	}

	const options = {
		body: payload.body || "",
		icon: "/apple-touch-icon.png",
		badge: "/apple-touch-icon.png",
		tag: payload.tag || "omp-deck",
		renotify: true,
		data: { actionUrl: payload.actionUrl || "/" },
	};

	event.waitUntil(self.registration.showNotification(payload.title || "omp-deck", options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const targetUrl = event.notification.data && event.notification.data.actionUrl ? event.notification.data.actionUrl : "/";

	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			for (const client of clientList) {
				if ("focus" in client) {
					client.postMessage({ type: "notification-click", url: targetUrl });
					return client.focus();
				}
			}
			return self.clients.openWindow(targetUrl);
		}),
	);
});
