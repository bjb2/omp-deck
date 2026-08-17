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
 *   (Anthropic 54545, Codex 1455), and the provider's app registration pins the
 *   same URI, so it cannot be repointed at a domain. The deck therefore never
 *   receives the provider callback directly.
 * - `GET /callback` exists anyway, but it is a *landing* route, not a redirect
 *   target: on a self-hosted deck the provider's redirect dies on the browser's
 *   own localhost, and this route lets the user finish by editing that dead
 *   URL's host to point at the deck. It feeds the URL to the same manual-code
 *   path the modal uses.
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
import { getPublicUrl } from "./deck-urls.ts";
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

/**
 * Minimal self-contained result page for the OAuth landing route.
 *
 * Inlined rather than served from the SPA: this page is opened in a stray tab
 * that may have no session state and no reason to boot the whole app, and it
 * has exactly one job — tell the user whether it worked.
 */
function callbackPage(title: string, detail: string, ok: boolean): string {
	const escape = (s: string) =>
		s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} — omp-deck</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #fbfbfa; color: #1b1c1a;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 2rem;
  }
  @media (prefers-color-scheme: dark) { body { background: #16181a; color: #e6e8e6; } }
  main { max-width: 26rem; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 .5rem; font-weight: 600; }
  p { margin: 0; color: #5d635f; }
  @media (prefers-color-scheme: dark) { p { color: #9aa3a0; } }
  .mark { font-size: 1.6rem; line-height: 1; margin-bottom: .75rem; }
</style>
</head>
<body>
  <main>
    <div class="mark">${ok ? "✓" : "✕"}</div>
    <h1>${escape(title)}</h1>
    <p>${escape(detail)}</p>
  </main>
</body>
</html>`;
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
		// `publicUrl` lets the client tell a self-hosted deck from a laptop one.
		// The difference matters here and nowhere else: on a remote deck the
		// provider's redirect to `localhost` lands on the user's own machine and
		// dies, so the UI has to lead with the recovery path instead of burying
		// it behind a disclosure triangle.
		return c.json({ ...body, publicUrl: getPublicUrl() ?? null });
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

	/**
	 * Public landing point for a provider redirect.
	 *
	 * Anthropic and Codex pin their redirect URI to `http://localhost:<port>/callback`
	 * inside the SDK, and the provider's app registration pins it too — neither
	 * can be repointed at a domain. On a self-hosted deck that redirect lands on
	 * the *browser's* machine, where nothing is listening, so the user sees a
	 * dead page.
	 *
	 * That dead page still has the authorization code in its address bar. This
	 * route lets the user finish the flow by editing the host of that URL to
	 * point at the deck — `https://deck.example.com/oauth/callback?code=…&state=…`
	 * — turning a dead end into one edit. It hands the whole URL to the SDK's
	 * manual-code path, which parses the code and verifies `state` itself, so
	 * this route never has to reason about CSRF.
	 *
	 * Reachable as `/oauth/callback` (aliased in the server's dispatcher) and as
	 * `/api/auth/oauth/callback`. It sits behind the deck's auth gate: completing
	 * a provider sign-in is a privileged act.
	 */
	app.get("/callback", (c) => {
		const code = c.req.query("code");
		const error = c.req.query("error_description") ?? c.req.query("error");

		if (error) return c.html(callbackPage("Sign-in failed", error, false), 400);
		if (!code) {
			return c.html(
				callbackPage(
					"Nothing to complete",
					"This URL carries no authorization code. Open it exactly as your browser left it, including the ?code=… part.",
					false,
				),
				400,
			);
		}

		const live = [...flows.values()].filter((f) => f.status !== "done" && f.status !== "errored");
		if (live.length === 0) {
			return c.html(
				callbackPage(
					"No sign-in is waiting",
					"The flow already finished, was cancelled, or timed out. Start it again from Settings → Providers.",
					false,
				),
				409,
			);
		}
		if (live.length > 1) {
			return c.html(
				callbackPage(
					"More than one sign-in is in progress",
					"Cancel the ones you don't want in Settings → Providers, then reload this URL.",
					false,
				),
				409,
			);
		}

		// Hand over the full URL: parseCallbackInput extracts code and state, and
		// the SDK rejects a state mismatch on our behalf.
		live[0]!.manualCode.resolve(c.req.url);
		return c.html(
			callbackPage(
				"Signed in",
				`Finishing ${live[0]!.provider} sign-in — you can close this tab and return to the deck.`,
				true,
			),
		);
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
