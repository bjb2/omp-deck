# WATCHDOG — Journey Log & Thoughts

## 2026-06-25 — Nghimmo Provider Configuration

- Added provider `nghimmo` with Base URL `https://api.nghimmo.com/v1`.
- Verified and applied API key `<redacted>`.
- Discovered and addressed validation errors:
  - Error: Missing `api` field at provider level. Solved by setting `api: openai-completions`.
  - Discovery block removed and replaced with explicit Claude models (`nghi/claude-*`) from official documentation, since the API key is Claude-restricted and the default discovery endpoints might return unauthorized models (e.g. Grok/xAI models) causing failures during automatic model selection.
- Verified final configuration via YAML parser in Python.
