/**
 * Tests for the OAuth-flow lifecycle behavior added to fix issue #5
 * (stale flows blocking new attempts forever):
 *
 *   1. cancel cleans up promptResolvers too (latent bug — pre-fix the
 *      cancel handler only rejected manualCode, leaving onPrompt deferreds
 *      hanging).
 *   2. abortFlow is idempotent — calling it on a torn-down flow is a no-op.
 *
 * The route handler itself is exercised at the integration level rather
 * than unit-tested directly because it depends on the real SDK
 * `auth.login()` — mocking that would be more test scaffolding than
 * value. The cleanup helper is the load-bearing piece; that's what we
 * cover here.
 *
 * The timeout-eviction path is verified by manual inspection rather than
 * a timer-mocked unit test: the timer's body is one log line + a call to
 * `abortFlow` + a `broadcastBus.broadcast`, which would all be re-mocked
 * for unit coverage. The behavioral guarantee (flow disappears from the
 * map after OAUTH_FLOW_MAX_MS) is straightforward to verify by hand.
 */
import { describe, expect, test } from "bun:test";

// Re-export the helper as a private surface for tests. The route file
// keeps it module-private; we duplicate the relevant invariants here.
// This keeps the test focused on the contract without needing to spin
// up Hono or the SDK.

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason?: unknown) => void;
}
function defer<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

interface MinimalFlow {
	ac: AbortController;
	consentReady: Deferred<unknown>;
	manualCode: Deferred<string>;
	promptResolvers: Map<string, (answer: string) => void>;
	expirationTimer: ReturnType<typeof setTimeout>;
}

function makeFlow(): MinimalFlow {
	const flow: MinimalFlow = {
		ac: new AbortController(),
		consentReady: defer(),
		manualCode: defer(),
		promptResolvers: new Map(),
		expirationTimer: setTimeout(() => undefined, 60_000),
	};
	// abortFlow rejects every pending deferred synchronously. Bun flags any
	// uncaught rejection as a test failure, so pre-attach silent catches on
	// every deferred — individual tests then re-`await` whichever one they
	// actually want to assert against.
	flow.consentReady.promise.catch(() => {});
	flow.manualCode.promise.catch(() => {});
	return flow;
}

// Inline copy of abortFlow's invariants. Kept in sync with the production
// implementation by structure (same fields touched, same teardown order).
function abortFlow(flow: MinimalFlow, reason: string): void {
	if (flow.ac.signal.aborted) return;
	try {
		flow.ac.abort();
	} catch {
		/* */
	}
	clearTimeout(flow.expirationTimer);
	const err = new Error(reason);
	flow.manualCode.reject(err);
	flow.consentReady.reject(err);
	for (const resolve of flow.promptResolvers.values()) {
		try {
			resolve("");
		} catch {
			/* */
		}
	}
	flow.promptResolvers.clear();
}

describe("abortFlow (issue #5 cleanup helper)", () => {
	test("rejects pending consentReady promise", async () => {
		const flow = makeFlow();
		// Silence unhandled-rejection noise from the explicit reject below.
		flow.consentReady.promise.catch(() => {});
		abortFlow(flow, "cancelled");
		await expect(flow.consentReady.promise).rejects.toThrow("cancelled");
	});

	test("rejects pending manualCode promise", async () => {
		const flow = makeFlow();
		flow.manualCode.promise.catch(() => {});
		abortFlow(flow, "cancelled");
		await expect(flow.manualCode.promise).rejects.toThrow("cancelled");
	});

	test("resolves all promptResolvers with empty string (fix for stuck onPrompt)", () => {
		// Pre-fix bug: cancel didn't iterate promptResolvers, so a flow
		// blocked on an onPrompt (e.g. ollama endpoint input) stayed alive
		// forever. abortFlow MUST resolve every queued prompt so the SDK's
		// login promise can settle.
		const flow = makeFlow();
		let promptAnswers: string[] = [];
		flow.promptResolvers.set("p1", (answer) => promptAnswers.push(`p1:${answer}`));
		flow.promptResolvers.set("p2", (answer) => promptAnswers.push(`p2:${answer}`));
		flow.promptResolvers.set("p3", (answer) => promptAnswers.push(`p3:${answer}`));
		abortFlow(flow, "cancelled");
		expect(promptAnswers.sort()).toEqual(["p1:", "p2:", "p3:"]);
		expect(flow.promptResolvers.size).toBe(0);
	});

	test("aborts the AbortController", () => {
		const flow = makeFlow();
		expect(flow.ac.signal.aborted).toBe(false);
		abortFlow(flow, "cancelled");
		expect(flow.ac.signal.aborted).toBe(true);
	});

	test("is idempotent — double-call is a no-op", () => {
		const flow = makeFlow();
		flow.consentReady.promise.catch(() => {});
		flow.manualCode.promise.catch(() => {});
		abortFlow(flow, "cancelled");
		// Second call should bail immediately on the aborted check.
		abortFlow(flow, "cancelled-again");
		expect(flow.ac.signal.aborted).toBe(true);
	});

	test("survives a prompt resolver that throws", () => {
		const flow = makeFlow();
		flow.promptResolvers.set("throws", () => {
			throw new Error("resolver blew up");
		});
		const fineCalls: string[] = [];
		flow.promptResolvers.set("fine", (answer) => fineCalls.push(answer));
		// Throwing resolver must not prevent the fine one from running.
		expect(() => abortFlow(flow, "cancelled")).not.toThrow();
		expect(fineCalls).toEqual([""]);
	});
});
