# 04 — ADHD / Focus / Productivity (developer-flavored)

**Category.** Open-source productivity tools written or curated for developers with ADHD, plus a small set of 2025-2026 newcomers surfaced via web search. Dominant pattern: **enforcement at the seam between intent and action** — git pre-commit, terminal lock, single-instance timer, agent output-style — rather than yet another kanban. Local-first and MIT/BSD-friendly is the norm; one AGPL outlier.

**Reading lens.** omp-deck already ships Tasks (kanban with display_id), Inbox (quick-capture + promote), Routines (cron/webhook/manual/event-driven multi-step), Overview, Onboarding, and theme tokens. Patterns below are filtered for slots that fit that surface without inventing a sixth pillar.

---

## Per-project entries

### Leantime — [leantime/leantime](https://github.com/leantime/leantime)
License: **AGPL-3.0-only** (`LICENSE` at repo root; confirmed at [support.leantime.io](https://support.leantime.io/en/article/how-is-leantime-the-open-source-system-licensed-29l3j)). Commercial: allowed, but network-facing SaaS forks must publish source — closed-source SaaS fork not safe. Differentiator: tagline itself is *"goals focused project management system for non-project managers. Building with ADHD, Autism, and dyslexia in mind."* — neurodiversity-first UX, not an afterthought ([README](https://github.com/leantime/leantime)). ADHD-specific: built-in **Pomodoro timers**, **Daily Intentions** (implementation-intentions cue→action pattern), and **Focused Task Initiation** prompts (e.g. *"What is one task that's on your mind right now?"*) plus a low-stimulation theme/font preset.

### Super Productivity — [johannesjo/super-productivity](https://github.com/johannesjo/super-productivity) (mirror [super-productivity/super-productivity](https://github.com/super-productivity/super-productivity))
License: **MIT** (`LICENSE`, Johannes Millan, 2018). Commercial: OK. Differentiator: **live bidirectional Jira/GitHub/GitLab/OpenProject sync** into a local task list, with time logged per issue and worklog review on completion ([integrations/jira](https://super-productivity.com/integrations/jira)). ADHD-specific: **three switchable focus modes** — Pomodoro / Flowtime / Countdown — tied to task timer; **idle-time detection** pauses tracking and prompts the user on return to classify the gap (re-engagement hook); **Procrastination Buster** plugin identifies 8 procrastination types and auto-triggers after 15 min inactivity ([DeepWiki Q&A](https://deepwiki.com/search/how-does-super-productivity-su_a73b6c40-d8d7-4327-b1d7-4d1eea8a82c4)).

### ActivityWatch — [ActivityWatch/activitywatch](https://github.com/ActivityWatch/activitywatch)
License: **MPL-2.0** (file-level weak copyleft across `activitywatch`, `aw-server-rust`, `aw-webui`, `aw-watcher-window`). Commercial: OK — only modified MPL-covered files themselves must be disclosed, not the whole consuming product. Differentiator: **fully passive, automatic time tracking** via modular watchers — `aw-watcher-window` (active app + title), `aw-watcher-afk` (keyboard/mouse idle), `aw-watcher-web` (browser tab/URL) — pushing heartbeats to `aw-server` and storing in local SQLite timeseries buckets queryable via REST ([DeepWiki Q&A](https://deepwiki.com/search/what-makes-activitywatch-relev_5d1f4dbd-6616-43b2-80a7-b57eab72f9f8)). ADHD-specific: local-first REST API makes raw activity/AFK buckets available without cloud roundtrips; combined app + browser awareness distinguishes deep work from tab-hopping; explicit **anti-surveillance positioning** (user-owned data, no telemetry) reframes activity monitoring as self-quantification rather than employer control.

### Focus (CLI) — [ayoisaiah/focus](https://github.com/ayoisaiah/focus)
License: **MIT** (`LICENCE` at repo root, Ayooluwa Isaiah 2021). Commercial: OK. Differentiator: **single-instance terminal Pomodoro** — only one `focus` session can run at a time, forcing single-tasking rather than stacking timers ([DeepWiki Q&A](https://deepwiki.com/search/how-does-the-focus-cli-help-us_c0704003-aaba-412c-8641-d05865e44378)). ADHD-specific: `focus stats` / `focus list` for session tagging + completed-vs-abandoned history with hourly/weekly breakdowns for self-monitoring; `session_cmd` config hook runs an arbitrary shell command after each session (lightweight integration seam, no plugin system); six built-in ambient sounds played **only during work** sessions and auto-pausing on break.

### git-leash — [SiteRelEnby/git-leash](https://github.com/SiteRelEnby/git-leash)
License: **BSD-3-Clause** (`LICENSE`, 2026). Commercial: OK, no copyleft. Differentiator: **schedule-based commit gating** with per-schedule `allow=` / `block=` repo filters — e.g. side-project repos blocked 9-5, work repos open; or all commits blocked 23:00-06:00 as a "go-to-bed" focus guard ([README](https://raw.githubusercontent.com/SiteRelEnby/git-leash/main/README.md)). ADHD-specific: focus-by-default framing — enforcement lives at the commit seam where attention already broke; **graduated override** instead of a hard wall (`UNLEASH=1` env, one-shot `leash slip`, or `git commit --no-verify`); **task reminder injected into every block message** (`task=...` per-schedule, or global fallback `current=...`) — forces re-orientation each blocked attempt rather than silent failure; **fails open** if the binary is missing.

### Octopus — [SebastianElvis/octopus](https://github.com/SebastianElvis/octopus)
License: **MIT** (stated in README; no standalone `LICENSE` file at master/main HEAD — verify before redistribution). Commercial: OK, MIT-typical. **Brief correction:** this is **not** a habit/tree tracker — it is a Tauri/React desktop dashboard for managing many parallel Claude Code CLI sessions, with kanban dispatch + git-worktree isolation + in-app issue→PR→CI→merge pipeline. ADHD-specific: **"Needs Attention" column** auto-surfacing sessions waiting on input; **AI session recaps** to avoid re-reading terminal scrollback after a context switch; **crash recovery + WCAG dark mode** explicitly framed for hyperfocus sessions. (Note: original brief described Octopus as a habit/tree tracker — that framing was incorrect per the actual repo.)

### i-have-adhd — [ayghri/i-have-adhd](https://github.com/ayghri/i-have-adhd)
License: **MIT** (`LICENSE`, Ayoub Ghriss, 2026). Commercial: OK. Differentiator: not an app/UI — it's a **coding-agent output-style skill** (SKILL.md) installable across Claude Code, Cursor, Codex, Copilot, Gemini, Qwen, Kimi, Hermes as `/i-have-adhd` slash command or always-on hook (`~/.claude/.i-have-adhd-always`). ADHD-specific: **10 hard response rules** — lead with next action, number multi-step tasks, end with ONE concrete next step, suppress tangents, restate state every turn (working-memory compensation), specific time estimates (no "a bit"), make wins visible, matter-of-fact error tone, cap lists at 5, no preamble/closers; **grounded in 5 ADHD facts** (small working memory, knowing-doing gap, task-initiation friction, uniform time perception, dopamine scarcity); **toggle UX** with `● ADHD ON` footer in some harnesses; fully forkable ([INSTALL.md](https://github.com/ayghri/i-have-adhd/blob/main/INSTALL.md)).

### Loft-Hours (formerly "Study With Me") — [lazyfoxjumps/Loft-Hours](https://github.com/lazyfoxjumps/Loft-Hours)
License: **MIT** (`LICENSE`, 2026). Commercial: OK. Differentiator: **Claude Code skill invoked as `/loft-hours`** — a body-doubling focus ritual that sets up your OS environment (DND, kills distracting apps, opens work apps, starts a playlist), runs a full-window HTML timer with the goal pinned on screen, and **only 3 gentle bell pings** (halfway/last-minute/complete). Ships OS adapters: `adapters/macos.sh`, `adapters/windows.ps1`, `adapters/linux.sh` ([README](https://raw.githubusercontent.com/lazyfoxjumps/Loft-Hours/main/README.md)). ADHD-specific: **evidence-based "receipts"** — every session writes `~/Documents/study-log/YYYY/MM/YYYY-MM-DD-HHMM.md` with goal, delivered, energy_start/end, next_step, reflection, explicitly to counter "you did nothing this week" memory distortion; **energy/mood tagging** (4-question intake pre + post); **non-punitive streak + break check-in** ("You said you'd [X]. Where are you?"); **weekly/monthly `/loft-hours review week|month` rollup** computes goal-vs-delivered ratio and energy patterns, refuses to fabricate patterns with <3 sessions.

### claude-adhd-skills — [ravila4/claude-adhd-skills](https://github.com/ravila4/claude-adhd-skills)
License: **MIT** (`LICENSE`, 2026). Commercial: OK. Differentiator: **time-awareness + nudge hook system** — `UserPromptSubmit` injects current time, and `check_alerts.py` / `add_alert.py` / `ack_alert.py` fire timed reminders ([README](https://raw.githubusercontent.com/ravila4/claude-adhd-skills/main/README.md)). ADHD-specific: **daily-journal skill** writes conversational journaling to Obsidian for cross-session memory reconstruction; **nudge skill/hooks** enforce time-blindness accountability ("Stop me at 11"); **CLAUDE.md template** with break suggestions, pacing, focus tracking, ask-over-assume working relationship. (Brief's "body-doubling co-pilot" + "evidence-based commit gates" framing **not** present in this repo — closest match is an included TDD skill (obra's Logic Gate + Iron Rule), which is generic dev practice, not ADHD-specific gating.)

### attention-control — [aaddrick/attention-control](https://github.com/aaddrick/attention-control) *(2025–2026 expansion)*
License: **MIT** (`LICENSE` present). Commercial: OK. Differentiator: installable **Claude Code / Cursor / Gemini / Codex skill + output-style** that imposes "air traffic control discipline" on agent output — short, scannable, single-focus responses for an ADHD reader. Ships localized READMEs (ja/ko/pt-BR/vi/zh-CN) and an **eval harness** (`evals/rubric.md`, `judge.py`) that scores agent responses for ADHD-readability, not just correctness — clarity as a first-class metric. Relevance: validates the "Claude skill for ADHD" slot already in omp-deck's catalog; informs an agent-response style guide rather than a UI feature.

### squirreltrap — [jtoeman/squirreltrap](https://github.com/jtoeman/squirreltrap) *(2025–2026 expansion)*
License: **none published** (no `LICENSE` file; GitHub default all-rights-reserved, source-visible only — NOT OSI open-source). Commercial: **reference only**, not forkable without author consent. Differentiator: macOS 14+ menu-bar app that **intercepts every Cmd+Tab app-switch** with a floating *"what are you about to do?"* prompt — catches the exact moment ADHD users get sidetracked mid-switch, rather than passive timer/blocklist. ADHD-specific: builds a running to-do checklist **entirely from these micro-captures** (no manual task entry); optional one-/bidirectional Apple Reminders + iCloud sync; local-only storage. Relevance: the "catch the moment of context-switch" capture maps directly to InboxView's quick-capture — validates capturing intent at transition points.

### flow-cli — [Data-Wise/flow-cli](https://github.com/Data-Wise/flow-cli) *(2025–2026 expansion)*
License: **MIT** (`LICENSE` confirmed). Commercial: OK. 1,868 commits, active. Differentiator: **"ADHD-optimized ZSH configuration documentation and workflows"** — full dev-environment CLI (Homebrew Formula, shell completions, `.claude/` integration, plugin system) built around reducing context-switch friction for developers specifically. ADHD-specific: ships `.flow` config dir + `commands/` set implying **named, repeatable workflow shortcuts** (cuts decision fatigue) plus `docs/` + `man/man1` manpage set for low-friction recall — externalizes memory rather than relying on it. Relevance: precedent for a CLI-first ADHD dev tool with real traction, validates omp-deck's developer-facing surface.

### dubbii (ADHD Love) — [apps.apple.com](https://apps.apple.com/us/app/dubbii-the-body-doubling-app/id6450302677) *(closed-source, reference only)*
Proprietary; no repo. Included because "body doubling" was an explicit search target with no stronger open-source competitor in 2025–2026. Differentiator: **on-demand live body-doubling video sessions** + 500+ pre-recorded task-specific videos (chores/admin/self-care) where a host works alongside you in real time or on recording; over 500k users per store listings. ADHD-specific: "nudges" unlimited custom reminders; explicit **anti-"ADHD tax"** subscription design — proactive renewal reminders before auto-charging inactive users, addressing forgotten-subscription executive-function pain. Out of scope for a dev tool — reference only.

---

## Cross-cutting patterns

1. **Time-blocking as default state, not opt-in** — Super Productivity Pomodoro/Flowtime/Countdown modes, Focus CLI single-instance lock, git-leash schedule blocks, Loft-Hours full-window timer with goal pinned. The timer isn't decoration; it's the primary UI surface during a session.
2. **Enforcement at the action seam** — git-leash (commit), Focus CLI (terminal lock), squirreltrap (Cmd+Tab), Super Productivity idle detection. Each one blocks *exactly the moment* an ADHD brain would otherwise slip.
3. **Evidence-based "receipts"** — Loft-Hours dated markdown logs, Super Productivity worklog review, ActivityWatch local REST bucket export. All three combat the same failure: *"you did nothing this week."* Receipts are the antidote to ADHD time-blindness.
4. **Action-first response style** — i-have-adhd's 10 hard rules, attention-control's "air traffic control" output style, Super Productivity's auto-trigger after 15 min inactivity. Different surfaces, same rule: lead with the next concrete action, not preamble.
5. **Body-doubling via co-located work** — Loft-Hours OS-level ritual setup, dubbii live sessions, claude-adhd-skills ask-over-assume CLAUDE.md template. The pattern is presence at low cognitive cost.
6. **Dopamine-rich visible progress** — Super Productivity worklog review (push time back to Jira), Loft-Hours goal-vs-delivered ratio, i-have-adhd "make wins visible" rule. Each surfaces a small concrete win at a known cadence.
7. **Frictionless capture at the transition point** — squirreltrap captures at Cmd+Tab, InboxView already captures on demand. The differentiator is *catching the moment*, not requiring a manual "open app and write" step.
8. **Local-first privacy as a feature** — ActivityWatch explicit anti-surveillance stance, Super Productivity encrypted local credentials + no telemetry. ADHD users in particular distrust employer-monitoring tools; both repos make the stance a marketing line.
9. **Non-punitive streaks** — Loft-Hours explicitly *"awareness, not pressure"*, squirreltrap's no-manual-entry checklist, i-have-adhd's matter-of-fact error tone. Three repos independently reject shame-based gamification.
10. **Single-instance / single-focus discipline** — Focus CLI's single-instance lock, Octopus's "Needs Attention" column, Super Productivity's single active timer. The shared UX rule: only one thing visible at a time during work.
11. **Energy/mood tagging over vanity metrics** — Loft-Hours energy_start/end, claude-adhd-skills journaling to Obsidian, ActivityWatch's AFK buckets as a proxy for energy. Output is "when are you sharp," not "how many tasks done."
12. **Forkable output-style as a skill surface** — i-have-adhd SKILL.md, attention-control rubric+judge, claude-adhd-skills skill+hook bundle. ADHD UX rules ship as editable text, not baked UI — because the user's own ruleset is the real product.

---

## Anti-patterns (what fails)

- **Vanity streak counters with public shame.** Streaks break during the inevitable ADHD bad week; public punishment destroys the tool. Loft-Hours explicitly rejects this.
- **Manual task entry as the only capture path.** Anything requiring "open the app and write a task" loses to squirreltrap-style transition-point capture.
- **Cloud-required productivity monitoring.** ActivityWatch's anti-surveillance positioning exists because too many tools ship employer-monitor-friendly by default; ADHD users distrust them.
- **Notifications that interrupt flow.** Super Productivity break reminders are timed, opt-in, and tied to the active timer — they do not fire arbitrarily. Notifications outside an active focus context consistently fail.
- **Choice overload at task entry.** Leantime's "one task on your mind right now?" prompt exists precisely because blank-task-input paralysis is a known ADHD failure mode. Tools that offer 12 fields per task consistently get emptied.
- **Forced multi-step onboarding.** i-have-adhd installs in one step and is immediately useful; tools that require account creation + email verification + workspace setup before first capture consistently lose ADHD users in the first 90 seconds.
- **Gamification without substance.** Trees, badges, and confetti do not compensate for missing receipts, missing receipts, or missing receipts. None of the repos above ship decorative gamification; they ship evidence.

---

## Patterns to apply to omp-deck

Each entry: pattern name → slot → UX idea → Effort (XS/S/M/L) → Impact (XS/S/M/L) → Acceptance.

### 1. Action-first task card
- **Slot:** TasksView.
- **UX:** Every task card shows ONE concrete next-action verb at the top (parsed from description or first non-filler line), capped at 5 sub-items. Filler lines (`a/an/the`, "just", "really", "actually") suppressed.
- **Effort:** XS (text transform in card renderer).
- **Impact:** M.
- **Acceptance:** Given a task description, the first displayed line is a verb-leading imperative ≤ 7 words; lists > 5 items collapse to "+N more."

### 2. Single-active-focus session
- **Slot:** Routines + Overview.
- **UX:** Exactly one focus session can be "active" across the whole app. Starting a new session on a different task prompts "End current?" instead of stacking. Active session pinned at the top of OverviewView with elapsed time + remaining time + ambient pause/resume.
- **Effort:** S (state lock + UI affordance).
- **Impact:** M.
- **Acceptance:** Attempting to start a second session shows a non-blocking "End current first?" sheet; no two sessions are simultaneously `running`.

### 3. Receipts log
- **Slot:** Tasks + Overview.
- **UX:** Every session produces a dated `data/sessions/YYYY-MM-DD-HHMM-<display_id>.md` file containing goal, delivered, next_step, reflection. OverviewView links to today's receipts. Pattern follows Loft-Hours verbatim.
- **Effort:** S (markdown serializer + file write).
- **Impact:** M.
- **Acceptance:** Completing a focus session writes one markdown file; Overview "Today's receipts" count increments without restart.

### 4. Git pre-commit focus guard
- **Slot:** Routines (event-driven on git hook).
- **UX:** A Routines routine watches `git commit-msg` / `pre-commit` events; if the current task is a "deep work" routine and `current_task` is unset, the routine blocks the commit and surfaces "what was I supposed to be doing?" mirror of git-leash. Override: explicit `UNFOCUS=1` env var.
- **Effort:** M (hook event + routine config).
- **Impact:** S (depends on whether devs use git inside omp-deck context).
- **Acceptance:** A routine configured as `focus_guard` triggers on `git` events; blocked commits show the task reminder; `UNFOCUS=1` bypasses.

### 5. Inbox capture on context-switch hint
- **Slot:** InboxView.
- **UX:** Optional OS-level hook (macOS/Windows/Linux adapters like Loft-Hours) detects app-switch away from omp-deck for > N seconds and surfaces an Inbox quick-capture prompt: *"what were you about to do?"* Pattern after squirreltrap. Off by default; explicit opt-in.
- **Effort:** L (native adapters + permission flow).
- **Impact:** M.
- **Acceptance:** With adapters enabled and focus on a non-omp-deck app for > 60s, returning shows a one-line capture prompt; captured text appears in InboxView.

### 6. Energy-tag rollup
- **Slot:** Tasks + Overview.
- **UX:** Tasks accept an optional `energy_tag` (low/medium/high). OverviewView computes "your sharp hours" by aggregating completed-by-tag per hour-of-day across the last 30 days. Refuses to render with < 3 samples per hour bin.
- **Effort:** S (DB column + aggregation query).
- **Impact:** S.
- **Acceptance:** A heatmap-style hour-of-day × energy panel renders only where n ≥ 3 sessions; otherwise shows "need more data" instead of fabricated bars.

### 7. ADHD-output-style for in-app agent replies
- **Slot:** Onboarding + agent responses across all views.
- **UX:** Apply i-have-adhd's 10 rules to omp-deck's own agent (gholam) output style: action-first, numbered multi-step, ≤ 5 bullets, restate state per turn, no preamble/closers. Editable via a settings page (forkable, like the source).
- **Effort:** S (system prompt edit + settings UI).
- **Impact:** M.
- **Acceptance:** Gholam's first line on any reply is a verb-leading imperative ≤ 7 words or a numbered list; reply length capped at the smallest viable answer.

### 8. Time-blindness nudge via Routines
- **Slot:** Routines (cron + manual).
- **UX:** A routine fires at configurable intervals (e.g. every 90 min) and injects a non-blocking toast: *"You've been on `<task>` for `<minutes>`. Continue, switch, or break?"* Toast has 3 buttons + auto-dismiss. Pattern after claude-adhd-skills nudge hooks.
- **Effort:** S (cron routine + toast component).
- **Impact:** M.
- **Acceptance:** A cron-style routine triggers a toast with 3 buttons; selection writes to the active task's `pomodoro_interrupt_count`.

### 9. Frictionless Inbox → Task promote
- **Slot:** InboxView → TasksView.
- **UX:** One keystroke (`p`) promotes the focused Inbox item to a Task. Auto-derived: `display_id`, default column = `inbox`, verb-first title normalization per Pattern 1. No modal, no field-filling.
- **Effort:** XS (hotkey + minimal server route).
- **Impact:** M.
- **Acceptance:** Pressing `p` on an Inbox item creates a Task row with the original text normalized to a verb-first imperative and lands at the top of the kanban `inbox` column.

### 10. Ambient DND envelope during focus session
- **Slot:** Routines + Settings.
- **UX:** When a focus session starts, a routine sets the OS notification preference to "focus" for the session duration (uses the existing native customizable notification preference surface). Restores prior state on session end. Off by default; explicit per-routine toggle.
- **Effort:** S (reuses existing settings API + routine event).
- **Impact:** S (depends on platform support).
- **Acceptance:** Starting a `dnd_envelope: true` routine flips notification preference to "focus"; ending restores the prior preference.

### 11. Non-punitive streak surface
- **Slot:** OverviewView.
- **UX:** Streak counter shows "focus sessions completed" over the trailing 7/30 days. No "broken" state — instead, a gap of > 2 days shows a soft *"welcome back"* and a link to the gap-day receipts (if any). Pattern after Loft-Hours' non-punitive framing.
- **Effort:** XS (derived view, no new data).
- **Impact:** S.
- **Acceptance:** After 7 days with no sessions, the streak card shows a "welcome back" tone, never a "0 streak" / red-X state.

### 12. Receipts-driven review rollup
- **Slot:** OverviewView.
- **UX:** `/review week|month` view (Routines-driven, manual trigger) computes goal-vs-delivered ratio and energy patterns from receipts. Refuses to render conclusions with < 3 sessions in the window. Pattern after Loft-Hours rollup.
- **Effort:** M (review command + aggregation).
- **Impact:** M.
- **Acceptance:** A weekly review with ≥ 3 receipts shows goal-vs-delivered ratio + energy pattern; with < 3, it shows "need more sessions" and a count to threshold.

---

## Open questions (verify before shipping)

1. **Octopus license file.** scout found MIT in README but no standalone `LICENSE` at master/main HEAD — both 404. Verify before any code reuse: check `https://github.com/SebastianElvis/octopus/blob/<default-branch>/LICENSE` directly.
2. **Leantime AGPL-3.0 carve-out scope.** `/app/Plugins` may carry other (incl. enterprise) licenses per the README; confirm whether any UX patterns we'd borrow live in the core (copyleft) or a plugin (separate license).
3. **git-leash graduated override semantics.** README implies `UNLEASH=1` is global; need to confirm per-session override is possible before mirroring in Pattern 4.
4. **ActivityWatch bucket schema stability.** aw-server's REST shape has changed across versions; pin a version (or wrap with an adapter) before consuming from omp-deck.
5. **squirreltrap reuse.** No LICENSE — treat as inspiration only. For Pattern 5, prefer writing a new OS adapter rather than forking.
6. **dubbii "anti-ADHD tax" mechanics.** Closed-source; the subscription-renewal-reminder behavior is asserted from store listing copy only, not first-party docs. If we ship a subscription surface in the future, verify independently.
7. **i-have-adhd rule licensing.** The 10 rules are MIT-licensed text in the SKILL.md, but if we paraphrase heavily, attribution may still be expected. Decide before shipping Pattern 7.
