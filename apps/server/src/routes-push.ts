/**
 * Web Push REST surface: hand out the VAPID public key so the browser can
 * create a subscription, then store/remove/test it.
 */
import { Hono } from "hono";

import { getVapidKeys, removeSubscription, saveSubscription, sendToAll, subscriptionCount } from "./push-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-push");

export function buildPushRouter(): Hono {
	const app = new Hono();

	app.get("/push/vapid-public-key", (c) => c.json({ publicKey: getVapidKeys().publicKey }));

	app.post("/push/subscribe", async (c) => {
		let body: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.endpoint || !body.keys?.p256dh || !body.keys.auth) {
			return c.json({ error: "endpoint and keys.{p256dh,auth} are required" }, 400);
		}
		saveSubscription(
			{ endpoint: body.endpoint, keys: { p256dh: body.keys.p256dh, auth: body.keys.auth } },
			c.req.header("user-agent"),
		);
		log.info("push subscription saved");
		return c.json({ ok: true });
	});

	app.post("/push/unsubscribe", async (c) => {
		let body: { endpoint?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.endpoint) return c.json({ error: "endpoint is required" }, 400);
		removeSubscription(body.endpoint);
		return c.json({ ok: true });
	});

	/** Send a real push to every subscription — the "did this actually work?" button in Settings. */
	app.post("/push/test", async (c) => {
		if (subscriptionCount() === 0) {
			return c.json({ error: "no-subscriptions", message: "No push subscriptions registered yet." }, 400);
		}
		const result = await sendToAll({
			title: "omp-deck",
			body: "Push notifications are working.",
			tag: "test",
		});
		return c.json(result);
	});

	return app;
}
