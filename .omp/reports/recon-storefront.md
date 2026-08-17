# Storefront / Marketplace / Skills / MCPs / Agents / Plugins — Recon

Scope: catalog surfaces end-to-end. Read-only inspection of `apps/server/src/`, `apps/web/src/`, `packages/protocol/src/`, `agent-defaults/`, `starter-skills/`, `starter-extensions/`, `scripts/`, `docs/`, `CHANGELOG.md`. Git log used to gauge stub vs. live.

---

## 1. Catalog endpoints today

All mount under `/api` (orchestrator in `apps/server/src/index.ts:264-268` strips the prefix before Hono routing). Mount table in `apps/server/src/routes.ts:382-436`.

### Storefront (read-only catalog composition)
| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/storefront/featured` | `{ items: StoreItem[] }` (criteria: id ends `@anthropic` or `isNew:true`; fallback to top by installs) | `routes-storefront.ts:38-44` |
| GET | `/storefront/trending` | `{ items: StoreItem[] }` sorted by `installs` desc | `routes-storefront.ts:46-50` |
| GET | `/storefront/new` | `{ items: StoreItem[] }` filtered `lastUpdated >= now-7d` | `routes-storefront.ts:52-58` |
| GET | `/storefront/section/:section` | `{ items: StoreItem[] }` section ∈ {plugins, mcps, skills, prompts} | `routes-storefront.ts:60-66` |
| GET | `/storefront/section/:section/:id` | `{ item: StoreItem }` | `routes-storefront.ts:68-80` |
| GET | `/storefront/installed` | `{ installed:{plugins:string[],skills:string[],mcps:string[]}, errors? }` | `routes-storefront-installed.ts:57-86` |

### Marketplace (SDK plugin catalog + CRUD)
| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/marketplace` | `{ sources, catalog, installed }` | `routes-marketplace.ts:135-143` |
| POST | `/marketplace/install` | `{ ok, installed }` / `InstallPluginErrorResponse` | `routes-marketplace.ts:145-169` |
| DELETE | `/marketplace/install/:pluginId` | `{ ok }` | `routes-marketplace.ts:171-181` |
| POST | `/marketplace/install/dry-run` | `DryRunInstallResponse` (manifest+clone+ref+sha) | `routes-marketplace.ts:183-205` |
| POST | `/marketplace/uninstall` | `{ ok }` (body: `{ id, scope? }`) | `routes-marketplace.ts:207-222` |
| POST | `/marketplace/refresh` | `{ ok }` | `routes-marketplace.ts:224-232` |
| POST | `/marketplaces` | `{ ok, marketplace }` (add source) | `routes-marketplace.ts:234-249` |
| DELETE | `/marketplaces/:name` | `{ ok }` | `routes-marketplace.ts:251-260` |
| POST | `/marketplace/plugins/:id/enabled` | `{ ok, id, enabled }` | `routes-marketplace.ts:262-281` |
| GET | `/marketplace/search` | `{ results: ScoredEntry[] }` (in `routes-harness.ts`) | `routes-harness.ts:165-175` |
| GET | `/marketplace/featured` | `{ results: ScoredEntry[] }` | `routes-harness.ts:177-181` |
| GET | `/marketplace/popular` | `{ results: ScoredEntry[] }` | `routes-harness.ts:183-187` |
| POST | `/marketplace/refresh` | `{ ok }` (second endpoint, same name) | `routes-harness.ts:189-197` |

### Skills
| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/skills` | `{ skills: SkillSummary[] }` (provider-grouped) | `routes-skills.ts:29-38` |
| GET | `/skills/:id` | `SkillDetailResponse` | `routes-skills.ts:40-52` |
| POST | `/skills/:id/enable` | `{ ok, skill }` | `routes-skills.ts:54-67` |
| POST | `/skills/:id/disable` | `{ ok, skill }` | `routes-skills.ts:69-82` |
| DELETE | `/skills/:id` | `{ ok, name, path }` | `routes-skills.ts:84-97` |
| POST | `/skills/:id/update` | `{ ok, path }` (body: `{ source }`) | `routes-skills.ts:99-121` |
| POST | `/skills/install` | `{ ok, name, path }` (body: `{ name, source?, scope?, cwd? }`) | `routes-skills-install.ts:65-105` |
| GET | `/skills/marketplace/search` | `{ results: SkillMPEntry[] }` (SkillsMP API) | `routes-harness.ts:200-205` |
| GET | `/skills/marketplace/featured` | `{ results: SkillMPEntry[] }` | `routes-harness.ts:207-210` |
| POST | `/skills/marketplace/install` | `{ ok, installedPath }` (SkillsMP) | `routes-harness.ts:212-222` |

### MCPs
| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/mcp/health` | `McpHealthResponse` | `routes-mcp-health.ts:9-15` |
| POST | `/mcp/install` | `{ ok, name }` (body: `{ name, config }`) | `routes-mcp-install.ts:131-196` |
| POST | `/mcp/:name/enable` | `{ ok, name, enabled }` | `routes-mcp-install.ts:198-218` |
| POST | `/mcp/:name/disable` | `{ ok, name, enabled:false }` | `routes-mcp-install.ts:220-240` |
| DELETE | `/mcp/:name` | `{ ok, name }` | `routes-mcp-install.ts:242-263` |
| POST | `/mcp/:name/update` | `{ ok, name }` | `routes-mcp-install.ts:265-301` |

### Discovery (cross-catalog omnibar)
| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/discovery/search` | `DiscoverySearchResponse` | `discovery/routes.ts:112-125` |
| GET | `/discovery/resolve` | `{ id, resolved, hit? }` | `discovery/routes.ts:127-139` |
| GET | `/discovery/stream` | SSE (`discovery_added`, `store_item_added`, `store_item_updated`, `store_item_removed`, `ping`) | `discovery/routes.ts:141-175` |
| POST | `/discovery/cache/purge` | `{ ok }` | `discovery/routes.ts:177-180` |

### WebSocket frames (cross-cutting)
`packages/protocol/src/index.ts:1158-1177`:
- `store_item_added`, `store_item_updated`, `store_item_removed` — pulses (`StorefrontDetail`/`StoreCard` consume via `storefrontPulse.byId` slice).
- `discovery_added` — fan-out of a fresh batch.
- `mcp_health` — periodic snapshot from `mcp-health.ts` watcher (driver of `McpHealthStrip`).
- `skills_changed` — emitted by `skills-watcher.ts`; clients (`SkillsView`) refetch.

### Agent registry
No dedicated agent install/registry API. Agents are managed two ways:
- Subagent definitions ship in `agent-defaults/agents/*.md` and are seeded at image start (see §5).
- `apps/server/src/routes-agent-config.ts` exposes generic CRUD over `OMP_AGENT_DIR` (list, read, write, delete, export, import/stage/apply/discard, backups). Not a catalog.
- No `/api/agents`, no `/api/agents/install`, no registry in `routes-marketplace.ts` for "agent" kind.

---

## 2. Registry sources

**Local file system only** is the primary source. Remote fetches are auxiliary.

| Surface | Source | Where |
|---|---|---|
| Marketplace plugin catalog | SDK `MarketplaceManager` reads JSON catalogs from `~/.omp/marketplaces.json` + clones each entry. Catalog lives under `marketplacesCacheDir` and `pluginsCacheDir`. Boot seeds `anthropics/claude-plugins-official.git` if registry empty (`index.ts:197-205`). | `marketplace-service.ts:35-44`, `index.ts:187-205` |
| Marketplace "known-good" verified badge | `apps/server/src/storefront/known-good-sources.json` (curated, ships in repo) | `storefront-catalog.ts:22`, `41-93` |
| Skills (read-only) | Local disk: `~/.omp/agent/skills/`, `<cwd>/.omp/skills/`, marketplace cache, plus `claude`, `codex`, `opencode`, `cursor`, `windsurf`, `cline`, `gemini` shared dirs | `SkillsService` (per `routes-skills.ts:1-17` docblock), `protocol SkillProvider` union L475-487 |
| Skill install (legacy path) | `skills/manage.ts` would fetch from SkillsMP REST API (`https://skillsmp.com/api/v1`) | `skillsmp.ts:22` |
| MCPs | Local `~/.omp/agent/mcp.json` (read & write through `mcp-health.ts` + `routes-mcp-install.ts`) | `routes-mcp-install.ts:51-63`, `storefront-installed.ts:35-49` |
| Discovery (omnibar) | Three external providers + one shared with SkillsMP. Each gated on env token; `GrepProvider` needs no key (hits `mcp.grep.app`). | `discovery/providers.ts:38-42`, `70-263` |
| Prompts | `~/.omp-deck/prompts/<id>.json` (separate from store) | `protocol Prompt` definition L2298-2323 |
| KB | `OMP_DECK_KB_ROOT` or `~/kb` (see `kb-service.ts`) | referenced from index.ts:35-37 |

**Both**: Skills/MCPs read from local disk; the marketplace adds a remote `git clone` path; SkillsMP and Discovery add JSON APIs. Anthropic's marketplace is the only canonical curated remote source (boot-seeded).

---

## 3. Install / uninstall / upgrade / delete paths

### Plugins (SDK format, "marketplace")
- **Install**: `POST /api/marketplace/install` → `MarketplaceService.install` → SDK `MarketplaceManager.installPlugin` → clone to `pluginsCacheDir/<marketplace>/<name>-<ver>/` + write `installed_plugins.json` + `registerRuntimePlugin`. `marketplace-service.ts:166-186`, `routes-marketplace.ts:145-169`.
- **Dry-run**: `POST /api/marketplace/install/dry-run` → clones to temp `.dryrun` under `pluginsCacheDir`, reads manifest, returns `{ manifest, cloneUrl, ref?, sha?, wouldCacheTo }`. Cleans up in `finally`. `marketplace-service.ts:195-241`.
- **Uninstall**: `DELETE /api/marketplace/install/:pluginId` AND `POST /api/marketplace/uninstall` (both routes exist, both work). `routes-marketplace.ts:171-181`, `routes-marketplace.ts:207-222`, `marketplace-service.ts:260-263`.
- **Enable/disable** (per-plugin): `POST /api/marketplace/plugins/:id/enabled` → `MarketplaceManager.setPluginEnabled`. `routes-marketplace.ts:262-281`, `marketplace-service.ts:307-310`.
- **Refresh**: `POST /api/marketplace/refresh` → `MarketplaceManager.updateAllMarketplaces`. `routes-marketplace.ts:224-232`. **Does NOT auto-upgrade** installed plugins (per `docs/marketplaces.md:80-89`).
- **Upgrade**: `POST /api/marketplace/install` with `force:true` reinstalls; `docs/marketplaces.md:85-89` explicitly notes "The deck's UI for upgrade is a follow-up." No `POST /api/marketplace/plugins/:id/upgrade` route exists; `docs/proposals/skills-cockpit.md:96-99` lists it as outstanding.
- **Add/remove marketplace source**: `POST /api/marketplaces` + `DELETE /api/marketplaces/:name`. `routes-marketplace.ts:234-249`, `251-260`.

### Skills
- **Install (omni)**: `POST /api/skills/install` (body: `{ name, source?, scope?, cwd? }`). `source` may be a URL (HTTP-fetched) or markdown text; missing source scaffolds a stub. Target: `~/.omp/agent/skills/<name>/SKILL.md` (user) or `<cwd>/.omp/skills/<name>/SKILL.md` (project). Safe-name regex `^[A-Za-z0-9._-]+$`. `routes-skills-install.ts:33-49`, `65-105`.
- **Install (SkillsMP path)**: `POST /api/skills/marketplace/install` (body: `{ slug, scope? }`) → fetches `https://skillsmp.com/api/v1/skills/<slug>` → downloads `archive_url` → writes to `~/.omp/agent/skills/<slug>/<manifest.path ?? SKILL.md>`. `skillsmp.ts:95-122`, `routes-harness.ts:212-222`.
- **Enable/disable**: posts to `/api/skills/:id/enable` / `/disable` flip `frontmatter.hide:` on SKILL.md. Refuses to touch skills owned by a marketplace plugin. `routes-skills.ts:54-82`.
- **Update**: `POST /api/skills/:id/update` re-writes SKILL.md from new source. `routes-skills.ts:99-121`.
- **Delete**: `DELETE /api/skills/:id` removes the dir. Refuses plugin-owned skills. `routes-skills.ts:84-97`.
- **No upgrade endpoint** (only reinstall via delete + install).

### MCPs
- **Install**: `POST /api/mcp/install` (body: `{ name, config: { type?, url?, command?, args?, env?, headers?, timeout?, enabled? } }`). Writes atomically (tmp + rename) to `~/.omp/agent/mcp.json`. `routes-mcp-install.ts:131-196`.
- **Update**: `POST /api/mcp/:name/update` merges existing entry. `routes-mcp-install.ts:265-301`.
- **Enable/disable**: `POST /api/mcp/:name/{enable,disable}` mutates `disabledServers[]`. `routes-mcp-install.ts:198-240`.
- **Delete**: `DELETE /api/mcp/:name` removes the entry + drops from disabled list. `routes-mcp-install.ts:242-263`.
- **No upgrade path** beyond update.

### Agents (subagent definitions)
- No dedicated install/uninstall/upgrade/delete API. Only ad-hoc file write/read through `/api/agent-config/write` (`routes-agent-config.ts:79-94`) and the export/import stage flow.
- `agent-config/import/stage` → `apply|discard` is a manual stage pipeline; not a catalog install. `routes-agent-config.ts:131-173`.

### Prompts
- No install path. CRUD over `~/.omp-deck/prompts/<id>.json` via `/api/prompts/library` (separate surface; not wired to Storefront install). `protocol Prompt` L2298-2323.

### Extensions
- **No install endpoint.** Seeded at boot only by `installStarterExtensions()` from `starter-extensions/` to `~/.omp/agent/extensions/<name>/`. Idempotent; never overwrites. `starter-extensions.ts:35-96`. Disable env: `OMP_DECK_INSTALL_STARTER_EXTENSIONS=0`.
- **No uninstall/delete.** User must remove the dir manually.

### Skills catalog bootstrap (separate from above)
- `apps/server/src/starter-skills.ts` copies `starter-skills/<name>/` into `~/.omp/agent/skills/<name>/` on boot. Idempotent. `OMP_DECK_INSTALL_STARTER_SKILLS=0` disables. `starter-skills.ts:41-102`.

---

## 4. Web UI surfaces

Route table in `apps/web/src/router.tsx:79-133`:

| Path | Component | Backing endpoint | Wired? |
|---|---|---|---|
| `/storefront` | `StorefrontHome` (featured/trending/new rows + `McpHealthStrip`) | `/storefront/{featured,trending,new}` + `/storefront/installed` + `/mcp/health` | **Live** — `StorefrontHome.tsx:32-84` |
| `/storefront/search` | `StorefrontSearch` (omnibar) | `/discovery/search` (and `safe-fallback` to empty) | **Live, no-op fallback** — `StorefrontSearch.tsx:24-43`; `meta.providers` is never populated (set to `[]` at L36) |
| `/storefront/:section` | `StorefrontSection` (grid + recent/popular/name sort) | `/storefront/section/:section` | **Live** — `StorefrontSection.tsx:21-34` |
| `/storefront/:section/:id` | `StorefrontDetail` (hero + InstallButton + RemoveButton + version history + capabilities) | `/storefront/section/:section/:id` | **Live** — `StorefrontDetail.tsx:23-40` |
| `/storefront` (alt embed) | `StorefrontPane` (studio pane wrapper, read-only flag) | same as `StorefrontHome` | **Live, read-only** — `studio/StorefrontPane.tsx:10-18` |
| `/marketplace` | `MarketplaceView` (sidebar + EntryCard + inspector + AddMarketplaceModalHost + dry-run) | `/marketplace`, `/marketplace/{search,featured,popular}`, `/marketplace/install(+dry-run)`, `/marketplace/uninstall`, `/marketplace/refresh`, `/marketplaces`, `/marketplace/plugins/:id/enabled` | **Live** — `MarketplaceView.tsx:36-203` |
| `/skills` | `SkillsView` (provider-grouped list + detail + enable/disable/remove) | `/api/skills`, `/api/skills/:id`, `/api/skills/:id/{enable,disable,update}`, `DELETE /api/skills/:id` | **Live, read-only for marketplace skills** — `routes-skills.ts:15-17` docblock; `MarketplaceView` is the install/uninstall surface |
| `/agent-config` | `AgentConfigView` (lazy) | `/api/agent-config/{list,read,write,delete,export,import,...}` | **Live but file-level** — not a catalog; see `routes-agent-config.ts` |
| `/prompts/library` | `PromptsLibrary` | `/api/prompts/library` | **Live but no install** — separate §4 STOREFRONT surface, not part of /storefront install pipeline |
| `/integrations` | `IntegrationsView` | (mcp+routines side-by-side) | not inspected in depth |

### Studio embed
- `apps/web/src/views/studio/StorefrontPane.tsx` mounts `StorefrontHome` in the studio multi-pane. The `readOnly` flag is declared (`L12`) but the wrapper currently forwards to the full home regardless.

### Recommendable gaps
- `/storefront/skills` and `/storefront/prompts` sections render empty (no `installAction` items for them). `StorefrontHome.tsx:90-105` filters them. Catalyst: `InstallButton.tsx:39-40` comment: "`skill`, `prompt` → unreachable (the catalog emits no such items)."
- No per-section grid view for Sections `kb` (KB is searchable from `/kb` directly, not surfaced under `/storefront`).
- No upgrades flow: `StorefrontDetail` flip from "Open" back to "Remove" only; `updateAvailable` dot is rendered but no upgrade action routes off it. `StoreCard.tsx:40-45`.

---

## 5. Seed content

### `starter-skills/` (bundled SKILL.md)
Copied to `~/.omp/agent/skills/<name>/` on every server boot (`starter-skills.ts:41-102`, called from `index.ts:142`). Never-overwrite idempotent contract.

- `create-skill/` — omp-native authoring loop (one new file, `create-skill/SKILL.md`).
- `handoff/`, `diagnose/`, `zoom-out/`, `prototype/{SKILL,LOGIC,UI}.md`, `grill-me/` — imported from `mattpocock/skills @ b8be62f` (MIT). Per-file footers + `ATTRIBUTION.md` index. `starter-skills/ATTRIBUTION.md`.
- `starter-skills/README.md` — explicitly notes overlap and non-bundled skills (caveman, write-a-skill, to-prd, etc.).

### `starter-extensions/` (bundled SDK extension)
- `maintenance-gate/index.ts` — the only starter extension. Copied to `~/.omp/agent/extensions/maintenance-gate/` on boot (`startup-extensions.ts:35-96`, `index.ts:143`). Per `maintenance-gate/index.ts:57-59` docblock.

### `agent-defaults/` (image-baked, seeded by `scripts/seed-agent-dir.sh`)
- `agents/*.md` — 27 subagent definitions (e.g. `engineering-frontend-developer.md`, `engineering-sre.md`, `engineering-code-reviewer.md`). Seeded by `scripts/seed-agent-dir.sh` (`copy_file` plain copy).
- `managed-skills/*.md` — 25 `skill://<name>` skills (e.g. `parallel-mcp`, `context7-mcp`, `github-mcp`, `deepwiki-mcp`, `openship`, `workflowz`, `security-quality`, `omp-operator`, `omp-eval-secret-safety`, `omp-secret-redaction-safety`).
- `extensions/combo-toggle/`, `extensions/caveman-session/`, `extensions/rtk-session/`, `extensions/ai-addons-updater/`, `extensions/orca-*.ts` — additional SDK extensions.
- `rules/caveman.md`, `rules/rule.md`, `RULES.md`, `AGENTS.md`, `WATCHDOG.md`, `WATCHDOG.yml` — standing instructions.
- `*.tmpl` — `mcp.json.tmpl`, `models.yml.tmpl` carrying `${VAR}` placeholders; rendered at container start. `agent-defaults/README.md:26-49`.
- `smithery.json` — Smithery registry config (API key in plaintext, **must be redacted before publishing**; `agent-defaults/smithery.json:2`).
- `config.yml` — full agent config (300+ lines, run-mode defaults).

### `scripts/seed-agent-dir.sh`
- Idempotent, never-overwrites existing files. `OMP_DECK_SEED_FORCE=1` to re-apply.
- Walks `agent-defaults/` for files/directories, copies them in; renders `*.tmpl` from env vars.

### Load-bearing?
- `starter-skills/`: yes — without `create-skill` the deck has no native authoring entry point. Provider `native` (`SkillProvider` union L475) is the home for them.
- `starter-extensions/maintenance-gate`: yes — explicitly referenced by `index.ts:104-117` and the Settings → Orientation panel; its presence is what enables the turn-end capture prompt.
- `agent-defaults/`: yes for the `mcp.json.tmpl`/`models.yml.tmpl` credentials, the `managed-skills/` (which feed `skill://<name>` paths), and the `extensions/*` (additional SDK extensions). Without `seed-agent-dir.sh`, the image starts empty and the deck has no MCP servers, no model routing, no rules.

---

## 6. Permission / safety

Confirmation checks found in the install/write paths:

| Check | Where |
|---|---|
| Skill name safe charset `^[A-Za-z0-9._-]+$`, rejects `.`/`..` | `routes-skills-install.ts:33-40` |
| Skill install scope path resolution: `user` → `~/.omp/agent/skills/<name>/`; `project` → `<cwd>/.omp/skills/<name>/` | `routes-skills-install.ts:42-49` |
| Skills won't mutate plugin-owned skill (`skill not found or owned by plugin` 404) | `routes-skills.ts:60, 75, 90` |
| Atomic write (tmp + rename) for both SKILL.md and `mcp.json` | `routes-skills-install.ts:95-97`, `routes-mcp-install.ts:65-70` |
| MCP config sanity: must declare `command` (stdio) or `url` (http) | `routes-mcp-install.ts:146-160` |
| Marketplace SSL CA bundle wiring (`applySslFix` + per-call `ensureSslFix`) + the `GIT_SSL_NO_VERIFY=true` opt-out | `marketplace-extras.ts:148-203`; per-call `marketplaceService.install/addMarketplace/dryRun` |
| Marketplace install error translation (codes: `marketplace_not_found`, `plugin_not_found`, `already_installed`, `git_clone_failed`, `ssl_ca_failed`, `unsupported_source`, `install_failed`) | `routes-marketplace.ts:31-131` |
| Marketplace registry seed is non-fatal: network/SSL failures `log.warn` + swallow (HTTP listener still opens) | `index.ts:196-205` |
| Dry-run install clones to temp `.dryrun` under `pluginsCacheDir`, cleans up in `finally` regardless of manifest-read outcome | `marketplace-service.ts:195-241` |
| Starter installers never overwrite user-edited targets (idempotent contract) | `starter-skills.ts:75-78`, `starter-extensions.ts:69-72` |
| Auth gate on all `/api/*` (and `/ws`, `/uploads/`, `/oauth/callback`) by `index.ts:230-255`. `isPublicApiPath` exempts a small list. | `index.ts:230-255` + `auth/guard.ts` |
| Cross-origin rejection at `Bun.serve` fetch before Hono | `index.ts:238-244` |

**Not present:**
- No signature/hash verification on plugin or skill content (inc. `n`/`prefix`/commit pin). The SkillsMP path trusts the upstream `archive_url` byte-for-byte. `skillsmp.ts:108-117`.
- No dependency audit on install (npm-resolution, package-lock compare, etc.).
- No sandboxing/preview of the installed plugin before `registerRuntimePlugin`.
- No content-addressable cache for `StoreItem` payloads.
- `known-good-sources.json` is purely a UX "Verified" badge chip; it does not gate install. `storefront-catalog.ts:76-93`.
- `mcp.json` write does not validate the `command` is in the allowed-binary list; `cwd` is taken from body verbatim. `routes-mcp-install.ts:131-196`.
- Smithery API key committed in plaintext at `agent-defaults/smithery.json:2`. **Security smell** — must be rotated + moved to `.tmpl`.
- The `update_available` chip on `StoreCard` is purely visual; no upgrade endpoint exists. `StoreCard.tsx:40-45`; `docs/marketplaces.md:85-89` acknowledges "The deck's UI for upgrade is a follow-up."

---

## 7. Dead vs. live

### Live (confirmed by code + git log)
- **Storefront**: 5 endpoints (`/storefront/{featured,trending,new,section/:s,section/:s/:id}`) + `/storefront/installed`. `routes-storefront.ts:36-82`. Wired web UI + `StorefrontHome`/`StorefrontSection`/`StorefrontDetail`/`StorefrontSearch`. Born in commit `36e7b08` (Deck feature bundle). Untouched since `e6f8167` (Solo capabilities build-out).
- **Marketplace CRUD**: all 13 endpoints in `routes-marketplace.ts` + 3 in `routes-harness.ts`. Wired UI `MarketplaceView`. Boot seed in `index.ts:197-205`. Multiple commits: `cf6dab0 Marketplace: seed canonical catalog on boot; ensureSslFix in addMarketplace (A+B)`, `a36e299 feat: full OMP web workstation — overview, OpenShip REST, GitHub PR, marketplace CRUD, offline drafts`.
- **MCP**: `/mcp/health` + 5 CRUD endpoints. Boot probe loop runs. `mcp-health.ts` + `routes-mcp-install.ts`. Commits: `db5a3b5 web: union-by-id mcp_health reducer + chrome McpHealthBadge`, `6ad5e27 protocol: mcp_health broadcast carries the full snapshot`, `9b94198 MCP health: boot probe loop, broadcast per cycle, default to ~/.omp/agent`.
- **Skills (catalog)**: `/api/skills` + 5 mutation endpoints + SkillsMP. Wired `SkillsView`. Commits: `996fe44 feat(server): SkillsService + GET /api/skills + WS skills_changed (T-27)`, `1dcd184 feat(server): GET /api/skills/:pluginId/:skillName detail endpoint (T-28)`, `1e78204 feat(web): /skills two-pane view with WS live refresh (T-29)`, `2f460b9 refactor(skills): omp-native pivot + mobile master-detail (T-31)`.
- **Discovery omnibar**: 4 endpoints + SSE stream. `discovery/routes.ts`. `36e7b08`.
- **Starter install**: `starter-skills.ts` + `starter-extensions.ts`. `b4d8cea feat(starter-skills): import five Matt Pocock starters (T-82)`, `f07cd7f feat: ship omp-native create-skill starter (T-32)`, `7849ac9 feat: ship maintenance-gate omp extension as starter (T-41a)`.

### Partially live (wired but undersized)
- **Storefront MCP section**: `StoreItem.installAction.kind === "mcp"` items are sourced from `mcp.json` directly (`storefront-catalog.ts:128-147, 176-200`). The web `InstallButton` handles them via `mcpState` (enable/disable/remove), but a brand-new MCP install must go through the `/marketplace` UI or `POST /api/mcp/install`. `InstallButton.tsx:69-78, 122-156`.
- **Storefront skills + prompts**: `installAction.kind === "skill"|"prompt"` is **unreachable**. `InstallButton.tsx:39-40` documents it; `StorefrontSection` for `skills` returns empty rows.
- **Upgrade flow**: `updateAvailable` flag is computed (`storefront-catalog.ts:211`) and rendered (`StoreCard.tsx:40-45`), but no endpoint upgrades. `docs/marketplaces.md:85-89` and `docs/proposals/skills-cockpit.md:96-99` confirm follow-up.
- **Discovery search metadata**: `StorefrontSearch.tsx:36` blanks `meta.providers` despite the server returning `{ providersUsed, cacheHits, tookMs }`. Copy/paste leftover.

### Stubs / dead ends
- **Agents catalog**: no `/api/agents` endpoint. `InstallButton.tsx:39-40` "agents" not in list. `routes-agent-config.ts` is file-level, not catalog. `docs/proposals/skills-cockpit.md:96-99` lists Future Work; competitive survey `competitive-landscape/02-multi-agent-orchestration.md` calls out Herd's "commander marketplace" as an aspirational pattern.
- **Studio `StorefrontPane`**: `readOnly` flag declared (`studio/StorefrontPane.tsx:12`) but never actually switches behavior — always mounts `StorefrontHome`.
- **Asset enrichment**: `storefront-catalog.ts:149-220` has hard-coded `icon: ""`, `screenshots: []`, `ratings: { stars: 0, count: 0 }` for every marketplace entry. Cards render without copy; competitive landscape `06-storefront-ux-patterns.md` "Pattern 1/2/3" lists these as gaps.
- **Smithery path**: `agent-defaults/smithery.json` ships a hardcoded API key. Not a URL endpoint; the registry is referenced but `routes-harness.ts:200-222` exposes SkillsMP only, not Smithery. `docs/tui-parity.md:38` plans "Smithery search" feature as backlog.
- **Prompts installation**: `prompts` `StoreSection` is in the protocol (`StoreSection = "plugins" | "mcps" | "skills" | "prompts"`) and `FilterChips` shows it, but no item is ever produced for `installAction.kind === "prompt"`. `StorefrontSearch.tsx:75-90` accepts `section=prompts`; server returns empty hits because the catalog never emits them.

---

## 8. Ranked actions to make Storefront/Marketplace fully functional

1. **Wire the upgrade path.** Add `POST /api/marketplace/plugins/:id/upgrade` (mirror `MarketplaceManager.upgradePlugin`) and a `GET /api/marketplace/updates` endpoint. Add a "Update" button on `StorefrontDetail` that calls it, then refresh `/storefront/installed`. Closes the gap flagged in `docs/marketplaces.md:85-89` and `docs/proposals/skills-cockpit.md:96-99`.
2. **Promote skills + prompts to live install.** The protocol already declares `installAction.kind === "skill" | "prompt"` but the UI marks them unreachable. Two paths: (a) `StorefrontSection('skills')` should call `skillsMP.searchFeatured` and `SkillsMP.install` (`/api/skills/marketplace/install`) instead of the silent-empty store; (b) for prompts, expose `POST /api/prompts/library/import` through the storefront `InstallButton` so an item with `installAction.kind === "prompt"` actually installs.
3. **Drop the hardcoded `claude-sonnet-4@anthropic` seed.** `storefront-catalog.ts:100-126` ships a single hand-rolled `StoreItem` that the storefront "Featured" row relies on before the marketplace catalog arrives. It's a placeholder, not a real catalog entry. Replace by deriving Featured from the marketplace catalog itself once `waitFor catalog` resolves.
4. **Sign or pin content for SkillsMP + Marketplace plugin installs.** Both paths (SkillsMP `archive_url` byte download, Marketplace `git clone` from arbitrary URL) trust upstream with no hash/signature. Add at least a SHA-256 verification step on the payload before writing to disk (SkillsMP) and a `known-good-sources.json` "block" mirror (Marketplace) before `registerRuntimePlugin`. The `verified` badge exists in the protocol but is bypassed by the install path.
5. **Promote the discovery search `meta.providers` + `tookMs` thread.** `StorefrontSearch.tsx:36` blanks the metadata. Read the `DiscoverySearchResponse` shape (`{ hits, providersUsed, cacheHits, tookMs }`) and render the "X providers — Yms" footer; cheap, fixes a visible lie.
6. **Rotate the Smithery API key + template-ize it.** `agent-defaults/smithery.json:2` ships a live `smry_…` in plaintext. Move to `agent-defaults/smithery.json.tmpl` with `${SMITHERY_API_KEY}` and let `scripts/seed-agent-dir.sh` render it (the `.tmpl` machinery already exists for `mcp.json.tmpl` / `models.yml.tmpl`).
7. **Actually wire the `StorefrontPane` read-only mode.** Today `studio/StorefrontPane.tsx` ignores the `readOnly` flag. Either pay it off (suppress `InstallButton` clicks inside the studio, intercept link clicks) or delete the flag. Pick one — the dead parameter is exactly the kind of half-finished stub the report is supposed to kill.
