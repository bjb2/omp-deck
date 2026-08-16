---
project: {{PROJECT}}
user_name: {{USER_NAME}}
focus: {{FOCUS}}
language: {{LANG}}
timezone: {{TIMEZONE}}
last_updated: {{YYYY-MM-DD}}
---

# Mission

Assist {{USER_NAME}} with ADHD without ever letting attention drift. Keep momentum high, context warm, and interruptions cheap. Every interaction either advances a task or removes friction from the next one — never both, never neither.

# Auto-Kanban

Rules for the W2 auto-kanban worker:

1. Numbered lists in chat become tasks.
2. Bullet lists in chat become tasks.
3. Headings in chat become tasks.
4. Cap ingestion at 10 tasks per message; overflow is queued, not dropped.
5. Every task is tagged with the project cwd basename so multi-repo sessions do not bleed into each other.
6. Tasks survive restarts; the inbox is the single source of truth, not chat history.

# ADHD Focus

Rules for the W1 focus-mode worker:

1. Pomodoro default: 25 minutes on, 5 minutes off.
2. The strip UI is pinned to every route, not just the home view.
3. Pre-alert fires 15 minutes before any routine starts.
4. Notifications are muted for the duration of an active focus session; queue, do not discard.
5. Session start and stop are idempotent — re-entry never doubles a timer.

# Voice

Rules for the W0-A and W0-B voice workers:

1. Support Farsi and English; detect from the most recent transcript, not the UI locale.
2. Transcribe locally via the Whisper binary pointed to by the `WHISPER_BIN` env var; no network calls for audio.
3. One `MediaRecorder` instance lives for the whole app; routes subscribe to it, none own it.
4. Successful transcription inserts at the caret of the active field, never replaces selection wholesale.

# Gholam Tab

Rules for the suggestion engine:

1. The Tab key inserts the current suggestion; there is no accept dialog.
2. Suggestions travel over the `GholamTextSuggestion` frame from `@omp-deck/protocol` — match that shape exactly.
3. When Gholam is offline, Tab falls back to no-op silently; the user never sees an error toast for a missing suggestion.
4. The suggestion is replaced, never appended; one slot, one value, one keystroke.

# Schedule + Routines

Rules for the W1 schedule manager:

1. The next routine is always visible in the strip, even when no focus session is active.
2. Each routine owns its own 15-minute pre-alert toggle; the default is on.
3. Pre-alerts are skipped while a focus session is running, never silenced globally.
4. Routine firing writes a journal entry; the journal is the audit trail, not the chat log.

# Variables table

| var | default | source |
| --- | --- | --- |
| `{{PROJECT}}` | `os.cwd()` basename | runtime |
| `{{USER_NAME}}` | `whoami` | runtime |
| `{{FOCUS}}` | `inbox` | runtime (per-session) |
| `{{LANG}}` | `en` | runtime |
| `{{TIMEZONE}}` | `Intl.DateTimeFormat().resolvedOptions().timeZone` | runtime |
| `{{YYYY-MM-DD}}` | today | runtime |

# Editing

Edit the YAML frontmatter fields freely; the resolver substitutes `{{TOKEN}}` placeholders at load time. No build step is needed — save and reload. Unknown tokens are left as literals so a typo is visible instead of silently emptied.
