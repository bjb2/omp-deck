# Pi Lineage & ACP/MCP Ecosystem — Competitive Landscape

## 1. Header

Two protocols are colliding into one practice: **ACP** (Agent Client Protocol, JSON-RPC 2.0, editor↔agent) standardizes *who drives the agent*; **MCP** (Model Context Protocol) standardizes *what the agent can touch*. The Pi lineage (`oh-my-pi`/`pi-coding-agent`, the SDK omp-deck embeds) sits at the ACP-client end. The dominant pattern across all 16 projects surveyed: **infrastructure providers are shipping MCP servers as their primary AI integration surface** (DigitalOcean, Hetzner ×4 forks, SSH/tmux), while a second wave of tooling (Hydra-ACP, container-use, Valet, AgentAPI/ACP) is building **session multiplexing, isolation, and persistence layers** around agent processes that used to be single-shot CLI invocations. omp-deck already owns both halves — an MCP health/install surface and a gholam that can act on the deck's own behalf — but no single project in this survey closes the loop into "agent manages its own MCP-backed infrastructure," which is the gap worth exploiting.

## 2. Per-Project Entries

### phi (`pulseaiclub/phi`)
Minimal terminal-first coding agent in Go, ~12 MB single binary, no Node/Python/Electron runtime. Model-agnostic (any OpenAI-compatible or Anthropic-native endpoint). Unique idea: **hashline edits** — line edits anchored by short content hashes so the agent can't silently overwrite stale sections; defaults to read-only with an explicit approval gate for `write`/`bash`. License: not verified (search-only, no README/LICENSE fetched directly). *(Source: web search, dev.to/GitHub summaries — [INFERENCE], no primary README read.)*

### compozy / CompozyOS (`compozy/compozy`)
Go-daemon "agent operating system": runs existing CLI agents (Claude Code, etc.) as durable, resumable background sessions instead of ephemeral terminal processes. SQLite-backed state; unified model for memory, loops, permissions, approvals. Unique idea: agents **discover each other and delegate via a "Compozy Network"** — multi-agent team coordination is a first-class daemon feature, not bolted on. MIT-licensed. *(Source: web search — [INFERENCE], no primary README read.)*

### aptove/bridge (likely `saltukalakus/aptove-bridge`)
Rust ACP bridge: spawns an ACP agent over stdio, exposes it via WebSocket to mobile/desktop clients, runnable standalone or as an embedded library. Unique idea: **QR-code pairing** plus TLS with certificate pinning and pluggable transports (Local, Cloudflare, Tailscale) — treats "attach a phone to a running coding agent" as a first-class UX. *(Source: web search — [INFERENCE], repo slug uncertain, verify before citing.)*

### vcoderun/acprouter
Part of the `vcoderun` ACP toolkit ecosystem (alongside `acpkit`, an adapter for exposing Pydantic AI/LangChain runtimes over ACP). Functions as a router/proxy translating ACP agents to OpenAI-compatible client expectations. Unique idea: **protocol-format translation as a router**, not a fixed 1:1 bridge — lets one agent serve multiple client dialects. *(Source: web search — low confidence, exact repo purpose partially inferred from naming convention.)*

### smagnuso/hydra-acp
npm-distributed (`@hydra-acp/cli`) session multiplexer/TUI daemon for ACP. Multiple clients (terminal, IDE, browser, Slack) attach to one live agent session; events broadcast to all, prompts/approvals serialize. Sessions survive terminal close, can be handed off to a teammate. Unique idea: **runs its own compaction algorithm and exposes the agent's transcript as a searchable MCP server** — the session history itself becomes an MCP resource. Extensions (Slack bridge, JS-rule auto-approvers) run as daemon-managed companion processes. *(Source: web search, GitHub summary.)*

### newioapp/acp-inspector (likely `tbrandenburg/acp-inspector`)
Web-based (React/TS frontend, Node/TS backend) visual debugger for ACP — the "MCP Inspector" equivalent for ACP. Views message logs, session state, client↔agent traffic over JSON-RPC 2.0/stdio. A separate F#-based `venikman/ACP-inspector` focuses on spec-conformance validation instead. Unique idea: **protocol observability tooling treated as a distinct product**, not a debug flag inside an agent. *(Source: web search — repo attribution uncertain, org slug `newioapp` not directly confirmed.)*

### digitalocean-labs/mcp-digitalocean
Official DigitalOcean MCP integration, evolving from local npx/Go-binary servers to **hosted remote MCP endpoints** (zero local setup). Covers App Platform, Droplets, DOKS, Databases, Networking, Spaces, Insights, Marketplace. Auth via personal access token in client config (`mcp.json`). Unique idea: **cloud-provider-hosted MCP as a product**, not something users self-run — infra-as-agent-tool with a managed control plane. *(Source: DigitalOcean docs + web search.)*

### nityeshaga/hetzner-mcp-server (unresolved — see alternatives)
No confirmed public repo under this exact slug; the pattern is real across community forks: `mjmirza/hetzner-mcp` (Cloud + Storage Box + Robot dedicated servers, "cost guard" requiring confirmation on billable actions), `valerius21/hetzner-mcp` (TS, full Cloud API coverage), `dkruyt/mcp-hetzner` (Python, stdio+SSE transports), `Xodus-CO/hetzner-mcp` (Cursor plugin). Unique idea across the cluster: **cost-guard confirmation gates on any resource-creating/deleting tool call** — infra MCP servers converging on a "confirm before you spend money" pattern. *(Source: web search — original slug unverified, four alternatives listed for accuracy.)*

### devnullvoid/mcp-ssh-tmux
Python MCP server pairing SSH with tmux for persistent remote dev sessions. Avoids per-command SSH handshakes, survives disconnects, keeps shell state (cwd, env vars) across agent turns. Unique idea: **"no regex, no complexity" terminal snapshots** — explicit rejection of screen-scraping in favor of structured tmux pane capture, positioned against fragile alternatives. *(Source: web search, GitHub summary.)*

### JinchengGao-Infty/agent-mux (unresolved — likely conflated with `Hydra`)
No public repo confirmed at this exact path; the user is associated with a git-worktree-based multi-agent orchestration tool. The broader "agent-mux" name cluster (`agentmuxai/agentmux` Rust, `leonardcser/agent-mux` TUI, `buildoak/agent-mux` cross-engine dispatch) converges on: **tmux-multiplexed agent panes as the UI metaphor** for running several coding agents side by side. *(Source: web search — target repo unresolved, pattern description covers the naming cluster instead.)*

### openronin/openronin
MIT-licensed autonomous "AI dev teammate": picks up GitHub issues, asks clarifying questions, writes code, opens PRs, handles reviews/merge conflicts, auto-merges and deploys. Pluggable supervisor model, OpenAI-API-compatible, worker support includes Claude Code. Unique idea: **local-first privacy posture** — data/prompts/tokens stay under the operator's control even while running a fully autonomous GitHub loop. *(Source: web search — [INFERENCE], no primary README read.)*

### omp.sh /collab (native, `@oh-my-pi/pi-coding-agent` SDK)
The SDK omp-deck embeds via `InProcessAgentBridge`. Confirmed in-repo: `ACP_BUILTIN_SLASH_COMMANDS` and `BUILTIN_SLASH_COMMAND_DEFS` are real exports consumed by `apps/server/src/routes-slash-commands.ts` (imports from `@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins` and `.../builtin-registry`). No confirmed dedicated `/collab` command in the base SDK; multi-agent collaboration in the wider Pi ecosystem is delivered via community extensions (`pi-crew`, `pi-collaborating-agents`) built on the SDK's `ExtensionAPI`/`registerCommand`. Unique idea already in omp-deck: **the slash-command list is filtered live** — `apps/server/src/routes-slash-commands.ts:167-171` cross-references `ACP_BUILTIN_SLASH_COMMANDS` against `BUILTIN_SLASH_COMMAND_DEFS` to hide TUI-only commands that would dead-end in a picker. *(Source: `apps/server/src/routes-slash-commands.ts` read directly + web search for broader Pi/omp ecosystem.)*

### dagger/container-use
Dagger-built MCP server giving each coding agent an isolated, containerized dev environment backed by a **Git worktree per agent** sharing one repo's metadata. Solves "agent chaos" (port/dependency collisions when multiple agents share one workspace). MCP interface exposes list/watch/log/diff/attach-terminal on the container. Unique idea: **worktree + container pairing exposed entirely through MCP tool calls** rather than a separate CLI the agent has to shell out to. *(Source: web search, dagger.io, container-use.com.)*

### coder/agentapi
Historical (largely deprecated) HTTP API wrapper that scraped stdin/stdout of CLI agents (Claude Code, Aider, Goose, Gemini, Codex) to expose a programmable API/web UI before those agents had native APIs. Coder has since moved to ACP (`coder/acp-go-sdk`) as the modern successor for agent lifecycle management. Unique idea (as a cautionary pattern): **stdio-scraping as a stopgap integration layer** — useful as the anti-pattern baseline that ACP was built to replace. *(Source: web search.)*

### tkhq/valet
Turnkey's fork of `yourbuddyconner/valet`; provides background coding agents with full, isolated development environments, plus a companion GitHub App for wiring agents into issues/PRs. Turnkey's core business is wallet/key-management infrastructure, so Valet is an internal devtool surfaced publicly. Unique idea: **key-management company running background coding agents against its own infra** — an early example of "agent as employee with its own environment," adjacent to the Compozy/EpicStaff pattern but security-vendor flavored. *(Source: web search — [INFERENCE], no primary README read.)*

### EpicStaff (`EpicStaff/EpicStaff`)
Source-available Django-backed visual multi-agent workflow builder (drag-and-drop canvas via Foblex Flow). Persistent audit trail (PostgreSQL: prompts, tool calls, responses), Redis/PostgreSQL agent memory, GraphRAG for multi-hop doc reasoning, OIDC/SAML/LDAP + RBAC + air-gapped deployment for regulated environments. Unique idea: **"hide the complexity, not the logic"** — operations teams edit workflow logic visually while engineers inject Python directly into nodes, explicitly targeting the technical/ops team split. *(Source: web search, GitHub/vendor site.)*

## 3. Cross-Cutting Patterns

1. **ACP as a cross-tool standard** — editors (Zed, JetBrains) and CLIs converge on one agent↔client wire format instead of bespoke integrations per tool (hydra-acp, acprouter, acp-inspector, coder/acp-go-sdk).
2. **QR pairing for mobile/desktop attach** — aptove/bridge lets a phone join a running agent session by scanning a code, sidestepping manual endpoint/token entry.
3. **Multi-client attach to one agent session** — hydra-acp broadcasts agent output to N clients while serializing prompts/approvals from any one of them; the session, not the client, is the unit of persistence.
4. **MCP for infrastructure provisioning** — DigitalOcean and the Hetzner-fork cluster both expose Droplet/Cloud-server lifecycle (create, list, delete) as MCP tools instead of CLI wrappers the agent has to shell out to.
5. **MCP for SSH/tmux persistence** — devnullvoid/mcp-ssh-tmux turns a remote shell into a stateful MCP resource, avoiding per-command re-auth and losing cwd/env between turns.
6. **Agent-side persistent state** — Compozy's SQLite daemon and Hydra-ACP's session store both keep agent context alive independent of any one client connection.
7. **Agent-as-team-member** — openronin and Valet both frame the agent as picking up tickets and shipping PRs autonomously, with a human-owned GitHub App as the trust boundary.
8. **Agent permission inspector / cost guard** — the Hetzner MCP-server cluster converges on requiring explicit confirmation before billable resource mutation; EpicStaff's audit trail plays the same role at the workflow level.
9. **OAuth/token-credential handshake** — DigitalOcean's remote MCP flow (token pasted into client config) and the GitHub Apps used by Valet/openronin both externalize the credential exchange from the agent's own code.
10. **Marketplace-installed MCP tracking** — DigitalOcean's shift from local npx-run servers to hosted remote endpoints mirrors omp-deck's own MarketplaceManager-driven install tracking, just cloud-hosted instead of local-registry-hosted.
11. **Prompt/session as first-class artifact** — Hydra-ACP's compaction-as-MCP-server treats transcript history as a queryable resource, not a log file.
12. **Slash commands as packages** — the Pi ecosystem's `pi-crew`/`pi-collaborating-agents` extensions register new slash commands via the SDK's `ExtensionAPI`, the same mechanism omp-deck's own `BUILTIN_SLASH_COMMAND_DEFS` filtering already assumes.
13. **E2E-encrypted/pinned relays** — aptove/bridge's TLS-with-cert-pinning transport modes (Local, Cloudflare, Tailscale) show infra-agnostic secure tunneling as table stakes for remote agent attach.
14. **Agent deadlock / stall detection** — container-use's watch/log/diff tooling and Hydra-ACP's auto-approver rules both exist because unattended multi-agent runs stall on unanswered permission prompts; both projects build explicit tooling around that failure mode rather than assuming happy-path completion.

## 4. Anti-Patterns

- **stdio-scraping as an API** (coder/agentapi, deprecated) — scraping a CLI's stdin/stdout to fake an HTTP API is brittle against any output-format change; superseded by ACP once the agent natively speaks a wire protocol.
- **One-shot ephemeral agent processes** — the entire Compozy/Hydra-ACP wave exists because bare CLI agent invocations lose all state on terminal close; treating a coding agent as "just another CLI command" doesn't survive multi-session or multi-client use.
- **Unscoped shell/SSH MCP access** — devnullvoid/mcp-ssh-tmux's own docs flag that any SSH/tmux MCP server grants the agent arbitrary remote command execution; several similar servers ship with no default scoping, pushing the security burden entirely onto the operator.
- **Ambiguous repo naming** — at least 4 of the 16 target slugs in this survey (phi, aptove/bridge, acprouter, acp-inspector, agent-mux, hetzner-mcp-server) collide with unrelated projects or forks of forks, making "which repo did you mean" a real cost when recommending third-party MCP tooling to users.
- **No cost guard on billable infra tools** — MCP servers that expose Droplet/server creation without a confirmation step risk runaway spend from a single misfired agent tool call; the Hetzner cluster's convergence on cost-guard behavior is a direct reaction to this failure mode having already happened to someone.

## 5. Pattern to Apply to omp-deck

### 1. MCP-backed infra provisioning tools (OpenShip-native)
- **Slot:** `apps/server/src/routes-openship.ts` + a new `mcp-infra-tools.ts` registering MCP tool definitions that call the existing `openship-service` client.
- **UX idea:** Expose "create project," "check deployment status," "restart service" as MCP tools the deck's own agent can call — mirroring DigitalOcean/Hetzner MCP servers but against OpenShip, which omp-deck already has full API access to.
- **Effort:** M. **Impact:** L.
- **Acceptance:** An in-deck agent session can invoke an MCP tool that creates an OpenShip project and the deployment appears in `GET /projects` without a human touching the OpenShip UI.

### 2. Cost-guard confirmation gate on infra MCP tools
- **Slot:** `apps/gholam/src/permissions.ts` (`GHOLAM_PERMISSIONS` export) — add a `requiresConfirmation` flag consumed before dispatching a billable/destructive tool call.
- **UX idea:** Any MCP tool call that creates/deletes billable resources surfaces an explicit approve/deny prompt in the deck UI, same shape as the Hetzner-cluster "cost guard" pattern.
- **Effort:** S. **Impact:** M.
- **Acceptance:** Calling a destructive MCP tool (e.g. project delete) without prior approval is blocked and logged; approving it once lets that specific call proceed.

### 3. Session-as-MCP-resource (transcript search)
- **Slot:** New route beside `apps/server/src/mcp-health.ts`, backed by the deck's existing chat/session store.
- **UX idea:** Following hydra-acp, expose the current session's transcript as an MCP resource other tools (or a second agent) can query, instead of only replaying it in the chat UI.
- **Effort:** M. **Impact:** M.
- **Acceptance:** A second agent session can call an MCP tool that returns a relevant excerpt from a *different* live session's transcript by keyword.

### 4. Multi-client attach to one live agent session
- **Slot:** `apps/server/src/bridge-supervisor.ts` (`BridgeSupervisor` class) generalized beyond Telegram to a "session attach" bridge type.
- **UX idea:** Let a second browser tab or the Telegram bridge attach to an *already-running* agent session (hydra-acp's core feature) rather than each surface owning its own session.
- **Effort:** L. **Impact:** L.
- **Acceptance:** Starting an agent turn from the web UI and sending a message to it from Telegram (or vice versa) both land in the same session transcript.

### 5. QR-pairing for mobile attach
- **Slot:** New route in `apps/server/src/routes-bridges.ts` alongside `buildBridgesRouter`.
- **UX idea:** Generate a short-lived QR code encoding a session-attach URL + token, following aptove/bridge, so a phone can join a running deck session without typing a URL.
- **Effort:** S. **Impact:** S.
- **Acceptance:** Scanning the generated QR code from a phone browser opens the same session as the desktop tab that generated it.

### 6. Cloud-hosted MCP endpoint tracking (parity with DigitalOcean's remote-MCP shift)
- **Slot:** `apps/server/src/routes-mcp-install.ts` + `mcp-health.ts` (`McpHealthProbe`).
- **UX idea:** Distinguish locally-spawned MCP servers from remote/hosted ones in the install and health UI, since remote MCP (DigitalOcean's own migration) has different failure modes (network reachability vs. process crash) than the `McpHealthProbe`'s current local-process assumptions.
- **Effort:** S. **Impact:** M.
- **Acceptance:** `GET /mcp/health` reports a distinct status code/reason for a remote MCP endpoint that is unreachable vs. a local process that crashed.

### 7. Worktree-per-agent isolation for gholam-driven changes
- **Slot:** `apps/gholam/src/` — wrap gholam's file-mutation path with a per-task git worktree, following dagger/container-use's model.
- **UX idea:** When gholam acts on the deck's own repo (e.g. applying a config change suggested by an agent), do it in an isolated worktree first, surface a diff, then merge — instead of writing directly to the live checkout.
- **Effort:** M. **Impact:** L.
- **Acceptance:** A gholam-initiated repo change produces a reviewable diff in a scratch worktree before any file in the live checkout is touched.

### 8. Auto-approver rule engine for permission prompts
- **Slot:** `apps/gholam/src/permissions.ts` (`GHOLAM_PERMISSIONS`) + a new rules file evaluated before falling back to a human prompt.
- **UX idea:** Hydra-ACP's JS-rule auto-approvers, adapted: let an operator write a small allow-list (e.g. "auto-approve read-only MCP calls to OpenShip") so unattended runs don't stall on every prompt.
- **Effort:** M. **Impact:** M.
- **Acceptance:** A configured auto-approve rule lets a matching tool call proceed without a human prompt, while a non-matching call still blocks for approval.

### 9. Marketplace-tracked remote MCP installs
- **Slot:** `apps/server/src/marketplace-service.ts` (`MarketplaceService`, wraps SDK `MarketplaceManager`).
- **UX idea:** When a user installs a remote/hosted MCP server (DigitalOcean-style) through the marketplace UI, persist it in the same installed-registry the SDK already tracks for local plugins, so uninstall/health both work uniformly.
- **Effort:** S. **Impact:** S.
- **Acceptance:** Installing a remote MCP endpoint via the marketplace UI shows up in the installed-plugins list and can be removed the same way as a locally-cloned one.

## 6. Open Questions (verify before claiming)

- Exact GitHub org/repo for **phi**, **aptove/bridge**, **vcoderun/acprouter**, **newioapp/acp-inspector**, **JinchengGao-Infty/agent-mux**, **nityeshaga/hetzner-mcp-server**, **openronin/openronin**, and **tkhq/valet** were not confirmed by direct README/LICENSE fetch — GitHub MCP tool auth failed (`401 Bad credentials`) and the built-in `github` search tool hit a TLS timeout during this research pass. All entries above are sourced from web search summaries only; re-verify via direct repo read before using any license claim or exact API name in a customer-facing doc.
- No confirmed dedicated `/collab` slash command exists in the base `@oh-my-pi/pi-coding-agent` SDK as installed in this repo — only `ACP_BUILTIN_SLASH_COMMANDS` and `BUILTIN_SLASH_COMMAND_DEFS` were grep-confirmed. If a `/collab` command is expected to exist, it needs its own SDK-source read (`node_modules/@oh-my-pi/pi-coding-agent` was empty/unreachable in this session — verify install path).
- Whether `nityeshaga/hetzner-mcp-server` and `JinchengGao-Infty/agent-mux` exist at all as public repos is unresolved; both may be private, renamed, or typos for the alternatives listed in their entries above.
