---
name: omp-eval-secret-safety
description: "Use before writing any JS/py/rb/jl eval cell in an OMP session that loads, derives, or passes through config/API data that may contain secrets (API keys, tokens, passwords, auth headers) — prevents accidental full-object leaks into the visible transcript via trailing-expression auto-display."
---

# Eval Secret Safety

## The failure mode
In OMP's persistent eval kernels (JS/Bun confirmed; treat py/rb/jl as suspect until verified otherwise), the **trailing expression of a cell is auto-displayed**, in full, regardless of any explicit `display()`/`console.log()` calls earlier in the same cell. This includes:
- A bare variable reference: `servers` as the last line.
- A plain assignment statement: `globalThis.cache = servers;` — this evaluates to `servers` and gets echoed too, not just executed silently.
- An awaited call whose return value is secret-bearing: `await fetchFullConfig();` as the last line.

This has caused real, repeated live-credential leaks into visible chat transcripts (API keys, Basic-auth headers, JWT secrets, admin passwords pulled from config files or infra-control-plane API responses like Dokploy project/compose details, which embed full `env` blocks).

## The rule
Before running ANY eval cell that touches config files, secrets managers, credential stores, or infra APIs (Dokploy, cloud consoles, secret-bearing MCP servers), ask: **could any value in scope contain a real secret?** If yes:

1. Extract only the non-secret fields you actually need into a fresh summary object BEFORE the last line (e.g. `{ ok, status, names: [...], count }` — never the raw object).
2. Make that summary object — not the raw secret-bearing object — the last thing the cell touches, OR terminate the cell with a deliberately inert final statement (`undefined;`, `1;`, a `console.log(...)` call whose own return value is `undefined`).
3. NEVER let a storage assignment (`globalThis.x = ...`, `const y = ...` when `y` is later referenced bare) be the literal last line if the right-hand side is or contains secret data — assignment expressions still auto-display their value in this kernel.
4. When in doubt, wrap the whole body in an IIFE that returns nothing: `(async () => { ...body...; })();` — the outer call's own return is a Promise, not the data, so nothing leaks even if you forget step 1.

## If it happens anyway
Do not bury it. In the same turn: name exactly which credentials were exposed (not vague — enumerate them), state they're now live in the transcript, and recommend rotation. Do not wait to be asked. Do not attempt to retroactively "fix" the transcript (impossible) — fix forward: correct the harness pattern immediately so the same cell shape doesn't repeat.

## Quick self-check before submitting a secret-adjacent eval cell
- What is the literal last line of this cell?
- If I removed every `display()`/`console.log()` call, what value would still print?
- Does that value, or anything it contains, come from an `env` block, `Authorization` header, API key field, password field, or token field?
- If yes to the last question, the cell is not safe to run as written.
