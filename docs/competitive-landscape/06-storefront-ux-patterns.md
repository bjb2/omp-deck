# 06 — Storefront / Marketplace UX Patterns

Research pass for elevating omp-deck's `/storefront` surface (image-free,
typographic Apple-store aesthetic — `StorefrontHome.tsx`, `StoreCard.tsx`,
`FilterChips.tsx`, `McpHealthStrip.tsx`, `InstallButton.tsx`,
`StorefrontDetail.tsx`, `marketplace-service.ts`) from "developer tool list"
toward a genuine multi-catalog store experience (Storefront + Marketplace +
Skills + MCP + Prompts + KB + Discovery). Dominant pattern across every
target studied: **curation beats chronology**. Every mature store (Apple,
Microsoft, Google Play, GitHub Marketplace, VS Code Marketplace, npm) layers
one algorithmic signal (installs/downloads/velocity) under one editorial or
trust signal (featured, verified, editor's choice) — raw lists never carry
discovery alone. omp-deck already has the algorithmic layer (`installs`,
`isNew`, `trending`); it lacks the trust/curation layer (verified badges,
screenshots, ratings, categories beyond the four top-level sections).

## Project entries

### Apple App Store
- **UI pattern**: "Today" tab splits editorial curation (hand-picked "App of
  the Day") from paid Search Ads cards; both render as full-bleed hero cards.
- **Card layout**: icon + name + subtitle pulled from metadata; ad cards
  additionally pull screenshots/video from a linked Custom Product Page for
  an animated background.
- **Filtering**: category tabs (Games, Apps) + charts (Top Free/Paid).
- **Install flow**: single tap "Get" → progress ring on the icon itself, no
  modal.
- **Ratings**: 5-star aggregate + count, review text below the fold.
- **Screenshots**: mandatory, device-scaled (6.9" iPhone size auto-scales
  down); must show the *actual shipping app* — fabricated UI is grounds for
  rejection.
- Source: [developer.apple.com/app-store/getting-featured](https://developer.apple.com/app-store/getting-featured/)

### Microsoft Store
- **UI pattern**: Fluent-Design curated shelves ("Essential Apps") sit beside
  algorithmic shelves ("Top Free", "Most Popular", "Top Trending") — same
  page, visually undifferentiated card style, different data source.
- **Card layout**: icon, name, publisher, star rating; MSIX-packaged apps get
  implicit trust signal (better system integration).
- **Filtering**: category + "particularly for Windows 11" tags.
- **Install flow**: inline "Get"/"Install" button with progress bar replacing
  the button label.
- **Ratings**: certification pass (security + policy checks) is a prereq for
  shelf placement, not just a display metric.
- Source: [Fluent Design principles](https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/design-principles)

### Google Play Store
- **UI pattern**: "Editor's Choice" badge (manual curation) layered over
  algorithmic "Trending"/"Top" charts driven by install velocity, retention,
  and crash rate (Android Vitals).
- **Card layout**: icon, name, category, star rating, install-count range
  (e.g. "100K+" — deliberately imprecise, unique-account based, not raw
  cumulative).
- **Filtering**: category + "For you" personalized rail.
- **Install flow**: single tap, no confirmation dialog; progress bar replaces
  button.
- **Trust layer**: **Data Safety** section — mandatory developer
  questionnaire disclosing what data is collected, whether shared with third
  parties, and whether encrypted in transit. Rendered as a structured label,
  not prose.
- Source: [Google Play Data Safety](https://support.google.com/googleplay/android-developer/answer/10787469)

### GitHub Marketplace
- **UI pattern**: category-browsable app cards (Code Quality, CI, Project
  Management) each showing logo + one-line value prop + feature card image.
- **Card layout**: logo, tagline, publisher, "Verified" badge (org-level, not
  app-level — requires domain ownership + 2FA + confirmed support email).
- **Filtering**: category taxonomy, free vs. paid toggle.
- **Install flow**: choose pricing plan (up to 10 tiers per listing) →
  permission-scope review (repos/issues/metadata) → install to
  account/org, optionally repo-scoped.
- **Pricing**: flat-rate or per-unit, USD-only, optional 14-day trial;
  GitHub owns billing/webhooks so publishers don't build payment infra.
- Source: [GitHub Marketplace docs](https://docs.github.com/en/apps/github-marketplace)

### npm registry
- **UI pattern**: search-first, no browsing shelves; relevance ranking blends
  keyword match with three historical scores — **Popularity**, **Quality**,
  **Maintenance** (the "QPM" bars, inspired by but not identical to
  `npms.io`).
- **Card layout** (search result row): name, description, weekly-download
  sparkline, last-publish date, license badge, TypeScript-types badge.
- **Filtering**: none beyond keyword + sort (relevance/downloads/date).
- **Install flow**: N/A — copyable `npm install <pkg>` command is the whole
  "install button."
- **Quality signals**: README presence, test coverage, dependency freshness,
  issue-resolution frequency feed the Quality/Maintenance scores; the CLI
  `npm search` is a much dumber lexical fallback distinct from the website.
- Source: [docs.npmjs.com](https://docs.npmjs.com/searching-for-and-choosing-packages-to-download)

### VS Code Marketplace
- **UI pattern**: single-column extension detail page; star rating + install
  count + verified-publisher checkmark cluster at the top, README renders
  inline as the body (screenshots/GIFs live inside the README, not a
  separate media reel).
- **Card layout** (search result): icon, name, publisher, install count,
  star rating — no screenshot thumbnail in the list view, only on detail.
- **Filtering**: category + tag facets in the sidebar.
- **Install flow**: single click, in-place progress, "Reload Required" toast
  on completion for extensions needing a restart.
- **Trust caveat (documented, not folklore)**: Microsoft's own security
  writeup notes the verified badge indicates *domain ownership only*, not
  code safety — recommends users check publisher history + last-update date
  as a "60-second review" before installing.
- Source: [VS Code extension runtime security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security), [Security & trust in VS Marketplace](https://developer.microsoft.com/blog/security-and-trust-in-visual-studio-marketplace/)

### Product Hunt
- **UI pattern**: daily ranked leaderboard; "Featured" (editorial pick) is
  the real gate — un-featured launches get near-zero visibility regardless
  of upvote count.
- **Card layout**: tagline (≤60 chars, benefit-driven) + hero
  image/demo-video carousel + maker comment thread.
- **Ranking signal**: weighted upvotes (verified long-time users count more;
  accounts <72h old are shadow-filtered), sustained hourly velocity beats a
  single morning spike, and substantive comments carry outsized algorithmic
  weight (roughly 40–50 upvotes' worth per the sourced writeup).
- **Roles**: ~79% of featured launches are now self-hunted; the "Hunter"
  role no longer confers ranking boost, only narrative/positioning advice.
- Source: search synthesis, no single canonical doc (Product Hunt does not
  publish its ranking algorithm)

### Docker Hub
- **UI pattern**: repository page = Overview (README) + Tags tab + optional
  Docker Scout security-scan tab; no card grid, single-item deep page.
- **Card layout** (search result): name, short description, pull count,
  star count, "Official Image" badge.
- **Filtering**: Docker Official Images / Verified Publisher / Sponsored OSS
  toggle facets.
- **Install flow**: copyable `docker pull <image>` command pinned top-right;
  Tags tab lists every version with digest + size + push date.
- **Trust layer**: "Official Image" badge = curated + security-scanned +
  co-maintained with upstream — the single strongest trust signal on the
  page, stronger than star count.
- Source: [Docker Hub Official Images](https://docs.docker.com/trusted-content/official-images/)

### Claude Code UI (siteboon/claudecodeui, "CloudCLI")
- **UI pattern**: not a store — a remote control panel (13.3k★) for driving
  Claude Code/Codex/Cursor CLI sessions from web/mobile; dashboard = chat +
  file explorer + project list, fully responsive down to mobile.
- **Relevant takeaway for omp-deck**: proves the "mobile-first session
  control" pattern is viable and popular for agent tooling, but it is *not*
  a discovery/install surface — no cards, ratings, or categories. Filed here
  as an anti-example of what NOT to imitate for the storefront specifically.
- Source: [github.com/siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)

### Harness Kanban (Orenoid/harness-kanban)
- **UI pattern**: Kanban board for dispatching containerized coding agents
  against issues; cards move To Do → In Progress → To Verify as agents work.
- **Card layout**: task/issue card, not an install card — no ratings feature
  confirmed in the source material (web search could not verify a
  ratings/dispatch UI beyond the basic column-board pattern).
- **Relevant takeaway**: the "card as unit of dispatched work" pattern (vs.
  "card as installable product") is the inverse of a storefront card —
  useful contrast, not a source of storefront patterns.
- Source: web search only, repository README not directly fetched;
  [github.com/Orenoid](https://github.com/Orenoid) — **flagged low-confidence**,
  see Open Questions.

### Orca (stablyai/orca)
- **UI pattern**: desktop "ADE" (46k★) for running a fleet of parallel
  coding agents in isolated git worktrees; not a storefront, but its
  multi-session dashboard is the closest present analog to a "catalog of
  running instances."
- **Relevant takeaway**: each worktree/session is presented as its own
  card-like unit with status, diff, and merge actions — the "session as
  product card" pattern. Confirms that agent-tooling users expect a grid of
  independently-actionable cards, reinforcing (not replacing) omp-deck's
  existing `StoreCard` grid model.
- Source: [github.com/stablyai/orca](https://github.com/stablyai/orca)

### awesome-cli-coding-agents (bradAGI)
- **UI pattern**: GitHub README-as-storefront — no live UI, pure markdown
  curation (1k★, 110+ projects) organized into category tables (Open-Source
  Tools, Platform Agents, Orchestration & Harnesses).
- **Card layout**: table row = name + one-line description + category tag;
  no images, no ratings — pure text density.
- **Relevant takeaway**: proves a well-organized taxonomy alone (no visuals)
  still drives discovery at meaningful scale; the omp-deck report should not
  over-index on visual richness at the expense of a clean category taxonomy.
- Source: [github.com/bradAGI/awesome-cli-coding-agents](https://github.com/bradagi/awesome-cli-coding-agents)

### CodeForge Agent / Soromi / MobileCLI / Dinotty
- **UI pattern**: fragmented ecosystem, not a unified marketplace. CodeForge
  is one agent inside the FFOLLOWME multi-agent platform (30+ agents,
  token-based pay-as-you-go — a *marketplace of agents*, distinct from
  omp-deck's *marketplace of tools/skills/MCPs*). Soromi is an
  infrastructure framework, not a storefront. MobileCLI and Dinotty are
  remote-session tools (mobile control, multi-device terminal sync) with no
  install/discovery UI of their own.
- **Relevant takeaway**: none of these four have a mature storefront UX
  worth imitating; they confirm the *category* (agent tooling ecosystems)
  but not the *pattern*. Treat as ruled out for this report.
- Source: web search synthesis; low individual-project confidence, see Open
  Questions.

## Cross-cutting patterns

1. **Curation over chronology** — every mature store layers an editorial or
   trust signal (Featured/Verified/Editor's Choice/Official Image) under the
   raw algorithmic list. (Apple, Play, Docker Hub, GitHub Marketplace)
2. **Featured hero carousel** — full-bleed rotating hero above the fold,
   distinct visual weight from grid cards. (Apple Today, Play Editor's
   Choice)
3. **Category rail / chips** — flat, non-nested category taxonomy as the
   primary filter, not a sidebar tree. (Play, GitHub Marketplace, VS Code)
4. **Dual popularity signal** — installs/downloads *and* a quality score
   (stars, ratings, or Q/M) shown together; neither alone is trusted.
   (npm QPM, VS Code installs+stars, Docker Hub pulls+stars)
5. **Verified badge ≠ safety** — every store that has one (VS Code, GitHub
   Marketplace, Google Play) documents it as an identity/domain check only,
   explicitly not a security guarantee — and pairs it with a "review before
   install" nudge.
6. **Screenshots inline, not separate media tab** — VS Code and npm render
   screenshots inside the README/description body; Apple/Play use a
   dedicated media carousel. Two valid patterns, chosen by content weight
   (docs-heavy tools inline; consumer apps carousel).
7. **In-place install with progress, no modal** — every native store
   replaces the CTA label with a progress indicator on the same card; no
   store studied uses a blocking install dialog.
8. **Trending / velocity ranking is separate from raw popularity** — "Top
   Trending" (recent install velocity) and "Most Popular" (cumulative) are
   always two distinct shelves, never merged into one sort. (Microsoft
   Store, Google Play)
9. **Install counts shown as ranges, not exact numbers, at consumer scale**
   — Google Play shows "100K+" not "103,482"; precision implies false
   confidence at scale. omp-deck's current `formatInstalls` (exact-to-1-decimal
   `1.2k`/`3.4M`) is closer to VS Code/npm's developer-tool convention
   (precise counts expected by a technical audience) — correct choice for
   this audience, not a gap.
10. **Structured trust label over prose disclosure** — Google Play's Data
    Safety section is a fixed-schema label, not a paragraph; users scan it
    in seconds. Directly applicable to MCP server permission scopes.
11. **Self-serve pricing tiers, platform-owned billing** — GitHub Marketplace
    handles payment/webhooks so publishers don't build billing (not directly
    applicable to omp-deck, which has no paid tier, but the *pattern* of
    "platform owns the transaction, publisher owns the content" maps to
    "deck owns install/uninstall, marketplace source owns the manifest").
12. **README-as-storefront works without visuals** — awesome-cli-coding-agents
    proves clean taxonomy + one-line descriptions drive discovery even with
    zero images; a fallback pattern for MCP/Skills entries that lack
    screenshots.
13. **Session/worktree as installable-unit card** — Orca's per-worktree
    dashboard card (status + diff + merge actions) generalizes the "card"
    concept beyond static catalog items to live, stateful units — relevant
    to omp-deck's MCP health strip and any future "running agent" surface.
14. **Ranking algorithms are opaque by design** — Product Hunt and Google
    Play both explicitly withhold their exact ranking formula to deter
    gaming; omp-deck's internal `trending`/`isNew` logic can stay simple
    without needing to publish or over-engineer a scoring formula.
15. **Post-install reload/restart nudge** — VS Code's "Reload Required" toast
    is the standard pattern for install actions with a listed-but-deferred
    side effect (extension needs a window reload); directly maps to
    "MCP server needs a health-probe restart after install."
16. **Domain/taxonomy segmentation ≠ visual differentiation** — Microsoft
    Store's curated and algorithmic shelves use *identical* card styling;
    only the shelf label communicates curation, keeping visual language
    consistent across trust levels.

## Anti-patterns

- **Fake urgency / manufactured scarcity** — "Only 3 left" patterns from
  e-commerce leaking into software stores erode trust fast; none of the
  legitimate stores studied use them.
- **Install count with no context** — a raw number without a comparison
  point (category median, "New" label for zero-install items) reads as
  either spam-inflated or dead.
- **Verified badge treated as a safety seal** — VS Code's own docs warn
  against this; a badge implying more security than it delivers is a
  documented trust failure mode.
- **Screenshots that don't match the shipping product** — explicit Apple
  App Store rejection ground; stale or aspirational screenshots destroy
  trust on first use.
- **No uninstall/removal path surfaced symmetrically with install** — every
  store studied treats install and remove as equal-weight actions in the
  same location; hiding "remove" behind a settings menu is a common
  complaint pattern in Play Store / VS Code user reviews.
- **Search with no relevance signal, pure alphabetical or chronological** —
  npm's CLI fallback search (lexical only) is called out by its own docs as
  inferior to the website's Q/P/M-weighted search; alphabetical/chronological
  sort as the *default* (not an option) is a discoverability anti-pattern.

## Patterns to apply to omp-deck

1. **Pattern**: Verified-source badge on `StoreCard`
   - **Slot**: Storefront (`StoreCard.tsx`) + Marketplace
     (`marketplace-service.ts`, `known-good-sources.json`)
   - **UX idea**: small badge next to `item.author.name` when the item's
     source marketplace matches an entry in `known-good-sources.json`
     (already exists server-side per `docs/STOREFRONT.md`); reuse that data,
     don't invent a new trust system.
   - **Effort**: XS — **Impact**: M
   - **Acceptance**: item from a known-good source renders a badge; item
     from an unverified/custom marketplace does not.

2. **Pattern**: Screenshot/preview reel on `StorefrontDetail`
   - **Slot**: Storefront (`StorefrontDetail.tsx`)
   - **UX idea**: optional image carousel above the description body, fed by
     a new `screenshots?: string[]` field on `StoreItem` (protocol addition);
     falls back to today's text-only layout when absent — no regression for
     existing catalogs.
   - **Effort**: M — **Impact**: L
   - **Acceptance**: item with `screenshots` populated shows a swipeable
     carousel; item without renders identically to current behavior.

3. **Pattern**: Structured permission/trust label (Data-Safety analog)
   - **Slot**: MCP (`routes-mcp-install.ts`, `mcp-health.ts`) surfaced on
     Storefront Detail for MCP-section items
   - **UX idea**: fixed-schema block — transports used, tools exposed,
     network access (local/remote), auth requirement — rendered as labeled
     rows, not prose, before install.
   - **Effort**: M — **Impact**: L
   - **Acceptance**: installing an MCP server shows the label block; label
     content matches the server's declared manifest capabilities.

4. **Pattern**: In-place install progress (replace CTA label)
   - **Slot**: Storefront (`InstallButton.tsx`)
   - **UX idea**: button text cycles Install → Installing… (with %/spinner
     from SSE progress, per `docs/STOREFRONT.md`'s existing realtime plan) →
     Installed/Open; no modal.
   - **Effort**: S — **Impact**: M
   - **Acceptance**: clicking Install never opens a dialog; button state
     reflects live install progress end-to-end.

5. **Pattern**: Post-install next-step hint
   - **Slot**: Storefront Detail + Skills/Prompts/MCP cross-section
   - **UX idea**: after successful install, a dismissible inline card: "Try
     it: <slash-command>" for skills, "Health: <probe status>" for MCP,
     "Open in chat" for prompts — one line, contextual to the section.
   - **Effort**: S — **Impact**: M
   - **Acceptance**: each of the four sections (Skills/MCP/Prompts/Plugins)
     shows a section-appropriate hint immediately after install completes.

6. **Pattern**: Trending vs. Popular as separate rows (already partially
   present — extend to real velocity math)
   - **Slot**: Storefront Home (`StorefrontHome.tsx`)
   - **UX idea**: keep existing Featured/Trending/New three-row layout, but
     define "Trending" server-side as install-velocity-over-7-days rather
     than a static/manual flag, matching the Play/Microsoft pattern of two
     distinct signals.
   - **Effort**: M — **Impact**: M
   - **Acceptance**: `marketplace-service.ts` computes a rolling velocity
     score; the Trending row reorders when velocity changes without a
     deploy.

7. **Pattern**: Category taxonomy beyond the four top-level sections
   - **Slot**: Storefront (`FilterChips.tsx`)
   - **UX idea**: within each section (Skills/MCPs/Prompts/Plugins), a
     second-level chip row (e.g. Skills → "design", "engineering",
     "research") sourced from existing skill/agent metadata categories
     already present in `agent-defaults/skills/`.
   - **Effort**: S — **Impact**: M
   - **Acceptance**: selecting a section shows relevant sub-category chips;
     selecting a sub-category filters the grid client-side.

8. **Pattern**: Uninstall surfaced symmetrically with install
   - **Slot**: Storefront Installed (`routes-storefront-installed.ts`) +
     `StorefrontDetail.tsx`
   - **UX idea**: on an already-installed item's detail page, the primary
     CTA becomes "Remove" in the same button position/style as "Install" was
     — not buried in a separate settings page.
   - **Effort**: XS — **Impact**: M
   - **Acceptance**: detail page for an installed item shows Remove in the
     primary CTA slot; removing updates state without a page reload.

9. **Pattern**: Cross-store linking ("Requires" / "Used with")
   - **Slot**: Storefront Detail, cross-section (Prompt ↔ MCP ↔ Skill)
   - **UX idea**: if a Prompt references an MCP server or Skill by name
     (already parseable from `prompts-library.ts` content), render a small
     "Requires: <MCP name>" chip linking to that item's detail page.
   - **Effort**: M — **Impact**: M
   - **Acceptance**: a prompt whose body references an installed/available
     MCP tool shows a linked requirement chip; clicking navigates to that
     MCP's detail page.

10. **Pattern**: Update-available indicator + changelog line
    - **Slot**: Storefront Installed
    - **UX idea**: badge on installed-item cards when a newer version exists
      (version comparison already implied by `StorefrontDetail`'s "version
      history list"); clicking shows a one-line "What's new" pulled from the
      source's changelog/release notes if available.
    - **Effort**: M — **Impact**: M
    - **Acceptance**: an installed item with a newer upstream version shows
      an Update badge; tapping it surfaces at least the version number
      even when no changelog text is available.

11. **Pattern**: Command-palette search across all stores
    - **Slot**: `StorefrontSearch.tsx` + `KbCommandPalette.tsx` (existing KB
      palette as the pattern to extend, per `KbView.tsx`)
    - **UX idea**: extend the existing KB command palette to also query
      Storefront items (Skills/MCP/Prompts/Plugins) by name/tagline, so one
      keyboard shortcut searches every catalog, not just KB entries.
    - **Effort**: M — **Impact**: L
    - **Acceptance**: invoking the command palette and typing a
      skill/MCP/prompt name (not just a KB doc title) surfaces and
      navigates to that Storefront item.

12. **Pattern**: Ratings/reviews deferred, install-count-as-quality-proxy
    kept explicit
    - **Slot**: Storefront (`StoreCard.tsx`)
    - **UX idea**: do **not** build a review/star-rating system (no
      reviewer pool exists yet to seed it credibly — see Open Questions);
      instead make the existing install count the sole quality proxy but
      pair it with recency ("Updated 3d ago") the way VS Code's 60-second
      review checklist recommends, since recency is cheap to compute and
      more honest than a synthetic rating.
    - **Effort**: XS — **Impact**: S
    - **Acceptance**: `StoreCard` shows last-updated relative time next to
      install count; no fabricated star rating is introduced anywhere.

## Open questions

- **Harness Kanban ratings/dispatch UI**: could not directly fetch
  `Orenoid/harness-kanban`'s README or live UI (GitHub MCP credentials were
  unavailable in this session; web search returned only inferred/adjacent
  project descriptions). Verify by reading the repo directly before citing
  it as a source of concrete card/rating patterns.
- **CodeForge/Soromi/MobileCLI/Dinotty**: none confirmed to have a
  storefront-relevant UI; treat as ruled-out unless a follow-up pass finds
  primary-source screenshots or docs.
- **agent-of-empires**: search results describe a PWA install-prompt
  pattern (standard browser "Add to Home Screen") but could not confirm
  specific storefront/catalog card treatment beyond that; low relevance to
  this report's card/rating/screenshot focus — verify if the user
  specifically wants PWA-install-prompt patterns applied to omp-deck.
- **omp-deck's own OpenShip marketplace integration**: `docs/marketplaces.md`
  exists but was not read in this pass (out of the explicit target list
  beyond a passing mention) — read it before implementing pattern #6 or #7
  above, since OpenShip's app catalog (`xd://mcp__openship_get_apps_catalog`)
  may already define a category taxonomy worth reusing rather than
  reinventing.
- **Reviews/ratings feasibility**: pattern #12 above deliberately defers a
  ratings system — confirm with the user whether a lightweight
  thumbs-up/down (not 5-star) is in scope before treating ratings as fully
  out of scope long-term.
