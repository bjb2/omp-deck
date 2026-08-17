---
name: context7-mcp
description: "Use the context7 MCP server to fetch current, version-pinned documentation and code examples for a specific library, framework, SDK, API, or CLI — resolve its Context7 library ID first, then query docs by topic; skip it for refactoring, business-logic debugging, code review, or general programming questions not tied to one library's own docs."
---

# Context7 MCP

## Invoke
Devices are `xd://mcp__context_<tool>`. Write the JSON argument object as `content` with `write`; `read xd://mcp__context_<tool>` returns docs and full schema. Confirm the exact path from this session's `xd://` inventory — the config key `context7` sanitizes to `context` in the mount (verified: `xd://mcp__context_resolve_library_id`, `xd://mcp__context_query_docs`). Transport is HTTP to Context7's hosted API.

## Route
One provider per lookup; don't split a single question across this MCP and `web_search`/`read`.
- Library/framework/SDK/API/CLI syntax, config, version-migration, or setup question — always this MCP, even for well-known libraries (React, Next.js, Django, Spring Boot, etc.). Training data and any locally cached docs can be stale; Context7 serves live, version-pinned docs with code examples. Prefer it over `web_search` and over guessing at doc URLs with `read`.
- Refactoring, business-logic debugging, code review, or a general programming concept not anchored to one library's documented API — skip this MCP; reason it out directly or use repo tools (`grep`, `read`).
- User hands you an exact URL and wants that page's content — `read` the URL directly; that's a page fetch, not a library-docs lookup.
- Broad research, news, or comparisons outside library documentation — `web_search`.

## Tool families
Exactly two tools, always used together — see Workflow.
- `resolve_library_id` — req `libraryName` (official punctuated form: `Next.js` not `nextjs`, `Three.js` not `threejs`, `Customer.io` not `customerio`) and `query` (your intent, used only to rank candidate libraries, not itself looked up). Returns candidates with library ID, description, snippet count, source reputation (High/Medium/Low/Unknown), benchmark score, and available versions.
- `query_docs` — req `libraryId` (exact `/org/project` or `/org/project/version`, e.g. `/vercel/next.js/v14.3.0-canary.87`) and `query` (one concept per call — split a multi-concept question into separate calls instead of combining it).

## Workflow
Order matters when you don't already have one — `query_docs` needs `libraryId` (the `/org/project[/version]` string), and the only source for that is `resolve_library_id`'s output, unless you already know the exact ID.
1. `resolve_library_id` with the library name and your intent. Pick by name match, source reputation, snippet coverage, and benchmark score. If several candidates are close and picking wrong would change the answer (e.g. different major versions), ask the user instead of guessing.
2. `query_docs` with that exact `libraryId` and a single-topic `query`.
Skip step 1 only when the request already states an explicit ID in `/org/project` or `/org/project/version` form — pass it straight to `query_docs`.

## Limits
- Both tools cap at 3 calls per question. If 3 `resolve_library_id` calls surface no good match, or 3 `query_docs` calls don't answer it, stop and use the best result on hand, or fall back to `web_search`, rather than retrying further.
- `query_docs` is single-topic by contract — a question spanning routing, auth, and caching needs three calls, not one broad one.
- No tool enumerates or browses libraries without a name; every lookup starts from a concrete library/package name.
- Low snippet count or "Unknown"/"Low" source reputation on a `resolve_library_id` candidate signals thin or unverified coverage, not necessarily the wrong pick — weigh it against name match and benchmark score.

## Safety
Read-only: both tools query Context7's hosted documentation index and cause no writes, no repo changes, no other external side effects. Never put API keys, passwords, tokens, credentials, personal data, or proprietary/confidential code in `query` — sent to the Context7 API as-is, per the tool's own schema docs. Extend the same caution to `libraryName`/`libraryId`: no explicit warning on those fields, but everything you send still leaves this session.
