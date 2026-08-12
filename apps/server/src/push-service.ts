/**
 * Web Push: the delivery path that reaches the deck when it isn't open in a
 * foreground tab. `notifications/channels/browser.ts` broadcasts over the
 * live WebSocket, which is exactly zero use to a phone with the app closed —
 * the case the mobile PWA install exists to serve. This module is the other
 * half.
 *
 * VAPID keys identify this deck instance to push services (Chrome's,
 * Mozilla's, etc.) without a third-party push provider or API key — the
 * `web-push` library's own asymmetric keypair is the whole auth story.
 * Generated once on first use and persisted in the deck data directory;
 * regenerating them would silently invalidate every existing subscription
 * (the browser ties a subscription to the public key it was created with),
 * so this reads-then-generates exactly like the API token in
 * `auth/bootstrap.ts` does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import webpush from "web-push";

import { getDb } from "./db/index.ts";
import { getDataDir } from "./env-store.ts";
import { getPublicUrl } from "./deck-urls.ts";
import { logger } from "./log.ts";

const log = logger("push-service");

const VAPID_FILE = "vapid-keys.json";

interface VapidKeyPair {
	publicKey: string;
	privateKey: string;
}

let cachedKeys: VapidKeyPair | undefined;
let configured = false;

function keysPath(): string {
	return path.join(getDataDir(), VAPID_FILE);
}

/**
 * Load persisted VAPID keys, or generate and persist a new pair. Idempotent
 * across restarts — the file is the source of truth once it exists.
 */
export function getVapidKeys(): VapidKeyPair {
	if (cachedKeys) return cachedKeys;

	const file = keysPath();
	try {
		const raw = fs.readFileSync(file, "utf8");
		cachedKeys = JSON.parse(raw) as VapidKeyPair;
		return cachedKeys;
	} catch {
		/* not written yet — generate below */
	}

	const generated = webpush.generateVAPIDKeys();
	cachedKeys = generated;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(generated), { mode: 0o600 });
		log.info(`generated VAPID keypair at ${file}`);
	} catch (err) {
		log.warn(`could not persist VAPID keys to ${file}; they will regenerate on restart: ${String(err)}`);
	}
	return generated;
}

/**
 * Point `web-push` at this deck's keys. Idempotent; safe to call from every
 * route handler that needs it — the underlying library call is cheap and
 * has no observable side effect beyond setting module-global config.
 */
function ensureConfigured(): void {
	if (configured) return;
	const keys = getVapidKeys();
	// web-push requires a contact URI (mailto: or https:) in the VAPID
	// "subject" claim so a push service operator has somewhere to reach the
	// sender about abuse. The deck's own public URL is the closest thing to
	// that available; falling back to a placeholder mailto keeps push
	// working (some push services don't enforce the subject) even before
	// OMP_DECK_PUBLIC_URL is configured.
	const subject = getPublicUrl() ?? "mailto:omp-deck@localhost";
	webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
	configured = true;
}

export interface PushSubscriptionInput {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

export function saveSubscription(sub: PushSubscriptionInput, userAgent?: string): void {
	const now = new Date().toISOString();
	getDb()
		.query(
			`INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at)
			 VALUES ($id, $endpoint, $p256dh, $auth, $ua, $now, $now)
			 ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
				user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at`,
		)
		.run({
			id: crypto.randomUUID(),
			endpoint: sub.endpoint,
			p256dh: sub.keys.p256dh,
			auth: sub.keys.auth,
			ua: userAgent ?? null,
			now,
		});
}

export function removeSubscription(endpoint: string): void {
	getDb().query("DELETE FROM push_subscriptions WHERE endpoint = $e").run({ e: endpoint });
}

interface SubscriptionRow {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export function listSubscriptions(): SubscriptionRow[] {
	return getDb().query("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as SubscriptionRow[];
}

export function subscriptionCount(): number {
	const row = getDb().query("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number };
	return row.n;
}

export interface PushPayload {
	title: string;
	body?: string;
	actionUrl?: string;
	tag?: string;
}

/**
 * Send to every subscription, best-effort and concurrent. A 404/410 from the
 * push service means that subscription is dead (uninstalled, permission
 * revoked, browser data cleared) — those are pruned automatically so the
 * table doesn't accumulate ghosts that fail forever.
 */
export async function sendToAll(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
	ensureConfigured();
	const subs = listSubscriptions();
	let sent = 0;
	let pruned = 0;
	await Promise.all(
		subs.map(async (sub) => {
			try {
				await webpush.sendNotification(
					{ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
					JSON.stringify(payload),
				);
				sent++;
			} catch (err) {
				const statusCode = (err as { statusCode?: number }).statusCode;
				if (statusCode === 404 || statusCode === 410) {
					removeSubscription(sub.endpoint);
					pruned++;
				} else {
					log.debug(`push to ${sub.endpoint.slice(0, 40)}… failed: ${String(err)}`);
				}
			}
		}),
	);
	return { sent, pruned };
}
