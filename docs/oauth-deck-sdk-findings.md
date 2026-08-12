# OAuth-from-the-deck — SDK findings

Source-verified against `@oh-my-pi/pi-ai@15.1.7`. Read before writing route
code; the task brief's `OAuthLoginCallbacks`-based design is partially wrong
and needs the corrections below.

## TL;DR

- The brief's assumption "drive login via `OAuthLoginCallbacks`" is _close but
  not quite_. The canonical entry point is **`AuthStorage.login(providerId, ctrl)`**
  on the `AuthStorage` instance the deck already gets from
  `discoverAuthStorage()`. It dispatches to the right per-provider login
  function, **and persists the credential on success**. The deck does not need
  to write `auth.db` itself.
- `OAuthLoginCallbacks` is an exported type alias but no SDK code consumes it.
  The real parameter type on `AuthStorage.login` is an inline
  `OAuthController & { onAuth: required; onPrompt: required }`. Structurally
  identical, but match the inline shape so future SDK changes propagate via
  the call site, not a stale alias.
- Architecture option (a) from the brief is correct: **the SDK runs its own
  short-lived loopback listener** on a hard-coded port per provider
  (54545 for Anthropic `/callback`, 1455 for Codex `/auth/callback`). The
  deck server never receives the OAuth provider callback itself — it only
  shows the consent URL and awaits the SDK promise. No `/api/auth/oauth/callback`
  route is needed on the deck.
- Mobile / Tailscale / **self-hosted** fallback already exists in the SDK:
  `onManualCodeInput` races the loopback listener. The deck modal wires a
  "paste redirect URL or code" textbox to it. On a remote deck the listener is
  on the wrong machine and can never win that race, so the modal promotes the
  paste box from a collapsed disclosure to the primary control.

## Exact callback shape

The deck constructs **one** controller object per flow and passes it to
`authStorage.login(providerId, ctrl)`:

```ts
type DeckOAuthController = {
  // Required. Fires once when the consent URL is ready.
  // Push to client as WS frame: { type: "auth_consent", flowId, url, instructions? }.
  onAuth: (info: { url: string; instructions?: string }) => void;

  // Required. Some providers (github-copilot, openai-codex enterprise paths)
  // ask interactive questions mid-flow — e.g. enterprise URL.
  // Surface as a modal text input. Resolve with the user's answer.
  onPrompt: (prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }) => Promise<string>;

  // Optional. Status strings ("Waiting for browser authentication...",
  // "Exchanging authorization code for tokens...").
  // Push as WS frame: { type: "auth_progress", flowId, message }.
  onProgress?: (message: string) => void;

  // Optional but STRONGLY recommended. Races against the loopback listener.
  // The user pastes the redirect URL or raw `code` value into a textbox in
  // the modal; resolves with that string. Required for the Tailscale/mobile
  // path where the phone browser cannot reach the deck host's 54545/1455 port.
  // Implementation: a deferred Promise the deck server resolves when the
  // client POSTs a "manual code" message over WS.
  onManualCodeInput?: () => Promise<string>;

  // Optional. Wire to the per-flow AbortController on the deck server so
  // POST /api/auth/oauth/<provider>/cancel aborts the SDK flow cleanly.
  signal?: AbortSignal;
};
```

Notes from the source:

- `AuthStorage.login` returns `Promise<void>`. Resolves after token exchange
  and persistence. Rejects with the SDK's error on failure (auth-failed,
  state-mismatch, timeout). 5-minute timeout is hard-coded in
  `OAuthCallbackFlow#waitForCallback` (`DEFAULT_TIMEOUT = 300_000`).
- For providers that resolve to an **API key string** (alibaba-coding-plan,
  huggingface, opencode-zen/go, …), `AuthStorage.login` saves them as
  `{type:"api_key", key}`; for Anthropic/Codex/Gemini/Cursor/etc. it saves
  the full `{type:"oauth", refresh, access, expires, accountId?, email?}`.
  The Providers UI should treat these uniformly — the resulting "auth
  state" lookup is just `AuthStorage.getAll()[provider]?.type`.
- `onPrompt` is invoked synchronously in the SDK's `await` chain — return a
  Promise the deck resolves when the client answers. Don't return synchronously.

## Redirect URI / callback port constraints

| Provider     | Port   | Path             | Hard-coded? | Notes                          |
|--------------|--------|------------------|-------------|--------------------------------|
| anthropic    | 54545  | `/callback`      | yes (via constructor) | OAuthCallbackFlow falls back to a random port if 54545 is busy, but Anthropic's authorize endpoint requires exact redirect_uri match against what's registered. In practice 54545 must be free. |
| openai-codex | 1455   | `/auth/callback` | yes         | Same fallback semantics; OpenAI's app registration likewise pins the URI. |

The deck server runs on 8787/8788; **no port conflict** with the SDK's
short-lived listeners. Concrete implications:

1. **Serialize per-provider flows on the deck server.** Two concurrent
   `start` calls for the same provider would have the second SDK flow collide
   on `Bun.serve({port: 54545, reusePort: false})`. Keep a `Map<providerId,
   ActiveFlow>` on the deck server; `POST /start` 409s if one is already in
   flight for that provider.
2. **Detect the "omp CLI is already logging in" case.** Same port collision.
   The SDK throws; surface the error to the user as "Port 54545 in use —
   close any running `omp /login` and retry."
3. **No deck-side *redirect target*.** The provider will never be told to
   redirect to the deck: `AnthropicOAuthFlow` / `OpenAICodexFlow` call
   `super(ctrl, CALLBACK_PORT, CALLBACK_PATH)` with a bare port number, so the
   redirect URI is always `http://localhost:<port>/callback`, and the
   provider's app registration pins the same value.

   Note the SDK base class *does* accept an `OAuthCallbackFlowOptions` with
   `redirectUri` / `callbackHostname` ("Exact redirect URI advertised to the
   provider; disables port fallback"). It is unused by the Anthropic and Codex
   flows, so it does not help those two — but the earlier claim here that no
   such override exists at all is wrong, and a provider that opts into the
   options form could be pointed at the deck.

4. **There is nevertheless a `GET /callback` route on the deck** — added for
   self-hosting, and it is a *landing* route rather than a redirect target. On
   a remote deck the provider's redirect dies on the user's own
   `localhost:54545`, but the authorization code is sitting in that browser's
   address bar. Editing the host of that dead URL to the deck's own origin
   (`https://deck.example.com/oauth/callback?code=…&state=…`) reaches this
   route, which feeds the URL into the same `onManualCodeInput` deferred the
   paste box uses. `parseCallbackInput` extracts the code and the SDK verifies
   `state`, so the route does no security reasoning of its own.

## Driving the flow — sketch

```ts
// apps/server/src/routes-auth-oauth.ts
const flows = new Map<string, { signal: AbortController; promise: Promise<void> }>();

app.post("/api/auth/oauth/:provider/start", async (c) => {
  const provider = c.req.param("provider");
  if (flows.has(provider)) return c.json({ error: "already-in-flight" }, 409);

  const ac = new AbortController();
  const flowId = randomUUID();
  const consentReady = Promise.withResolvers<{ url: string; instructions?: string }>();
  const manualPending = Promise.withResolvers<string>();

  const auth = await getDeckAuthStorage(); // memoized discoverAuthStorage()
  const promise = auth.login(provider, {
    onAuth: (info) => { consentReady.resolve(info); broadcast(flowId, "consent", info); },
    onPrompt: (p) => awaitClientPrompt(flowId, p),
    onProgress: (m) => broadcast(flowId, "progress", { message: m }),
    onManualCodeInput: () => manualPending.promise,
    signal: ac.signal,
  })
    .then(() => broadcast(flowId, "ok", {}))
    .catch((e) => broadcast(flowId, "error", { message: String(e?.message ?? e) }))
    .finally(() => {
      flows.delete(provider);
      broadcastModelsChanged(); // model picker refresh
    });

  flows.set(provider, { signal: ac, promise });
  const consent = await consentReady.promise; // blocks until SDK fires onAuth
  return c.json({ flowId, ...consent });
});
```

The `Promise.withResolvers` pattern is the bridge between the SDK's push-style
controller and the deck's pull-style HTTP/WS interface.

## Settings → Providers state lookup

```ts
const data = authStorage.getAll(); // Record<provider, AuthCredentialEntry>
const providers = getOAuthProviders(); // OAuthProviderInfo[] from SDK

const rows = providers
  .filter(p => p.available)
  .map(p => {
    const entry = data[p.id];
    const first = Array.isArray(entry) ? entry[0] : entry;
    return {
      id: p.id,
      name: p.name,
      state:
        !first ? "unconfigured" :
        first.type === "oauth" ? "oauth" :
        "api-key",
      // Multi-credential is uncommon for the providers we care about (Claude,
      // Codex), but if the SDK has multiple stored, surface the count so the
      // user knows to manage them.
      count: Array.isArray(entry) ? entry.length : entry ? 1 : 0,
    };
  });
```

Revoke = `await authStorage.remove(providerId)` (also aliased as
`authStorage.logout(providerId)` which is a one-liner delegating to `remove`).
Confirmed at `auth-storage.ts:1099` and `:1494`. Internally calls
`store.deleteAuthCredentialsForProvider(provider, "deleted by user")` plus
`#resetProviderAssignments(provider)` — wipes both the SQLite row and the
session-stickiness state.

## Wrinkles answered from the brief

> Does the SDK's Claude Code OAuth listener support a custom port?

No. Hard-coded 54545 via `AnthropicOAuthFlow`'s `super(ctrl, CALLBACK_PORT, CALLBACK_PATH)`.
The base class accepts an `OAuthCallbackFlowOptions.redirectUri` for a custom
URI, but Anthropic does not pass it. Same for Codex (1455). The CLI works
today because 54545/1455 are free on a fresh machine.

> Does the SDK fire callbacks SYNCHRONOUSLY?

Mixed but safe. `onAuth`/`onProgress` are sync push (just resolve a deferred
on the deck side); `onPrompt`/`onManualCodeInput` are async (return a
Promise the deck resolves when the client answers). The whole `login()` is
a single awaitable Promise — the deck's WS broadcaster fires
`auth_changed` in the `.then()` and `auth_failed` in `.catch()`.

> Exact `OAuthLoginCallbacks` shape?

Defined in `utils/oauth/types.ts` as `OAuthController` with `onAuth` and
`onPrompt` made required. **But the SDK never references the alias**; the
inline shape on `AuthStorage.login` is what binds. Use the shape above and
ignore the alias.

## Answers — pre-implementation follow-ups

1. **Revoke API.** `authStorage.remove(provider): Promise<void>` (canonical)
   or `authStorage.logout(provider)` (alias). Both wipe SQLite + in-memory
   session bindings. No reload needed.

2. **Model picker invalidation — no `refresh()` needed for static-catalog
   providers** (Anthropic, Codex, all built-in subscriptions). Proof:
   - `ModelRegistry.hasConfiguredAuth(model)` and `getApiKey()` are **live**
     reads against `this.authStorage.hasAuth(provider)` — see
     `model-registry.ts:1963` and `:1995`. No cache layer.
   - `AuthStorage.hasAuth(provider)` reads the in-memory `#data` Map
     populated by `set()` inside `login()` — see `auth-storage.ts:1123`.
   - The deck's existing `/api/models` calls `registry.getAll().map(model =>
     modelInfoFromSdk(model, registry, current))`; `isAvailable` is computed
     via `registry.hasConfiguredAuth(model)` per row
     (`bridge/in-process.ts:634`). So **the very next `GET /api/models` after
     `auth.login()` resolves returns the new availability** — broadcast a
     `models_changed` WS frame after a successful flow and let the client
     re-fetch. Zero registry rebuild, zero deck restart.
   - **Belt-and-suspenders for dynamic-discovery providers** (Ollama Cloud,
     OpenAI direct-key model enumeration, etc.): after a successful
     `auth.login`, fire-and-forget
     `registry.refreshProvider(provider, "online").catch(noop)`. For
     Anthropic/Codex (v0.2 scope) this is a no-op — their model catalogs
     are static built-ins — but the call is cheap and future-proofs other
     providers added to the UI later.

3. **`AuthStorage.getAll()` shape** — confirmed: returns
   `Record<provider, AuthCredential | AuthCredential[]>`. The Providers
   row builder must `Array.isArray(entry) ? entry[0] : entry` to read the
   primary credential, and `Array.isArray(entry) ? entry.length : entry ? 1 : 0`
   for the count badge. The earlier sketch already handles this — flagged
   so reviewers don't miss it.

No remaining blockers for route design.
