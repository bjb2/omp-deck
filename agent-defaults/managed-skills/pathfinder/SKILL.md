---
name: pathfinder
description: "Use when tracing code paths through unfamiliar codebases — from an entry point to a target symbol, or finding all callers of a function. Useful for impact analysis, debugging, and onboarding to a new codebase."
---

# Pathfinder

Use when you need a path through code: from an entry (HTTP handler, CLI command, scheduled job) to a target, or the reverse — every caller of a symbol. Impact analysis, debugging, onboarding to a new repo.

## Triggers

- "Trace how X reaches Y"
- "What calls this function?"
- "Call chain from the API handler to the DB write"
- "Find every caller of this method"
- "Impact analysis on changing this function"

## Workflow

1. **Anchor.** `lsp definition` to fix the start symbol. If searching by name, `lsp references` first — faster than grep and follows shadowing.
2. **Walk the graph.** LSP-based traversal beats text search for re-exports, generics, trait dispatch:
   - `lsp callers` / `lsp callees` — immediate neighborhood
   - `lsp definition` — declaration site
   - `lsp implementation` — concrete implementors of an interface
3. **Narrow.** A symbol with 200 callers isn't useful — filter by file, layer (controller/service/repo), or annotation.
4. **Note language boundaries.** FFI / IPC / HTTP break the static graph; mark the hop explicitly.
5. **Deliver the chain.** Ordered path with `file:line` for each hop. The chain is the artifact.

## Commands

- `lsp references <symbol>` — every callsite
- `lsp definition <symbol>` — where it's declared
- `lsp implementation <symbol>` — interface → concrete impls
- `ast_grep` with a `calls` pattern — structural search across the repo
- `grep -rn <symbol>` — last resort when LSP doesn't cover the file type

## Pitfalls

- Dynamic dispatch / DI / reflection breaks static analysis. Read the wiring code when the graph stops.
- Re-exports create phantom callsites. Trust LSP over grep.
- "Shortest path" is rarely the only path. Surface alternates if the chain branches.

## Pairing

- Bug → trace forward from the symptom to the cause.
- Refactor → trace backward from the symbol being changed — that's the impact surface.
- Onboarding → start at the entry, follow the graph three layers deep, then read those files linearly.
