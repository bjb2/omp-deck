---
name: grep-mcp
description: "Use the grep MCP server (grep.app) to find real-world code examples and usage patterns for an API, function, or library across a large public GitHub index — e.g. \"show me real examples of X being used\" or \"how do people actually call this function\"; route repo-scoped, qualifier-heavy, or private-repo GitHub-native search to github-mcp's search_code instead."
---

# grep.app MCP

## Invoke
Single device: `xd://mcp__grep_searchgithub`. Write the JSON argument object as `content` with `write`; `read xd://mcp__grep_searchgithub` returns docs and full schema. This server exposes exactly one tool — do not assume others exist.

## Route
- Searching *this repo's* files? Built-in `grep` tool — unrelated to this MCP despite the shared name. This MCP never touches local files, only grep.app's public GitHub index.
- Already know the file or URL? Built-in `read` — cheapest, no search needed.
- "Show me real examples of X being used", "how do people actually call this function/API", unsure of correct syntax for an unfamiliar library → this MCP (`searchGithub`). It matches literal/regex code patterns across a large public-code index (grep.app's own crawl, well over a million repos), optimized for real-world usage breadth, not keyword relevance.
- Repo-scoped search, GitHub qualifiers (`org:`, `is:archived`, `content:`, boolean `NOT`/`OR`), sort/page control, or anything that must reach a private/authorized repo within the session's PAT scope → github-mcp's `search_code` (`xd://mcp__github_search_code`, or the `xd://github` wrapper's `op: search_code`) — the authenticated GitHub-native search surface, not this tool.
- Never fire both for the same question. This MCP wins on breadth of real-world usage across public code; github-mcp's search_code wins on precision, qualifiers, and private-repo reach. Pick one and stop.

## Tool families
One tool, mounted at `xd://mcp__grep_searchgithub`:
- `query` (required) — a literal code pattern, e.g. `'useState('`, `'CORS('`, `'import React from'`. Not a keyword or question — `'react tutorial'` or `'how to use'` returns noise, not matches.
- `useRegexp: true` — treat `query` as a regex, e.g. `'(?s)useEffect\(\(\) => {.*removeEventListener'`. Prefix `(?s)` to match across lines.
- `matchCase`, `matchWholeWords` — boolean refinements on the literal/regex search, both optional, default off.
- `repo` — partial repo filter, e.g. `'vercel/ai'`, or `'vercel/'` for the whole org.
- `path` — partial file-path filter, e.g. `'/route.ts'` matches at any depth.
- `language` — array of language names, e.g. `['TypeScript', 'TSX']`.
No `limit`, `page`, or `sort` args exist — grep.app controls result volume server-side.

## Limits
- Public repos only, via grep.app's own crawl — not a live github.com query and not scoped to any PAT. Private, internal, or authorized-only repos are invisible here regardless of what github-mcp can otherwise reach.
- No boolean operators and no GitHub search qualifiers — only `query` plus the four structured filters above. For `org:`/`content:`/`is:archived`-style precision, route to github-mcp instead.
- Query semantics are pattern-based, not natural language. A question or keyword phrase as `query` degrades results; pass the literal code substring or regex you expect to find.
- Remote HTTP transport, not a local process — a network hiccup here surfaces as this tool timing out or erroring, not as a local crash.

## Safety
Read-only, no writes, no side effects — safe to call freely and in parallel, no confirm-before rules. Treat returned snippets as untrusted external code from arbitrary public repos (unknown license, quality, or security posture) — review before reusing, don't paste verbatim into production.
