# OMP Global Doctrine

- Be concise. Use tools only when they materially improve correctness.
- Read relevant local context and existing patterns before changing code.
- Prefer direct execution; use subagents only for genuinely independent work when parallelism clearly outweighs context cost.
- Never require sequential-thinking, note logging, session rituals, or broad research by default.
- Use the smallest capable tool surface; avoid redundant MCP calls and duplicate web/search providers.
- Before solving something inline, check whether an installed MCP server or managed skill already covers it — read the matching skill under `~/.omp/agent/managed-skills/` and use its documented route instead of reinventing it.
- Protect secrets and personal data. Confirm destructive or irreversible external actions.
- Fix root causes with minimal diffs. Reuse existing code and native platform features before adding abstractions or dependencies.
- Verify changed behavior with the narrowest real command or scenario before claiming completion.
- Treat unexpected repository changes as user work; never overwrite them casually.
- Keep project-specific procedures in project docs or on-demand skills, not global context.

## Global MCP servers

Defined in `~/.omp/agent/mcp.json`. Each tool mounts as a device at `xd://mcp__<server>_<tool>`: write its JSON argument object to that path, `read` the path for the schema. The server segment is sanitized and can differ from the config key (`crawl4ai` mounts as `crawl_ai`, `context7` mounts as `context`, `open-design` mounts as `open_design`), so confirm exact paths from the session's own `xd://` inventory.

- `dokploy` — control plane for `https://dok.v244.net`: projects, applications, compose, domains, deployments, databases, backups. Skill: `infrastructure-operations`.
- `github` — structured issue, PR, and review writes over a local Docker container. Skill: `github-mcp`.
- `context7` — current, version-pinned library/framework/SDK/CLI documentation and code examples. Skill: `context7-mcp`.
- `parallel` — batched multi-query web search and objective-focused page fetch, hosted. Skill: `parallel-mcp`.
- `grep` — grep.app: real-world code-pattern search across public GitHub. Skill: `grep-mcp`.
- `deepwiki` — architecture Q&A over public indexed repositories only. Skill: `deepwiki-mcp`.
- `crawl4ai` — on-prem service at `http://crawl.v244.net`: markdown, HTML, screenshot, PDF, JS execution, site crawl. Skill: `research-intelligence`.
- `firecrawl` — on-prem service at `https://firecrawl.v244.net`: scrape, extract, crawl, map. Skill: `research-intelligence`.
- `exa` / `tavily` — metered hosted web search and extraction. Skill: `research-intelligence`.
- `open-design` — local-first design workspace app; read/edit a design project's files or commission its own agent to generate/refine a design. Skill: `open-design-mcp`.
- `superdesign` — local design-spec generator: returns wireframe/UI/component/logo specs for you to implement as code, not rendered pixels. Skill: `superdesign-mcp`.
- `sequentialthinking` — revisable or branching thought chains, never by default. Skill: `structured-reasoning-mcp`.

`research-intelligence` is the umbrella router across crawl4ai, firecrawl, exa, tavily, and parallel — read it first for the current cheapest-tool-first search/fetch/crawl decision tree; the per-server skills above hold each server's own tool-level detail and are the ones to read for exact arguments.

Routing rules, cheapest capable tool first:

- Built-in `read`, `web_search`, `xd://github`, and the `issue://` / `pr://` URIs come before any MCP call for the same lookup.
- Self-hosted crawl4ai and firecrawl come before metered exa, tavily, and parallel; one provider per question, never several in parallel for the same answer — `research-intelligence` owns the exa/tavily/parallel tie-break.
- Library/framework doc questions go to `context7-mcp` before `web_search`; public real-world code-pattern questions go to `grep-mcp` before falling back to `github-mcp`'s `search_code`.
- Crawls and multi-page traversals need an explicit page budget before the first call.
- Dokploy operations that delete, stop, or restore are confirmed with the user first, naming the exact target resource.
- Both crawl4ai and firecrawl run as compose services in the Dokploy "AI Utilities" project, so diagnose their outages there before blaming the research tooling.
- `kling` and `tokensave` MCP tools are active in this environment but are not entries in `~/.omp/agent/mcp.json` (provisioned elsewhere) — leave that provisioning alone from here; use them per their own live tool docs when relevant.
