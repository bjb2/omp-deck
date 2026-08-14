# Generative UI + Gholam Chat Persistence + Deck LLM Registry

Six asks. One additive doc.

1. Persistent Gholam chat history (start/cancel/restart).
2. Deck LLM registry (multi-provider, MiniMax first-class).
3. The deck web becomes generative UI (Vercel AI SDK).
4. Pre-update preview ("what it would look like AFTER").
5. Concrete shape of post-update UX.
6. Vercel AI SDK as the streaming UI primitive.

Everything is additive. Existing routes, the broadcast bus, the WS hub, and the protocol `ServerFrame` union all keep working. New code lands in new files; the protocol and `routes.ts` get append-only edits.

---

## §1 Gholam chat persistence + replay + on-demand start

### Storage — append-only migration `007-gholam-chats.sql`

The deck's SQLite db (`apps/server/src/db/migrations/` numbered 001–006) is the destination. Three tables:

```sql
-- 007-gholam-chats.sql
--
-- Persistent chat history for the Gholam twin. Each `gholam_chats` row is one
-- conversation; `gholam_chat_messages` is the append-only message log.
--
-- Conventions follow the rest of the db: TEXT ids (ulid-ish from db/id()),
-- ISO-8601 TEXT timestamps, snake_case columns. Foreign keys ON DELETE
-- CASCADE so a chat delete is one statement.
--
-- kind = "user"   → user-initiated from the new GholamChat view
-- kind = "auto"   → fired by the priority queue (a priority item was the seed prompt)
-- kind = "priority" → mirror of a GholamPriority entry; kept here for traceability
--
-- state mirrors the SDK's session lifecycle plus a few deck-only values:
-- running / paused / awaiting_user / awaiting_tool / completed / failed
--
-- summary is server-generated (cheap compaction; capped 1KB).

CREATE TABLE IF NOT EXISTS gholam_chats (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('user','auto','priority')),
    cwd         TEXT NOT NULL,
    model       TEXT,
    state       TEXT NOT NULL CHECK (state IN
                    ('running','paused','awaiting_user','awaiting_tool','completed','failed')),
    summary     TEXT,
    priority_id TEXT,  -- nullable; foreign key to the gholam priorities file is soft
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    usage_json  TEXT  -- {tokens_in, tokens_out, cost_microcents}
);

CREATE INDEX IF NOT EXISTS idx_gholam_chats_updated
    ON gholam_chats(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gholam_chats_kind
    ON gholam_chats(kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gholam_chats_cwd
    ON gholam_chats(cwd, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS gholam_chat_messages (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES gholam_chats(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,        -- monotonic per chat; 1, 2, 3…
    role        TEXT NOT NULL CHECK (role IN
                    ('user','assistant','tool_call','tool_result','system','note')),
    content     TEXT NOT NULL,           -- for tool_call rows this is JSON of {tool,args}
    meta_json   TEXT,                    -- model, tool_call_id, usage, error
    created_at  TEXT NOT NULL,
    UNIQUE(chat_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_gholam_msgs_chat_seq
    ON gholam_chat_messages(chat_id, seq);
```

Migration naming follows the existing convention (`NNN-name.sql`) and is auto-applied by `apps/server/src/db/index.ts:applyMigrations` (already loops files sorted, idempotent on `schema_migrations`).

### Service — `apps/server/src/gholam-chats.ts` (new)

```ts
// API shape — what Worker D implements.
// (Read `apps/server/src/db/tasks.ts` and `apps/server/src/auth/store.ts` for
// the row → interface conventions; this module reuses `getDb()` + `id()` +
// `nowIso()` from `apps/server/src/db/index.ts`.)
export interface GholamChat { id; title; kind; cwd; model?; state; summary?; priorityId?; createdAt; updatedAt; deletedAt?; usage: ChatUsage }
export interface GholamChatMessage { id; chatId; seq; role; content; meta?; createdAt }
export interface ChatUsage { tokensIn; tokensOut; costMicrocents }
export function listChats(opts: { cursor?: string; kind?: string; cwd?: string; limit?: number }): GholamChat[]
export function getChat(id: string): GholamChat | null
export function createChat(input: { cwd; prompt; model?; permissionsRequired?: string[]; title?; kind?: 'user'|'auto'|'priority'; priorityId? }): GholamChat
export function appendMessage(chatId: string, msg: Omit<GholamChatMessage, 'id'|'chatId'|'seq'|'createdAt'>): GholamChatMessage
export function updateState(chatId: string, state: GholamChat['state'], patch?: Partial<Pick<GholamChat,'summary'|'usage'>>): void
export function listMessages(chatId: string, since?: number): GholamChatMessage[]
export function cancelChat(chatId: string): GholamChat      // state=paused, in-flight loop aborts
export function restartChat(chatId: string, newPrompt: string): GholamChat  // clones history, appends new user message
export function softDeleteChat(chatId: string): void
```

### REST surface — `apps/server/src/routes-gholam-chats.ts` (new)

All gated by `resolvePrincipal` (cookie session or api token — see `apps/server/src/auth/guard.ts:119`). WS principals with `kind === "internal"` may also call `GET /:id/messages?internal=1` for sidecar bookkeeping.

```
GET    /api/gholam/chats?cursor=<updatedAt>&kind=&cwd=&limit=50
GET    /api/gholam/chats/:id
GET    /api/gholam/chats/:id/messages?since=<seq>
POST   /api/gholam/chats              { cwd, prompt, model?, permissionsRequired?, title? }
POST   /api/gholam/chats/:id/messages { role: 'user', content }
POST   /api/gholam/chats/:id/cancel
POST   /api/gholam/chats/:id/restart  { prompt }
DELETE /api/gholam/chats/:id
```

Mount: `apps/server/src/routes.ts` line 273 area — `app.route("/gholam/chats", buildGholamChatsRouter())`. The `/api/gholam/*` control surface already exists (`apps/server/src/routes-harness.ts:293-309`); the new mounts live under a separate sub-path (`/gholam/chats`) so no overlap.

### Runtime loop — `apps/server/src/gholam-chat.ts` (new)

```ts
// Pseudocode — Worker D implements against the real DeckLLM.
import { gholamDeckLLM } from "./llm-registry.ts";
import { appendMessage, updateState } from "./gholam-chats.ts";
import { sendGholamFrame } from "./gholam.ts";   // for tool sidecar calls

export async function runGholamChat(chatId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const msgs = await buildContext(chatId);                  // summarize + last N turns
    const plan = await gholamDeckLLM.complete({ model: chat.model, messages: msgs, signal });
    if (plan.toolCalls.length === 0) {
      appendMessage(chatId, { role: "assistant", content: plan.text ?? "" });
      updateState(chatId, "awaiting_user");
      return;
    }
    for (const tc of plan.toolCalls) {
      const perm = checkGholamFramePermissions(tc.requiredPermissions ?? []);
      if (!perm.ok) {
        appendMessage(chatId, { role: "tool_result", content: JSON.stringify({ ok: false, error: `missing:${perm.missing.join(",")}` }) });
        updateState(chatId, "awaiting_user");
        return;
      }
      const reply = await callSidecar(tc);                    // mcp_call frame, await mcp_reply
      appendMessage(chatId, { role: "tool_result", content: JSON.stringify(reply) });
    }
    updateState(chatId, "running");
  }
}
```

Each loop iteration is **append-only**: every assistant text, every tool_call, every tool_result lands in `gholam_chat_messages` before the next move. Persist `usage` on each assistant message's `meta_json` so cost telemetry is queryable.

### WS — new `ServerFrame` variants (append-only)

Add to `_ServerFrameBase` in `packages/protocol/src/index.ts`:

```ts
| { type: "gholam_chat_delta"; chatId: string; message: GholamChatMessageWire }
| { type: "gholam_chat_message"; chatId: string; message: GholamChatMessageWire }
| { type: "gholam_chat_state"; chatId: string; state: GholamChat['state']; usage?: ChatUsage }
```

`GholamChatMessageWire` and `ChatUsage` are exported alongside `GholamChat` from the protocol. Broadcast path uses the existing `WsHub.broadcast()` (already throttled per-frame-type at 1s by default; `gholam_chat_message` should be added to the throttle map as unthrottled or 200ms — see implementation sequence). Add the three new variants to `BroadcastFrame` in `apps/server/src/broadcast-bus.ts:12-34` if they should fan out to non-subscribed clients too. (Recommended: yes — the chat list view updates without a per-chat subscribe.)

### Client — `subscribeGholamChat(chatId)` (new in `apps/web/src/lib/ws.ts`)

Thin wrapper over the existing `WsClient.subscribe()` — filters frames by `chatId`, calls store setters. Lives in the same file the rest of the WS reducers use (read `apps/web/src/lib/store.ts:300+` for the `handleFrame` switch).

### On-demand start

User click "New chat" → `POST /api/gholam/chats { cwd, prompt, model? }` → server `createChat()` returns the row, kicks off `runGholamChat(chatId, signal)` in the background, broadcasts `gholam_chat_state{state:"running"}`. No priority entry needed. The route `/gholam/chat/new?cwd=&prompt=` is the deep-link target.

### Replay

Opening an existing chat:
1. `GET /api/gholam/chats/:id/messages` → full history (or `since=<seq>` for delta).
2. `subscribeGholamChat(id)` — wire to live deltas.
3. Render the message thread (existing `AssistantMessage` + `UserMessage` + a new `<GholamToolCall>` per `role: 'tool_call'`/`tool_result` row).

The existing renderer in `apps/web/src/components/messages/AssistantMessage.tsx` is reused for assistant turns; for `role: 'tool_call'` rows add a thin `<GholamToolCard>` (read the existing tool-card renderer first — same `AssistantContentBlock.toolCall` shape, no new component vocabulary needed for tool surfaces).

---

## §2 Deck LLM registry — multi-provider including MiniMax

The SDK already loads `ModelRegistry` via `getDeckModelRegistry()` (`apps/server/src/bridge/in-process.ts:184`). `CustomProvidersRegistry` (`apps/server/src/custom-providers.ts:69-260`) already maps `models.yml` providers into that registry. We extend that path, not replace it.

### MiniMax is already in the tree

Confirmed by `grep` over `agent-defaults/`:

```
WATCHDOG.yml:        model: minimax-code/MiniMax-M3:low       # Product And Revenue Strategist
WATCHDOG.yml:        model: minimax-code/MiniMax-M3:medium    # Experience & Domain Advocate
config.yml:          task: minimax-code/MiniMax-M3:medium
config.yml:          default: minimax-code/MiniMax-M3:medium
config.yml:          - minimax/MiniMax-M3                     # usageAwareFallback chain
config.yml:          - minimax/MiniMax-M3                     # omni/* fallback
```

`apps/server/src/routes-harness.ts:85-109` already special-cases `provider === "minimax"` in `POST /api/auth/login`. `apps/server/src/bridge/in-process.ts:1175-1207` lists `minimax-code`, `minimax-code-cn` as `SUBSCRIPTION_PROVIDER_IDS`. The provider is wired — what we add is a typed registry surface that exposes ALL providers (not just custom) via REST.

`agent-defaults/models.yml.tmpl` does NOT currently list `minimax` (verified — only `groq, inception, codexhub, 9router, omni, open-go, gepete, ngh-claude` are listed). Two options:

a. **Add `minimax` to `models.yml.tmpl`** (one stanza) — picked up by the file watcher at boot and hot-reloaded when the user changes the entry. Matches the existing 9router/omni pattern.
b. Treat it as a **built-in** (like anthropic, cerebras) — register it in `custom-providers.ts` as a special case in `applyToRegistry`.

**Recommendation: option (a).** The `models.yml.tmpl` is the documented extension point. A single stanza:

```yaml
  minimax:
    baseUrl: https://api.minimax.io/v1
    apiKey: ${OMP_PROVIDER_MINIMAX_API_KEY}
    api: openai-completions
    authHeader: true
    discovery:
      type: openai-models-list
```

MiniMax's public API is OpenAI-compatible (HTTPS JSON streaming); no SDK call is needed. `api: openai-completions` reuses the existing dispatcher in the SDK's model registry.

### Typed registry — `apps/server/src/llm-registry.ts` (new)

```ts
// Additive; does not replace CustomProvidersRegistry — wraps it.
import { getCustomProviders } from "./custom-providers.ts";

export interface DeckLLMProvider {
  id: string;            // "minimax", "anthropic", "openai", …
  displayName: string;
  baseUrl?: string;
  api: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  models: DeckLLMModel[];
}
export interface DeckLLMModel {
  id: string;            // canonical "provider/model"
  displayName: string;
  contextWindow: number;
  pricing: { inputMicrocents: number; outputMicrocents: number };
  capabilities: { tools: boolean; vision: boolean; json: boolean; thinking?: boolean };
}
export interface DeckLLMProviderRegistry {
  list(): Promise<DeckLLMProvider[]>;
  resolve(modelRef: { provider: string; id: string }): Promise<{ provider: DeckLLMProvider; model: DeckLLMModel } | null>;
  complete(opts: { model: string; messages: LlmMessage[]; tools?: LlmToolSpec[]; signal?: AbortSignal }): AsyncIterable<LlmChunk>;
}
export function getDeckLLMRegistry(): DeckLLMProviderRegistry { … }
```

Implementation: a thin wrapper that reads the SDK `ModelRegistry` snapshot + `CustomProvidersRegistry.snapshot()` and exposes a typed view. `complete()` dispatches to the SDK's `ModelRegistry.complete()` (already in `@oh-my-pi/pi-coding-agent`); pricing comes from the model's `cost` field the SDK already exposes.

### Cost telemetry

Every `complete()` call accumulates `pricing.inputMicrocents * tokens_in + pricing.outputMicrocents * tokens_out`. Persist on the chat message's `meta_json` and broadcast on `gholam_chat_state`. UI shows in `useStore.modelUsage` — a rolling per-model-per-day map for the inspector pane.

### Model selection UX

- Top-level `useStore.modelSelection` (zustand slice, persisted to `localStorage.omp-deck:model-selection`).
- Default = first model of the user's default provider (read `useStore.userDefaultProvider` — derive from settings).
- New component `<ModelPicker />` (`apps/web/src/components/ModelPicker.tsx`) — a dropdown mounted in the composer's header (the existing `<SlashCommandPicker />` slot is a good neighborhood). Filters `capabilities.tools` if a tool-required prompt is being sent.
- Chat routes use the chat's `model` field (defaulting to `useStore.modelSelection` if unset).
- `GET /api/llm/providers` returns the typed registry snapshot.
- `POST /api/llm/test` (admin-only — `auth/guard.ts:194` returns the `admin` principal) smoke-tests a provider with a 1-token prompt; returns `{ ok, latencyMs, modelId }`.

### Cache

`~/.omp-deck/llm-registry-cache.json` — `list()` snapshot, refresh on 24h TTL or on `models_changed` WS frame. Same pattern as `discovery-cache.json` from `docs/STOREFRONT.md §2`.

---

## §3 Generative UI — "the website is generative"

### Premise

The deck's React tree is no longer a static hand-written component graph. Each route renders AI-generated React tree-frames streamed from the server as JSON. The shell is fixed (layout, status bar, navigation); the **content is generated**.

### Vercel AI SDK

- `apps/web/package.json`: add `"@ai-sdk/react": "^4.0.68"` and `"ai": "^7.0.65"` (verified via `npm view`, both Apache-2.0 — see §5). These two are the only new deps.
- `useChat` replaces the composer's text-input wiring. The composer becomes a thin shell over `useChat` with the existing `PromptSuggestions` + `SlashCommandPicker` hooked into the same input stream.
- Server-side: `genui-stream.ts` calls the LLM with a structured-output prompt; the response is a JSON stream of `<Frame>` objects.
- Client-side: `GenuiRenderer` mounts inside each route's `<ContentArea />`. A whitelist of allowed React components (so the LLM can't inject `<script>`). The whitelist lives at `apps/web/src/lib/genui/components.ts` and is **the single source of truth** — also exported to the server for the prompt context.

### Component vocabulary (white-listed types the LLM may emit)

```ts
// apps/web/src/lib/genui/components.ts
export type GenComponent =
  | { type: "GenStack"; props: { gap?: number }; children: GenNode[] }
  | { type: "GenRow"; props: { gap?: number; align?: "start" | "center" | "end" }; children: GenNode[] }
  | { type: "GenGrid"; props: { cols?: number; gap?: number }; children: GenNode[] }
  | { type: "GenText"; props: { size?: "xs" | "sm" | "md" | "lg"; tone?: "default" | "muted" | "danger" | "accent" }; content: string }
  | { type: "GenMarkdown"; content: string }
  | { type: "GenCode"; props: { lang?: string }; content: string }
  | { type: "GenImage"; props: { src: string; alt?: string } }
  | { type: "GenVideo"; props: { src: string } }
  | { type: "GenButton"; props: { label: string; action: GenAction } }
  | { type: "GenAction"; props: { kind: "mcp_call" | "gholam_command" | "navigate" | "submit_prompt"; payload: Record<string, unknown> } }
  | { type: "GenTable"; props: { headers: string[] }; rows: GenNode[][] }
  | { type: "GenKeyValue"; entries: Array<{ key: string; value: GenNode }> }
  | { type: "GenCard"; props: { title?: string }; children: GenNode[] }
  | { type: "GenTabs"; props: { default?: string }; tabs: Array<{ id: string; label: string; content: GenNode }> }
  | { type: "GenModal"; props: { title?: string; onClose: GenAction }; children: GenNode[] }
  | { type: "GenForm"; props: { submit: GenAction; fields: GenField[] } };

export type GenNode = GenComponent | string;     // string = inline text leaf
```

Renderer: `apps/web/src/lib/genui/GenuiRenderer.tsx` — `React.createElement` dispatch against the whitelist; unknown `type` → silent skip (log to console in dev, no-op in prod). Action emitters (`<GenButton>`, `<GenForm>`) call the existing `broadcastBus` dispatchers — the same wire surface we already built. **No new event channels**.

### Streaming protocol

- `GET /api/genui/stream?route=<path>` returns NDJSON via Hono `streamSSE`.
- Each line: `{ type: "frame", frame: GenComponent }` or `{ type: "done", finalHash: string }`.
- Client: `useChatThread` (new — `apps/web/src/lib/genui/useChatThread.ts`) maps the WS `mcp_call`/`gholam_command` wire to `useChat`'s tool-call interface.

### Component allowlist lock file

`~/.omp-deck/genui/components-allowlist.json` — mirrors the typescript union; version-stamped so the client and server agree. Read once on `apps/web` mount, cached. **Not user-editable** in v1; ships with the deck.

### Where each route mounts the renderer

| Route | Renderer mount | Notes |
|-------|----------------|-------|
| `/` (ChatView) | replaces `Chat` body | shell stays — `Composer` + `Sidebar` + `Inspector` |
| `/tasks` | inside `TasksView` main | list+detail shells, content cells are generated |
| `/kb` | inside `KbView` | markdown rendering via `GenMarkdown` |
| `/gholam/chat/:id` | full chat thread | the Gholam chat view IS the renderer |
| `/storefront/:section` | `DiscoveryResults` | reuses §3 from STOREFRONT |
| `/studio` | `StudioProvider` panes | reuses STUDIO's panes |

---

## §4 Pre-update preview — "what would it look like AFTER"

### Pipeline

For any route with an in-flight `gholam.edit` (file change from the sidecar), the user gets a **side-by-side preview**:

- Left: current rendered tree (the live route).
- Right: `<Preview>` mounted in the route's right rail. Same `GenuiRenderer` but seeded with the post-update file content.

### Routes

- `POST /api/preview/render` body `{ path, content, route }` — server reads the change intent, constructs an "intent" prompt for the LLM ("Given this changed file content, generate the React tree for route `/chat` that uses it"), streams the result.
- `GET /api/preview/diff?path=` — lists in-flight changes (the sidecar's `gholam.edit` invocations) so the preview knows what's coming.
- Client: `<PreviewPane />` mounted as a right-rail toggle. Three modes:
  - `current` — only current rendered tree (default).
  - `updated` — only the preview.
  - `side-by-side` — both, in a split.
  Persisted per route in `localStorage.omp-deck:genui:preview-mode:<route>`.

### Static fast path

For routes that don't need an LLM round-trip (a pure-Render-component route), the preview can be a static `<iframe>` with the new bundle path. Worker E picks one path per render call — both endpoints share the URL; the server picks `iframe` when the route is on the "no-LLM-needed" allowlist (`apps/server/src/routes-preview.ts` config block).

### Model selection

The preview's LLM call defaults to `minimax/MiniMax-M3` (cheap + fast structured JSON output; user-configurable per call). Override via `body.model` on `POST /api/preview/render`.

---

## §5 Vercel AI SDK integration

### Package adds

```diff
# apps/web/package.json
"dependencies": {
+   "@ai-sdk/react": "^4.0.68",
+   "ai": "^7.0.65",
    …
}
```

Versions verified via `npm view @ai-sdk/react version` → `4.0.68` and `npm view ai version` → `7.0.65`. Both packages list `license: "Apache-2.0"` — MIT-compatible, no LICENSE file read needed for compliance; the npm registry's `license` field is the source of truth.

### Server-side

No new deps. `genui-stream.ts` is plain TypeScript + Deck LLM. Vercel AI SDK is a JS/TS library; the streaming primitives (`streamText`, `streamObject`) are usable server-side too, but we don't need them — the LLM completion path goes through the existing SDK `ModelRegistry.complete()` (already used by `apps/server/src/bridge/in-process.ts:184`).

### Client wiring

`Composer` becomes a thin shell over `useChat`:

```ts
const { messages, input, handleInputChange, handleSubmit, append } = useChat({
  api: "/api/genui/chat",                    // the chat-thread bridge
  experimental_throttle: 50,
  // existing slash/variable suggestions hook into `input`/`handleInputChange`
});
```

Existing `PromptSuggestions` reads `input` (the draft text) and surfaces recommendations — drop-in.

### Files added

- `apps/web/src/lib/genui/useChatThread.ts` — thin wrapper mapping WS `mcp_call` / `gholam_command` to `useChat`'s tool-call interface.
- `apps/web/src/lib/genui/GenuiRenderer.tsx` — the React renderer.
- `apps/web/src/lib/genui/components.ts` — the whitelist (also exported to server via `apps/server/src/genui-allowlist.ts`).

---

## §6 Routing + persistence

### Web routes to add (`apps/web/src/router.tsx`)

```tsx
{ path: "/gholam/chats", element: <GholamChats /> },                      // list
{ path: "/gholam/chat/new", element: <GholamChatNew /> },                 // start new
{ path: "/gholam/chat/:chatId", element: <GholamChat /> },                // single chat (replaces today's GholamView sidebar)
{ path: "/preview/:route", element: <PreviewPane /> },                   // pinned preview
{ path: "/studio/gholam", element: <StudioGholamPane /> },                // StudioProvider pane
```

The existing `/gholam` route stays as the priorities/heartbeat control panel (`apps/web/src/views/GholamView.tsx`); `/gholam/chat/:chatId` is the new chat thread surface.

### `localStorage` keys

```
omp-deck:gholam:chat-list-collapse      (bool)
omp-deck:gholam:model-selection         ({ provider, id })
omp-deck:genui:preview-mode             (default "current")
omp-deck:genui:preview-mode:<route>     (per-route override)
omp-deck:llm:default-provider           (string)
```

### Server-side persistence

| Path | Owner | Lifetime |
|------|-------|----------|
| `<db>` table `gholam_chats` / `gholam_chat_messages` | DB migration 007 | durable |
| `~/.omp-deck/llm-registry-cache.json` | §2 | 24h TTL |
| `~/.omp-deck/genui/components-allowlist.json` | §3 | bundled w/ deck |

---

## §7 Implementation sequence — three workers, disjoint file scopes

All edits to `packages/protocol/src/index.ts`, `apps/web/src/router.tsx`, and `apps/server/src/routes.ts` are **append-only**. Worker D and Worker E both touch `protocol/src/index.ts` (D adds the chat frames; E adds the genui frames) — they touch different union arms, so the merge is trivial.

### Worker D — LLM registry + Gholam chat history + MiniMax

**File scope:**
- `apps/server/src/db/migrations/007-gholam-chats.sql` (NEW)
- `apps/server/src/gholam-chats.ts` (NEW — service)
- `apps/server/src/gholam-chat.ts` (NEW — runtime loop)
- `apps/server/src/routes-gholam-chats.ts` (NEW — REST mounts)
- `apps/server/src/llm-registry.ts` (NEW)
- `apps/server/src/llm-providers/` (NEW dir; one file per provider adapter)
- `apps/server/src/routes-llm.ts` (NEW)
- `agent-defaults/models.yml.tmpl` (append a `minimax:` stanza)
- `apps/server/src/routes.ts` (append `app.route("/gholam/chats", …)` and `app.route("/llm", …)` at line 273 area)
- `apps/server/src/broadcast-bus.ts` (extend `BroadcastFrame` union at line 12-34)
- `packages/protocol/src/index.ts` (add `GholamChat`, `GholamChatMessage`, `ChatUsage` interfaces + the three `_ServerFrameBase` arms)
- `apps/web/src/views/GholamChat.tsx` (NEW)
- `apps/web/src/views/GholamChats.tsx` (NEW — list)
- `apps/web/src/views/GholamChatNew.tsx` (NEW)
- `apps/web/src/router.tsx` (append the four `/gholam/chat*` and `/gholam/chats` paths)
- `apps/web/src/lib/ws.ts` (append `subscribeGholamChat(chatId)` next to existing handlers)
- `apps/web/src/lib/store.ts` (append `gholamChats`, `gholamChatMessages`, `modelSelection`, `modelUsage` slices + actions)

**Step list (D1-D12):**

- **D1.** Migration `007-gholam-chats.sql`. Verify against the existing pattern (`003-routines-v1.sql` — multi-table migration with CHECK constraints + indexes).
- **D2.** `gholam-chats.ts` service — row types + queries (mirror `apps/server/src/db/tasks.ts:13-60` row types → interface projection).
- **D3.** `llm-registry.ts` — typed wrapper around `CustomProvidersRegistry.snapshot()` + SDK `ModelRegistry.getAll()`.
- **D4.** `llm-providers/minimax.ts` — adapter mapping to `DeckLLMProvider` (no new SDK calls; OpenAI-compat path).
- **D5.** `agent-defaults/models.yml.tmpl` — append the `minimax:` stanza.
- **D6.** `routes-llm.ts` — `GET /api/llm/providers`, `POST /api/llm/test`.
- **D7.** `routes-gholam-chats.ts` — all 7 routes from §1.
- **D8.** `gholam-chat.ts` — runtime loop, `runGholamChat(chatId, signal)`. Imports `gholamDeckLLM` from `llm-registry.ts` and `sendGholamFrame` from `gholam.ts` for sidecar tool calls.
- **D9.** `routes.ts` — mount the two new routers.
- **D10.** `protocol/src/index.ts` — `GholamChat` + `GholamChatMessage` + `ChatUsage` interfaces, the three new `_ServerFrameBase` arms, add to `BroadcastFrame`.
- **D11.** `broadcast-bus.ts` — extend `BroadcastFrame` union.
- **D12.** Web side: `GholamChats.tsx` + `GholamChatNew.tsx` + `GholamChat.tsx` + `subscribeGholamChat` + `useStore` slices + router paths. `ModelPicker.tsx` is also Worker D's (mounted in the composer for §2 model selection).

### Worker E — Generative UI + Vercel AI SDK + Preview

**File scope:**
- `apps/web/package.json` (add `@ai-sdk/react` and `ai`)
- `apps/web/src/lib/genui/components.ts` (NEW)
- `apps/web/src/lib/genui/GenuiRenderer.tsx` (NEW)
- `apps/web/src/lib/genui/useChatThread.ts` (NEW)
- `apps/web/src/lib/genui/ModelPicker.tsx` (if not Worker D — coordinate; Worker D owns it)
- `apps/web/src/components/Preview.tsx` (READ FIRST; existing renderer gallery)
- `apps/web/src/components/PreviewPane.tsx` (NEW — right-rail toggle)
- `apps/server/src/genui-allowlist.ts` (NEW — mirrors the client whitelist)
- `apps/server/src/genui-stream.ts` (NEW)
- `apps/server/src/routes-genui.ts` (NEW)
- `apps/server/src/routes-preview.ts` (NEW)
- `apps/server/src/routes.ts` (append mounts)
- `packages/protocol/src/index.ts` (add `GenFrame` wire shape + a `genui_delta` `_ServerFrameBase` arm — disjoint from Worker D's three arms)
- `apps/web/src/router.tsx` (append `/preview/:route` and `/studio/gholam` paths)
- `apps/web/src/views/PreviewView.tsx` (NEW — pinned preview per route)
- `apps/web/src/views/StudioView.tsx` (NEW — uses StudioProvider from STUDIO doc §1)

**Step list (E1-E10):**

- **E1.** `apps/web/package.json` — add the two deps. Run `bun install`.
- **E2.** `genui/components.ts` — the GenComponent union, the whitelist, the version constant.
- **E3.** `genui-allowlist.ts` (server) — mirror the union; export the same version constant. Used as prompt context for the LLM.
- **E4.** `GenuiRenderer.tsx` — `React.createElement` dispatch against the whitelist; unknown `type` → skip + log.
- **E5.** `useChatThread.ts` — `useChat` wrapper mapping WS frames.
- **E6.** `genui-stream.ts` + `routes-genui.ts` — `GET /api/genui/stream?route=` (NDJSON SSE).
- **E7.** `routes-preview.ts` — `POST /api/preview/render` + `GET /api/preview/diff`.
- **E8.** `PreviewPane.tsx` — three modes (current/updated/side-by-side); localStorage per-route persistence.
- **E9.** `protocol/src/index.ts` — `GenFrame` + `genui_delta` arm.
- **E10.** `routes.ts` — mount; `router.tsx` — paths; `PreviewView.tsx` (pinned route).

### Worker F — MiniMax provider specifically

**Verdict: roll into Worker D.** §2's MiniMax wiring is the same scope as `llm-registry.ts` + `models.yml.tmpl` + `llm-providers/minimax.ts`. Splitting into a third worker adds coordination overhead (same `models.yml.tmpl`, same `custom-providers.ts` hot-reload path) for no parallelism gain. If the executor insists on a third worker, the scope is `agent-defaults/models.yml.tmpl` (the `minimax:` stanza only) + `apps/server/src/llm-providers/minimax.ts` — but Worker D must NOT touch these files until F lands, which serializes them. Recommend against splitting.

### Conflict watch

- `routes.ts` line 273 area: both D (`/gholam/chats`, `/llm`) and E (`/genui`, `/preview`) append new `app.route()` lines below the existing mounts. **No path overlap.**
- `packages/protocol/src/index.ts`: D adds three arms to `_ServerFrameBase` + extends `BroadcastFrame`; E adds one arm (`genui_delta`). Disjoint union arms — auto-merge.
- `router.tsx`: D appends 4 paths; E appends 2 paths. Disjoint.

### Existing-path check

- `grep api/preview` over `apps/server` → only `orientation-store.ts` (pre-existing `preview: { … }` field on a different concept). **No conflict.**
- `grep Preview` over `apps/web/src/App.tsx` → not found there. The current `Preview.tsx` is mounted only via `?preview=1` URL flag (read `apps/web/src/Preview.tsx:1-7` header comment). Worker E adds a NEW `<PreviewPane>` component; does NOT rename the existing `Preview.tsx`.

### One dep, authorized

Worker E adds TWO deps (`@ai-sdk/react`, `ai`). The user explicitly asked for Vercel AI SDK. This breaks the "no new deps" rule from prior workstreams — documented here, authorized.

---

## §8 After-update UX shape — concrete walkthrough

### Today

- `/gholam` → priorities + heartbeat panel + state pill.
- `/` → ChatView → Chat + Composer + Inspector.

### After

- `/gholam/chats` → table: `title`, `cwd`, `model`, `state`, `updatedAt`, `usage ($)`. Filters by kind (`user | auto | priority`) and cwd.
- `/gholam/chat/new?cwd=/path/to/repo&prompt=base64` → form: prompt, model picker, permissions required (multi-select from `GHOLAM_PERMISSIONS`), title (auto-generated if blank). Submit → POST `/api/gholam/chats` → redirect to `/gholam/chat/:id`.
- `/gholam/chat/:id` → full chat thread rendered by `GenuiRenderer` (the chat IS a GenUI surface). Assistant turns render through the existing `AssistantMessage` (reused unchanged). Tool calls render through a new `<GholamToolCard>` that handles `role: 'tool_call'` / `tool_result` rows. The composer at the bottom is `<ModelPicker />` + `<Composer />`. Right rail: live usage + state pill + the three-preview toggle.
- `/preview/:route` → pinned preview pane per route; mounted in studio.
- `/` (ChatView) → existing shell, but the `Chat` body is now a `GenuiRenderer` rendering the active session's events as `GenComponent` frames. Reuses `<AssistantMessage>` for assistant text; tool calls go through the same `GenuiRenderer`. The shell stays — chrome (sidebar, inspector, status bar) is unchanged.

### Visual delta (single sentence)

Before: a hand-written React tree with static components. After: the same shell with a GenUI renderer in the content slot — every screen is now data-driven by an LLM prompt + the components-allowlist, and a side-by-side preview shows what the screen will look like once an in-flight `gholam.edit` lands.

---

## verified

**READ in full:**

- `apps/gholam/src/index.ts` (453 lines; elided sections re-read for mcp_call flow at lines 322-411)
- `apps/server/src/gholam.ts` (398 lines; gholam.start/stop/setPriorities/setHeartbeat/snapshot/edit + WS bridge)
- `apps/server/src/bridge/in-process.ts` (first 300 lines; createSession/ModelRegistry wiring)
- `apps/web/src/views/GholamView.tsx` (232 lines; full priorities/heartbeat panel)
- `apps/web/src/views/ChatView.tsx` (26 lines; chat shim)
- `apps/web/src/components/Composer.tsx` (first 103 lines; slash-command wiring + draft + history)
- `packages/protocol/src/index.ts` (2400+ lines; full ServerFrame union, REST shapes, KNOWN_TOOLS)
- `apps/server/src/db/index.ts` (204 lines; openDb + applyMigrations + id/nowIso helpers)
- `apps/server/src/db/migrations/001-init.sql` (82 lines; kanban + inbox + routines seed pattern)
- `apps/server/src/db/migrations/003-routines-v1.sql` (141 lines; multi-table migration with CHECK + indexes + ALTER CHECK rebuild)
- `apps/server/src/db/migrations/004-state-entered-at.sql` (21 lines; simple ALTER ADD COLUMN + backfill)
- `apps/server/src/db/migrations/005-auth.sql` (47 lines; deck_users + deck_sessions tables)
- `apps/server/src/db/migrations/006-push-subscriptions.sql` (22 lines)
- `apps/server/src/auth/store.ts` (333 lines; session/user storage — row type → interface projection pattern)
- `apps/server/src/custom-providers.ts` (282 lines; full CustomProvidersRegistry including applyToRegistry + registerProvider)
- `apps/server/src/broadcast-bus.ts` (59 lines; full BroadcastFrame union + subscribe/broadcast pattern)
- `apps/server/src/ws.ts` (480 lines; full WsHub, onMessage dispatch, throttle map, handlePrompt/handleAbort/handlePlanResponse)
- `apps/server/src/routes.ts` (283 lines; buildRouter full body + mounts)
- `apps/server/src/routes-harness.ts` (356 lines; /api/gholam/* + /gholam/edit + MiniMax login handler)
- `apps/web/src/router.tsx` (110 lines; full createBrowserRouter)
- `apps/web/src/App.tsx` (94 lines; bootstrap + AuthGate + WS subscribe)
- `apps/web/src/lib/store.ts` (first 300 lines; zustand slice shape + actions)
- `apps/web/src/Preview.tsx` (315 lines; existing renderer gallery + `?preview=1` URL flag)
- `agent-defaults/models.yml.tmpl` (115 lines; full providers list — MiniMax NOT currently listed, will be appended by Worker D)
- `apps/web/package.json` (59 lines; current deps — no `@ai-sdk/*` present)
- `docs/STOREFRONT.md` (955 lines; StudioProvider reuse pattern + discovery surface)
- `docs/STUDIO.md` (455 lines; tooltip/context-menu catalog + 6 hard-coded panes)

**External lookups used:**

- `npm view @ai-sdk/react version` → `4.0.68` (Apache-2.0)
- `npm view ai version` → `7.0.65` (Apache-2.0)
- `grep -r MiniMax agent-defaults/` → confirmed provider is already wired in `WATCHDOG.yml`, `config.yml`, and `routes-harness.ts:85-109` login handler, but **not** in `models.yml.tmpl` yet — that's the one place Worker D must add it.

**Summaries only (referenced, not full-read):**

- `apps/web/src/components/messages/AssistantMessage.tsx` (existing tool-card renderer reused for gholam chat threads)
- `apps/server/src/db/tasks.ts` (full — read as the row → interface pattern reference)

---

# Worker briefs (verbatim — copy-paste into vibe_spawn)

## Worker D

```
Target: apps/server/src/db/migrations/007-gholam-chats.sql (NEW); apps/server/src/gholam-chats.ts (NEW); apps/server/src/gholam-chat.ts (NEW); apps/server/src/routes-gholam-chats.ts (NEW); apps/server/src/llm-registry.ts (NEW); apps/server/src/llm-providers/minimax.ts (NEW); apps/server/src/routes-llm.ts (NEW); agent-defaults/models.yml.tmpl (append minimax stanza); apps/server/src/routes.ts (append 2 mounts at line 273 area); apps/server/src/broadcast-bus.ts (extend BroadcastFrame at line 12-34); packages/protocol/src/index.ts (append GholamChat + GholamChatMessage + ChatUsage interfaces + 3 new _ServerFrameBase arms); apps/web/src/views/GholamChat.tsx (NEW); apps/web/src/views/GholamChats.tsx (NEW); apps/web/src/views/GholamChatNew.tsx (NEW); apps/web/src/views/ModelPicker.tsx (NEW); apps/web/src/router.tsx (append 4 paths); apps/web/src/lib/ws.ts (append subscribeGholamChat); apps/web/src/lib/store.ts (append gholamChats, gholamChatMessages, modelSelection, modelUsage slices).

Change: Implement §1 (Gholam chat persistence + replay + on-demand start) and §2 (Deck LLM registry, MiniMax first-class). Schema: 007 migration adds gholam_chats + gholam_chat_messages tables per §1 (TEXT ids, ISO timestamps, CHECK constraints, indexes on updated_at + kind + cwd, partial index WHERE deleted_at IS NULL). Service: gholam-chats.ts (CRUD + listMessages with since). Runtime: gholam-chat.ts — async loop buildContext → gholamDeckLLM.complete → persist tool_call → for each tc permCheck (uses existing checkGholamFramePermissions from apps/server/src/auth/gholam-permissions.ts) → callSidecar via sendGholamFrame → persist tool_result → repeat until awaiting_user. Cancel = abort signal. Restart = clone history + new user message. REST: 7 routes in routes-gholam-chats.ts, all gated by resolvePrincipal. WS principal kind="internal" allowed on messages?internal=1. llm-registry.ts: typed wrapper over getCustomProviders().snapshot() + SDK ModelRegistry.getAll(); exports DeckLLMProvider, DeckLLMModel, complete(). models.yml.tmpl: append a `minimax:` stanza (baseUrl=https://api.minimax.io/v1, api: openai-completions, discovery: openai-models-list) following the existing 9router/omni pattern. routes-llm.ts: GET /api/llm/providers + POST /api/llm/test (admin-only via auth/guard). protocol/src/index.ts: append-only — add GholamChat/GholamChatMessage/ChatUsage interface types AND the 3 _ServerFrameBase arms (gholam_chat_delta, gholam_chat_message, gholam_chat_state) AND extend BroadcastFrame in broadcast-bus.ts. routes.ts: append 2 app.route() lines (no path overlap with existing mounts). Router: 4 new paths (/gholam/chats, /gholam/chat/new, /gholam/chat/:chatId, /gholam/chats; existing /gholam control panel stays). Store: zustand slice for gholamChats (Record<id, GholamChat>) + gholamChatMessages (Record<chatId, GholamChatMessage[]>) + modelSelection ({provider,id}) + modelUsage (Record<provider/model, daily totals). subscribeGholamChat: filter WS frames by chatId, dispatch into store. GholamChat.tsx: GenuiRenderer (Worker E ships the renderer — until then, render messages with existing AssistantMessage + UserMessage + a new <GholamToolCard> for tool_call/tool_result rows). GholamChats.tsx: list with filters. GholamChatNew.tsx: form.

Acceptance: bun run typecheck passes for apps/server + apps/web + packages/protocol. sqlite3 ~/.omp-deck/omp-deck.db ".schema gholam_chats" shows the 3 expected tables + 3 indexes. POST /api/gholam/chats with {cwd:"/tmp",prompt:"hi"} returns {id,title,state:"running"}; the chat row appears in the DB; subsequent gholam_chat_message + gholam_chat_state frames broadcast on the WS bus. GET /api/llm/providers returns at least the minimax provider with one model. POST /api/llm/test {provider:"minimax",id:"MiniMax-M3"} returns {ok:true,latencyMs:N}. The minimax stanza is in agent-defaults/models.yml.tmpl and reloads via CustomProvidersRegistry hot-watch.

Do NOT touch: anything Worker E owns (genui/*, Preview*, /api/preview/*, /api/genui/*). Do NOT run project-wide linters or test suites.
```

## Worker E

```
Target: apps/web/package.json (add @ai-sdk/react ^4.0.68 + ai ^7.0.65); apps/web/src/lib/genui/components.ts (NEW); apps/web/src/lib/genui/GenuiRenderer.tsx (NEW); apps/web/src/lib/genui/useChatThread.ts (NEW); apps/web/src/components/PreviewPane.tsx (NEW); apps/server/src/genui-allowlist.ts (NEW); apps/server/src/genui-stream.ts (NEW); apps/server/src/routes-genui.ts (NEW); apps/server/src/routes-preview.ts (NEW); apps/server/src/routes.ts (append 2 mounts at line 273 area); packages/protocol/src/index.ts (append GenFrame + 1 new _ServerFrameBase arm genui_delta); apps/web/src/router.tsx (append /preview/:route + /studio/gholam paths); apps/web/src/views/PreviewView.tsx (NEW); apps/web/src/views/StudioView.tsx (NEW); apps/web/src/components/Preview.tsx (READ FIRST; do not rename).

Change: Implement §3 (Generative UI), §4 (Pre-update preview), §5 (Vercel AI SDK integration). Package adds: @ai-sdk/react + ai (Apache-2.0; verified via npm view). components.ts: the GenComponent union (§3 vocabulary: GenStack/GenRow/GenGrid/GenText/GenMarkdown/GenCode/GenImage/GenVideo/GenButton/GenAction/GenTable/GenKeyValue/GenCard/GenTabs/GenModal/GenForm). Export a GENUI_ALLOWLIST_VERSION constant. GenuiRenderer.tsx: React.createElement dispatch against the whitelist; unknown type = skip + console.warn in dev, no-op in prod. Action emitters route to existing broadcastBus dispatchers — no new event channels. useChatThread.ts: useChat wrapper mapping WS mcp_call/gholam_command to useChat's tool-call interface. genui-allowlist.ts (server): mirrors the union; same version constant. Used as prompt context for the LLM. genui-stream.ts + routes-genui.ts: GET /api/genui/stream?route=<path> returns NDJSON via Hono streamSSE; each line is {type:"frame",frame:GenComponent} or {type:"done"}. Routes-preview.ts: POST /api/preview/render {path,content,route,model?} streams the post-update render; GET /api/preview/diff lists in-flight changes. PreviewPane.tsx: right-rail toggle with 3 modes (current/updated/side-by-side); per-route localStorage key omp-deck:genui:preview-mode:<route>. protocol/src/index.ts: append GenFrame interface + 1 new _ServerFrameBase arm (genui_delta). routes.ts: append 2 app.route() lines (no overlap with Worker D's mounts). Router: 2 new paths (/preview/:route, /studio/gholam). PreviewView.tsx: pinned preview per route. StudioView.tsx: uses StudioProvider pattern from docs/STUDIO.md §1 (six hard-coded panes including a StorefrontPane from docs/STOREFRONT.md §3).

Acceptance: bun run typecheck passes for apps/server + apps/web + packages/protocol. apps/web/package.json lists @ai-sdk/react ^4.0.68 and ai ^7.0.65. GET /api/genui/stream?route=/chat returns NDJSON with at least one frame per request. POST /api/preview/render with a sample body returns a streamed frame set; the frame's `type` is in the whitelist. PreviewPane toggles correctly between 3 modes and persists per-route. No existing tests fail. Do not rename apps/web/src/Preview.tsx (the existing renderer gallery).

Do NOT touch: Worker D's files (gholam-chats.ts, gholam-chat.ts, llm-registry.ts, llm-providers/, routes-gholam-chats.ts, routes-llm.ts, agent-defaults/models.yml.tmpl, broadcast-bus.ts). Do NOT run project-wide linters or test suites.
```

## Worker F (roll into Worker D — recommendation only)

```
Target: agent-defaults/models.yml.tmpl (append minimax stanza); apps/server/src/llm-providers/minimax.ts (NEW).

Change: Append a minimax: stanza to agent-defaults/models.yml.tmpl following the existing 9router/omni pattern (baseUrl=https://api.minimax.io/v1, apiKey=${OMP_PROVIDER_MINIMAX_API_KEY}, api: openai-completions, authHeader: true, discovery: type openai-models-list). New file apps/server/src/llm-providers/minimax.ts: small adapter mapping the SDK Model shape (from CustomProvidersRegistry.applyToRegistry's registerProvider call) to DeckLLMProvider. No new SDK calls; OpenAI-compat path.

Acceptance: After restart, CustomProvidersRegistry picks up the minimax stanza (verified via the file-watcher's reload). The minimax model appears in GET /api/llm/providers. POST /api/llm/test with provider:"minimax" id:"MiniMax-M3" returns {ok:true,latencyMs:N}.

Do NOT touch: anything outside the two files. Do NOT run project-wide linters or test suites.
```
