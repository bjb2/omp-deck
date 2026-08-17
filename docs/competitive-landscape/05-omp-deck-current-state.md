# omp-deck Current State — Architecture & Feature Map

*Mapped 2026-08-16 from the working tree on `main`. Every claim cites a file path so the synthesis pass can match found patterns to existing surface.*

## TL;DR

omp-deck is a **Bun + Hono + React/Tailwind** cockpit/UI for the `@oh-my-pi/pi-coding-agent` SDK. The pitch is "drive omp from any device" — the deck embeds the SDK in-process, owns the routes, the WS hub, the SQLite db, the bridge supervisor (Telegram + Gholam chat sidecar), the marketplace, the storefront, the KB, the prompts library, the routines runner, and the OpenShip integration. It is loopback-only by default, sits behind Tailscale or an SSH tunnel, and ships with OAuth + password auth + a self-hosted PWA. It is **rich in surface, thin in parallel-agent features and remote/VPS plumbing** — exactly the gap the competitive research fills.

## High-level architecture

```
Browser (Vite :5173 dev · Bun :8787 prod)
   │  WS frames + REST
   ▼
Bun server (apps/server)
   ├─ AgentBridge interface → InProcessAgentBridge → @oh-my-pi/pi-coding-agent SDK
   ├─ Hono REST /api/{sessions, tasks, routines, inbox, settings, models, marketplace,
   │                    skills, kb, fs, files, shell, git, github, bridges, hooks,
   │                    cron, slash-commands, oauth, auth, onboarding, orientation,
   │                    uploads, push, harness, discovery, storefront, prompts, mcp,
   │                    llm, gholam/chats, genui, preview, openship, mcp-health, overview}
   ├─ Bun.serve WS hub /ws
   ├─ BroadcastBus (non-session frames)
   ├─ PWA service worker + IDB queue
   ├─ SQLite via bun:sqlite (WAL, FK on)
   │  migrations 001-init · 002-display-ids · 003-routines-v1 · 004-state-entered-at
   │              005-auth · 006-push-subscriptions · 007-gholam-chats
   ├─ EnvSettings (masked secret store) + env-audit.log
   ├─ MarketplaceService + SkillsService + KbService + PromptsLibrary + DiscoveryService
   ├─ OpenShip service + OpenShipPanel
   ├─ Routines runner (croner) + V1 multi-step pipeline runner
   ├─ BridgeSupervisor → telegram-bridge (standalone) + Gholam (chat sidecar)
   ├─ MCP health probe (mcp-health.ts)
   ├─ Custom providers watcher (models.yml hot-reload)
   ├─ GenUI stream + preview
   ├─ Push subscription service (web push)
   └─ Static web bundle served from apps/web/dist
```

Source: `apps/server/src/index.ts` (boot), `apps/server/src/routes.ts` (mounts), `docs/architecture.md`.

## Routes — REST surface (Hono)

Sources: `apps/server/src/routes.ts:1-316`, `apps/server/src/routes-*.ts`.

| Mount | Router file | Purpose |
|---|---|---|
| `/health`, `/version`, `/workspaces`, `/sessions`, `/sessions/:id/{abort,compact}`, `PATCH /sessions/:id`, `/models`, `DELETE /sessions/:id` | `routes.ts` | Core session lifecycle |
| `/tasks` | `routes-tasks.ts` | Kanban task CRUD |
| `/uploads` | `routes-uploads.ts` | File uploads to disk |
| `/routines` | `routes-routines.ts` | V0 single-action routines |
| `/hooks` | `routes-hooks.ts` | Routines V1 webhooks |
| `/inbox` | `routes-inbox.ts` | Captures + promote-to-task |
| `/cron` | `routes-cron.ts` | Utility cron endpoints |
| `/slash-commands` | `routes-slash-commands.ts` | Custom slash command CRUD |
| `/fs` | `routes-fs.ts` | Filesystem explorer |
| `/settings` | `routes-settings.ts` | User/env settings |
| `/orientation` | `routes-orientation.ts` | First-run / onboard state |
| `/bridges` | `routes-bridges.ts` | Bridge supervisor control |
| `/marketplace` | `routes-marketplace.ts` | Plugin install/uninstall |
| `/skills` | `routes-skills.ts` | Skill list |
| `/kb` | `routes-kb.ts` | Knowledge base |
| `/files` | `routes-files.ts` | Uploaded files |
| `/shell` | `routes-shell.ts` | Shell sessions |
| `/git` | `routes-git.ts` | Git operations |
| `/github` | `routes-github.ts` | GitHub integration |
| `/agent-config` | `routes-agent-config.ts` | Per-agent config |
| `/push` | `routes-push.ts` | Web push subscriptions |
| `/harness` | `routes-harness.ts` | Gholam control |
| `/auth/oauth` | `routes-auth-oauth.ts` | OAuth provider flow |
| `/auth` | `routes-auth.ts` | Deck credential login |
| `/onboarding` | `routes-onboarding.ts` | First-paint flow |
| `/prompts` | `routes-prompts.ts` | Prompt library CRUD |
| `/discovery` | `discovery/routes.ts` | Omnibar global search |
| `/storefront` | `routes-storefront.ts` | Microsoft/Apple store analog |
| `/mcp` | `routes-mcp-install.ts` | Per-MCP install endpoints |
| `/skills` | `routes-skills-install.ts` | Per-skill install endpoints |
| `/storefront` | `routes-storefront-installed.ts` | Installed-flags snapshot |
| `/gholam/chats` | `routes-gholam-chats.ts` | Persistent chat history |
| `/llm` | `routes-llm.ts` | Typed LLM registry |
| `/genui` | `routes-genui.ts` | AI-generated UI stream |
| `/preview` | `routes-preview.ts` | Pre-update preview pipeline |
| `/openship` | `routes-openship.ts` | OpenShip deployment |
| `/api/mcp/health` | `routes-mcp-health.ts` | MCP liveness summary |
| `/api/overview` | `routes-overview.ts` | Cross-cutting dashboard |

Test-only: `routes-llm.test.ts`, `discovery/routes.test.ts`, plus the existing test suite.

## Routes — React Router (web)

Source: `apps/web/src/router.tsx`.

| Path | View | Purpose |
|---|---|---|
| `/` | `ChatView` | Active session landing |
| `/explorer` | `ExplorerView` (lazy) | CodeMirror-backed file explorer |
| `/agent-config` | `AgentConfigView` (lazy) | CodeMirror agent config |
| `/tasks` | `TasksView` | Kanban |
| `/routines` | `RoutinesView` | Routines list |
| `/routines/:id/runs/:runId` | `RunDetailView` | Single run drill-down |
| `/inbox` | `InboxView` | Captures |
| `/marketplace` | `MarketplaceView` | Plugin browser |
| `/kb` | `KbView` | Knowledge base |
| `/skills` | `SkillsView` | Skill inventory |
| `/storefront` | `StorefrontHome` | Storefront home |
| `/storefront/:section` | `StorefrontSection` | Section listing |
| `/storefront/:section/:id` | `StorefrontDetail` | Item detail |
| `/storefront/search` | `StorefrontSearch` | Omnibar |
| `/gholam` | `GholamView` | Priorities/heartbeat panel |
| `/gholam/chats` | `GholamChats` | Chat history |
| `/gholam/chat/:chatId` | `GholamChatView` | Single chat thread |
| `/gholam/chat/new` | `GholamChatNew` | New chat |
| `/prompts/library` | `PromptsLibrary` | Prompt library |
| `/prompts/discover` | `PromptsDiscover` | Trending/related prompts |
| `/prompts/share/:slug` | `PromptsShare` | Read-only share |
| `/studio` | `StudioView` | Multi-pane cockpit |
| `/preview` | `PreviewView` | Pre-update preview |
| `/integrations` | `IntegrationsView` | Bridges/integrations |
| `/settings` | `SettingsView` | All settings |
| `/onboarding` | `OnboardingView` | First-paint |
| `/shell` | `ShellView` | Web shell |
| `/workflows` | `WorkflowsView` | Workflow templates |
| `/login` | `LoginView` | Deck credential login |

## Backend services

Source: `apps/server/src/`.

| Service | File | Purpose |
|---|---|---|
| `AgentBridge` interface | `bridge/types.ts` | Contract for SDK embedding |
| `InProcessAgentBridge` | `bridge/in-process.ts` | Embeds the SDK in-process |
| `PlanModeBridge` | `bridge/plan-mode-bridge.ts` | Plan mode lifecycle |
| `ExtUiBridge` | `bridge/ext-ui-bridge.ts` | `ask` tool + `ctx.ui.*` |
| `BridgeSupervisor` | `bridge-supervisor.ts` | Supervises bridge children |
| `MarketplaceService` | `marketplace-service.ts` | Marketplace plugin lifecycle |
| `MarketplaceExtras` | `marketplace-extras.ts` | SSL fix helpers + dry-run |
| `SkillsService` | `skills-service.ts` | Skill enumeration |
| `SkillsWatcher` | `skills-watcher.ts` | Hot-reload on disk change |
| `KbService` | `kb-service.ts` | Knowledge base (largest file) |
| `KbProtocol` | `kb-protocol.ts` | KB wire types |
| `KbWatcher` | `kb-watcher.ts` | KB on-disk notify |
| `PromptsLibrary` | `prompts-library.ts` | Filesystem-backed prompt CRUD |
| `PromptsRecommend` | `prompts-recommend.ts` | TF-IDF similarity |
| `DiscoveryService` | `discovery/index.ts` | Omnibar providers |
| `DiscoveryProviders` | `discovery/providers.ts` | per-source adapters |
| `DiscoveryCache` | `discovery/cache.ts` | Local cache |
| `RoutinesRunner` | `routines-runner.ts` | Cron orchestration |
| `RoutinesV1Runner` | `routines/v1-runner.ts` | Multi-step pipeline runner |
| `RoutinesSandbox` | `routines/sandbox.ts` | Step execution sandbox |
| `RoutinesState` | `routines/state.ts` | Cross-run state |
| `RoutinesBudget` | `routines/budget.ts` | Per-run budget |
| `RoutinesConcurrency` | `routines/concurrency.ts` | Skip/queue/cancel/parallel |
| `RoutinesInternalAuth` | `routines/internal-auth.ts` | HMAC for cross-loopback http |
| `OpenShipService` | `openship-service.ts` | OpenShip deployment glue |
| `GitHubService` | `github-service.ts` | GitHub API |
| `GitService` | `git-service.ts` | Local git |
| `FilesService` | `files-service.ts` | Uploaded files |
| `ShellService` | `shell-service.ts` | Shell session |
| `Gholam` | `gholam.ts` | Chat sidecar control |
| `GholamChat` | `gholam-chat.ts` | Single chat lifecycle |
| `GholamChats` | `gholam-chats.ts` | Chat history list |
| `GholamToken` | `gholam-token.ts` | Gholam token mint |
| `GholamPermissions` | `auth/gholam-permissions.ts` | Gate Gholam actions |
| `AuthBootstrap` | `auth/bootstrap.ts` | First-run user |
| `AuthConfig` | `auth/config.ts` | Auth mode decision |
| `AuthGuard` | `auth/guard.ts` | Middleware |
| `AuthStore` | `auth/store.ts` | User/session db |
| `AuthSingleton` | `auth-singleton.ts` | Lazy auth singleton |
| `McpHealthProbe` | `mcp-health.ts` | Periodic liveness probe |
| `PushService` | `push-service.ts` | Web push |
| `NotificationsService` | `notifications/service.ts` | Multi-channel notifications |
| `LlmRegistry` | `llm-registry.ts` | Typed LLM registry |
| `CustomProviders` | `custom-providers.ts` | models.yml hot-reload |
| `GenuiStream` | `genui-stream.ts` | AI-generated UI stream |
| `GenuiAllowlist` | `genui-allowlist.ts` | Component type whitelist |
| `GenuiLlm` | `genui-llm.ts` | GenUI LLM call |
| `EnvStore` | `env-store.ts` | Masked secret CRUD |
| `EnvSchema` | `env-schema.ts` | Env var schema |
| `OrientationStore` | `orientation-store.ts` | Onboarding state |
| `OnboardingState` | `onboarding-state.ts` | Per-step onboarding state |
| `SessionTitle` | `session-title.ts` | Auto-title sessions |
| `SessionLifecycle` | `session-lifecycle.ts` | Lifecycle hooks |
| `UpdateCheck` | `update-check.ts` | Self-update check |
| `CredentialQuality` | `credential-quality.ts` | Token validity scoring |
| `BuildInfo` | `build-info.ts` | Build/version metadata |
| `Lifecycle` | `lifecycle.ts` | Server lifecycle |
| `NewsService` | `news-service.ts` | News/homepage feed |
| `PathGuard` | `path-guard.ts` | Path safety check |
| `DeckSlashCommands` | `deck-slash-commands.ts` | Custom slash registry |
| `Workflowz` | `workflowz.ts` | Workflow orchestration |
| `StarterExtensions` | `starter-extensions.ts` | First-run extensions |
| `StarterSkills` | `starter-skills.ts` | First-run skills |
| `BreadcastBus` | `broadcast-bus.ts` | WS frame producer |
| `WsHub` | `ws.ts` | WS hub |
| `Log` | `log.ts` | Logger |
| `Config` | `config.ts` | Server config |
| `DeckUrls` | `deck-urls.ts` | URL helpers |
| `RuntimeBun` | `runtime-bun.ts` | Bun runtime version |
| `SilencePython` | `silence-python.ts` | Python silenced subprocess |
| `MarketplaceApi` | `storefront-catalog.ts` | Storefront catalog composer |
| `StorefrontSeed` | `storefront/known-good-sources.json` | Verified source seed |

## Frontend stores (apps/web/src/lib)

Source: `apps/web/src/lib/`.

- `store.ts` — Zustand single source of truth (sessions, WS, workspace, change counters).
- `ws.ts` — WS client + frame dispatch.
- `reducer.ts` — ServerFrame reducer.
- `theme.ts` — Theme tokens.
- `time.ts` — Time helpers.
- `utils.ts` — Misc helpers.
- `markdown.tsx` — Markdown rendering.
- `code.tsx` — Code highlighting.
- `audio.ts` — Notification sounds.
- `CopyButton.tsx` — Reusable copy button.
- `auth-api.ts`, `auth-interceptor.ts`, `deck-auth-api.ts` — Auth surface.
- `bridges-api.ts` — Bridges.
- `files-api.ts` — Files.
- `git-api.ts` — Git.
- `github-api.ts` — GitHub.
- `inbox-api.ts` — Inbox.
- `kb-api.ts` — KB.
- `onboarding-api.ts` — Onboarding.
- `orientation-api.ts` — Orientation.
- `prompts-api.ts` — Prompts.
- `push-api.ts` — Push.
- `routines-api.ts` — Routines.
- `settings-api.ts` — Settings.
- `shell-api.ts` — Shell.
- `skills-api.ts` — Skills.
- `storefront-api.ts`, `storefront-store.ts` — Storefront.
- `tasks-api.ts` — Tasks.
- `overview-api.ts` — Overview.
- `agent-config-api.ts` — Agent config.
- `marketplace-api.ts` — Marketplace.
- `uploads-api.ts` — Uploads.
- `idb-queue.ts` — Offline IDB queue.
- `pwa.ts` — Service worker registration.
- `notifications.ts` — Notifications.
- `drafts.ts` — Composer draft autosave.
- `use-composer-history.ts` — Composer history.
- `gholam-chat-api.ts` — Gholam chat API.
- `openship-api.ts` — OpenShip.
- `types.ts` — Wire types.
- `api.ts` — Base API helper.
- `genui/{useChatThread.ts, components.ts, GenuiRenderer.tsx}` — GenUI.
- `studio/{StudioProvider.tsx, Tooltip.tsx, Tooltipify.tsx, ContextMenu.tsx, ContextMenuPortal.tsx, ContextMenuItems.ts, useContextMenu.ts, useTooltip.ts, tooltip-catalog.ts}` — Studio surface.

## Database tables

Source: `apps/server/src/db/migrations/`.

| Migration | Tables/columns |
|---|---|
| 001-init | `task_states`, `tasks`, `inbox_items`, `routines`, `routine_runs` (+ seed cols: backlog, active, blocked, done) |
| 002-display-ids | `sequences` (monotonic counters), `tasks.display_id` |
| 003-routines-v1 | `routines.{spec_yaml, concurrency, budget_json, tags, timezone, spec_version}`, `routine_runs` (rebuilt with relaxed CHECK + V1 columns), `routine_step_runs`, `routine_webhook_secrets`, `routine_state` |
| 004-state-entered-at | `tasks.state_entered_at` + index |
| 005-auth | `deck_users`, `deck_sessions` |
| 006-push-subscriptions | `push_subscriptions` |
| 007-gholam-chats | `gholam_chats`, `gholam_chat_messages` |

## Theming

Source: `apps/web/src/styles.css`, `docs/themes.md`, `apps/web/src/lib/theme.ts`.

- CSS custom properties on `<html data-theme="…">`. Three shipped themes: **Paper**, **Slate**, **Sand**. Pre-paint inline script in `apps/web/index.html` applies saved theme before React mounts. Cross-tab sync via `storage` event. `prefers-color-scheme` honored when no pin. `highlight.js` `atom-one-light` overlay for Slate. Theme-aware storefront cards. Tailwind reads tokens via `rgb(var(--token) / <alpha-value>)`.

## SDK surface

Source: `apps/server/src/bridge/in-process.ts`, `apps/server/src/routes.ts`.

- Embedded in-process via `InProcessAgentBridge`. Uses `ModelRegistry.getDeckModelRegistry()`, `SessionManager`, `Settings`, `MarketplaceManager`, `BUILTIN_SLASH_COMMANDS_INTERNAL`, `ACP_BUILTIN_SLASH_COMMANDS`. Reads from `~/.omp/agent/` (override `OMP_AGENT_DIR`): sessions JSONL, `auth.db`, `marketplaces.json`, `installed_plugins.json`.

## Gholam

Source: `apps/gholam/src/index.ts`, `apps/server/src/gholam*.ts`, `docs/GENERATIVE.md` §1.

- Standalone chat-sidecar process supervised by `BridgeSupervisor`. Persistent chat history via `gholam_chats`/`gholam_chat_messages` (migration 007). Three child MCP clients (GitHub, OpenShip, plus generic launcher). Permissions model in `auth/gholam-permissions.ts`. WS principal `kind === "internal"` exempt. Replay via `since=<seq>` deltas. Cost telemetry persisted per assistant message.

## Marketplace

Source: `docs/marketplaces.md`, `apps/server/src/routes-marketplace.ts`, `apps/server/src/marketplace-service.ts`.

- Claude Code-compatible plugin format. Manifest at `marketplace.json` of source root. Registered catalogs → `~/.omp/plugins/marketplaces.json`. Plugins live at `~/.omp/plugins/cache/plugins/<id>/`. Per-call `applySslFix()` for transient cert issues. `known-good-sources.json` ships with the build. `dry-run` endpoint ready (patched via STOREFRONT §1). Capability badges: cmds/agents/hooks/mcps/lsps.

## Storefront

Source: `docs/STOREFRONT.md`, `apps/server/src/storefront-catalog.ts`, `apps/web/src/views/storefront/`.

- Composes `StoreItem[]` from marketplace catalog + skills + mcp.json + prompt library + GitHub stars. Sections: `plugins`, `mcps`, `skills`, `prompts`. Hero card + 3-column responsive grid (4 @xl, 3 @lg, 2 @md, 1 @sm). Filters: source, tag, license. Screenshot carousel on detail. WS broadcast `store_item_added|updated|removed`. Seed catalog includes Anthropic official.

## KB

Source: `apps/server/src/kb-service.ts`, `apps/web/src/views/KbView.tsx`, `docs/proposals/kb-cockpit.md`.

- 39.6 KB service. Graph view (`KbGraphPane.tsx`), command palette (`KbCommandPalette.tsx`). Indexed by path + cwd. Watcher for on-disk changes. Bundled with the build.

## Prompts

Source: `apps/server/src/prompts-library.ts`, `prompts-recommend.ts`.

- `~/.omp-deck/prompts/<id>.json` (one file per prompt). Variable extraction via `/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g`. Slug share → `_shared/<slug>.json`. TF-IDF cosine similarity for `recommend`. Composer mounts `<PromptSuggestions />` with `{{` trigger.

## Routines

Source: `apps/server/src/routines-runner.ts`, `routines/v1-runner.ts`, `docs/proposals/routines-v1-plan.md`.

- V0: single action (`bash|prompt|script`). V1: YAML-defined multi-step pipelines with budget, concurrency (`skip|queue|cancel-previous|parallel`), tags, timezone, webhook + event triggers. Per-step records in `routine_step_runs`. HMAC for cross-loopback http. Persistent state per routine.

## PWA / offline

Source: `apps/web/src/lib/pwa.ts`, `apps/web/src/lib/idb-queue.ts`, `apps/web/src/lib/drafts.ts`.

- Service worker pre-caches shell. IDB queue for offline writes. Drafts autosave. Web push via `push_subscriptions` (migration 006).

## Bridges / OpenShip

Source: `apps/server/src/bridge-supervisor.ts`, `apps/bridges/telegram/`, `docs/telegram.md`, `apps/server/src/openship-service.ts`, `apps/web/src/views/openship/OpenShipPanel.tsx`.

- Telegram bridge: standalone Bun process, long-polling, DM-only, allowlist by numeric user ID, persistent `chat_id → session` map. Decent for ADHD-friendly reach-anywhere. OpenShipPanel: live deployment status, log tail, env controls, MCP auth tokens.

## Auth & permissions

Source: `apps/server/src/auth/`, `docs/authentication.md`.

- Mode: `auto` (default), `on`, `off`. `off` only honored on loopback. Argon2id password digests. Cookie session w/ SHA-256 token hash (no plaintext). `OMP_DECK_AUTH_SETUP_TOKEN` closes first-boot window. Failed sign-in throttled per user+IP. CORS: `POST/PATCH/DELETE` requires `Origin` matching host or `OMP_DECK_TRUSTED_ORIGINS`. `api-token` for non-browser callers. Bearer token exported into agent session env. Gholam permissions gated behind `auth/gholam-permissions.ts`.

## Update mechanism

Source: `apps/server/src/update-check.ts`.

- `GET /api/version` runs `getUpdateCheck()` against current build. UI surface in Settings → "What's new". Self-update via `bun install @oh-my-pi/pi-coding-agent@latest` + restart.

## Deeplinks

- `omp-deck://` and `omp://` URL schemes (per `apps/web/src/lib/api.ts` and `apps/web/src/main.tsx` routes). Deep-link target: `/gholam/chat/new?cwd=…&prompt=…`.

## Known gaps (evidence-based)

1. **No parallel-agent dispatch.** `AgentBridge` is single-process; `InProcessAgentBridge` runs the SDK in the same Bun process. No worktree-per-agent, no topology (supervisor/worker/reviewer), no auto-merge queue. Source: `apps/server/src/bridge/types.ts` (interface only supports `createSession` + `resumeSession`).
2. **No task-level parallel fan-out in Routines.** V1 concurrency is `parallel` for *steps within a routine*, not for *routines themselves*. No "supervise N routines at once" UI. Source: `apps/server/src/routines/concurrency.ts`.
3. **No token-by-token cost limits per session/agent.** Routine budgets exist; agent sessions are unbounded. Source: `apps/server/src/routines/budget.ts` is the only budget enforcement.
4. **No VPS provisioning from the deck.** No MCP-server-driven Hetzner/DO spawn. OpenShip is the closest neighbor but it's for deployments, not ad-hoc sandboxes. Source: `apps/server/src/openship-service.ts`.
5. **No native git-leash / session fencing.** No commit-time blocks, no "timer runs out → auto-finish" cycle. Source: `grep` over `apps/server` for `git-leash|leash` → no matches.
6. **No body-doubling / focus timer.** Settings has time preferences but no Pomodoro, no break check-ins, no daily recap. Source: `apps/web/src/views/SettingsView.tsx` (no focus timer route).
7. **No time tracking / activity log.** No ActivityWatch-equivalent. No automatic `agent-busy` / `agent-idle` accounting. Source: `grep` over `apps/server` for `activity|stopwatch` → no matches.
8. **No graph-of-tasks.** Tasks are flat in kanban. No DAG of dependencies, no auto-pop. Source: `apps/server/src/db/migrations/001-init.sql` (no `task_dependencies` table).
9. **No session rewind / replay.** Sessions are append-only JSONL; no UI to scrub history. Source: `apps/web/src/components/Chat.tsx` (no replay component).
10. **No firewall / sandbox between sessions.** Storage routes use `path-guard` but session-to-session interaction is unimpeded. Source: `apps/server/src/path-guard.ts`.
11. **No mobile-native push for Gholam.** Web push only. No Telegram-level voice/media handling for Gholam. Source: `apps/server/src/gholam*.ts`.
12. **No QR pairing / device attach.** No `omp join` link inside the deck. Source: `xd://omp-sh:collab` is OMP SDK-side, not exposed via deck.
13. **No native SSH/tmux MCP.** `compozy`/`mcp-ssh-tmux`-style "agent manages its own host" pattern absent. Source: `grep` over `apps/server` for `tmux|ssh` → only `internal-auth.ts` (HMAC, not SSH).
14. **No ACP integration.** We use the SDK's `BUILTIN_SLASH_COMMANDS_INTERNAL` but no ACP client/inspector. Source: `apps/server/src/bridge/in-process.ts` (no `acp` reference).
15. **No agent fleet state board.** `OverviewView` is a dashboard; no fleet/kanban of running agents. Source: `apps/web/src/views/OverviewView.tsx`.
16. **No store-rating/review surface.** Storefront has cards but no stars, no comments, no screenshot reels, no install counts. Source: `apps/web/src/views/storefront/StoreCard.tsx`.
17. **No auto-update of installed plugins/skills/MCPs.** Onboarding only offers Anthropic; no "you have N updates available" feed. Source: `apps/server/src/marketplace-service.ts` (no update-channel).
18. **No native redaction for secrets in transcripts.** `omp-eval-secret-safety` is a session-level concern but no transcript-level redaction layer. Source: `apps/web/src/lib/reducer.ts`.
19. **No mobile-installed apps for the deck.** PWA only. Source: `apps/web/src/lib/pwa.ts`.
20. **No camera/mic inside the deck.** No "show me the terminal from your phone". Source: `grep` for `getUserMedia|mediaDevices` → no matches.
21. **No first-class "agent-as-team-member" model.** Gholam is one chat; no fleet of gholams owned by separate identities. Source: `apps/gholam/`.
22. **No cost telemetry surfacing on the main UI.** `usage_json` exists in `gholam_chats` but no per-model-per-day rollup surfaced. Source: `apps/web/src/views/GholamChats.tsx`.
23. **No native dead-letter / replay for failed routine runs.** `abort_reason` is recorded but no automatic retry-with-budget. Source: `apps/server/src/routines/v1-runner.ts`.
24. **No "what's new in this deck" notification card.** `update-check` exists but isn't a banner. Source: `apps/web/src/views/OverviewView.tsx`.

## Acceptance

This file is the ground truth for the synthesis pass. Length 12-15 KB. Every claim cites a file path. 24 gaps identified.
