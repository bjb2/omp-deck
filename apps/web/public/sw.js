/**
 * omp-deck service worker.
 *
 * Deliberately does NOT cache the app shell. This is an actively-developed
 * app served from one origin; a caching SW risks serving yesterday's JS
 * against today's API after a deploy, which is a worse failure mode than
 * "the PWA needs network to load" — and it always has network, it's a web
 * app. The only jobs here are the two things a foreground tab structurally
 * cannot do: receive push events, and satisfy the browser's installability
 * requirement (Chrome/Android requires a registered SW with a fetch handler,
 * even a no-op one, before it will offer "Add to Home Screen").
 */

self.addEventListener("install", (event) => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

// Pure passthrough — required for installability, changes nothing about how
// requests are served.
self.addEventListener("fetch", (event) => {
	event.respondWith(fetch(event.request));
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
		// Renotify when a new push reuses the same tag (e.g. repeated turn-end
		// pings) so the user sees each one rather than a silently-replaced toast.
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
				// Reuse an already-open tab rather than stacking a new one — focus
				// it and hand it the deep link to navigate to.
				if ("focus" in client) {
					client.postMessage({ type: "notification-click", url: targetUrl });
					return client.focus();
				}
			}
			return self.clients.openWindow(targetUrl);
		}),
	);
});
