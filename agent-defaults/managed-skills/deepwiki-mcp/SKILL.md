---
name: deepwiki-mcp
description: "Use the DeepWiki MCP server for AI-generated architecture/design Q&A over public, already-indexed GitHub repositories you don't have checked out locally; read source directly for repos already on disk, and use xd://github file_read or plain read on the GitHub URL when you need exact file content or a README instead of a synthesized summary."
---

# DeepWiki MCP

## Invoke
Devices are `xd://mcp__deepwiki_<tool>`. Write the JSON argument object as `content` with `write`; `read xd://mcp__deepwiki_<tool>` returns docs and full schema. Confirm the exact path from this session's `xd://` inventory before calling.

## Route
DeepWiki returns an AI-generated architectural narrative for a public GitHub repo it has indexed. It is not a code reader and never a substitute for real source you can already reach.
- Repo is checked out in this workspace (including this one): read the source directly with `read`/`grep`/`glob`. Never call DeepWiki for something already on disk.
- Need a repo's rendered README or a specific doc page, not cloned: `read` the GitHub URL directly — reader-mode text, cheaper than an MCP round trip.
- Need exact file content or a directory listing from a public repo NOT on disk: `xd://github` with `op: file_read` — literal bytes, no cloning, no summarization.
- Need a specific issue or PR: `issue://<N>` / `pr://<N>`.
- Need current news, releases, or general web facts: `web_search`.
- Need architecture, design rationale, or a "how does X work" overview of a public repo you don't have locally: DeepWiki. This is its one real niche — nothing else here synthesizes a whole-codebase narrative.
Pick one path per question; don't fetch the same fact through both `xd://github op:file_read` and DeepWiki.

## Tool families
All three take `repoName` as `owner/repo` (e.g. `facebook/react`).
- `read_wiki_structure` — topic list for a repo. Cheap; call first to see what's documented before pulling full contents.
- `read_wiki_contents` — full generated wiki text for a repo. Can be long; pull only when you need the whole document, not one fact.
- `ask_question` — targeted Q&A grounded in the repo's indexed content. `repoName` accepts one repo or an array up to 10 per the schema, but observed behavior favors the first repo — a multi-repo array is not reliable for genuine cross-repo synthesis. Loop one `ask_question` call per repo instead of trusting the array for cross-repo questions. Prefer this tool over `read_wiki_contents` for a single question — it returns a synthesized answer, not the whole wiki.

## Limits
- Public repositories only, and only ones DeepWiki has already indexed. No private-repo or org auth is configured in this deployment; don't attempt private repos, and expect gaps on obscure or very new ones.
- Every answer is DeepWiki's synthesis, not verbatim source — treat specifics (a function signature, a config key, a version number) as [INFERENCE] and confirm anything load-bearing against the real file via `xd://github op:file_read`.
- Transport is remote HTTP. A DeepWiki outage or network blip presents as this server being absent, not as a GitHub-wide failure.

## Safety
Read-only throughout — no writes, no side effects on the target repo or this workspace. Safe to call freely; the only cost is context and latency, so don't reach for `read_wiki_contents` when `ask_question` already answers the question.
