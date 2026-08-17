---
name: research-intelligence
description: "Perform current web, documentation, code, repository, and market research with minimal tool calls and source-grounded synthesis."
---

# Research Intelligence

## Invocation
MCP tools mount as devices: write the JSON argument object to `xd://mcp__<server>_<tool>`; `read` that path for full schema.
`crawl4ai` sanitizes to `crawl_ai` — confirm every exact device path against the session's own `xd://` inventory, never a hardcoded one.

## Route
Cheapest capable tool wins. Descend only when the rung above cannot do the job.
1. Known URL or local path: built-in `read`. It already returns reader-mode markdown. Never spend an MCP call to fetch a page `read` can fetch.
2. Broad current-fact discovery: exactly ONE provider, never more than one. `web_search_exa` for semantic/neural discovery and source-quality filtering; `tavily_search` for direct factual lookup with answer synthesis.
   Parallel `web_search` (see `parallel-mcp`) is a third alternative for the same rung — prefer it when the ask packs several related sub-questions into one atomic objective, since it batches `search_queries` in a single call where exa/tavily need several separate ones.
   Escalate to `tavily_research` (or Parallel `web_fetch` on the specific URLs) only after that single call returned incomplete or conflicting evidence. Exa's tool set is package-dependent — check the live `xd://` inventory before assuming an advanced-search variant exists.
3. One page needing JS rendering or clean extraction: on-prem infrastructure first — crawl4ai `md`(url), then `firecrawl_scrape`(url) or `firecrawl_extract`(urls). Use `web_fetch_exa` or `tavily_extract` only when both are unreachable.
4. Whole-site or multi-page traversal: crawl4ai `crawl`(urls), `firecrawl_map`(url), `firecrawl_crawl`(url), or `tavily_map`(url). Fix an explicit page budget before starting — these fan out.
5. Script execution, screenshot, or PDF of a page: crawl4ai `execute_js`(url, scripts), `screenshot`(url), `pdf`(url).
6. Public repository architecture: deepwiki `read_wiki_structure`(repoName), then `read_wiki_contents`(repoName); `ask_question`(repoName, question) for one targeted question. Deepwiki knows only public indexed repositories — for private or local code, read the source.
   Full tool detail, argument shapes, and the cross-repo-array caveat live in `deepwiki-mcp` — read it before a multi-repo `ask_question` call.
7. Library/framework/SDK API syntax or version-pinned docs: `context7-mcp` (resolve the library ID, then query docs by topic) before falling back to `read` on official doc URLs. Public real-world implementation patterns across many repos: `grep-mcp`'s `searchGithub`. Repo-scoped, qualifier-heavy, or private-repo GitHub search: `github-mcp`'s `search_code`.

## Cost
Self-hosted crawl4ai (`http://crawl.v244.net`) and firecrawl (`https://firecrawl.v244.net`) cost nothing per call — take fetch, extract, and crawl there first.
Vendor-hosted exa, tavily, and Parallel bill per call — spend them only on discovery that on-prem crawling cannot do. Deepwiki, Context7, and grep.app are remote too but scoped narrow: deepwiki only for public repos not on disk, Context7 only for library docs, grep.app only for public code patterns — read source directly whenever the answer is already on disk.

## Rules
Start with one precise query. Escalate only when evidence is incomplete or conflicting. Prefer primary sources and current official docs; record publication/version dates. Cross-check high-impact claims. Cite links and label inference. Never fire multiple equivalent engines by default.

## Output
Answer decision first, then evidence, uncertainty, and next action. Avoid raw search dumps.

## Freshness
Do not freeze volatile API details in this skill. Retrieve current documentation at execution time; read the device schema for parameters and response shapes.

## Archived references
Provider-specific and market-research procedures are searchable under archived skill directories; load only the exact procedure needed.
