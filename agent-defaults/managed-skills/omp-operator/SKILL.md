---
name: omp-operator
description: "Configure and troubleshoot Oh My Pi context, skills, MCP servers, agents, models, memory, and token usage with minimal prompt overhead."
---

# OMP Operator

## Sources of truth
Use `omp://` docs for harness behavior and `~/.omp/agent/{config.yml,mcp.json,models.yml,AGENTS.md}` for machine state.

## Token discipline
- Keep global AGENTS/RULES short.
- Keep few active skills; archive specialized runbooks and load on demand.
- Avoid duplicate MCP providers and large tool schemas.
- Keep automatic loops, advisors, recursion, and eager task fanout disabled unless explicitly needed.
- Use subagents only when independent parallel work saves more than their bootstrap context costs.
- Measure first-call input in a fresh session after configuration changes.

## Change safety
Back up touched files, archive rather than delete, never expose secrets, validate JSON/YAML, restart OMP when MCP or discovery state changes, and record rollback paths.

## Installing a source-built stdio MCP server (no npm package)
Some MCP servers are never published to npm/PyPI — the only distribution channel is a git clone + local build. Recipe used successfully for `superdesign` (2026-07-30):

1. Check `~/.omp/agent/mcp-servers/` first — it's the established convention directory for locally-built/cloned MCP servers and diagnostic probe scripts (already holds crawl4ai-mcp.js, firecrawl-mcp.js, and reusable probes). Clone the target repo into a subdirectory there: `git clone <repo-url> ~/.omp/agent/mcp-servers/<name>`.
2. Build it: `npm install && npm run build` (check package.json's `scripts.build` and `main`/`bin` fields for the actual entry point — don't assume `dist/index.js`). Never trust a pre-committed `dist/` or `node_modules/` as correct for this OS — rebuilding locally re-resolves platform-specific binaries (confirmed: a macOS-built `node_modules` had to drop `@esbuild/darwin-arm64`/`fsevents` and pull Windows equivalents on rebuild).
3. Back up `mcp.json` first: `cp mcp.json mcp.json.bak-$(date +%Y%m%d-%H%M%S)` — matches the existing timestamp convention already used by prior edits in this file.
4. Add the new entry to `mcpServers` in `~/.omp/agent/mcp.json`. On this Windows box, every stdio entry that isn't a plain native `.exe` (npx, node scripts) is wrapped through `cmd.exe /c <absolute-exe-path> <args...>` — bare command names have failed to resolve reliably in the host's spawn path before; the absolute `node.exe`/`npx.CMD` path lives under the `npm config get prefix` directory (e.g. `C:\nvm4w\nodejs\node.exe`). Example:
   ```json
   "superdesign": {
     "type": "stdio",
     "command": "cmd.exe",
     "args": ["/c", "C:\\nvm4w\\nodejs\\node.exe", "C:\\Users\\PC\\.omp\\agent\\mcp-servers\\<name>\\dist\\index.js"],
     "env": {},
     "timeout": 60000
   }
   ```
5. Validate JSON syntax: `node -e "require('<path to mcp.json>')"`.
6. Smoke-test the real stdio handshake BEFORE relying on a host reload: `node ~/.omp/agent/mcp-servers/probe-mcp-server.js <server-name>` spawns the entry exactly as written in mcp.json, sends `initialize` + `tools/list`, and reports `toolCount`/`tools`. Add `--tool <name> --args '<json>'` to also smoke-test one real `tools/call` round trip (run it from a scratch cwd like a temp dir if the tool has filesystem side effects, then delete the scratch dir afterward — don't leave test artifacts in the project or in `~/.omp/agent/`).
7. New/changed MCP servers are discovered at harness startup — this agent has no in-session tool to hot-reload MCP registration, so a successful `probe-mcp-server.js` handshake proves the server itself works, but the new tools won't appear in this session's own `xd://` inventory until the OMP session/Orca is restarted. Say so explicitly rather than implying the tools are already live.

## First-party AI-vendor MCP endpoints tied to a chat subscription
Before wiring up an official vendor MCP server (e.g. Anthropic's own `https://api.anthropic.com/v1/design/mcp` for Claude Design), check its OAuth protected-resource metadata (`<mcp-base>/.well-known/oauth-protected-resource`, RFC9728) directly. If `authorization_servers` points at the vendor's own consumer-app domain (e.g. `claude.ai`) rather than a developer/API-key-issuing domain, and there's no documented API-key/bearer path, treat it as locked to that vendor's own first-party client — these are frequently policy-enforced (not just technically hard) against generic/third-party clients impersonating the sanctioned app. Don't attempt to spoof headers or client identity to work around this; find or install a genuine alternative instead.

## Archived references
Previous OMP/plugin/fallback procedures live in `~/.omp/agent/managed-skills-archive-2026-07-20/`; load only by exact incident name.
