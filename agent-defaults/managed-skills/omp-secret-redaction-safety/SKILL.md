---
name: omp-secret-redaction-safety
description: "Use when a secret/API-key value needs to be removed or replaced inside a file in an OMP session with secrets.enabled, or when redacted $$HASH:CASE$$-style tokens appear in tool output and need handling."
---

## The trap

OMP's secret obfuscation shows real secret values to the model as deterministic placeholders shaped like `$$HASH:CASE$$` (or `#HASH:CASE#` depending on format). These are **not inert text**. If the model types that exact literal glyph into ANY outbound tool-call payload — a bash env var, a JS string literal, an `apply_patch` hunk, even a `grep` pattern argument — the substrate resolves it back to the real secret before the tool runs, on every tool, unconditionally. Typing the placeholder meaning "insert these literal characters as prose" instead injects the live credential into whatever you're writing.

This bites hardest when a subagent's dispatch context contains a redacted placeholder (because the orchestrator's own message got obfuscated before send) and the subagent's model reconstructs/deobfuscates it while generating file content — the real secret ends up baked into a persisted file (skill, doc, config) with no visible sign in the transcript.

## Symptoms

- A `read` of a just-written file shows `$$HASH:CASE$$` sitting in prose where you expected a plain word.
- Attempts to "fix" it by writing what looks like a different value still show the placeholder afterward.
- JS eval `display()` output shows the placeholder even for a runtime string you built without any bracket syntax (the display layer independently re-obfuscates matching content, which is expected and fine — the write-time round-trip is the actual bug).

## Diagnose without leaking

Never `read`/`cat`/`display` a suspect file's raw content into your own context to check — that's what a human reviewer can look at, but for the model, use boolean-only checks so the value never re-enters context:

```bash
if grep -qF "$THE_REAL_ENV_VAR" suspect_file; then echo LEAKED; else echo clean; fi
```

Run this against every registered secret env var for every file the session touched, not just the one you suspect — the same failure mode tends to repeat across sibling files (a shared dispatch context leaks into every subagent that receives it).

## Fix

1. Never type the `$$...$$` (or `#...#`) glyph again for the rest of the fix — not even inside a variable assignment, not even as a grep pattern. Any literal occurrence anywhere in a tool call round-trips to the real value.
2. Redact using a shell one-liner that reads the real value from its env var and substitutes a plain replacement, entirely inside one bash invocation:
   ```bash
   perl -i -pe 'BEGIN{$k=$ENV{THE_KEY}; $r=$ENV{REPL}} s/\Q$k\E/$r/g' file1 file2
   ```
3. Pick a replacement word under 8 characters. Env-var-based auto-secret-detection in OMP only registers values >= 8 characters, so a short word ("on-prem", "local") can't itself collide with another registered secret and re-trigger the same bug.
4. Verify with the same blind boolean grep immediately after, in the same message. Do not trust eval-tool self-reports or `display()` output as the verification — they pass through the same contamination path.
5. If grammar needs polishing afterward, edit with plain words only, then re-run the blind grep one more time before moving on — a second pass is cheap insurance against a repeated slip.

## Scope check

A hardcoded credential in a local, non-shared, already-trusted config file (e.g. `~/.omp/agent/mcp.json`, matching the trust tier of a prior working config it replaced) is not a leak worth chasing — it never left its intended boundary. The actual incident to hunt for is a secret value landing in a file designed for broad exposure: a managed skill (auto-loaded into every future session's prompt), a doc, a committed repo file, or anything a subagent's dispatch context could echo into its own output.
