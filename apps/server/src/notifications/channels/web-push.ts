/**
 * Web Push channel — the counterpart to `browser.ts` that reaches a closed
 * tab or a phone with the app in the background. See `push-service.ts` for
 * the VAPID/subscription machinery this wraps.
 */
import { sendToAll } from "../../push-service.ts";
import { logger } from "../../log.ts";
import type { NotificationChannel, NotificationEnvelope } from "../types.ts";

const log = logger("web-push-channel");

export class WebPushChannel implements NotificationChannel {
	readonly id = "web-push";

	async deliver(envelope: NotificationEnvelope): Promise<void> {
		try {
			await sendToAll({
				title: envelope.title,
				...(envelope.body !== undefined ? { body: envelope.body } : {}),
				...(envelope.actionUrl !== undefined ? { actionUrl: envelope.actionUrl } : {}),
				tag: envelope.id,
			});
		} catch (err) {
			// NotificationChannel contract: never throw. A push failure is
			// logged, not escalated — the browser WS channel already delivered
			// to any open tab, so this is best-effort coverage for closed ones.
			log.debug(`web-push delivery failed: ${String(err)}`);
		}
	}
}
