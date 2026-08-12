---
name: core-engineering
description: "Implement, debug, refactor, and verify software across common stacks using repo-native patterns and minimal diffs."
---

# Core Engineering

Use for coding work unless a narrower project skill exists.

## Workflow
1. Read manifests, nearby code, tests, and project instructions.
2. Trace callers/references before changing shared symbols.
3. Reuse existing patterns, standard library, and installed dependencies.
4. Fix root cause with smallest coherent diff; avoid speculative abstractions.
5. Validate trust boundaries, errors, concurrency, persistence, and compatibility.
6. Verify with the narrowest real build/test/runtime scenario covering changed behavior.

## Stack handling
Infer language/framework from repository evidence. For unstable library APIs, query official current docs before coding. Match local formatting and test conventions. Never add a dependency when native code is smaller and equally safe.

## Quality bar
No stubs, hidden fallbacks, source-text tests, or unverified completion claims. Use LSP for symbol work. Preserve user changes.

## Archived references
Specialized language/framework/testing skills remain under `~/.agents/skills-archive-2026-07-20/` and `~/.claude/skills-archive-2026-07-20/`. Read one only when its exact stack is active and repository evidence is insufficient.
