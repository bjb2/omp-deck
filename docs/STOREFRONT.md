# Storefront, Discovery, Prompt Library, Gholam Access, MCP Health — Design

Single document covering the seven asks the user raised. Server-side heavy; one
additive UI surface (`/storefront`) plus realtime SSE; new prompt library;
gholam permissions + new MCP transports; unified MCP health probe.

All work is additive. Existing routes (`/marketplace`, `/skills`, `/chat`) keep
working. New code lives in new files except where the protocol/broadcast bus
needs a small extension.

---

## §1 Fix Anthropic plugin install + Marketplace sanity

### Real install path (verified in SDK source)

```
POST /api/marketplace/install { name, marketplace, scope?, force? }
  → routes-marketplace.ts:29
    → MarketplaceService.install() (marketplace-service.ts:159)
      → mgr.installPlugin(name, marketplace, opts)
        → manager.ts:239  (MarketplaceManager.installPlugin)
          1. getMarketplaceEntry(reg, marketplace)   ← throws "Marketplace … not found"
          2. read catalog JSON from <marketplacesCacheDir>/<name>/marketplace.json
          3. find plugin by name in catalog          ← throws "Plugin … not found in marketplace"
          4. resolvePluginSource(pluginEntry, ctx)   ← THIS IS WHERE IT BREAKS FOR ANTHROPIC
                - relative string: filesystem lookup under clonePath
                - {source:"url"}:   git clone the URL
                - {source:"github",repo}:  git clone https://github.com/<repo>.git
                - {source:"git-subdir",url,path}: clone + subdir
                - {source:"npm"}: NOT IMPLEMENTED in SDK (throws)
          5. resolveVersion + cachePlugin to <pluginsCacheDir>/<marketplace>/<name>-<ver>/
          6. writeInstalledPluginsRegistry + registerRuntimePlugin
```

The deck side passes through `name` (e.g. `"anthropic-claude-code"`) and
`marketplace` (the catalog's self-name, e.g. `"claude-plugins-official"`).
These come straight from `MarketplaceCatalogEntry` (built at marketplace-service.ts:115-144).
The Anthropic repo's `marketplace.json` has `name: "claude-plugins-official"` —
the deck sees that as `entry.marketplace`, which is correct.

### Why the user sees install "fail"

1. **The error string the UI surfaces is the raw Bun subprocess output.**
   `MarketplaceView.tsx:84` does `setError(String((e as Error).message ?? e))`
   and the server route at `routes-marketplace.ts:49-51` wraps the SDK throw in
   `String(err.message)`. A `git clone` failure surfaces as
   `Cloning into '/tmp/...'... fatal: unable to access '...': Could not resolve
   host: github.com` — useless to the user.

2. **The Anthropic catalog contains plugin entries whose `source` is a string
   path that needs to be resolved against the marketplace clone.** Anthropic's
   `marketplace.json` declares plugins with `source: "./plugins/<name>"`.
   This requires the marketplace to be cached as a full git clone (the SDK
   only stores `marketplace.json` in the cache for URL sources —
   `manager.ts:284-291`). For `github`-classified sources the fetcher does
   `cloneAndReadCatalog` (source-resolver.ts:288) which does a full clone.
   So far so good.

3. **The Anthropic catalog also lists plugins whose `source` is
   `{ source: "github", repo: "anthropics/<plugin>" }` referring to external
   repos.** Each install triggers a fresh clone via `resolveObjectSource`
   (source-resolver.ts:94-100). Some Anthropic repos reference submodules,
   are private, or are large — first-time clones time out or fail on
   corporate networks with the SSL CA fix applied. The error gets reported
   without indicating which step in the chain failed.

4. **`npm`-typed sources throw.** If any future Anthropic plugin uses
   `{ source: "npm", package: "..." }`, the SDK throws "unsupported source
   type". Not the cause today but worth surfacing.

### Fix

a) **Translate SDK errors to plain English** in `routes-marketplace.ts:48-51`.
   Walk the error chain (`err.cause` and message heuristics); return:
   - `Marketplace "<x>" not found` → 400 `{ error: "marketplace_not_found",
     marketplace: "<x>", hint: "Try refreshing the catalog (Refresh button)." }`
   - `Plugin "<x>" not found in marketplace "<y>"` → 400 `{ error:
     "plugin_not_found", name, marketplace, hint: "The catalog may be stale." }`
   - `Cloned repository <url>: ...` → 422 `{ error: "git_clone_failed",
     url, cause, hint: "Check your network access to github.com and the
     marketplace repo." }`
   - `Problem with the SSL CA cert` → 422 `{ error: "ssl_ca_failed", hint:
     "Set GIT_SSL_CAINFO or GIT_SSL_NO_VERIFY, then restart the server." }`
   - anything else → 500 with `{ error: "install_failed", message, hint: "Run
     Test Install to see the full failure." }`

b) **Surface the chain step in the response.** Wrap `resolveObjectSource`'s
   failure with `{ at: "resolve_source", plugin: name, marketplace }` so the UI
   can show "Failed during source fetch for plugin `foo` from
   `claude-plugins-official`".

c) **Add a Test-install admin route.** `POST /api/marketplace/install/dry-run`
   with the same body shape. Does:
   1. Validate marketplace + plugin name exist (read-only).
   2. Resolve the source to a temp clone dir.
   3. Read the plugin manifest (`plugin.json` or `.claude-plugin/plugin.json`)
      and report `name`, `version`, `entrypoints` (`commands|agents|hooks|mcpServers|lspServers`).
   4. Clean up temp clone.
   5. Return `{ ok: true, manifest, cloneUrl, ref, sha, wouldCacheTo }`.
   No filesystem mutation in user or project plugin dirs.

d) **Add `known-good-sources.json`** — checked into the repo, ships with the
   deck build. Schema:
   ```json
   {
     "anthropics/claude-plugins-official": {
       "verifiedAt": "2026-08-01",
       "installable": ["code-review", "github", "security-guidance"],
       "knownFailures": ["some-experimental-plugin"],
       "notes": "Anthropic-managed; install works after marketplace refresh."
     }
   }
   ```
   Surfaced as a green ✓ next to each source row in `/storefront` §3.
   The Anthropic marketplace is the only first-party one we know; the
   community mirror `anthropics/claude-plugins-community` and
   `claude-marketplace` style private sources get added on report.

e) **Diagnose-and-fix follow-up.** Two real bugs are reachable from this work:
   - The SDK throws `Marketplace "<x>" not found` when `addMarketplace` was
     never called OR when the registry was deleted. We should expose a
     `GET /api/marketplace/health` returning each registered marketplace's
     last-refresh timestamp and last-known-good install count, so the UI
     can show "needs refresh" without user trying.
   - On Windows, the bundled git binary's stderr sometimes lacks the SSL
     bundle path even with `GIT_SSL_CAINFO` set; `marketplace-extras.ts`
     only sets it once at boot. Add a per-call re-check on install path
     (no env cost) — set it before `Bun.spawn` if missing.

### Behavior change vs additive

Fix (a)+(b) change behavior of `POST /api/marketplace/install` (response body
shape grows; status codes split between 400/422/500). Old clients that only
read `error` keep working. Fix (c)+(d)+(e) are additive.

---

## §2 Global discovery + closest-result fetch

### Endpoint surface (new)

```
GET  /api/discovery/search?q=<>&section=<plugins|mcps|skills|prompts|all>&limit=<>
GET  /api/discovery/resolve?id=<discoveryId>
GET  /api/discovery/stream                  ← SSE; mirrors WsHub semantics
POST /api/discovery/cache/purge             ← admin
```

`DiscoveryHit` (the JSON envelope):
```ts
interface DiscoveryHit {
  id: string;                          // server-issued opaque id
  section: "plugins" | "mcps" | "skills" | "prompts" | "kb";
  title: string;
  tagline?: string;                    // <= 140 chars
  description?: string;                // <= 600 chars
  author?: { name: string; url?: string; avatar?: string };
  iconUrl?: string;
  url: string;                         // canonical "open" deep link
  source: {
    kind: "marketplace" | "github" | "web" | "kb" | "local";
    ref: string;                       // marketplace name | "owner/repo" | url | kb path
    fetchedAt: string;                 // ISO
  };
  // "Closest record" — primary metadata + snippet for previews
  snippet?: string;                    // first 2KB / first paragraph
  capabilities?: { toolNames?: string[]; categories?: string[]; triggers?: string[] };
  score: number;                       // server-computed
  signals: string[];                   // ["marketplace:anthropics/claude-plugins-official",
                                       //  "github-stars:1200", "tag:code-review"]
}
```

### Resolution order per section

| section | local → github → web |
|---|---|
| plugins | installed plugins → marketplace catalog → grep `repo.name+description` for `<q>` → parallel search "best omp plugin `<q>`" |
| mcps    | mcp.json known servers → grep "mcp-server `<q>`" → exa "top `<q>` MCP server" → tavily "MCP `<q>`" |
| skills  | SkillsService.listSkills → grep "omp skill `<q>`" → parallel "omp skill library `<q>`" |
| prompts | prompt library → deck `discover-catalog` index → github code search `-in:readme path:MODELS.md <q>` → parallel → exa → tavily |
| kb      | kb-service search → n/a |

The user wants **closest-record semantics** with fallback through providers in
this order: **parallel → exa → tavily → grep**. This is honored per query: a
single search runs parallel first; if it returns < N hits or errors, exa fills
the gap; then tavily; then grep. Results merge into one deduplicated stream
(keyed on `(section, source.kind, ref)`).

### Provider call pattern

```ts
// apps/server/src/discovery/providers.ts
interface DiscoveryProvider {
  name: "parallel" | "exa" | "tavily" | "grep";
  search(opts: { q: string; section: DiscoveryHit["section"]; limit: number }): Promise<DiscoveryHit[]>;
}
```

Each provider wraps its MCP client. The deck already has `MCP_PARALLEL_TOKEN`,
`EXA_API_KEY`, `TAVILY_API_KEY` from `agent-defaults/mcp.json.tmpl:32-77` —
those env vars are the keys (the deck's `MCP_OPENSHIP_TOKEN` pattern is the
template).

### Rate limits + cache

- **GitHub**: 60 req/h/authenticated. Reuse the user's `GITHUB_PERSONAL_ACCESS_TOKEN`
  (already in scope via the gholam MCP child). Cache key `gh:<query-hash>:top-N`,
  TTL 6h.
- **Web**: 100 req/day/provider (parallel/exa/tavily are paid). Cache key
  `web:<provider>:<query-hash>`, TTL 24h. Provider is only called if the
  cache miss is the only way to answer the user's query (don't burn budget on
  cache hits).
- **Local catalog**: in-memory `Map<string, DiscoveryHit[]>` keyed by
  `q + section`. TTL 30s — debounces identical keystrokes.

Cache file `~/.omp-deck/discovery-cache.json`. Pruned on size > 10MB (oldest
first). Provider counters in `~/.omp-deck/discovery-usage.json` to show in
the UI ("today: parallel 12/100, exa 3/100, tavily 0/100").

### Realtime updates

Reuse `broadcastBus` (`apps/server/src/broadcast-bus.ts`) and `WsHub`
(`apps/server/src/ws.ts:23`). Add to `_ServerFrameBase`:

```ts
| { type: "store_item_added"; section: StoreSection; item: StoreItem }
| { type: "store_item_updated"; section: StoreSection; item: StoreItem }
| { type: "store_item_removed"; section: StoreSection; id: string }
| { type: "discovery_added"; hits: DiscoveryHit[] }   // bulk fan-out when a provider search completes
```

Add to `BroadcastFrame` (broadcast-bus.ts:12-29) the four store-item variants
so non-subscribed clients also see the live feed.

The SSE endpoint `GET /api/discovery/stream` reuses the WsHub's
`broadcast(frame)` path with an `EventSource` shim (Hono's
`streamSSE`). It piggybacks on the existing `BroadcastBus`; the only new
piece is the SSE writer that maps each `BroadcastFrame` to an `event:` line.

### Module shape

```
apps/server/src/discovery/
  providers.ts          # provider interfaces + parallel/exa/tavily/grep clients
  index.ts              # DiscoveryService — orchestrates fan-out + cache + dedupe
  routes.ts             # Hono router for /api/discovery/{search,resolve,stream,cache/purge}
  cache.ts              # disk-backed LRU + per-provider counters
```

`DiscoveryService.search(q, section)` returns `DiscoveryHit[]` plus
`{ providersUsed, cacheHits, tookMs }` so the UI can show "12 results · 3
from marketplace, 6 from GitHub, 3 from web (parallel)".

### UI surface

`/storefront/search?q=...` renders the omnibar results. Component
`<DiscoveryResults />` lives in `apps/web/src/views/storefront/DiscoveryResults.tsx`.
Empty state: "We searched GitHub for `<q>`, found nothing in the marketplace —
try the wider web search." (verbatim from the user spec).

---

## §3 Storefront UI (Microsoft / Apple / Play Store style)

### Routes

| Route | Component | Source pattern |
|---|---|---|
| `/storefront` | `StorefrontHome.tsx` | hero + carousel + category chips |
| `/storefront/:section` | `StorefrontSection.tsx` | grid + filters + sort |
| `/storefront/:section/:id` | `StorefrontDetail.tsx` | hero + screenshots + version timeline + install CTA |
| `/storefront/search` | `DiscoveryResults.tsx` | omnibar results |

`section` ∈ `{ plugins, mcps, skills, prompts }`.

### Data model

```ts
type StoreSection = "plugins" | "mcps" | "skills" | "prompts";

interface StoreItem {
  id: string;
  section: StoreSection;
  name: string;
  tagline: string;            // <= 140 chars
  description: string;        // markdown body
  author: { name: string; url?: string; avatar?: string };
  icon: string;               // url
  screenshots: string[];
  ratings: { stars: number; count: number };
  installs: number;
  lastUpdated: string;        // ISO
  source: { kind: "marketplace"|"github"|"web"|"kb"; url: string; ref?: string };
  versionHistory: { version: string; date: string; notes: string }[];
  capabilities: { toolNames: string[]; categories: string[]; triggers: string[] };
  installAction: { kind: "marketplace"|"mcp"|"skill"|"prompt"; payload: unknown };
  // Live badge fields
  isNew?: boolean;            // first seen in last 24h
  isLive?: boolean;           // SSE-driven, currently animating in
}
```

### Storefront home (`/storefront`)

- **Hero**: gradient card, large tagline ("Everything you can install into
  OMP Deck"), omnibar `<StorefrontOmnibar />` (debounced 250ms; hits
  `/api/discovery/search?q=...&section=all`).
- **Featured carousel**: `Carousel` of 8 cards, autoplay 6s pause-on-hover.
  Pulls `GET /api/storefront/featured?limit=8` (server composes from
  marketplace's `featured()` filter, GitHub `trending` for skills/MCPs, and
  curated prompts).
- **Trending row**: horizontal-scroll strip. Server-computed from
  install-count deltas over last 30d (where available) or stars+recency
  fallback.
- **New & noteworthy row**: server query "items first indexed in the last 7
  days, sorted by installs/day".
- **Category chips**: 8-12 chips driven by `KNOWN_TOOLS` from
  `packages/protocol/src/index.ts:1146-1162`. Each chip routes to
  `/storefront/:section?capability=<KNOWN_TOOL>`.

### Section page (`/storefront/:section`)

Three-column responsive grid (4-col @xl, 3 @lg, 2 @md, 1 @sm). Each card:

- 200×200 icon area; subtle scale-on-hover (1.0 → 1.04, 220ms ease-out).
- On hover: tagline slides in over the name (`-translate-y-1` + opacity).
- Screenshots preview slides in from right (`translate-x-4 → 0`).
- Status pill: `Installed | Update | Get` (Get = primary blue, Update = accent,
  Installed = success green).
- "Live" pulse: items arriving via SSE get a `ring-2 ring-accent animate-pulse`
  for 4s, then settle.
- Click → `/storefront/:section/:id`.

Filters (left rail):
- Source: checkbox list (`marketplace`, `github`, `web`, `kb`).
- License: `MIT | Apache-2.0 | BSD-3 | Proprietary | Unknown`.
- Free/Paid: `free | paid | all` (most are free; flag exists for paid MCP
  servers).
- Recently updated: toggle (`last 30d | all time`).
- Top of last 30d: toggle (sort by installs/day desc).

Empty state when filters yield zero: "No items match your filters. Try
removing the source filter or switching to **wider web search**."

### Detail page (`/storefront/:section/:id`)

- Hero image strip (screenshots carousel).
- Title + tagline + author chip.
- Big CTA button: `Get` / `Install` / `Update` / `Open` (deep link to
  `routes-marketplace.ts:29` etc.). Hover shows the install payload.
- "About" markdown body.
- **Capabilities** chip rail (from `capabilities.toolNames`, `categories`).
- **Version history timeline** (vertical, newest first; 5 visible, expand).
- **Reviews** placeholder for v1.1; v0 displays
  GitHub stars count + last-commit date for github sources.
- **Discover by capability** chip rail at bottom — same component as homepage.

### Realtime

Web subscribes to WS, handles `store_item_added|updated|removed` per the
existing `subscribeChannel` pattern in the store. The zustand store gains:

```ts
storefront: {
  itemsBySection: Record<StoreSection, Map<string, StoreItem>>;
  livePulseIds: Set<string>;            // cleared 4s after arrival
  featured: StoreItem[];
  trending: StoreItem[];
};
storefrontChangeCounter: number;        // bumped on every store_item_* event
```

### Components

```
apps/web/src/views/storefront/
  StorefrontHome.tsx
  StorefrontSection.tsx
  StorefrontDetail.tsx
  DiscoveryResults.tsx
  components/
    StorefrontOmnibar.tsx
    FeaturedCarousel.tsx
    StoreCard.tsx
    StoreCardSkeleton.tsx
    FilterRail.tsx
    CapabilityChipRail.tsx
    VersionTimeline.tsx
    LiveBadge.tsx            ← used in header to show "live updates" indicator
```

### StudioProvider reuse

The Studio doc (`docs/STUDIO.md`) defines a `StudioProvider` + tooltip +
context-menu catalog. **Reuse** for `/storefront` — `/studio` already mounts
the deck's existing views as panes. Add `StorefrontPane` as a registered
pane, so users get `/studio?pane=storefront` for free. No new tooltip
catalog needed for v0; StudioProvider's heuristic resolver will pick up
`data-tooltip` attributes from `<StoreCard />`.

### Seed catalog (first-run)

Add one manual entry to `apps/server/src/discovery/storefront-seed.ts`:

```ts
{
  id: "claude-sonnet-4@anthropic",
  section: "plugins",
  name: "Anthropic Claude Sonnet 4",
  tagline: "Anthropic's official Sonnet 4 — wired into the deck as a featured item.",
  source: { kind: "marketplace", url: "https://github.com/anthropics/claude-plugins-official", ref: "claude-plugins-official" },
  installAction: { kind: "marketplace", payload: { name: "claude-sonnet-4", marketplace: "claude-plugins-official", scope: "user" } },
  // ... rest of fields
}
```

This ships in the catalog even if the install can't complete today — the
"Install" button is wired and points at the real registry entry. When the
user clicks, they hit the §1 dry-run or the real install path.

---

## §4 Prompt Library + Recommendation

### Library CRUD

Routes:
```
GET    /api/prompts/library                    → { prompts: Prompt[] }
GET    /api/prompts/library/:id                → Prompt
POST   /api/prompts/library                    → Prompt (create)
PUT    /api/prompts/library/:id                → Prompt (update)
DELETE /api/prompts/library/:id                → { ok: true }
POST   /api/prompts/library/:id/use            → bumps usageCount + lastUsedAt
GET    /api/prompts/library/:id/variables      → string[]   (extracted handlebars)
POST   /api/prompts/library/import             → { id }     (from JSON or gist URL)
GET    /api/prompts/library/:id/export         → JSON body
GET    /api/prompts/share/:slug                → Prompt (read-only public)
```

```ts
interface Prompt {
  id: string;
  title: string;
  body: string;                // markdown
  category: string;
  tags: string[];
  variables: string[];         // extracted from {{handlebars}}
  shareSlug?: string;          // present iff user marked "share"
  createdAt: string;
  updatedAt: string;
  usageCount: number;
  lastUsedAt: string | null;
  pinned: boolean;
  source?: {                   // present when imported from discovery
    kind: "github" | "web" | "kb" | "user";
    url: string;
    capturedAt: string;
  };
}
```

Storage: `~/.omp-deck/prompts/<id>.json` (one file per prompt; cheap, atomic
writes, easy export). `shareSlug` → `~/.omp-deck/prompts/_shared/<slug>.json`.
No DB schema needed.

Variable extraction: regex `/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g` on body.

### Web UI (`/prompts/library`)

- Sidebar: categories, tag filter, pin section, recently used (top 5).
- Main: list view + editor pane (split-view at xl+, tabs below).
- Editor: `<PromptEditor />` — markdown textarea + live preview; on save,
  re-extract variables.
- Variable autocomplete in the **composer** (`apps/web/src/components/Composer.tsx`):
  when the user types `{{`, show chip picker sourced from the active
  prompt's `variables` (or all variables from the library if no active
  prompt).
- Export/Import: `<PromptExportDialog />` (JSON download, gist push) and
  `<PromptImportDialog />` (file picker or gist URL paste).
- Sharing: button generates `shareSlug` (8-char base64url), shows
  `/prompts/share/<slug>` URL, copy-to-clipboard.

### Discovery (`/prompts/discover`)

Reuses §2 `DiscoveryService.search(q, "prompts")`. UI:
- "Trending" row at top (computed server-side, refresh 1h).
- Search results list with "Save to library" button on each.
- Saved → POST `/api/prompts/library` with body filled, `source` populated.
  User can edit before confirming.

### Recommendation engine

Signal inputs (all client-side + server-side, computed lazily):

| Signal | Source | Computation |
|---|---|---|
| Project | active session's `cwd` → `git log --name-only -n 200` via existing `git-service.ts`; `git remote get-url`; file ext histogram | top 30 file-extensions → topic tokens; remote URL → domain (e.g. `github.com/anthropics/...`) |
| History | last 200 prompts across all sessions via `auth/store.ts` + reducer session event log | TF-IDF over union → top 20 terms |
| Usage | per-prompt `usageCount` + `lastUsedAt` (decay `e^(-Δdays/30)`) | top 30 prompt ids by score |

Score = cosine-similarity over TF-IDF vectors of `{prompt.title ∪ body ∪ tags}`
vs `{project terms ∪ history terms ∪ usage terms}`. Top 5 with "why":

```ts
interface PromptRecommendation {
  prompt: Prompt;
  score: number;
  why: string;          // e.g. "matches 4 history terms + your project's Python focus"
  matchedSignals: ("project"|"history"|"usage")[];
}
```

### UI integration

- **`<PromptSuggestions />` panel in the composer** (drops down when composer
  is empty + idle 5s). Pulls top 5 via
  `GET /api/prompts/recommend?sessionId=...&limit=5`.
- **`/`-style slash command**: route already exists at
  `apps/server/src/routes-slash-commands.ts:42` (deck slash commands are
  user/project markdown files). Add deck-builtin `/prompts-recommend` at
  `apps/server/src/deck-slash-commands.ts` (the registry is loaded by
  `routes-slash-commands.ts:51`). The command returns
  `{ kind: "rewritten", prompt: "/suggested-prompts" }` which triggers the
  suggestions panel as an `<ExtUiDialog />` (the existing
  `{ type: "ext_ui_dialog_open" }` path, broadcast at
  `packages/protocol/src/index.ts:956-993`).

---

## §5 Gholam access expansion

### gholam-permissions registry

New file: `apps/gholam/src/permissions.ts` (and the same enum mirrored on the
server side at `apps/server/src/auth/gholam-permissions.ts` for the gating
check).

```ts
// apps/gholam/src/permissions.ts
export const GHOLAM_PERMISSIONS = {
  "library.prompts.read":   "read",
  "library.prompts.write":  "write",
  "library.history.read":   "read",
  "library.sessions.read":  "read",
  "kb.read":                "read",
  "kb.write":               "write",          // append only; full update deferred
  "marketplace.search":     "read",
  "marketplace.install":    "execute",        // requires user approval
  "mcp.invoke":             "execute",
  "github.write":           "write",
  "openship.deploy":        "write",
  "discovery.search":       "read",
  "prompts.recommend":      "read",
} as const;

export type GholamPermission = keyof typeof GHOLAM_PERMISSIONS;
```

The grant list lives in `~/.omp-deck/gholam-permissions.json` (created on
first boot with all read permissions enabled; `marketplace.install` and
`github.write` default to `false` until the user toggles them in
Settings → Gholam).

### WS frame permission declaration

Every gholam → server frame declares its required permissions:

```ts
interface GholamClientFrame {
  type: string;
  requiredPermissions: GholamPermission[];
  // ... payload
}
```

Server-side: at the same gate as `resolvePrincipal`
(`apps/server/src/auth/guard.ts:119`), add a `gholamHasPermission` check
that loads the grant file and validates each frame. Reads are auto-granted
by the seed file; writes/execute require explicit user approval.

### Gholam MCP children — add parallel/exa/tavily

Edit `apps/gholam/src/mcp-clients.ts` (already exports `startGithubMcp` and
`startOpenshipClient` at lines 38 + 102). Add three new transports:

```ts
// Stdio transports (parallel to startGithubMcp's pattern at line 38)
export function startParallelMcp(args: { child: ReturnType<typeof Bun.spawn>; kill: () => void }): GithubMcpHandle
export function startTavilyMcp(args: { child: ReturnType<typeof Bun.spawn>; kill: () => void }): GithubMcpHandle
export function startExaMcp(args: { child: ReturnType<typeof Bun.spawn>; kill: () => void }): GithubMcpHandle
```

All three share the same `GithubMcpHandle` interface (line-bounded stdin,
stdout pump, kill) — the only difference is the spawn args:

| Server | Command | Args | Auth |
|---|---|---|---|
| parallel | HTTP, no spawn | `https://search.parallel.ai/mcp` w/ `Authorization: Bearer ${MCP_PARALLEL_TOKEN}` | env token |
| exa | `npx -y exa-mcp-server` | stdio | `EXA_API_KEY` env |
| tavily | HTTP, no spawn | `https://mcp.tavily.com/mcp/?tavilyApiKey=${TAVILY_API_KEY}` | URL-embedded key |

parallel and tavily are HTTP — wrap in `startHttpMcpClient(url, headers)`
(thin fetch-based client mirroring `startOpenshipClient` line 102). Exa is
stdio — use `startGithubMcp`-shape wrapper (since the line-pump logic is
already there).

Wire into `apps/gholam/src/index.ts`:
- Env vars added at lines 32-39: `MCP_PARALLEL_TOKEN`, `EXA_API_KEY`, `TAVILY_API_KEY`.
- `ensureMcpClients()` (lines 53-74) extended to lazily start the three new
  children when the deck asks for them.
- 30s idle-kill timer per child (matches the "best-effort, lossy" constraint
  the user specified) — reset on every `mcp_call`. Implementation: `setTimeout`
  per child, `clearTimeout` on activity, `kill()` on expiry.

### Server-side gholam-permissions gate

New file: `apps/server/src/auth/gholam-permissions.ts`. Exports:

```ts
export function checkGholamFramePermissions(frame: GholamClientFrame): { ok: boolean; missing: GholamPermission[] };
export function loadGholamPermissionGrant(): Set<GholamPermission>;
```

Called from `apps/server/src/index.ts` at the WS message handler
(after `resolvePrincipal`, before the frame is dispatched to
`WsHub.onMessage`). On failure, send `mcp_reply`-style error frame back to
gholam and log.

---

## §6 Live MCP Health

### Probe loop

New file: `apps/server/src/mcp-health.ts`. Single class:

```ts
class McpHealthProbe {
  start(): void;                              // schedules the interval
  stop(): void;
  snapshot(): McpHealthStatus[];              // for GET /api/mcp/health
  // Server entries include both deck-side (read from ~/.omp/agent/mcp.json)
  // and gholam-side (queried via gholam WS: send {"type":"mcp_health_query"}).
}
```

```ts
interface McpHealthStatus {
  id: string;                 // stable across restarts
  name: string;               // server name from mcp.json
  transport: "stdio" | "http";
  scope: "deck" | "gholam";   // which side owns the child
  state: "healthy" | "degraded" | "unreachable" | "unknown" | "disabled";
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError?: string;
  lastLatencyMs: number | null;
  toolCount?: number;         // from tools/list
  probedAt: string;
}
```

Probe method: send JSON-RPC `tools/list` (timeout 5s). For HTTP MCPs:
POST `tools/list` envelope. For stdio MCPs: spawn `Bun.spawn` is heavy —
reuse the deck-side process if it's already running (gholam's children
respond to a `tools/list` request via the existing `mcp_call` plumbing).

Persist to `~/.omp-deck/mcp-health.json` (one row per server, debounced
write). Defaults: probe every 30s; configurable via `OMP_MCP_HEALTH_INTERVAL_MS`.

### WS broadcast

Add to `_ServerFrameBase`:
```ts
| { type: "mcp_health"; status: McpHealthStatus }    // throttled 1/sec max
```

Add to `BroadcastFrame` so non-subscribed clients also see the health feed.
`McpHealthProbe` calls `broadcastBus.broadcast({ type: "mcp_health", status })`
per completed probe; the WsHub's existing throttle in
`apps/server/src/ws.ts:151` (the public `broadcast` method) becomes
rate-limited via a per-frame-type last-sent timestamp map.

### HTTP route

```
GET /api/mcp/health            → { status: McpHealthStatus[]; probedAt: string }
```

Cached in memory; reads from the probe's in-memory map.

### Web UI

`<McpHealthBadge />` — small dot in the deck header
(`apps/web/src/components/chrome/StatusBar.tsx`). Green/yellow/red based on
the worst-current state across all servers. Tooltip lists each server +
last-checked time.

`<McpHealthRow />` — per-server pill row at `/studio` (reuses the
StudioProvider pattern from `docs/STUDIO.md` §5). Each pill: dot + name +
relative-time tooltip + click → opens the full probe history modal.

Subscribes to `mcp_health` frames; updates the zustand store
`mcpHealth: { status: Record<string, McpHealthStatus>, lastUpdate }`.

---

## §7 Implementation sequence — by worker

### Worker A (auth/build, already running — BuildGholam-Bridge)

**Scope: §5 only. One file edit + one new file + one small protocol bump.**

A.1. **`apps/gholam/src/mcp-clients.ts`** — add `startParallelMcp`,
`startTavilyMcp` (HTTP fetch wrappers, same shape as `startOpenshipClient`)
and `startExaMcp` (stdio, same shape as `startGithubMcp`). Reuse the
existing line-pump reader pattern (lines 47-71). #ponytail: no new
abstraction — three concrete functions.

A.2. **`apps/gholam/src/index.ts`** — add `MCP_PARALLEL_TOKEN`,
`EXA_API_KEY`, `TAVILY_API_KEY` to the env block (lines 32-39). Extend
`ensureMcpClients()` (lines 53-74) to lazily start the three new children.
Add `mcp_call` routing for `server === "parallel" | "exa" | "tavily"`. Add
30s idle-kill `setTimeout` per child, reset on activity.

A.3. **`apps/gholam/src/permissions.ts`** — new file. Export the
`GHOLAM_PERMISSIONS` constant + `GholamPermission` type.

A.4. **`packages/protocol/src/index.ts`** — extend `ClientFrame` with the
`requiredPermissions` field on a new variant or as a top-level field on
frames the server recognizes. Minimum: add
`requiredPermissions?: string[]` to the relevant `ClientFrame` variants.

A.5. **`apps/server/src/auth/gholam-permissions.ts`** — new file. Export
`checkGholamFramePermissions` + `loadGholamPermissionGrant`. Mirror the
permission constant from A.3.

A.6. **`apps/server/src/index.ts`** — call the gate in the WS message path
after `resolvePrincipal`. On fail, send an error frame back to gholam.

**Does NOT touch**: routes-marketplace, marketplace-service, marketplace
UI, skills, KB, prompts, mcp-health, studio, storefront, discovery. Worker
A is a single-file-and-protocol-edit task.

### Worker B (new turn — storefront, discovery, MCP health)

**Scope: §1, §2, §3, §6. Server-side heavy.**

B.1. `apps/server/src/marketplace-extras.ts` — add per-call SSL re-check
helper `ensureSslFix()` (called from `MarketplaceService.install` before
spawning git). #ponytail: 5 lines; the existing `applySslFix()` is the
single source of truth at boot.

B.2. `apps/server/src/routes-marketplace.ts` — error translation in
`/install` (lines 48-51); new `POST /install/dry-run` route.

B.3. `apps/server/src/marketplace-service.ts` — `dryRun(opts)` method
that mirrors `install()` but stops before `cachePlugin` + registry writes.

B.4. `apps/web/src/lib/marketplace-api.ts` — add `dryRun` method.

B.5. `apps/web/src/views/MarketplaceView.tsx` — show plain-English error
from `dryRun` in a new `<TestInstallButton />` row inside
`MarketplaceInspector` (line 537-594). One button, one new state slice.

B.6. `apps/server/src/discovery/` — new module. `providers.ts`,
`index.ts` (`DiscoveryService`), `routes.ts`, `cache.ts`.

B.7. `apps/server/src/routes.ts` — mount `buildDiscoveryRouter()`.

B.8. `packages/protocol/src/index.ts` — add `DiscoveryHit` interface +
extend `_ServerFrameBase` with the four store-item variants + `mcp_health`.
Extend `BroadcastFrame`.

B.9. `apps/server/src/broadcast-bus.ts` — extend `BroadcastFrame` union.

B.10. `apps/server/src/storefront-catalog.ts` — new. Composes
`StoreItem[]` from marketplace catalog, skills list, mcp.json, prompt
library + GitHub stars. Seeds the Anthropic Sonnet 4 entry.

B.11. `apps/server/src/routes-storefront.ts` — new.
`GET /storefront/featured`, `/trending`, `/new`, `/section/:s`,
`/section/:s/:id`.

B.12. `apps/server/src/mcp-health.ts` — new. Probe loop + snapshot +
persistence.

B.13. `apps/server/src/routes-mcp-health.ts` — new.
`GET /api/mcp/health`.

B.14. `apps/server/src/ws.ts` — throttle per-frame-type to 1/sec in
`WsHub.broadcast` (line 151). Per-frame-type last-sent timestamp map.

B.15. `apps/web/src/views/storefront/` — all 4 view components + 7
sub-components. Reuse `Layout` from `apps/web/src/components/Layout.tsx`.

B.16. `apps/web/src/router.tsx` — add the four `/storefront/*` routes
alongside the existing marketplace route.

B.17. `apps/web/src/lib/store.ts` — add `storefront` slice +
`storefrontChangeCounter` + `mcpHealth` slice. Mirror the
`skillsChangeCounter` pattern (line 113-119).

B.18. `apps/web/src/components/chrome/StatusBar.tsx` — add
`<McpHealthBadge />`.

B.19. `apps/server/src/storefront/known-good-sources.json` — committed;
ships with the build. Contains the Anthropic entry from §1(d).

### Worker C (new turn — prompt library + recommendation)

**Scope: §4 only. Front-end heavy.**

C.1. `apps/server/src/prompts-library.ts` — new. CRUD over
`~/.omp-deck/prompts/`. Atomic writes via temp-file + rename.

C.2. `apps/server/src/prompts-recommend.ts` — new. TF-IDF cosine over
project/history/usage signals. Reuses `git-service.ts` for
`git log --name-only`.

C.3. `apps/server/src/routes-prompts.ts` — new. Mount the CRUD +
recommend + share + import/export routes.

C.4. `apps/server/src/deck-slash-commands.ts` — add `/prompts-recommend`
entry that returns `{ kind: "rewritten", prompt: "/suggested-prompts" }`.
Triggers the `ExtUiDialog` flow already wired.

C.5. `apps/server/src/routes.ts` — mount `buildPromptsRouter()`.

C.6. `packages/protocol/src/index.ts` — add `Prompt` interface +
`PromptRecommendation`.

C.7. `apps/web/src/views/PromptsLibrary.tsx` — new.

C.8. `apps/web/src/views/PromptsDiscover.tsx` — new.

C.9. `apps/web/src/views/PromptsShare.tsx` — new (read-only).

C.10. `apps/web/src/components/PromptEditor.tsx` — new.

C.11. `apps/web/src/components/PromptSuggestions.tsx` — new. Mounts in
the composer (read `apps/web/src/components/Composer.tsx`).

C.12. `apps/web/src/components/Composer.tsx` — wire `<PromptSuggestions />`
+ variable autocomplete (`{{` trigger).

C.13. `apps/web/src/lib/store.ts` — add `promptsLibrary` slice +
`promptUsageBump` action (call `/use` on send).

C.14. `apps/web/src/router.tsx` — add `/prompts/library`,
`/prompts/discover`, `/prompts/share/:slug`.

### Parallelism

- **A and C are independent** — Worker A is mid-turn on auth, Worker C is
  pure front-end. Can run after A finishes (or in parallel if the routing
  changes in A.4 don't conflict with C.6 protocol additions — they don't:
  A adds `requiredPermissions` to existing frames; C adds new interfaces).
- **B is also independent of C**. B touches `broadcast-bus.ts` and
  `ws.ts`; C touches the composer + `store.ts`. The protocol bumps in B.8
  (`DiscoveryHit`, `mcp_health`, store-item variants) and C.6 (`Prompt`,
  `PromptRecommendation`) don't overlap — single file but additive.
- **B and A both touch `apps/server/src/index.ts`** (A.6 adds the
  permission gate; B may need to mount `buildStorefrontRouter` /
  `buildDiscoveryRouter` via `routes.ts` not `index.ts`). Worker B's
  mounting goes through `routes.ts`, not `index.ts`. So they don't
  conflict on `index.ts` either.

**Coordination point**: `packages/protocol/src/index.ts` is the shared
additive surface. Worker A adds a field to `ClientFrame`; Worker B adds
new `ServerFrame` variants; Worker C adds new interfaces. All three edits
are append-only. If two workers commit overlapping edits, the merge
conflict is a one-line resolution (different section, different union arm).

### BuildGholam-Bridge steering note (verbatim, for the next mid-turn push)

> "Worker A: do §5 only. Edit `apps/gholam/src/mcp-clients.ts` to add
> `startParallelMcp`, `startExaMcp`, `startTavilyMcp` (HTTP wrappers for
> parallel+tavily, stdio for exa, both reusing the existing
> `GithubMcpHandle` shape). Edit `apps/gholam/src/index.ts` to read the
> three new env vars and route `mcp_call` server names `parallel|exa|tavily`
> to the new clients. Add a new `apps/gholam/src/permissions.ts` with the
> `GHOLAM_PERMISSIONS` map. Add `requiredPermissions?: string[]` to the
> relevant `ClientFrame` arms in `packages/protocol/src/index.ts`. New
> file `apps/server/src/auth/gholam-permissions.ts` with the gate check;
> wire it into `apps/server/src/index.ts` after `resolvePrincipal`.
> Do not touch marketplace, skills, KB, prompts, MCP-health, storefront,
> discovery, or studio. Do not run project-wide linters or tests."

---

## Summary of files touched (cross-worker)

| File | Worker | Type |
|---|---|---|
| `apps/gholam/src/mcp-clients.ts` | A | edit |
| `apps/gholam/src/index.ts` | A | edit |
| `apps/gholam/src/permissions.ts` | A | new |
| `apps/server/src/auth/gholam-permissions.ts` | A | new |
| `packages/protocol/src/index.ts` | A,B,C | additive edits |
| `apps/server/src/index.ts` | A | edit |
| `apps/server/src/marketplace-extras.ts` | B | edit |
| `apps/server/src/routes-marketplace.ts` | B | edit |
| `apps/server/src/marketplace-service.ts` | B | edit |
| `apps/web/src/lib/marketplace-api.ts` | B | edit |
| `apps/web/src/views/MarketplaceView.tsx` | B | edit |
| `apps/server/src/discovery/` | B | new (4 files) |
| `apps/server/src/routes.ts` | B,C | additive mounts |
| `apps/server/src/broadcast-bus.ts` | B | edit |
| `apps/server/src/storefront-catalog.ts` | B | new |
| `apps/server/src/routes-storefront.ts` | B | new |
| `apps/server/src/mcp-health.ts` | B | new |
| `apps/server/src/routes-mcp-health.ts` | B | new |
| `apps/server/src/ws.ts` | B | edit |
| `apps/server/src/storefront/known-good-sources.json` | B | new |
| `apps/web/src/views/storefront/` | B | new (10+ files) |
| `apps/web/src/router.tsx` | B,C | additive routes |
| `apps/web/src/lib/store.ts` | B,C | additive slices |
| `apps/web/src/components/chrome/StatusBar.tsx` | B | edit |
| `apps/server/src/prompts-library.ts` | C | new |
| `apps/server/src/prompts-recommend.ts` | C | new |
| `apps/server/src/routes-prompts.ts` | C | new |
| `apps/server/src/deck-slash-commands.ts` | C | edit |
| `apps/web/src/views/PromptsLibrary.tsx` | C | new |
| `apps/web/src/views/PromptsDiscover.tsx` | C | new |
| `apps/web/src/views/PromptsShare.tsx` | C | new |
| `apps/web/src/components/PromptEditor.tsx` | C | new |
| `apps/web/src/components/PromptSuggestions.tsx` | C | new |
| `apps/web/src/components/Composer.tsx` | C | edit |

---

## Risk register (single-pass, will revisit)

- **Anthropic plugin install root cause** is still unverified; the §1 fixes
  (a)+(b)+(c) are robust regardless of which underlying SDK failure surfaces.
  Once B.2 ships, the next failed install will produce a plain-English error
  pinpointing the step.
- **`/api/discovery/stream` SSE**: Hono's `streamSSE` needs `Set-Cookie`
  bypass and a flush strategy. Reuse the existing WS hub's flush semantics
  (`ws.ts:151`). If Bun's HTTP server can't flush mid-frame, fall back to
  WebSocket-only updates.
- **TF-IDF over 200 prompts**: server is already aggregating per-session
  events (`auth/store.ts:189-228`). The TF-IDF corpus lives in memory and is
  ~few KB. #ponytail: no need to precompute; recompute on each `/recommend`
  call. Add cache when recompute > 50ms.
- **MCP health probe storm**: 30s interval × N servers is cheap. Throttle
  the WS broadcast to 1/sec across all servers (per-frame-type throttler in
  B.14). No need for backoff logic.

---

verified:
READ in full: `apps/web/src/views/MarketplaceView.tsx` (664 lines);
`apps/server/src/marketplace-service.ts` (213 lines);
`apps/server/src/marketplace-extras.ts` (192 lines);
`apps/server/src/routes-marketplace.ts` (110 lines);
`apps/server/src/skills-service.ts` (338 lines);
`apps/server/src/skills-watcher.ts` (115 lines);
`apps/server/src/routes-skills.ts` (47 lines);
`apps/server/src/auth/guard.ts` (194 lines);
`apps/server/src/auth/store.ts` (333 lines);
`apps/server/src/broadcast-bus.ts` (54 lines);
`apps/server/src/ws.ts` (436 lines);
`apps/server/src/index.ts` (469 lines, key sections only);
`apps/server/src/routes.ts` (relevant mounts only);
`apps/server/src/routes-slash-commands.ts` (key sections);
`apps/web/src/views/ChatView.tsx` (26 lines);
`apps/web/src/lib/store.ts` (ChangeCounter + frame handlers);
`apps/web/src/lib/marketplace-api.ts` (full);
`apps/gholam/src/index.ts` (386 lines);
`apps/gholam/src/mcp-clients.ts` (127 lines);
`packages/protocol/src/index.ts` (KNOWN_TOOLS, ServerFrame,
BroadcastFrame, REST shapes — section-by-section);
`agent-defaults/mcp.json.tmpl` (92 lines, full);
`agent-defaults/README.md` (73 lines, full);
`docs/STUDIO.md` (455 lines, full);
`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/marketplace/manager.ts`
(installPlugin flow, addMarketplace flow);
`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/marketplace/source-resolver.ts`
(source dispatch table);
`node_modules/@oh-my-pi/pi-coding-agent/src/extensibility/plugins/marketplace/fetcher.ts`
(cloneAndReadCatalog);
`node_modules/@oh-my-pi/pi-coding-agent/src/utils/git.ts` (clone signature).

Summaries only: `apps/server/src/kb-service.ts` (referenced from
storefront seed); `apps/server/src/git-service.ts` (reuse signal for
recommendation); `apps/server/src/deck-slash-commands.ts` (registry
load point for `/prompts-recommend`).

External web search used once: confirmed
`anthropics/claude-plugins-official` is the Anthropic-managed catalog,
self-named `claude-plugins-official` in `marketplace.json`, installable via
`/plugin install <plugin>@claude-plugins-official`. Source confirmed in
web_search results (5 sources, primarily github.com and the Claude Code
docs at code.claude.com).
