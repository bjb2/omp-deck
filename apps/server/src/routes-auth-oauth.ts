/**
 * OAuth login routes — drives provider sign-in from the deck UI without
 * requiring the user to run `omp /login` in a terminal first.
 *
 * Architecture (verified against the SDK in docs/oauth-deck-sdk-findings.md):
 *
 * - Canonical entry point is `AuthStorage.login(providerId, ctrl)`. The SDK
 *   dispatches per-provider internally AND persists the resulting credential
 *   via `.set()` — we do NOT call `upsertAuthCredentialForProvider` ourselves.
 * - SDK spawns its own short-lived loopback listener on hard-coded ports
 *   (Anthropic 54545, Codex 1455). The deck never receives the provider
 *   callback. No `/callback` route here.
 * - One in-flight flow per provider — port collisions on the SDK's
 *   `Bun.serve({ port, reusePort: false })` would otherwise throw.
 * - 5-minute hard timeout lives in the SDK (`DEFAULT_TIMEOUT` in
 *   `callback-server.ts`). Cancel triggers the controller's AbortSignal.
 * - On success: `models_changed` WS frame + belt-and-suspenders
 *   `registry.refreshProvider(provider, "online")` for dynamic-discovery
 *   providers (no-op for Anthropic/Codex which ship static catalogs).
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { getOAuthProviders } from "@oh-my-pi/pi-ai";
import type { OAuthProviderInfo } from "@oh-my-pi/pi-ai";
import type {
	ListProvidersResponse,
	OAuthManualCodeRequest,
	OAuthPromptReplyRequest,
	ProviderAuthState,
	ProviderInfo,
	StartOAuthResponse,
} from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import { getDeckAuthStorage, getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

/**
 * ES2023-safe deferred helper. `Promise.withResolvers` is ES2024; the deck's
 * tsconfig targets ES2023 so we roll our own. Cheap, correct, no library.
 */
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

const log = logger("oauth-routes");

/**
 * Maximum lifetime of a single OAuth flow before the deck force-cancels it.
 * Issue #5: ollama's flow uses `onPrompt` for endpoint URL — if the user
 * closes the modal without typing one, the SDK's login promise sits pending
 * forever, the flow stays in the map, and every subsequent `start` 409s
 * with "already in progress." The SDK's own DEFAULT_TIMEOUT (5 min) only
 * fires on the loopback callback listener, not on prompt-based flows.
 *
 * 5 minutes matches the SDK's loopback timeout so the deck and SDK time
 * out together for callback flows, and gives prompt flows a finite TTL.
 */
const OAUTH_FLOW_MAX_MS = 5 * 60_000;

interface ActiveFlow {
	flowId: string;
	provider: string;
	ac: AbortController;
	consentReady: Deferred<{ url: string; instructions?: string }>;
	manualCode: Deferred<string>;
	promptResolvers: Map<string, (answer: string) => void>;
	consent?: { url: string; instructions?: string };
	status: "awaiting-consent" | "consent-ready" | "exchanging" | "done" | "errored";
	error?: string;
	/** Wall-clock ms when the flow was registered. Used by the stale-flow eviction. */
	startedAt: number;
	/** Server-side max-lifetime timer; cleared on natural completion. */
	expirationTimer: ReturnType<typeof setTimeout>;
}

// One in-flight flow per provider — second `start` 409s while the first is
// alive. flowsById is the WS lookup index.
const flows = new Map<string, ActiveFlow>();
const flowsById = new Map<string, ActiveFlow>();

/**
 * Tear down a flow: cancel SDK abort, reject every pending deferred so the
 * SDK's login promise settles, remove from both maps, clear the lifetime
 * timer. Idempotent. Used by `/cancel`, by the expiration timer, and by
 * stale-flow eviction on `/start`.
 *
 * The previous cancel handler only rejected `manualCode` — left `onPrompt`
 * deferreds hanging, so cancelling an Ollama flow waiting on endpoint
 * input left the SDK promise pending and the flow effectively un-cleaned.
 */
function abortFlow(flow: ActiveFlow, reason: string): void {
	if (flow.ac.signal.aborted) return; // already torn down
	try {
		flow.ac.abort();
	} catch {
		/* abort() is well-behaved but be defensive */
	}
	clearTimeout(flow.expirationTimer);
	const err = new Error(reason);
	flow.manualCode.reject(err);
	flow.consentReady.reject(err);
	// Resolve outstanding prompt waits with an empty string — rejecting via
	// throw would surface as an uncaught error in the SDK's onPrompt caller;
	// empty answer at least lets the SDK proceed (and likely fail cleanly).
	for (const resolve of flow.promptResolvers.values()) {
		try {
			resolve("");
		} catch {
			/* swallow — best-effort cleanup */
		}
	}
	flow.promptResolvers.clear();
	flows.delete(flow.provider);
	flowsById.delete(flow.flowId);
}

function deriveAuthState(entry: unknown): { state: ProviderAuthState; count: number } {
	if (!entry) return { state: "unconfigured", count: 0 };
	const arr = Array.isArray(entry) ? entry : [entry];
	if (arr.length === 0) return { state: "unconfigured", count: 0 };
	// AuthCredentialEntry is `AuthCredential | AuthCredential[]`; the discriminator
	// on each entry is `type: "oauth" | "api_key"`. We surface the FIRST credential's
	// type — multi-credential is uncommon for the subscription providers we care
	// about; the count badge tells the user there's more if so.
	const first = arr[0] as { type?: string } | undefined;
	const state: ProviderAuthState = first?.type === "oauth" ? "oauth" : "api-key";
	return { state, count: arr.length };
}

/**
 * Translate the SDK's port-collision error into something actionable.
 * `Bun.serve({ port, reusePort: false })` throws an `EADDRINUSE` when the
 * provider's hard-coded port is already bound (typical cause: a separate
 * `omp /login` running in a terminal). The default message is opaque.
 */
function humanizeError(provider: string, raw: unknown): string {
	const msg = raw instanceof Error ? raw.message : String(raw);
	if (/EADDRINUSE/i.test(msg) || /address already in use/i.test(msg)) {
		// Provider-specific port hint — Anthropic 54545, Codex 1455.
		const port =
			provider === "anthropic" ? "54545" : provider === "openai-codex" ? "1455" : "the OAuth callback port";
		return `Port ${port} in use — close any running 'omp /login' or other OAuth flow and retry.`;
	}
	return msg;
}

export function buildAuthOAuthRouter(): Hono {
	const app = new Hono();

	app.get("/providers", async (c) => {
		const auth = await getDeckAuthStorage();
		const sdkProviders: OAuthProviderInfo[] = getOAuthProviders();
		const data = auth.getAll() as Record<string, unknown>;
		const providers: ProviderInfo[] = sdkProviders
			.filter((p) => p.available)
			.map((p) => ({
				id: String(p.id),
				name: p.name,
				...deriveAuthState(data[String(p.id)]),
			}));
		const body: ListProvidersResponse = { providers };
		return c.json(body);
	});

	app.post("/:provider/start", async (c) => {
		const provider = c.req.param("provider");
		const existing = flows.get(provider);
		if (existing) {
			// Stale-flow eviction (issue #5): if the held flow is past its max
			// lifetime, the timeout handler should already have fired, but be
			// defensive — evict it here too so a wedged flow doesn't block new
			// attempts indefinitely.
			const age = Date.now() - existing.startedAt;
			if (age > OAUTH_FLOW_MAX_MS) {
				log.warn(
					`evicting stale ${provider} OAuth flow (age=${Math.round(age / 1000)}s) before starting a new one`,
				);
				abortFlow(existing, "stale-flow-evicted");
			} else {
				return c.json(
					{
						error: "already-in-flight",
						message: `An OAuth flow for ${provider} is already in progress. Cancel it first.`,
					},
					409,
				);
			}
		}

		const auth = await getDeckAuthStorage();
		const registry = await getDeckModelRegistry();
		const flowId = randomUUID();
		// expirationTimer is filled in below — assigned to a `noop` setTimeout
		// at first so the field is non-undefined for `abortFlow`'s clearTimeout
		// in the unlikely case start() throws between map insertion and timer
		// scheduling.
		const flow: ActiveFlow = {
			flowId,
			provider,
			ac: new AbortController(),
			consentReady: defer<{ url: string; instructions?: string }>(),
			manualCode: defer<string>(),
			promptResolvers: new Map(),
			status: "awaiting-consent",
			startedAt: Date.now(),
			expirationTimer: setTimeout(() => undefined, 0),
		};
		clearTimeout(flow.expirationTimer);
		// Real lifetime timer: force-cancel if the flow hasn't naturally
		// completed within OAUTH_FLOW_MAX_MS. Catches stuck onPrompt waits
		// (issue #5: ollama endpoint prompt with closed modal).
		flow.expirationTimer = setTimeout(() => {
			log.warn(`OAuth flow for ${provider} exceeded ${OAUTH_FLOW_MAX_MS}ms; force-cancelling`);
			abortFlow(flow, "timeout");
			broadcastBus.broadcast({
				type: "oauth_failed",
				flowId,
				provider,
				message: `OAuth flow timed out after ${Math.round(OAUTH_FLOW_MAX_MS / 60_000)} minutes`,
			});
		}, OAUTH_FLOW_MAX_MS);
		// Manual-code deferred may be rejected on cancel even when the SDK never
		// awaited it (loopback won the race) — silence the unhandled rejection
		// instead of letting Bun's postmortem surface it as a spurious server error.
		flow.manualCode.promise.catch(() => {});
		flows.set(provider, flow);
		flowsById.set(flowId, flow);

		const loginPromise = auth
			.login(provider as Parameters<typeof auth.login>[0], {
				onAuth: (info) => {
					flow.consent = info;
					flow.status = "consent-ready";
					broadcastBus.broadcast({
						type: "oauth_consent",
						flowId,
						provider,
						url: info.url,
						...(info.instructions ? { instructions: info.instructions } : {}),
					});
					flow.consentReady.resolve(info);
				},
				onPrompt: async (p) => {
					const promptId = randomUUID();
					const deferred = defer<string>();
					flow.promptResolvers.set(promptId, deferred.resolve);
					broadcastBus.broadcast({
						type: "oauth_prompt",
						flowId,
						provider,
						promptId,
						message: p.message,
						...(p.placeholder ? { placeholder: p.placeholder } : {}),
					});
					return deferred.promise;
				},
				onProgress: (message) => {
					broadcastBus.broadcast({ type: "oauth_progress", flowId, provider, message });
				},
				// Mobile/Tailscale fallback — racer against the SDK's loopback listener.
				// Resolves only when the client POSTs `/manual-code`.
				onManualCodeInput: () => flow.manualCode.promise,
				signal: flow.ac.signal,
			})
			.then(
				() => {
					flow.status = "done";
					broadcastBus.broadcast({ type: "oauth_complete", flowId, provider });
					// Static providers (Anthropic/Codex) need no refresh — `hasAuth` is
					// live-read. Dynamic-discovery providers need this to enumerate.
					// Fire-and-forget; failure here doesn't block the client.
					void registry.refreshProvider(provider, "online").catch((err) => {
						log.debug(`refreshProvider(${provider}) after login failed: ${err}`);
					});
					broadcastBus.broadcast({ type: "models_changed" });
				},
				(err) => {
					flow.status = "errored";
					flow.error = humanizeError(provider, err);
					broadcastBus.broadcast({
						type: "oauth_failed",
						flowId,
						provider,
						message: flow.error,
					});
					// Reject the consentReady deferred too — otherwise the awaiting HTTP
					// response below would hang on a login that never produced a URL.
					flow.consentReady.reject(err);
				},
			)
			.finally(() => {
				clearTimeout(flow.expirationTimer);
				flows.delete(provider);
				flowsById.delete(flowId);
			});
		// Keep the unhandled-rejection inspector quiet — we attached handlers above.
		loginPromise.catch(() => {});

		try {
			const info = await flow.consentReady.promise;
			const body: StartOAuthResponse = {
				flowId,
				url: info.url,
				...(info.instructions ? { instructions: info.instructions } : {}),
			};
			return c.json(body);
		} catch (err) {
			return c.json({ error: humanizeError(provider, err) }, 500);
		}
	});

	app.post("/:provider/cancel", async (c) => {
		const provider = c.req.param("provider");
		const flow = flows.get(provider);
		if (!flow) return c.json({ ok: true, message: "no flow in progress" });
		abortFlow(flow, "cancelled");
		return c.json({ ok: true });
	});

	app.post("/manual-code/:flowId", async (c) => {
		const flowId = c.req.param("flowId");
		const flow = flowsById.get(flowId);
		if (!flow) return c.json({ error: "flow not found" }, 404);
		let body: OAuthManualCodeRequest;
		try {
			body = (await c.req.json()) as OAuthManualCodeRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.code || typeof body.code !== "string") {
			return c.json({ error: "code is required" }, 400);
		}
		flow.manualCode.resolve(body.code);
		return c.json({ ok: true });
	});

	app.post("/prompt-reply/:flowId", async (c) => {
		const flowId = c.req.param("flowId");
		const flow = flowsById.get(flowId);
		if (!flow) return c.json({ error: "flow not found" }, 404);
		let body: OAuthPromptReplyRequest;
		try {
			body = (await c.req.json()) as OAuthPromptReplyRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const resolver = flow.promptResolvers.get(body.promptId);
		if (!resolver) return c.json({ error: "prompt not found" }, 404);
		flow.promptResolvers.delete(body.promptId);
		resolver(body.answer);
		return c.json({ ok: true });
	});

	app.delete("/:provider", async (c) => {
		const provider = c.req.param("provider");
		const auth = await getDeckAuthStorage();
		try {
			await auth.remove(provider);
			broadcastBus.broadcast({ type: "models_changed" });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`revoke ${provider} failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	return app;
}
