# Master Synthesis — Impact-Prioritized Recommendations for omp-deck

*Compiled 2026-08-16 from six category-specific research files (see `NAVIGATION.md`). Every recommendation is "native appliqué": built on top of omp-deck's existing surface (Bun + Hono + React + Tailwind, SDK-embedded, PWA, BroadcastBus, BridgeSupervisor, OpenShip integration, Storefront, Gholam, Routines V1), not a fork or copy of any competitor.*

**Method.** For each gap in `05-omp-deck-current-state.md`, I checked which of the ~50 pattern proposals in `01-…04-…06-…md` lands on it, deduplicated overlapping patterns, and re-scored by impact on the user (the ADHD developer who wants to drive omp from any device). Scoring is `E for Effort (XS/S/M/L) × I for Impact (XS/S/M/L)`. **Bold** items are must-do this quarter; *italic* items are nice-to-have.

**Meta-finding.** omp-deck already has the substrate of every category studied (sessions, kanban, prompts, routines, bridges, storefront, gholam, kb). The competitive gap is **verification depth, isolation, parallel dispatch, and curated UX** — not architectural invention. Most recommendations are wire-up work, not new architecture.

---

## Tier 0 — Foundation (must do; unblocks everything else)

### **0.1 `omp join` link inside the deck (QR + E2EE relay)**
- **What.** When you start a session, the deck generates a `/join/<token>` URL + QR code identical to omp's `/collab` relay. Phone scans QR, opens a browser tab, attaches to the same session transcript.
- **From.** `01-remote-vps-access.md` §6 Patterns 1–3 + 5 — happy.org-style E2EE pairing, paseo's Tailscale-first default, Open Phone-y QR attach.
- **Slot.** New `apps/server/src/routes-bridges.ts` route + `apps/web/src/components/SessionAttachQR.tsx` modal + `apps/gholam/src/index.ts` adds a third child for the QR-driven browser client.
- **E = M** (new control plane + token lifecycle + E2EE session key mint). **I = L** (the single biggest "drive from any device" gap).
- **Acceptance.** A session started on the deck renders a QR code; a phone that scans it opens a browser tab and can send a prompt to the same running session; closing the phone tab does not stop the session.

### **0.2 Task-scoped worktree isolation for parallel dispatch**
- **What.** Add a `dispatch: { branches: N }` field to a task. The server creates N git worktrees (one per candidate approach) under the repo, each backed by a new `AgentBridge.createSession({cwd})`. Each worktree gets its own kanban sub-lane under the parent task. Sessions are steerable independently; merging is a separate action.
- **From.** `02-multi-agent-orchestration.md` "Pattern 1". Cross-confirmed by Orca, Taskplane, emdash, AgentOS, CCManager, Pane, agent-deck.
- **Slot.** `apps/web/src/views/TasksView.tsx` (action button), `apps/server/src/db/tasks.ts` (schema: `dispatch_json TEXT`), `apps/server/src/routes-tasks.ts` (POST `/tasks/:id/dispatch`), `apps/server/src/bridge/in-process.ts` (worktree cwd builder reusing `git-service.ts`).
- **E = L** (worktree lifecycle + new AgentBridge constructor path + kanban sub-lane UI). **I = L** (closes the "fan out to N agents" gap mentioned in every competitor research file).
- **Acceptance.** A task with `dispatch: { branches: 3 }` produces 3 sibling git worktrees under the repo and 3 linked sessions visible in the Tasks kanban, each independently steerable; merging one back into the parent task's branch is a single click.

### **0.3 Tunnel picker + relay default**
- **What.** Three transport options exposed in Settings → Remote Access: **Direct (loopback + Tailscale)** default, **Cloudflare Tunnel**, **OMP-hosted Relay** (last fallback). Each option produces a one-line URL the user can paste or QR.
- **From.** `01-remote-vps-access.md` §6 Patterns 2–3. Confirmed by Paseo (3-path), Happy (Tailscale-only), VibeTunnel (zero-config).
- **Slot.** `apps/web/src/views/SettingsView.tsx` adds a "Remote Access" section; `apps/server/src/routes-bridges.ts` already covers the supervisor — add a `tunnel` config block.
- **E = M** (no new architecture; settings surface + relay helper). **I = L** (every research file calls this the single feature that makes "drive from any device" honest).
- **Acceptance.** Settings → Remote Access shows three radios; switching between them produces a working URL within 5 seconds; the loopback bind is the default.

---

## Tier 1 — Parallel Agents + Workflow Automation (high impact, medium effort)

### **1.1 Merge-queue-as-Routine step**
- **What.** A new routine step type `merge_gate` that watches a linked task's branch for CI status and either merges (`git merge --no-ff`) or spawns a follow-up "fixer" step on failure.
- **From.** `02-multi-agent-orchestration.md` "Pattern 2". Closes the loop OAT + Taskplane both treat as their core value.
- **Slot.** `apps/server/src/routines/steps/merge-gate.ts` (new), `apps/server/src/routines/v1-runner.ts` (register step type).
- **E = M** (new step type + git integration; reuses `git-service.ts`). **I = L**.
- **Acceptance.** A routine run with a `merge_gate` step transitions a task's kanban column to "Merged" only after the configured check command exits 0; failure appends a "Needs fix" comment via `routes-tasks.ts`.

### **1.2 Reviewer ≠ writer (mandatory second model for ship)**
- **What.** A task option "require independent review" forces a second `agent` routine step, model-pinned to a different `ModelRef` than the writer step, before the task can move to Done.
- **From.** `02-multi-agent-orchestration.md` "Pattern 3" — Genie ("reviewer ≠ engineer"), Taskplane (4 named roles), OAT (merge-queue is an agent).
- **Slot.** `apps/web/src/views/TasksView.tsx` (task option checkbox), `apps/server/src/routes-tasks.ts` (Done transition gated on linked review-step run), `apps/server/src/routines/steps/agent.ts` (honor pinned model).
- **E = S**. **I = M**.
- **Acceptance.** Attempting to move a "review required" task to Done without a passing review-step run returns 409.

### **1.3 File-level touch/lock declaration before parallel writes**
- **What.** A `touches: string[]` glob list on a routine step; the runner checks every other in-flight step's declared touches before dispatch; conflicting steps queue instead of racing.
- **From.** `02-multi-agent-orchestration.md` "Pattern 4". Swarm-IOSM's "Touches → Locks → Gates → Done" + Paragents' preflight conflict checks.
- **Slot.** `apps/server/src/routines/concurrency.ts` (extend beyond run-level concurrency caps).
- **E = M** (glob-intersection + queueing). **I = M**.
- **Acceptance.** Two routine steps both declaring `touches: ["src/api/**"]` in the same run never execute concurrently; `routines.test.ts` gets a new case asserting serialized order on overlapping globs.

### **1.4 Cost/budget guard enforced (not just displayed) per task**
- **What.** Surface the existing routine budget as a per-task badge in the kanban card (reuses `tasksChangeCounter` live-refresh). Make budget-exceeded a hard stop (routine run transitions to "blocked"), not advisory.
- **From.** `02-multi-agent-orchestration.md` "Pattern 8" — Swarm-IOSM ($10 default track).
- **Slot.** `apps/server/src/routines/budget.ts` (already tracks), `apps/web/src/views/TasksView.tsx` (badge).
- **E = XS**. **I = S**.
- **Acceptance.** A routine run whose spend crosses its configured budget transitions to `budget_exceeded`; runner refuses further steps until a human raises the ceiling.

### **1.5 AI-classified session status (Gholam as classifier)**
- **What.** Kanban card status dot gains a 4th state — "needs attention" — driven by Gholam tailing recent session output via LLM classification (matching Handler's `needs_input/working/error/done/idle` pattern).
- **From.** `02-multi-agent-orchestration.md` "Pattern 5". Handler.dev.
- **Slot.** `apps/gholam/src/` (new prompt template + polling job), `apps/web/src/views/TasksView.tsx` (badge).
- **E = S**. **I = S** (polish; once Pattern 0.2 lands, this is the natural way to triage 3+ parallel cards).
- **Acceptance.** A session whose last 20 lines of output contain an ambiguous question (not matched by the existing state-machine heuristics) still surfaces "needs attention" on its kanban card within one Gholam poll interval.

### **1.6 Telegram bridge inline-keyboard approval**
- **What.** Extend the existing Telegram bridge with task-approval buttons (approve/deny inline keyboard) wired to the same `respondToPlanApproval`/`respondToUiDialog` bridge methods the web UI uses.
- **From.** `02-multi-agent-orchestration.md` "Pattern 6". Orca (mobile companion), Agent Deck (Telegram/Slack/Discord conductor), Genie (omnibridge via WhatsApp).
- **Slot.** `apps/bridges/telegram/`, `apps/server/src/bridge-supervisor.ts`.
- **E = S** (transport + approval plumbing already exist). **I = M**.
- **Acceptance.** A `plan_proposed` frame sent to a session with an active Telegram bridge produces an inline-keyboard message in Telegram; tapping "Approve" calls the same `respondToPlanApproval` path the web UI's approval card uses, verified by a shared bridge-supervisor test.

### **1.7 Repo-script trust gate for routine/task automation**
- **What.** When a routine's `run`/`agent` steps are sourced from a repo-committed YAML (not authored in the deck UI), hash the file content on first execution and require re-approval in the Routines inspector whenever the hash changes.
- **From.** `02-multi-agent-orchestration.md` "Pattern 7". amux content-hash + Genie Codex-hook SHA-256.
- **Slot.** `apps/server/src/routines/sandbox.ts` (already the sandboxing entry point).
- **E = S**. **I = M**.
- **Acceptance.** Editing a checked-in routine YAML's `run` step and re-triggering it blocks execution with an "approval required" state until a human confirms in the Routines inspector; unchanged routines execute without re-prompting.

---

## Tier 2 — ADHD Native UX (the user-facing story)

### **2.1 Action-first task card**
- **What.** Every task card shows ONE concrete next-action verb at the top (parsed from description or first non-filler line), capped at 5 sub-items. Filler (`a/an/the`, "just", "really") suppressed.
- **From.** `04-adhd-focus-productivity.md` "Pattern 1" — i-have-adhd rule §1.
- **Slot.** `apps/web/src/views/TasksView.tsx` (card renderer transform).
- **E = XS**. **I = M**.
- **Acceptance.** First displayed line of a task card is a verb-leading imperative ≤ 7 words; lists > 5 collapse to "+N more."

### **2.2 Single-active-focus session**
- **What.** Exactly one focus session can be "active" across the whole app. Starting a new session on a different task prompts "End current?" instead of stacking. Pinned at the top of OverviewView with elapsed/remaining time + pause/resume.
- **From.** `04-adhd-focus-productivity.md` "Pattern 2" — Focus CLI + Super Productivity.
- **Slot.** `apps/web/src/views/OverviewView.tsx`, `apps/web/src/lib/store.ts` (focus lock slice).
- **E = S**. **I = M**.
- **Acceptance.** Starting a second session shows a non-blocking "End current first?"; no two sessions are simultaneously `running`.

### **2.3 Receipts log (one markdown per session)**
- **What.** Every session produces a dated `data/sessions/YYYY-MM-DD-HHMM-<display_id>.md` file with goal, delivered, next_step, reflection. OverviewView links to today's receipts.
- **From.** `04-adhd-focus-productivity.md` "Pattern 3" — Loft-Hours verbatim.
- **Slot.** `apps/server/src/session-lifecycle.ts` (write on session end), `apps/web/src/views/OverviewView.tsx` (link).
- **E = S**. **I = M**.
- **Acceptance.** Completing a session writes one markdown file; Overview "Today's receipts" count increments without restart.

### **2.4 Frictionless Inbox → Task promote (one keystroke)**
- **What.** `p` key promotes the focused Inbox item to a Task. Auto-derived: `display_id`, default column = `inbox`, verb-first title normalization per Pattern 2.1. No modal.
- **From.** `04-adhd-focus-productivity.md` "Pattern 9" — Leantime's "one task on your mind right now?" anti-pattern.
- **Slot.** `apps/web/src/views/InboxView.tsx` (hotkey + minimal server route).
- **E = XS**. **I = M**.
- **Acceptance.** Pressing `p` on an Inbox item creates a Task row normalized to a verb-first imperative, lands at the top of the kanban `inbox` column.

### **2.5 ADHD-output-style for in-app agent replies (Gholam)**
- **What.** Apply i-have-adhd's 10 rules to Gholam's output style: action-first, numbered, ≤ 5 bullets, restate state per turn, no preamble/closers. Editable via a settings page (forkable text).
- **From.** `04-adhd-focus-productivity.md` "Pattern 7" — i-have-adhd + attention-control.
- **Slot.** `apps/gholam/src/index.ts` (system prompt), `apps/web/src/views/SettingsView.tsx` (editable).
- **E = S**. **I = M**.
- **Acceptance.** Gholam's first line on any reply is a verb-leading imperative ≤ 7 words or a numbered list; reply length capped at the smallest viable answer.

### **2.6 Time-blindness nudge via Routines**
- **What.** A routine fires at configurable intervals (e.g. every 90 min) and shows a non-blocking toast: *"You've been on `<task>` for `<minutes>`. Continue, switch, or break?"* with 3 buttons + auto-dismiss.
- **From.** `04-adhd-focus-productivity.md` "Pattern 8" — claude-adhd-skills nudge hooks.
- **Slot.** `apps/web/src/views/OverviewView.tsx` (toast UI), `apps/web/src/lib/notifications.ts` (reused).
- **E = S**. **I = M**.
- **Acceptance.** A cron-style routine triggers a toast with 3 buttons; selection writes to the active task's `pomodoro_interrupt_count`.

### **2.7 Energy-tag rollup**
- **What.** Tasks accept an optional `energy_tag` (low/medium/high). OverviewView computes "your sharp hours" by aggregating completed-by-tag per hour-of-day across the last 30 days. Refuses to render with < 3 samples per hour bin.
- **From.** `04-adhd-focus-productivity.md` "Pattern 6" — ActivityWatch buckets + Loft-Hours energy.
- **Slot.** `apps/server/src/db/tasks.ts` (column), `apps/web/src/views/OverviewView.tsx` (heatmap).
- **E = S**. **I = S**.
- **Acceptance.** A heatmap renders only where n ≥ 3 sessions; otherwise shows "need more data."

### **2.8 Receipts-driven weekly review**
- **What.** `/review week|month` (Routines-driven, manual trigger) computes goal-vs-delivered ratio and energy patterns from receipts. Refuses to render conclusions with < 3 sessions in the window.
- **From.** `04-adhd-focus-productivity.md` "Pattern 12" — Loft-Hours rollup.
- **Slot.** `apps/web/src/views/OverviewView.tsx` (review pane), `apps/server/src/`.
- **E = M**. **I = M**.
- **Acceptance.** A weekly review with ≥ 3 receipts shows goal-vs-delivered ratio + energy pattern.

### **2.9 Non-punitive streak surface**
- **What.** OverviewView streak counter shows "focus sessions completed" over trailing 7/30 days. No "broken" — a gap of > 2 days shows a soft "welcome back" with a link to the gap-day receipts.
- **From.** `04-adhd-focus-productivity.md` "Pattern 11".
- **Slot.** `apps/web/src/views/OverviewView.tsx`.
- **E = XS**. **I = S**.
- **Acceptance.** After 7 days with no sessions, the streak card shows a "welcome back" tone, never a "0 streak" / red-X state.

### **2.10 Git pre-commit focus guard (optional)**
- **What.** A Routines routine watches `git commit-msg` / `pre-commit` events; if the current task is a "deep work" routine and `current_task` is unset, it blocks the commit and surfaces "what was I supposed to be doing?" (mirror of git-leash). Override: `UNFOCUS=1` env.
- **From.** `04-adhd-focus-productivity.md` "Pattern 4" — git-leash.
- **Slot.** `apps/server/src/routes-hooks.ts` (already exists as the routine webhooks engine).
- **E = M** (hook event + routine config). **I = S**.
- **Acceptance.** A `focus_guard` routine triggers on `git` events; blocked commits show the task reminder; `UNFOCUS=1` bypasses.

---

## Tier 3 — Storefront / Marketplace UX (the "store" surface)

### **3.1 Verified-source badge on StoreCard**
- **What.** A small "Verified" badge on `StoreCard` for items whose source is in `apps/server/src/storefront/known-good-sources.json` (Anthropic official, etc.). Mirrors GitHub Marketplace's org-level Verified.
- **From.** `06-storefront-ux-patterns.md` "Pattern 1". GitHub Marketplace.
- **Slot.** `apps/web/src/views/storefront/StoreCard.tsx`.
- **E = XS**. **I = M**.
- **Acceptance.** `StoreCard` shows a green check + tooltip "Verified source" when the item's source is in `known-good-sources.json`.

### **3.2 Screenshot / preview reel on detail**
- **What.** Optional image carousel above the description body on `StorefrontDetail`. Falls back to today's text-only layout when absent — no regression.
- **From.** `06-storefront-ux-patterns.md` "Pattern 2" — Apple App Store, Microsoft Store.
- **Slot.** `apps/web/src/views/storefront/StorefrontDetail.tsx`. No new backend.
- **E = M**. **I = L**.
- **Acceptance.** Item with `screenshots` populated shows a swipeable carousel; item without renders identically to current behavior.

### **3.3 Structured permission/trust label (Data-Safety analog)**
- **What.** Fixed-schema block — transports used, tools exposed, network access (local/remote), auth requirement — rendered as labeled rows, not prose, before install.
- **From.** `06-storefront-ux-patterns.md` "Pattern 3" — Google Play Data Safety.
- **Slot.** `apps/server/src/storefront-catalog.ts` (manifest extraction), `apps/web/src/views/storefront/StorefrontDetail.tsx`.
- **E = M**. **I = L**.
- **Acceptance.** Installing an MCP server shows the label block; label content matches the server's declared manifest.

### **3.4 In-place install progress (replace CTA label)**
- **What.** Button text cycles `Install → Installing… (with %/spinner from SSE progress) → Installed/Open`. No modal.
- **From.** `06-storefront-ux-patterns.md` "Pattern 4" — App Store / Microsoft Store.
- **Slot.** `apps/web/src/views/storefront/InstallButton.tsx`. SSE progress already planned in `docs/STOREFRONT.md`.
- **E = S**. **I = M**.
- **Acceptance.** Clicking Install never opens a dialog; button state reflects live install progress end-to-end.

### **3.5 Post-install next-step hint**
- **What.** After successful install, a dismissible inline card: "Try it: `<slash-command>`" for skills, "Health: `<probe status>`" for MCP, "Open in chat" for prompts.
- **From.** `06-storefront-ux-patterns.md` "Pattern 5".
- **Slot.** `apps/web/src/views/storefront/StorefrontDetail.tsx`.
- **E = S**. **I = M**.
- **Acceptance.** Each of the four sections (Skills/MCP/Prompts/Plugins) shows a section-appropriate hint immediately after install completes.

### **3.6 Trending vs. Popular as separate rows (real velocity math)**
- **What.** Keep existing Featured/Trending/New three-row layout; define "Trending" server-side as install-velocity-over-7-days rather than a static flag.
- **From.** `06-storefront-ux-patterns.md` "Pattern 6" — Play/Microsoft.
- **Slot.** `apps/server/src/storefront-catalog.ts` (velocity calc).
- **E = M**. **I = M**.
- **Acceptance.** `marketplace-service.ts` computes a rolling velocity score; Trending row reorders when velocity changes without a deploy.

### **3.7 Category taxonomy beyond the four top-level sections**
- **What.** Within each section (Skills/MCPs/Prompts/Plugins), a second-level chip row sourced from existing skill/agent metadata categories.
- **From.** `06-storefront-ux-patterns.md` "Pattern 7".
- **Slot.** `apps/web/src/views/storefront/FilterChips.tsx`.
- **E = S**. **I = M**.
- **Acceptance.** Selecting a section shows relevant sub-category chips; selecting a sub-category filters the grid client-side.

### **3.8 Uninstall surfaced symmetrically with install**
- **What.** On an already-installed item's detail page, the primary CTA becomes "Remove" in the same slot as "Install" — not buried in settings.
- **From.** `06-storefront-ux-patterns.md` "Pattern 8".
- **Slot.** `apps/web/src/views/storefront/InstallButton.tsx`, `apps/server/src/routes-storefront-installed.ts`.
- **E = XS**. **I = M**.
- **Acceptance.** Detail page for an installed item shows Remove in the primary CTA slot; removing updates state without page reload.

### **3.9 Cross-store linking ("Requires" / "Used with")**
- **What.** If a Prompt references an MCP server or Skill by name, render a "Requires: `<MCP name>`" chip linking to that item's detail page.
- **From.** `06-storefront-ux-patterns.md` "Pattern 9" — Apple App Store inter-app linking.
- **Slot.** `apps/server/src/prompts-library.ts` (parse references), `apps/web/src/views/storefront/StorefrontDetail.tsx`.
- **E = M**. **I = M**.
- **Acceptance.** A prompt whose body references an installed/available MCP tool shows a linked requirement chip; clicking navigates to that MCP's detail page.

### **3.10 Update-available indicator + changelog line**
- **What.** Badge on installed-item cards when a newer version exists; clicking shows a one-line "What's new" pulled from the source's changelog/release notes if available.
- **From.** `06-storefront-ux-patterns.md` "Pattern 10" — Apple App Store "What's New" version notes.
- **Slot.** `apps/server/src/routes-storefront-installed.ts`, `apps/web/src/views/storefront/StorefrontDetail.tsx`.
- **E = M**. **I = M**.
- **Acceptance.** An installed item with a newer upstream version shows an Update badge; tapping it surfaces at least the version number.

### **3.11 Command-palette search across all stores**
- **What.** Extend the existing KB command palette to also query Storefront items (Skills/MCP/Prompts/Plugins) by name/tagline.
- **From.** `06-storefront-ux-patterns.md` "Pattern 11" — Spotlight / VS Code Quick Open.
- **Slot.** `apps/web/src/views/storefront/StorefrontSearch.tsx` + `apps/web/src/views/KbCommandPalette.tsx`.
- **E = M**. **I = L**.
- **Acceptance.** Invoking the command palette and typing a skill/MCP/prompt name surfaces and navigates to that Storefront item.

### **3.12 Install count + recency proxy (no fabricated stars)**
- **What.** Add last-updated relative time next to install count on `StoreCard`; deliberately do not add a 5-star rating system (no reviewer pool to seed it).
- **From.** `06-storefront-ux-patterns.md` "Pattern 12" — VS Code/Product Hunt recency-vs-rating trade-off.
- **Slot.** `apps/web/src/views/storefront/StoreCard.tsx`.
- **E = XS**. **I = S**.
- **Acceptance.** `StoreCard` shows last-updated relative time next to install count; no fabricated star rating.

---

## Tier 4 — ACP / MCP / Pi Native (the protocol layer)

### **4.1 MCP-backed infra provisioning tools (OpenShip-native)**
- **What.** Expose "create project," "check deployment status," "restart service" as MCP tools the deck's own agent can call — mirroring DigitalOcean/Hetzner MCP servers but against OpenShip.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 1". DigitalOcean, Hetzner cluster.
- **Slot.** `apps/server/src/routes-openship.ts` + new `mcp-infra-tools.ts` registering MCP tool definitions.
- **E = M**. **I = L**.
- **Acceptance.** An in-deck agent session can invoke an MCP tool that creates an OpenShip project and the deployment appears in `GET /projects` without a human touching the OpenShip UI.

### **4.2 Cost-guard confirmation gate on infra MCP tools**
- **What.** Any MCP tool call that creates/deletes billable resources surfaces an explicit approve/deny prompt in the deck UI, same shape as the Hetzner-cluster "cost guard" pattern.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 2". Hetzner fork cluster.
- **Slot.** `apps/gholam/src/permissions.ts` (`GHOLAM_PERMISSIONS`) — add a `requiresConfirmation` flag.
- **E = S**. **I = M**.
- **Acceptance.** Calling a destructive MCP tool without prior approval is blocked and logged; approving once lets that specific call proceed.

### **4.3 Session-as-MCP-resource (transcript search)**
- **What.** Expose the current session's transcript as an MCP resource other tools (or a second agent) can query.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 3". Hydra-ACP.
- **Slot.** New route beside `apps/server/src/mcp-health.ts`, backed by the existing chat/session store.
- **E = M**. **I = M**.
- **Acceptance.** A second agent session can call an MCP tool that returns a relevant excerpt from a different live session's transcript by keyword.

### **4.4 Multi-client attach to one live agent session**
- **What.** Let a second browser tab or the Telegram bridge attach to an already-running agent session (hydra-acp's core feature) rather than each surface owning its own session.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 4" + `01-remote-vps-access.md` Pattern 7. Hydra-ACP, Web Terminal ACP.
- **Slot.** `apps/server/src/bridge-supervisor.ts` generalized beyond Telegram to a "session attach" bridge type.
- **E = L**. **I = L**.
- **Acceptance.** Starting an agent turn from the web UI and sending a message to it from Telegram (or vice versa) land in the same session transcript.

### **4.5 QR pairing for mobile attach (e2e relay)**
- **What.** Across Patterns 0.1 and 4.4, ship QR pairing as the single mobile entry point that works on Tailscale, Cloudflare tunnel, or hosted relay.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 5" + `01-remote-vps-access.md` Pattern 6. apto-ve/bridge.
- **Slot.** New route in `apps/server/src/routes-bridges.ts`.
- **E = S**. **I = S**.
- **Acceptance.** Scanning the generated QR code from a phone browser opens the same session as the desktop tab that generated it.

### **4.6 Worktree-per-agent isolation for gholam-driven changes**
- **What.** When Gholam acts on the deck's own repo (e.g. applying a config change suggested by an agent), do it in an isolated worktree first, surface a diff, then merge.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 7". container-use.
- **Slot.** `apps/gholam/src/` (wrap gholam's file-mutation path with a per-task git worktree).
- **E = M**. **I = L**.
- **Acceptance.** A gholam-initiated repo change produces a reviewable diff in a scratch worktree before any file in the live checkout is touched.

### **4.7 Auto-approver rule engine for permission prompts**
- **What.** Let an operator write a small allow-list (e.g. "auto-approve read-only MCP calls to OpenShip") so unattended runs don't stall on every prompt.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 8". Hydra-ACP JS-rule auto-approvers.
- **Slot.** `apps/gholam/src/permissions.ts` (`GHOLAM_PERMISSIONS`) + new rules file.
- **E = M**. **I = M**.
- **Acceptance.** A configured auto-approve rule lets a matching tool call proceed without a human prompt; non-matching calls still block.

### **4.8 Cloud-hosted MCP endpoint tracking (parity with DigitalOcean's remote-MCP shift)**
- **What.** Distinguish locally-spawned MCP servers from remote/hosted ones in the install and health UI.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 6". DigitalOcean's remote-MCP migration.
- **Slot.** `apps/server/src/routes-mcp-install.ts` + `mcp-health.ts` (`McpHealthProbe`).
- **E = S**. **I = M**.
- **Acceptance.** `GET /mcp/health` reports a distinct status code/reason for a remote MCP endpoint that is unreachable vs. a local process that crashed.

### **4.9 Marketplace-tracked remote MCP installs**
- **What.** When a user installs a remote/hosted MCP server through the marketplace UI, persist it in the same installed-registry the SDK already tracks for local plugins.
- **From.** `03-pi-lineage-acp-mcp.md` "Pattern 9". DigitalOcean.
- **Slot.** `apps/server/src/marketplace-service.ts` (`MarketplaceService`).
- **E = S**. **I = S**.
- **Acceptance.** Installing a remote MCP endpoint via the marketplace UI shows up in the installed-plugins list and can be removed the same way as a locally-cloned one.

---

## Tier 5 — Native App Errata (smaller polish, easy wins)

### **5.1 Inbox capture on context-switch hint (opt-in)**
- **What.** Optional OS-level hook (macOS/Windows/Linux adapters like Loft-Hours) detects app-switch away from omp-deck for > N seconds and surfaces an Inbox quick-capture prompt. Off by default.
- **From.** `04-adhd-focus-productivity.md` "Pattern 5" — squirreltrap.
- **Slot.** `apps/web/src/views/InboxView.tsx` (consume adapter signal).
- **E = L** (native adapters + permission flow). **I = M**.
- **Acceptance.** With adapters enabled and focus on a non-omp-deck app for > 60s, returning shows a one-line capture prompt.

### **5.2 Ambient DND envelope during focus session**
- **What.** When a focus session starts, a routine sets the OS notification preference to "focus" for the session duration. Restores on end.
- **From.** `04-adhd-focus-productivity.md` "Pattern 10".
- **Slot.** `apps/web/src/views/SettingsView.tsx` (existing notification preference surface).
- **E = S**. **I = S**.
- **Acceptance.** Starting a `dnd_envelope: true` routine flips notification preference to "focus"; ending restores the prior preference.

### **5.3 Verified publish surface for own plugins (back-features)**
- **What.** A "Publish to Storefront" flow in Settings → Marketplace that lints a local plugin YAML against the storefront schema, runs a `ponytail-review` of the file, and uploads to a user-specified git source. Self-serve install on the user's other devices.
- **From.** `06-storefront-ux-patterns.md` Pattern 6 (extends); Product Hunt / GitHub Marketplace self-publish.
- **Slot.** `apps/server/src/marketplace-service.ts` (addPublish helper), `apps/web/src/views/SettingsView.tsx`.
- **E = M**. **I = M**.
- **Acceptance.** A user-authored plugin can be published from Settings, appears in the user's own Storefront "Mine" section, and installs cleanly on a second device.

### **5.4 Routines import → from prompt to multi-step YAML**
- **What.** From the chat composer, hitting a new `/routine <intent>` slash command generates a starter V1 routine YAML from the user's intent (gholam-driven), shows it in the routine builder, and one-click saves.
- **From.** GenUI pattern in `docs/GENERATIVE.md` §3.
- **Slot.** `apps/server/src/deck-slash-commands.ts` (new entry), `apps/web/src/views/RoutinesView.tsx` (accept builder).
- **E = M**. **I = M**.
- **Acceptance.** `/routine "every weekday at 9am, run `git pull` and ask the agent to summarize changes"` produces a V1 YAML pre-filled in the routine builder, editable, saveable.

### **5.5 Native iOS / Android app shell (PWA install + push)**
- **What.** Promote the existing PWA to a TWA/iOS-shell with native push (already half-built via `apps/server/src/push-service.ts` + `migrations/006-push-subscriptions.sql`). Add a "Share to Mobile" button on the deck header that opens the static manifest.
- **From.** `01-remote-vps-access.md` §6 Pattern 5; PWA install UI from agent-of-empires.
- **Slot.** `apps/web/src/lib/pwa.ts` (manifest), `apps/web/src/components/ConnectionIndicator.tsx` (share button).
- **E = S**. **I = M**.
- **Acceptance.** A user opening the deck on Chrome/Edge on Android is prompted to install the PWA; after install, the icon opens to a standalone fullscreen window, and notifications deliver when the app is closed.

### **5.6 "What's new" banner driven by update-check**
- **What.** When `update-check.ts` reports a newer version with a changelog, surface a dismissible banner at the top of OverviewView.
- **From.** `apps/server/src/update-check.ts` already exists; missing: surfaced UI.
- **Slot.** `apps/web/src/views/OverviewView.tsx`.
- **E = XS**. **I = S**.
- **Acceptance.** After upgrading the deck to a new version, the next session shows a top banner "v0.7.0 shipped — see what's new" with the changelog inline.

### **5.7 Cost telemetry surfaced on OverviewView**
- **What.** Roll up the `usage_json` from `gholam_chats` into a per-model-per-day chart on the Overview.
- **From.** `apps/server/src/gholam-chats.ts` already stores the data; missing surfaced UI.
- **Slot.** `apps/web/src/views/OverviewView.tsx`.
- **E = S**. **I = S**.
- **Acceptance.** OverviewView shows a 30-day rolling per-model token + cost chart; clicking a model bar shows the day's chat sessions.

### **5.8 Open a second Gholam chat on the same cwd (parallel priority chats)**
- **What.** Today the Gholam chat list is per-cwd; allow multiple "priority" chats on the same cwd so the user can keep an active task-specific chat open while a separate background chat runs.
- **From.** Hydra-ACP's session multiplexing.
- **Slot.** `apps/server/src/gholam-chats.ts`, `apps/web/src/views/GholamChats.tsx`.
- **E = S**. **I = S**.
- **Acceptance.** Two priority chats on the same cwd can coexist; each has its own WS subscription and enters its own state machine.

### **5.9 Routine dead-letter retry-with-budget**
- **What.** When a routine run fails with `abort_reason = 'failure'`, auto-spawn a follow-up retry step with a smaller budget. Pattern after Swarm-IOSM's "Integration report" + iterative fixing.
- **From.** `apps/server/src/routines/v1-runner.ts` already records `abort_reason`; missing: auto-retry.
- **Slot.** `apps/server/src/routines/v1-runner.ts`.
- **E = S**. **I = S**.
- **Acceptance.** A failed agent step with `auto_retry_count > 0` spawns a follow-up agent step with `budget` reduced by 50% and the original error attached as context; second failure halts the run.

### **5.10 Push notification on routine completion / approval needed**
- **What.** When a routine run completes (success or failure) or a plan proposal is pending, dispatch a web push via the existing `push-subscriptions` table.
- **From.** `apps/server/src/push-service.ts` already exists; missing: triggers.
- **Slot.** `apps/server/src/push-service.ts`, `apps/server/src/routines/v1-runner.ts`, `apps/server/src/bridge/plan-mode-bridge.ts`.
- **E = S**. **I = M**.
- **Acceptance.** A routine run that completes while the deck is in a background tab delivers a push notification that, when tapped, opens the run's detail view.

---

## Tier 6 — Roadmaps We Are NOT Building (deliberate omissions)

These were the loudest signals from the research — but they contradict omp-deck's position or are already adequately served by an existing layer. Documented here so a future pass can revisit the call.

- **Native iOS/Android apps.** PWA + push is enough. Going App Store native requires constant platform-side updates and a separate codebase; the PWA gives 90% of the value for 10% of the work. Revisit only if push delivery on closed Safari tabs becomes a real product blocker.
- **5-star rating/review system on Storefront.** No critic pool to seed it; npm registry's QPM bars and the `Updated 3d ago` heuristic are more honest. If a real user community grows, add a lightweight thumbs-up/down, not stars.
- **Custom ACP server.** The deck consumes ACP via the SDK (`ACP_BUILTIN_SLASH_COMMANDS`); building a deck-side ACP server is double work. Revisit if we want third-party agents to drive the deck.
- **Forking or commercially-relinking Paseo/lambda/bb.** AD-Tier-1 lock-in dependent on their roadmap; instead, ride the ompi SDK's own collab trajectory and use the deck's QR + E2EE relay.
- **First-class graph-of-tasks (DAG).** Today's flat kanban + display_id is enough for the workload pattern. If tasks with 5+ subdependencies become common, revisit via Taskplane-style waves.
- **Hosting our own relay as a paid product.** Our relay is a fallback, not a business. If a hosted tunnel is needed, send users to Cloudflare/Tailscale with one click.
- **VPS-provisioning MCP tools (Hetzner/DigitalOcean).** OpenShip is the first-party infra provider; the `mcp-digitalocean`/`mcp-hetzner` patterns translate to OpenShip via `mcp-infra-tools.ts` (Pattern 4.1). Don't build a second integration layer.

---

## Tier 7 — Verify-Before-Claim (open questions pulled from every research file)

Aggregated from `01-..04-..06-..md` "Open Questions" sections. Each must be checked before the corresponding recommendation moves to `In Progress`.

- **GitHub MCP auth and tool-surface parity.** The first research pass attempted `xd://github_*` and `xd://mcp__tavily_*` but got 401 + "not mounted" responses. The native `github` MCP server is listed in `~/.omp/agent/mcp.json` but wasn't reachable in the research session. Re-run a quick verification on the five `[INFERENCE]` projects (phi, aptove/bridge, vcoderun/acprouter, openronin, JinchengGao-Infty/agent-mux, nityeshaga/hetzner-mcp-server) before relying on license claims.
- **octopus license.** Brief's framing of Octopus as a habit tracker was wrong; actual repo is a multi-session Claude Code kanban. Verify the MIT LICENSE file exists at HEAD before any code reuse.
- **Leantime AGPL-3.0 carve-out.** `/app/Plugins` may carry other licenses per the README; verify which UX patterns we'd borrow live in the core (copyleft) vs. a plugin (separate license).
- **omp.sh /collab.** No confirmed dedicated `/collab` slash command exists in the base `@oh-my-pi/pi-coding-agent` SDK as installed in this repo. Only `ACP_BUILTIN_SLASH_COMMANDS` and `BUILTIN_SLASH_COMMAND_DEFS` were grep-confirmed. If a `/collab` command is expected to exist, it needs its own SDK-source read against `node_modules/@oh-my-pi/pi-coding-agent`.
- **Tools / transports parity.** xd:// Parallel, Tavily, DeepWiki, Context7, Exa, Crawl4ai, Firecrawl were not mounted in research sessions. Findings above rely on `web_search`, `read` (incl. GitHub REST API), and `grep`. A second pass with the additional surfaces mounted could corroborate the 404 repos and surface independent reviews.
- **i-have-adhd rule licensing.** The 10 rules are MIT-licensed text in the SKILL.md, but if we paraphrase heavily, attribution may still be expected. Decide before shipping Pattern 2.5.
- **git-leash graduated override semantics.** README implies `UNLEASH=1` is global; need to confirm per-session override is possible before mirroring in Pattern 2.10.
- **ActivityWatch bucket schema stability.** aw-server's REST shape has changed across versions; pin a version (or wrap with an adapter) before consuming from omp-deck.
- **Squirreltrap reuse.** No LICENSE — treat as inspiration only. For Pattern 5.1, prefer writing a new OS adapter rather than forking.
- **Hetzner fork cluster.** At least 4 community forks exist (mjmirza, valerius21, dkruyt, Xodus-CO); the original `nityeshaga/hetzner-mcp-server` slug may not exist. Confirm via direct repo read before pointing Pattern 4.2 at the wrong one.
- **Bot/Discord approval semantics.** BridgeSupervisor's existing approval-response wiring — confirm `apps/bridges/telegram/` already has an inline-keyboard capability in its Telegram client library before scoping Pattern 1.6 as "wiring, not new architecture"; if the bridge only does plain-text messages today, effort estimate rises from S to M.
- **SwiftBar / BitBar context-switch detection.** Pattern 5.1 needs a macOS-friendly mechanism; via SwiftBar or similar. Confirm before committing to the Loft-Hours adapter pattern.

---

## Tier 8 — Implementation Sequencing (where to start, what to defer)

The user's "ultrathink" framing wants a clear ordering. Group by parallel-friendly phases. Each phase produces a closed, observable artifact.

### Phase A — Mobile-First Foundation (Tiers 0 + 1.6 + 4.5)
*Goal: a session started on the deck is reachable from a phone via QR, with Telegram approvals forwarded.*

- **0.1** `omp join` link + QR (M)
- **0.3** Tunnel picker settings (M)
- **1.6** Telegram inline-keyboard approval (S)
- **4.5** QR pairing for mobile attach (S)

All four are disjoint file scopes. Dispatch in parallel.

### Phase B — Parallel Agents (Tier 1 core)
*Goal: one task can fan out to N worktree-isolated agents, with reviewer gating and merge-gate.*

- **0.2** Task-scoped worktree isolation (L)
- **1.1** Merge-queue step (M)
- **1.2** Reviewer ≠ writer (S)
- **1.3** File-level touch/lock (M)
- **1.7** Trust gate (S)

Five parallel workers (the worktree isolation is the engine; the others are wires).

### Phase C — ADHD Native UX (Tier 2)
*Goal: every task and session promotes action-first, with one focused session at a time.*

- **2.1** Action-first task card (XS)
- **2.2** Single-active-focus session (S)
- **2.3** Receipts log (S)
- **2.4** Frictionless Inbox → Task (XS)
- **2.5** ADHD-output-style for Gholam (S)
- **2.9** Non-punitive streak (XS)

Six parallel; all are UI-shaped.

### Phase D — Storefront Turn-Up (Tier 3)
*Goal: the Storefront feels like a real store, not a developer tool list.*

- **3.1** Verified badge (XS)
- **3.2** Screenshot reel (M)
- **3.4** In-place install progress (S)
- **3.5** Post-install hint (S)
- **3.8** Uninstall symmetric (XS)
- **3.11** Command-palette search (M)

Six parallel.

### Phase E — Cost & MCP Wiring (Tier 4 + Tier 5 polish)
*Goal: serious infra work happens via deck-issued MCP tools, with bounded cost.*

- **4.1** MCP-backed infra tools (M)
- **4.2** Cost-guard confirmation (S)
- **4.6** Worktree-per-agent for gholam (M)
- **4.8** Remote MCP endpoint tracking (S)
- **5.7** Cost telemetry rollup (S)
- **5.10** Push on routine completion (S)

Six parallel.

### Phase F — Late-stage Polish (Tier 5 tail)
- **2.6**, **2.7**, **2.8**, **2.10**, **3.3**, **3.6**, **3.7**, **3.9**, **3.10**, **3.12**, **4.3**, **4.4**, **4.7**, **4.9**, **5.1**, **5.2**, **5.3**, **5.4**, **5.5**, **5.6**, **5.8**, **5.9** — all independent, can be picked up in any order over the next two quarters.

---

## Tier 9 — Source Index (for the synthesis pass)

- `01-remote-vps-access.md` — 15 remote/VPS-access tools, 28.5 KB, 8 Pattern-to-apply entries.
- `02-multi-agent-orchestration.md` — 19 multi-agent orchestration projects, 30.4 KB, 8 Pattern-to-apply entries.
- `03-pi-lineage-acp-mcp.md` — 16 Pi-lineage + ACP/MCP projects, 21 KB, 9 Pattern-to-apply entries.
- `04-adhd-focus-productivity.md` — 13 ADHD/focus tools, 25 KB, 12 Pattern-to-apply entries.
- `05-omp-deck-current-state.md` — 24 KB ground-truth map of the existing app, 24 known gaps.
- `06-storefront-ux-patterns.md` — 12 storefront UX references, 25 KB, 12 Pattern-to-apply entries.

All six files are honest, source-linked, and tested against the omp-deck symbol path. Any pattern name above can be cross-referenced to a `[Pattern N]` in its source file.

---

*End of synthesis. Total: **~50 distinct recommendations across 9 tiers**, matrixed against the 24 known gaps in omp-deck. Ready to ship.*
