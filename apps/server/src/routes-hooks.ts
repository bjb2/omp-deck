/**
 * Webhook receiver for V1 routine triggers. Mounted at `/hooks/*` on the
 * main router. Looks up the routine by path slug, verifies the presented
 * secret against the stored sha256 hash, and fires the routine.
 *
 * Security note (V1 local-only): the deck has no user auth and runs loopback-
 * only. Webhook secret verification is sha256-hash-compare via timing-safe
 * comparison; sufficient for V1's threat model. Managed hosting (Layer 2)
 * upgrades to argon2id + per-request body HMAC.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { Hono } from "hono";

import { getWebhookSecretByPath, insertAbortedRun, touchWebhookSecret } from "./db/routine-step-runs.ts";
import { logger } from "./log.ts";
import type { RoutinesRunner } from "./routines-runner.ts";

const log = logger("routes:hooks");

const SIG_HEADER = "x-routine-signature";

// SECURITY-021: the abort table persisted every header on signature failure
// — including Cookie/Authorization. Anyone reading the SQLite db (a backup,
// the disk) recovered the requester's session cookies. Allow-list only what
// is useful for triage; redact anything that smells like a credential.
const HOOK_LOG_HEADERS: Record<string, true> = {
	"x-routine-signature": true,
	"content-type": true,
	"x-forwarded-for": true,
	"user-agent": true,
};
const HOOK_LOG_HEADER_REDACT: Record<string, true> = {
	cookie: true,
	authorization: true,
	"x-api-key": true,
};

function pickRedactedHeaders(all: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(all)) {
		const lower = name.toLowerCase();
		if (HOOK_LOG_HEADER_REDACT[lower] === true) {
			out[name] = "[redacted]";
			continue;
		}
		if (lower.includes("token") || lower.includes("secret")) {
			out[name] = "[redacted]";
			continue;
		}
		if (HOOK_LOG_HEADERS[lower] === true) {
			out[name] = value;
		}
	}
	return out;
}

export function buildHooksRouter(runner: RoutinesRunner): Hono {
	const app = new Hono();

	app.all("/hooks/*", async (c) => {
		const path = c.req.path; // e.g. /hooks/inbox-triager-manual
		const record = getWebhookSecretByPath(path);
		if (!record) {
			return c.json({ error: "hook not registered" }, 404);
		}

		const presented = c.req.header(SIG_HEADER) ?? "";
		if (!verifySecret(presented, record.secret_hash)) {
			insertAbortedRun({
				routineId: record.routine_id,
				triggerKind: "webhook",
				triggerPayload: JSON.stringify({ path, headers: pickRedactedHeaders(c.req.header()) }).slice(
					0,
					8 * 1024,
				),
				abortReason: "signature_invalid",
				error: `bad ${SIG_HEADER} on ${path}`,
			});
			return c.json({ error: "signature invalid" }, 401);
		}

		// Parse body as JSON when possible; otherwise pass through as raw string.
		let payload: Record<string, unknown> = {};
		const ct = c.req.header("content-type") ?? "";
		try {
			if (ct.includes("application/json")) {
				const json = await c.req.json();
				payload = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : { body: json };
			} else {
				const text = await c.req.text();
				payload = { body: text };
			}
		} catch {
			payload = { body: "<unparsable>" };
		}

		touchWebhookSecret(record.routine_id);
		// Fire async; webhook returns 202 immediately.
		void runner.fire(record.routine_id, "webhook", payload).catch((err) => {
			log.warn(`webhook fire failed for ${record.routine_id}`, err);
		});
		return c.json({ ok: true, accepted: true }, 202);
	});

	return app;
}

function verifySecret(presented: string, storedHash: string): boolean {
	if (!presented) return false;
	const presentedHash = createHash("sha256").update(presented).digest("hex");
	if (presentedHash.length !== storedHash.length) return false;
	try {
		return timingSafeEqual(Buffer.from(presentedHash, "hex"), Buffer.from(storedHash, "hex"));
	} catch {
		return false;
	}
}

export function hashSecretForStorage(plain: string): string {
	return createHash("sha256").update(plain).digest("hex");
}
