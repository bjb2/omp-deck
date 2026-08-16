/**
 * Internal routine-runner bearer-token mint + verify.
 *
 * The `http` step type can call the deck's own REST API (e.g. /api/tasks) from
 * inside a routine without a user session. We mint an HMAC-SHA256 token per
 * run, inject it as an Authorization header on outgoing localhost requests,
 * and validate it on the receiving side via middleware. The secret is a stable
 * server-side env var; tokens carry the runId so a leak of run A's token
 * doesn't authenticate as run B.
 *
 * Threat model: this isn't user-facing auth. It's an internal bypass so the
 * routine runner (which runs in-process with the rest of the server) can hit
 * its own API without round-tripping a session cookie. The middleware checks
 * BOTH the HMAC AND the runId being present + plausible.
 *
 * SECURITY-028: the secret is held in a module-scoped variable, never written
 * to process.env. The previous implementation set process.env[ENV_KEY] which
 * leaked the secret into every spawn (shell, run step, git, bridge).
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ENV_KEY = "DECK_INTERNAL_RUNNER_SECRET";
const HEADER_TOKEN = "X-Routine-Internal-Auth";
const HEADER_RUN_ID = "X-Routine-Run-Id";

let cachedSecret: string | null = null;

function getSecret(): string {
	if (cachedSecret) return cachedSecret;
	const existing = process.env[ENV_KEY];
	if (existing && existing.length >= 32) {
		cachedSecret = existing;
		return existing;
	}
	// First-boot: mint and stash in-process (module-scoped only — never
	// process.env). Persisting across restarts is nice-to-have but not
	// required — in-flight runs die on restart anyway.
	cachedSecret = randomBytes(32).toString("hex");
	return cachedSecret;
}

/** Compute the token bound to a specific runId. */
export function mintInternalToken(runId: string): string {
	return createHmac("sha256", getSecret()).update(runId).digest("hex");
}

/** Check whether the request headers contain a valid internal token for the claimed runId. */
export function verifyInternalToken(req: Request): { ok: true; runId: string } | { ok: false; reason: string } {
	const runId = req.headers.get(HEADER_RUN_ID);
	const presented = req.headers.get(HEADER_TOKEN);
	if (!runId || !presented) return { ok: false, reason: "missing headers" };
	const expected = mintInternalToken(runId);
	const a = Buffer.from(presented, "hex");
	const b = Buffer.from(expected, "hex");
	if (a.length !== b.length) return { ok: false, reason: "length mismatch" };
	if (!timingSafeEqual(a, b)) return { ok: false, reason: "hmac mismatch" };
	return { ok: true, runId };
}

export const INTERNAL_AUTH_HEADERS = {
	token: HEADER_TOKEN,
	runId: HEADER_RUN_ID,
};
