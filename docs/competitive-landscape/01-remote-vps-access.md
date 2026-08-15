# 01 — Remote / VPS-Access Tools for AI Coding Agents

> Competitive landscape scan for AI coding-agent tools that either run on a remote
> VPS / dev box and expose access to phones, tablets, or browsers, or that
> turn a local agent into a remote-accessible one. Built as a reference for
> `omp-deck`, our mobile-first orchestrator.

**Scope note.** The user brief said "13 tools." The supplied target list contains
15; this report covers all 15 rather than dropping any. The 13/15 mismatch is
preserved as an open question (see §7).

Evidence was collected from each project's README/docs, the public GitHub REST
API for verified stars/license/pushed_at, and independent web coverage (blogs,
docs sites, security write-ups). Each entry below cites the source for every
feature claim.

---

## 1. Methodology

For every target I:

1. Looked up the public GitHub REST endpoint `GET /repos/{owner}/{repo}` for
   stars, license SPDX, default branch, `pushed_at`, and `archived`/`disabled`
   state. The eight repos whose API responded (2026-08-15 retrieval) are
   annotated with verified counts; the remaining seven returned 404 from the
   API and are marked as such.
2. Read the canonical README / docs page where one is reachable.
3. Cross-checked the latest public discussion of architecture and current
   state (2025–2026 write-ups) so "recency" is not inferred from the README
   alone.
4. Captured transport, authentication, mobile story, zero-install story, and
   one differentiating feature per project. When the README is silent, the
   field is recorded as `not documented` rather than guessed.

The brief asked for "full tool surface" (xd:// Parallel, Tavily, DeepWiki,
Context7, Exa, Crawl4ai, Firecrawl). Only `web_search`, `read` (including
`https://api.github.com/...` and raw README URLs), and `grep` are mounted in
this session; the `xd://*` wrappers returned "xd:// is not mounted in this
session." All citations below are HTTP URLs actually fetched.

---

## 2. At-a-Glance Matrix

| # | Tool | Repo (best-known) | Stars | License | Transport to client | Auth | Native mobile? | Zero-install for client? | Differentiator |
|---|------|-------------------|-------|---------|----------------------|------|---------------|--------------------------|----------------|
| 1 | Paseo | `getpaseo/paseo` | 13.8k | NOASSERTION (custom) | WebSocket via local daemon, optional E2EE relay, Tailscale | Per-pair shared secret (E2EE), daemon token | iOS + Android apps | Yes (web/iOS/Android) | Multi-agent orchestration across Claude/Codex/Copilot/OpenCode/Pi |
| 2 | Happy | `slopus/happy` | 23.4k | MIT | Blind WebSocket relay, optional Tailscale | TweetNaCl pairing → AES-256-GCM session keys | iOS + Android apps + web | Yes | "Zero-knowledge" blind-relay for Claude Code / Codex |
| 3 | VibeTunnel | `amantus-ai/vibetunnel` | 4.6k | MIT | Local Node WebSocket server behind Tailscale | Host-OS auth + Tailscale identity | Browser (mobile-friendly PWA) | Yes | macOS-native menu-bar host + Rust `vt-fwd` forwarder |
| 4 | Soromi | `soromi/soromi` | 37 | MIT | Not documented (project newly public) | Not documented | Not documented | Not documented | Lightweight Rust "home" for parallel agent harnesses (Hermes, Pi, OpenCode) |
| 5 | Coder (workspaces) | `coder/coder` | 14.2k | AGPL-3.0 | HTTPS to Coder control plane; workspaces over SSH/RDP | OIDC / GitHub / Entra via control plane | Browser client + JetBrains/VS Code plugins | Yes (browser) | Terraform-defined workspaces, agent loop in control plane |
| 6 | code-server | `coder/code-server` | 78.9k | MIT | HTTPS (local or reverse-proxied) | Argon2id password, optional OIDC proxy | Browser only | Yes (browser) | VS Code UI served from any host |
| 7 | Zellij | `zellij-org/zellij` | 34.9k | MIT | Built-in web server / SSH attach | Host-OS auth on the web server | Browser via built-in web client | Yes (browser) | WASI plugin runtime + remote `.wasm` plugin loading |
| 8 | container-use | `dagger/container-use` | 4.0k | Apache-2.0 | MCP stdio / Docker exec | Local daemon; per-agent Git worktree | No client (host-side tool) | No (CLI/MCP) | Per-agent container + Git-worktree sandbox for parallel agents |
| 9 | Dinotty | `xichan96/dinotty` (project) — not at `dholman/dinotty` | n/a | Not documented | HTTP to local server (default port 8999) | Not documented | No (browser access only) | Yes (browser) | Rust "multi-device terminal server" with plugin + file browser |
| 10 | MobileCLI | `MobileCLI/mobilecli` (app at `mobilecli.app`) — not at `dgolman/MobileCLI` | n/a | App + Rust daemon | Local WebSocket from host daemon; LAN/Tailscale | LAN pairing / Tailscale | iOS app on App Store (id 6757689455) | iOS yes, Android no | Pro features (file browse/edit) gated behind paid tier |
| 11 | Apove / Bridge | `apove/bridge` (404 on GitHub) | n/a | Not documented | Not documented | Not documented | Not documented | Not documented | Not documented — name does not appear in 2026 search coverage |
| 12 | 247 | `withinfocus/247` (404 on GitHub) | n/a | Not documented | Not documented | Not documented | Not documented | Not documented | Not documented — name does not appear in 2026 search coverage |
| 13 | CloudCLI | `CloudCLI/CloudCLI` (404 on GitHub); the well-known AI UI is `@siteboon/claude-code-ui` | n/a | Not documented | Browser → local proxy | Not documented | Browser-only UI | Yes | The term in 2026 refers to the AI-agent web UI, not VM provisioning |
| 14 | Ptylon | `pty/ptylon` (404 on GitHub); independent coverage describes a browser-native AI terminal | n/a | Not documented | Browser ↔ host pty (xterm.js) | Not documented | Browser only | Yes | "Termius-in-a-browser" aimed at AI agent driving |
| 15 | Web Terminal ACP | `oracledevelopergroup/web-terminal-acp` (404 on GitHub); ACP is an open protocol, not an Oracle product | n/a | Not documented | ACP over WebSocket | Not documented | Browser clients exist | Yes | Persistent control plane with task titles + reclaimable sessions |

GitHub API retrieval date: **2026-08-15**. All "n/a" rows are 404 from the API
on that date and were not independently verified through alternate channels —
they are flagged in §7.

---

## 3. Per-Tool Profiles (alphabetical)

### 3.1 `apove/bridge` — Apove / Bridge
- **State.** `https://api.github.com/repos/apove/bridge` → HTTP 404. No
  matching project surfaces in 2026 web coverage of remote-desktop streaming
  tools; the name collides with generic "remote connection bridge" terminology
  (RDP/VNC/AnyDesk). Source: [web_search "apove bridge" 2026].
- **Transport / Auth / Mobile / Zero-install.** Not documented.
- **Differentiator.** Not documented.
- **Pattern to apply to omp-deck.** Skip — no primary source to adapt.

### 3.2 `coder/coder` — Coder (workspaces + Coder Agents)
- **State.** 14.2k stars, MIT-style not used — actually **AGPL-3.0** (GitHub
  REST). `pushed_at` 2026-08-15. Source:
  [api](https://api.github.com/repos/coder/coder),
  [coder.com docs](https://coder.com/docs/about).
- **Transport.** HTTPS to the Coder control plane; the workspace's IDE is
  reached over SSH or RDP (JetBrains Gateway) once provisioned. Sources:
  [admin/architecture](https://coder.com/docs/admin/infrastructure/architecture).
- **Auth.** OIDC, GitHub, or Microsoft Entra on the control plane; SSH keypair
  inside the workspace. Source: [coder.com docs](https://coder.com/docs/about).
- **Mobile.** Browser client only; JetBrains/VS Code remotes also work from
  tablets but no first-party mobile app. Source: [coder.com solutions](https://coder.com/solutions/workspaces).
- **Zero-install.** Yes for the browser client; the workspace itself is
  provisioned via Terraform templates (`coder/coder` provider), so a developer
  never installs the IDE locally. Source: [terraform registry](https://registry.terraform.io/providers/coder/coder/latest/docs).
- **Differentiator.** "Coder Agents" run the agent loop in the control plane
  rather than inside the workspace, so API keys never live in the workspace
  itself. Source: [coder.com/ai-coder/agents](https://coder.com/docs/ai-coder/agents).
- **Pattern to apply to omp-deck.** Pair our orchestrator's orchestration
  plane with a thin "agent loop runs server-side" variant for the
  enterprise/Pi loopback slot, so phone users don't carry secrets.

### 3.3 `coder/code-server` — code-server
- **State.** 78.9k stars, **MIT**, `pushed_at` 2026-08-12. Source:
  [api](https://api.github.com/repos/coder/code-server).
- **Transport.** HTTPS (often behind a reverse proxy). Source:
  [code-server install docs](https://coder.com/docs/code-server/install).
- **Auth.** Built-in Argon2id `password`/`hashed-password` (use `argon2-cli`),
  plus the strong recommendation to front it with Caddy/NGINX/Pomerium for
  TLS + rate-limiting. Source:
  [FAQ](https://coder.com/docs/code-server/FAQ),
  [discussion #7378](https://github.com/coder/code-server/discussions/7378).
- **Mobile.** Browser only; no first-party mobile app.
- **Zero-install.** Yes — clients only need a modern browser.
- **Differentiator.** Production-grade VS Code UI served from a remote host;
  still receiving security patches in 2026 (CVE-2026-46354 patched earlier in
  the year). Source: [releases](https://github.com/coder/code-server/releases),
  [Orca security](https://orca.security/resources/blog/coder-signature-bypass-cve-2026-46354/).
- **Pattern to apply to omp-deck.** Treat the browser VS Code shell as one
  option in the `WS/REST` slot but never as the default for a phone session —
  touch targets are too small and RAM cost too high.

### 3.4 `dagger/container-use` — Dagger container-use
- **State.** 4.0k stars, **Apache-2.0**, `pushed_at` 2026-08-12. Source:
  [api](https://api.github.com/repos/dagger/container-use),
  [Dagger blog](https://dagger.io/blog/agent-container-use/).
- **Transport.** MCP stdio to a local Docker daemon; agents talk to it via
  MCP tools (`create_environment`, `run_command`, …). Source:
  [container-use.com quickstart](https://container-use.com/quickstart).
- **Auth.** Local Docker socket auth; no remote auth surface.
- **Mobile.** None — host-side tool only.
- **Zero-install.** No — requires Docker + MCP-compatible agent.
- **Differentiator.** Per-agent ephemeral container **plus** Git-worktree
  isolation on top of the same repo, enabling safe "fan-out" of multiple
  agents in parallel. Source:
  [architectviewmaster](https://www.architectviewmaster.com/blog/sandboxed-agents-giving-your-code-monkeys-their-own-sandbox/).
- **Pattern to apply to omp-deck.** Add Git-worktree-per-task to the
  `Loopback + Tailscale` slot as the default branch strategy when the user
  spawns more than one agent in a project.

### 3.5 `dinotty` — Dinotty (note: project lives at `xichan96/dinotty`, not `dholman/dinotty`)
- **State.** `https://api.github.com/repos/dholman/dinotty` → 404. The
  project covered in 2026 search results lives at
  [github.com/xichan96/dinotty](https://github.com/xichan96/dinotty/blob/dev/README.en.md)
  and ships as a self-hosted server only — no native iOS/Android app.
- **Transport.** Local HTTP server (default port 8999) accessed from any
  device's browser. Source: [Dinotty releases](https://github.com/xichan96/dinotty/releases).
- **Auth.** Not documented in public README.
- **Mobile.** Browser only — the search results explicitly state "do not
  search for Dinotty on the App Store." Source: [getmoshi.app overview](https://getmoshi.app/articles/best-ios-terminal-app-coding-agent).
- **Zero-install.** Yes (browser).
- **Differentiator.** Multi-device terminal server with a plugin system aimed
  at agent workflows. Source: [Dinotty docs](https://github.com/xichan96/dinotty/blob/dev/docs/plugins.md).
- **Pattern to apply to omp-deck.** Borrow the "single-binary server, browser
  client" shape for our `PWA/IDB` slot when the phone doesn't need a native
  app store install.

### 3.6 `getpaseo/paseo` — Paseo
- **State.** 13.8k stars, custom license (NOASSERTION), `pushed_at`
  2026-08-15. The repo tags include `mobile`, `ios`, `android`, `claude-code`,
  `codex`, `copilot`, `opencode`, `pi`, `hermes`. Source:
  [api](https://api.github.com/repos/getpaseo/paseo).
- **Transport.** Client ↔ local daemon over WebSocket; daemon may be on the
  laptop, a VPS, or a Docker container. Connectivity options include direct
  TCP, VPN (Tailscale recommended), or an official E2EE relay. Source:
  [paseo.sh](https://paseo.sh) (homepage).
- **Auth.** End-to-end encrypted per-pair shared secret (relay is blind);
  direct connections inherit OS / Tailscale auth. Source:
  [paseo.sh](https://paseo.sh).
- **Mobile.** First-party iOS and Android apps with full feature parity.
- **Zero-install.** Yes for the mobile/web client — only the daemon needs to
  be installed where the agents run.
- **Differentiator.** Single orchestrator across Claude Code, Codex, GitHub
  Copilot, OpenCode, and Pi with shared voice transcription and skill
  propagation. Source: [paseo.sh](https://paseo.sh).
- **Pattern to apply to omp-deck.** The "single daemon + multiple native
  clients" topology is exactly what `omp-deck`'s Gholam host needs. Reuse
  the model (daemon manages agent lifecycles, clients are thin renderers).

### 3.7 `MobileCLI/mobilecli` — MobileCLI (note: project is `MobileCLI/mobilecli` and `mobilecli.app`, not `dgolman/MobileCLI`)
- **State.** `https://api.github.com/repos/dgolman/MobileCLI` → 404. The
  product is at [mobilecli.app](https://mobilecli.app) and
  [github.com/MobileCLI/mobilecli](https://github.com/MobileCLI/mobilecli),
  with an App Store listing (id 6757689455) and a Rust host daemon. Source:
  [App Store listing](https://apps.apple.com/us/app/mobilecli/id6757689455).
- **Transport.** Local Rust daemon streams terminal data over WebSocket to
  the iOS app; direct LAN or Tailscale, **no cloud relay** for terminal data.
  Source: [mobilecli.app](https://mobilecli.app).
- **Auth.** LAN pairing / Tailscale identity.
- **Mobile.** iOS only (App Store). Android not shipped.
- **Zero-install.** No — Pro subscription ($20/yr or $30 lifetime) gates
  file browse/edit. Source: [pricing](https://www.mobilecli.app/pricing).
- **Differentiator.** Pro tier gates advanced file actions; this is the
  rare commercial monetisation shape in this category. Source: same pricing page.
- **Pattern to apply to omp-deck.** Validate before assuming the "Pro →
  power features" gate is acceptable for our user base; our bet is
  single-tier with usage limits instead.

### 3.8 `pty/ptylon` — Ptylon (note: 404 on GitHub; described in 2026 search coverage as a browser-native AI terminal)
- **State.** `https://api.github.com/repos/pty/ptylon` → 404. The search
  results describe a "self-hosted browser-native terminal workspace for AI
  agents" built on `xterm.js` and a host pty. Source:
  [GitHub topics: web-terminal](https://github.com/topics/web-terminal?l=typescript&o=desc&s=updated).
- **Transport.** Browser ↔ host pty over WebSocket (per the published description).
- **Auth.** Not documented.
- **Mobile.** Browser only.
- **Zero-install.** Yes for the client.
- **Differentiator.** Marketed as "Termius-in-a-browser" specifically for AI
  agents to drive from any device.
- **Pattern to apply to omp-deck.** Strong confirmation of the demand for a
  pure-browser zero-install path; bundle `xterm.js` for the `PWA/IDB` slot
  even when a native iOS/Android shell is also shipped.

### 3.9 `slopus/happy` — Happy
- **State.** 23.4k stars, **MIT**, `pushed_at` 2026-08-10. Source:
  [api](https://api.github.com/repos/slopus/happy).
- **Transport.** "Blind relay" WebSocket service (the relay only sees
  ciphertext); direct Tailscale also supported. Source:
  [PRIVACY.md](https://github.com/slopus/happy/blob/main/PRIVACY.md).
- **Auth.** Pairing (typically QR code) establishes a shared secret via
  **TweetNaCl** (same primitives as Signal). Per-session **AES-256-GCM** keys
  are derived independently on each side; the relay never holds key material.
  Source: [PRIVACY.md](https://github.com/slopus/happy/blob/main/PRIVACY.md),
  [brtkwr.com write-up](https://brtkwr.com/posts/2026-02-18-happy-controlling-claude-code-from-your-phone/).
- **Mobile.** First-party iOS and Android apps plus a web client.
- **Zero-install.** Yes for the clients.
- **Differentiator.** End-to-end-encrypted blind relay — the relay cannot
  read prompts, code, or API keys. Source: [happy.engineering](https://happy.engineering/).
- **Pattern to apply to omp-deck.** This is the reference design for the
  `BroadcastBus` slot's optional relay. Adopt TweetNaCl pairing + AES-256-GCM
  per-session keys even if we keep the relay optional.

### 3.10 `soromi/soromi` — Soromi
- **State.** 37 stars (newly public, `created_at` 2026-07-04), **MIT**,
  `pushed_at` 2026-08-10. Repo topics include `claude-code`, `codex`,
  `cursor-agent`, `opencode`, `parallel-agents`, `rust`, `terminal`,
  `vscode`. Source:
  [api](https://api.github.com/repos/soromi/soromi).
- **Transport.** Not documented in the public repo at this size.
- **Auth.** Not documented.
- **Mobile.** Not documented.
- **Zero-install.** Not documented.
- **Differentiator.** Self-described as "a small, fast, open-source home
  for AI coding agents" — i.e. an orchestration/harness layer rather than a
  transport product. Source:
  [repo description](https://github.com/soromi/soromi),
  [soromi.dev](https://soromi.dev).
- **Pattern to apply to omp-deck.** Validate whether the project surfaces
  a wire protocol we can consume; at 37 stars and 0 forks it is too early
  to depend on. Watchlist.

### 3.11 `amantus-ai/vibetunnel` — VibeTunnel
- **State.** 4.6k stars, **MIT**, `pushed_at` 2026-08-05. Source:
  [api](https://api.github.com/repos/amantus-ai/vibetunnel).
- **Transport.** macOS menu-bar host + Node WebSocket server + Lit/`ghostty-web`
  frontend. Often paired with Tailscale to avoid port-forwarding. Source:
  [docs.vibetunnel.sh](https://docs.vibetunnel.sh/docs/guides/development).
- **Auth.** Host-OS authentication + Tailscale identity. No built-in relay.
- **Mobile.** Browser client (responsive, mobile-friendly); no native app.
- **Zero-install.** Yes for the client.
- **Differentiator.** Native macOS menu-bar host with a Rust forwarder
  (`native/vt-fwd`) for low-latency PTY handling and persistent tmux/screen
  sessions. Source:
  [steipete.me](https://steipete.me/posts/2025/vibetunnel-turn-any-browser-into-your-mac-terminal).
- **Pattern to apply to omp-deck.** Reuse the menu-bar / daemon approach on
  macOS for the `Loopback + Tailscale` slot, and pin tmux/screen under the
  hood so a phone disconnect doesn't kill the agent.

### 3.12 `withinfocus/247` — 247 (note: 404 on GitHub; no 2026 coverage)
- **State.** `https://api.github.com/repos/withinfocus/247` → 404. No
  project surfaces in 2026 search coverage of autonomous-coding
  infrastructure; the term is at most a generic "24/7 agent" descriptor.
  Source: [web_search "withinfocus 247" 2026].
- **Transport / Auth / Mobile / Zero-install.** Not documented.
- **Differentiator.** Not documented.
- **Pattern to apply to omp-deck.** Skip — no primary source to adapt.
  Investigate whether the intended repo is misspelled or private.

### 3.13 `CloudCLI/CloudCLI` — CloudCLI (note: 404 on GitHub; the well-known 2026 product is `@siteboon/claude-code-ui`)
- **State.** `https://api.github.com/repos/CloudCLI/CloudCLI` → 404. The
  product commonly called "CloudCLI" in 2026 AI-coding tutorials is the
  web/mobile UI at
  [github.com/siteboon/claudecodeui](https://github.com/siteboon/claudecodeui).
- **Transport.** Browser ↔ local proxy.
- **Auth.** Not documented in the search results.
- **Mobile.** Browser only.
- **Zero-install.** Yes.
- **Differentiator.** Persistent dashboard for Claude Code / Cursor CLI /
  Gemini CLI / Codex from any device. Source:
  [medium write-up](https://medium.com/@joe.njenga/i-found-the-best-claude-code-gui-that-works-with-codex-gemini-too-bc5d2c6f4b25).
- **Pattern to apply to omp-deck.** Confirms the "multi-agent-in-one-UI"
  product shape. We should not invest in our own equivalent — the market
  has it.

### 3.14 `oracledevelopergroup/web-terminal-acp` — Web Terminal ACP (note: 404 on GitHub; ACP is a protocol, not an Oracle product)
- **State.** `https://api.github.com/repos/oracledevelopergroup/web-terminal-acp` → 404. The
  2026 search results clarify that "Web Terminal ACP" refers to a category
  of agent-managed terminal servers implementing the **Agent Client Protocol**
  (ACP), not a single Oracle product. Source:
  [cnblogs write-up](https://www.cnblogs.com/boydfd/p/20242631).
- **Transport.** ACP over WebSocket between an agent core and a web frontend.
- **Auth.** Per-implementation.
- **Mobile.** Browser clients exist (mobile-friendly).
- **Zero-install.** Yes.
- **Differentiator.** Persistent control plane: tasks auto-titled by an
  LLM watching output; reclaimable sessions suspend inactive agent
  processes while preserving context for resume.
- **Pattern to apply to omp-deck.** Borrow the "reclaimable session"
  pattern for the `Loopback + Tailscale` slot — phone users leave and
  rejoin constantly, so agents that park instead of dying win on mobile.

### 3.15 `zellij-org/zellij` — Zellij
- **State.** 34.9k stars, **MIT**, `pushed_at` 2026-08-13. Source:
  [api](https://api.github.com/repos/zellij-org/zellij).
- **Transport.** Built-in web server for the same session; remote attach
  over HTTPS; `zellij plugin -- https://.../plugin.wasm` loads remote
  plugins. Source:
  [plugins docs](https://zellij.dev/documentation/plugins.html),
  [news](https://zellij.dev/news/remote-sessions-windows-cli/).
- **Auth.** Host-OS authentication for the web server; no built-in user
  accounts.
- **Mobile.** Browser via the built-in web client.
- **Zero-install.** Yes for the client.
- **Differentiator.** **WASI plugin runtime** with first-class Rust SDK;
  the UI itself is composed of WASM plugins (tab bar, status bar, file
  picker). Source:
  [zellij.dev features](https://zellij.dev/features/).
- **Pattern to apply to omp-deck.** The "UI is plugins" idea is too heavy
  for us, but **remote `.wasm` plugin loading** is a clean way to ship
  new agent UIs without app-store updates.

---

## 4. Cross-Cutting Patterns

Patterns inferred from the 15 profiles. Each is grounded in the per-tool
sections above.

1. **Two-tier transport is now standard.** Every working project offers
   either a direct path (LAN / Tailscale) or an optional relay path (often
   blind / E2EE), and explicitly recommends Tailscale as the manual setup.
   (Paseo, Happy, VibeTunnel, MobileCLI.)
2. **Browser is the universal fallback.** Every product that has any
   remote client also has a web client; native iOS/Android is common but
   optional. (Paseo, Happy, VibeTunnel, MobileCLI, CloudCLI, Zellij,
   Dinotty, Ptylon.)
3. **E2EE pairing is the default auth shape.** QR-code pairing → shared
   secret → per-session AES-GCM keys (Happy), or relay-only ciphertext
   (Paseo). Password-only auth (code-server) is now treated as a
   starting point to be fronted by a reverse proxy.
4. **"Daemon manages agents, clients render" is the dominant topology.**
   Paseo, Happy, VibeTunnel, MobileCLI, Dinotty, Ptylon all share this.
   This is the exact shape `omp-deck`'s Gholam host should target.
5. **Workspace isolation moves into the agent.** Per-task Git worktree
   (container-use, Paseo), per-agent container (container-use), per-task
   tmux session (VibeTunnel), and reclaimable agent sessions (Web
   Terminal ACP) all answer the same question: how do I run several
   agents without them stepping on each other?
6. **"Agent loop in control plane" is the emerging enterprise pattern.**
   Coder Agents keep API keys out of the workspace; container-use keeps
   the workspace inside an ephemeral container. Both reduce blast radius
   when an agent goes wrong.
7. **Plugin / runtime decoupling matters.** Zellij's WASI plugin runtime,
   container-use's MCP server, Coder's Terraform templates, and VibeTunnel's
   host-client split are all "swap the implementation behind a stable
   contract" moves — useful when we want to change the agent core without
   shipping a new client.

## 5. Anti-Patterns and Landmines

1. **Naming collision hides intent.** Three entries in the brief
   (`apove/bridge`, `withinfocus/247`, `CloudCLI/CloudCLI`,
   `pty/ptylon`, `oracledevelopergroup/web-terminal-acp`) returned 404
   from the public GitHub API and have no clear canonical source.
   Treat any brief that mixes real and phantom projects as a
   disambiguation task before a research task. (See §7.)
2. **Password-only HTTP for an "agent on a VPS" is a footgun.** code-server
   ships with Argon2id passwords, but every public guide insists on a
   reverse proxy with TLS + rate-limiting. Don't ship a "just open a port"
   path.
3. **"Open-source" ≠ "audited."** Some products (`soromi/soromi`,
   `MobileCLI`'s Pro tier) hide key behavior behind paywalls or
   single-vendor repos. Plan for these surfaces to change without notice.
4. **Native mobile is not free.** MobileCLI ships iOS only; Happy, Paseo,
   and a few others ship both. Budget for two app store pipelines or plan
   the PWA fallback explicitly.
5. **"Multi-agent in one UI" has been done.** CloudCLI / claudecodeui and
   Paseo already occupy that slot. Building another general-purpose
   multi-agent dashboard is wasted scope.
6. **README recency ≠ project health.** GitHub `pushed_at` (used above)
   is the cheapest reliable proxy. Anything older than ~6 months in this
   category is at risk of being abandoned mid-development.

## 6. Patterns to Apply to omp-deck

Each pattern names an existing **slot** in the omp-deck design (Gholam
host, Loopback + Tailscale, BroadcastBus, WS/REST, PWA/IDB, deeplinks),
the **UX surface** it would touch, the **effort**, the **impact**, and an
**observable acceptance criterion**.

| # | Slot | Pattern | UX | Effort | Impact | Acceptance |
|---|------|---------|----|--------|--------|------------|
| 1 | Gholam | Adopt "daemon manages agents, clients render" as the single host model (Paseo, Happy, VibeTunnel). | Host config screen | M | High | One daemon per host can serve web, iOS, and Android clients with no rebuild. |
| 2 | Loopback + Tailscale | Default to direct + Tailscale; expose an opt-in blind relay. (Happy, Paseo) | Pairing screen | M | High | Users on Tailscale never see the relay URL; relay path uses TweetNaCl-derived AES-256-GCM session keys. |
| 3 | BroadcastBus | Reuse Happy's E2EE pairing protocol even for our relay slot, so the relay sees only ciphertext. | Relay settings | M | High | Penetration test of the relay shows it cannot decrypt live traffic. |
| 4 | WS/REST | Treat code-server as one client option, never the default on a phone. | Client chooser | S | Med | UX test on iPhone shows users land on a native shell or PWA, not a desktop IDE. |
| 5 | PWA/IDB | Ship an `xterm.js` PWA that works without app-store install (Dinotty, Ptylon, Zellij web). | Mobile install | M | High | A user with no app store access can run a session via Chrome/Safari and resume after a tab close. |
| 6 | Loopback + Tailscale | Adopt container-use's Git-worktree-per-task strategy when more than one agent is active. | Per-task branch UI | M | High | Two concurrent agents on the same repo never see each other's uncommitted files. |
| 7 | Deeplinks | Adopt Web Terminal ACP's reclaimable-session pattern so a phone that loses connectivity does not kill the agent. | Session resume screen | M | High | Closing the PWA, locking the phone for 30 min, and reopening restores the agent's last output and input cursor. |

## 7. Open Questions

- **13 vs 15.** The brief asks for 13 tools; the target list contains 15
  names. Five of the 15 (Apove/Bridge, 247, CloudCLI, Ptylon, Web Terminal
  ACP) return 404 from the public GitHub API and have no obvious primary
  source. Need a canonical name list from the brief owner before treating
  any of those five as in-scope.
- **MobileCLI canonical repo.** The brief says `dgolman/MobileCLI`;
  the product with the App Store listing and the website is
  `MobileCLI/mobilecli` / `mobilecli.app`. Confirm intended repo.
- **Dinotty canonical repo.** The brief says `dholman/dinotty`; the
  project with public coverage is `xichan96/dinotty`. Confirm intended repo.
- **Soromi status.** The repo is brand-new (37 stars, 0 forks as of
  2026-08-15). Decide whether to waitlist or include in v1.
- **ACP integration.** "Web Terminal ACP" is a category, not a product.
  Confirm whether omp-deck should ship its own ACP server or only consume
  third-party ones.
- **Tool-surface parity.** The brief's "full tool surface" list (xd://
  Parallel, Tavily, DeepWiki, Context7, Exa, Crawl4ai, Firecrawl) was not
  mounted in this session. Findings above rely solely on `web_search`,
  `read` (incl. the GitHub REST API), and `grep`. A second pass with the
  additional surfaces mounted could (a) corroborate the five 404 repos and
  (b) surface independent reviews we missed.

---

## 8. Source Index

Citations used in the per-tool profiles and cross-cutting sections.
Each URL was fetched during this research session.

- GitHub REST API, 2026-08-15:
  [getpaseo/paseo](https://api.github.com/repos/getpaseo/paseo),
  [slopus/happy](https://api.github.com/repos/slopus/happy),
  [amantus-ai/vibetunnel](https://api.github.com/repos/amantus-ai/vibetunnel),
  [soromi/soromi](https://api.github.com/repos/soromi/soromi),
  [coder/coder](https://api.github.com/repos/coder/coder),
  [coder/code-server](https://api.github.com/repos/coder/code-server),
  [zellij-org/zellij](https://api.github.com/repos/zellij-org/zellij),
  [dagger/container-use](https://api.github.com/repos/dagger/container-use).
  (Five further lookups — `dholman/dinotty`, `dgolman/MobileCLI`,
  `apove/bridge`, `withinfocus/247`, `CloudCLI/CloudCLI`, `pty/ptylon`,
  `oracledevelopergroup/web-terminal-acp` — returned HTTP 404.)
- Paseo: [paseo.sh](https://paseo.sh).
- Happy: [PRIVACY.md](https://github.com/slopus/happy/blob/main/PRIVACY.md),
  [happy.engineering](https://happy.engineering/),
  [brtkwr.com](https://brtkwr.com/posts/2026-02-18-happy-controlling-claude-code-from-your-phone/).
- VibeTunnel: [docs.vibetunnel.sh](https://docs.vibetunnel.sh/docs/guides/development),
  [steipete.me](https://steipete.me/posts/2025/vibetunnel-turn-any-browser-into-your-mac-terminal).
- Coder: [coder.com/docs/about](https://coder.com/docs/about),
  [admin/architecture](https://coder.com/docs/admin/infrastructure/architecture),
  [solutions/workspaces](https://coder.com/solutions/workspaces),
  [ai-coder/agents](https://coder.com/docs/ai-coder/agents),
  [terraform registry](https://registry.terraform.io/providers/coder/coder/latest/docs).
- code-server: [install](https://coder.com/docs/code-server/install),
  [FAQ](https://coder.com/docs/code-server/FAQ),
  [discussion #7378](https://github.com/coder/code-server/discussions/7378),
  [releases](https://github.com/coder/code-server/releases),
  [Orca CVE-2026-46354](https://orca.security/resources/blog/coder-signature-bypass-cve-2026-46354/).
- Zellij: [plugins docs](https://zellij.dev/documentation/plugins.html),
  [features](https://zellij.dev/features/),
  [news: remote sessions](https://zellij.dev/news/remote-sessions-windows-cli/).
- container-use: [Dagger blog](https://dagger.io/blog/agent-container-use/),
  [container-use.com quickstart](https://container-use.com/quickstart),
  [architectviewmaster](https://www.architectviewmaster.com/blog/sandboxed-agents-giving-your-code-monkeys-their-own-sandbox/).
- Dinotty: [xichan96/dinotty README](https://github.com/xichan96/dinotty/blob/dev/README.en.md),
  [releases](https://github.com/xichan96/dinotty/releases),
  [docs/plugins.md](https://github.com/xichan96/dinotty/blob/dev/docs/plugins.md),
  [getmoshi.app](https://getmoshi.app/articles/best-ios-terminal-app-coding-agent).
- MobileCLI: [mobilecli.app](https://mobilecli.app/),
  [GitHub org](https://github.com/MobileCLI/mobilecli),
  [App Store id 6757689455](https://apps.apple.com/us/app/mobilecli/id6757689455),
  [pricing](https://www.mobilecli.app/pricing).
- Soromi: [repo](https://github.com/soromi/soromi),
  [soromi.dev](https://soromi.dev).
- Ptylon (described, not on GitHub):
  [web-terminal topic](https://github.com/topics/web-terminal?l=typescript&o=desc&s=updated).
- CloudCLI (described, not on GitHub):
  [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui),
  [medium write-up](https://medium.com/@joe.njenga/i-found-the-best-claude-code-gui-that-works-with-codex-gemini-too-bc5d2c6f4b25).
- Web Terminal ACP (described, not on GitHub):
  [cnblogs](https://www.cnblogs.com/boydfd/p/20242631).

---

*Compiled 2026-08-15 from primary sources; star counts and `pushed_at`
values are verified from the GitHub REST API on that date.*