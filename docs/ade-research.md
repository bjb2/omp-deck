# Remote-Capable AI Dev Workspace — Research Report

*Prepared 2026-08-14, expanded 2026-08-15. Part 1 covers the six repos you named plus omp.sh (oh-my-pi), with every claim adversarially fact-checked by independent reviewers before being trusted — claims that couldn't survive that check are reported separately, not silently dropped. Part 2 is a breadth scan: 66 additional open-source projects found by searching GitHub directly (not blog roundups), each confirmed real via a live fetch of its own repo, sorted by recency rather than stars per your instructions. Part 2 is single-pass verified (real + current), not adversarially cross-examined the way Part 1 was — solid signal, but do your own quick check before betting real time on any one pick.*

## Bottom line

For your specific requirement — a setup you can drive from *any* device when your own computer or internet isn't available, with omp.sh as your agent of choice — the two projects that actually hold up under verification are **Paseo** and **omp.sh's own `/collab` feature**. Everything else you listed either doesn't yet do remote/VPS access (Frame), oversells it in its marketing relative to what's actually shipped (Superset), or serves a different purpose entirely (EpicStaff). bb and anycode are solid secondary options worth trying alongside your main setup.

The practical setup: rent a small VPS, run omp.sh on it inside tmux or a systemd service so sessions survive disconnects, and use its built-in `/collab` command to get a link and QR code that let any browser join and drive the session with zero install. If you want a fuller mobile/desktop app experience with multi-agent orchestration on top, run Paseo alongside it — it's a self-hosted daemon with an official Docker image, reachable via a hosted encrypted relay, your own Tailscale/Cloudflare tunnel, or direct port exposure, and its CLI is explicitly designed to target a remote host. One open question neither project's documentation resolves: whether omp.sh can run *as a managed agent inside* Paseo (vs. just being reachable side-by-side on the same box) — worth testing yourself rather than assuming.

## Suggested VPS baseline

Generic guidance from hosting-focused sources (not project-specific, so treat as a starting point, not a verified benchmark): 2–4 vCPU, 4–8 GB RAM, Ubuntu 22.04 LTS, SSD storage, Docker installed. That's enough headroom to run omp.sh plus Paseo's daemon simultaneously, with room to spare for a second agent session. Bump RAM if you plan to run several parallel agent sessions through Paseo at once.

## Head-to-head comparison

| Project | Remote/VPS story (verified) | Agents supported | License | Confidence |
|---|---|---|---|---|
| **Paseo** | Docker self-host, `--host` CLI flag, 3 remote-access paths (relay/tunnel/direct) | Claude Code, Codex, Copilot, OpenCode, Pi (omp listed but not confirmed as deep integration) | AGPL-3.0 (real open source) | High |
| **omp.sh (oh-my-pi)** | `/collab` relay: link + QR, zero-install browser join | Is the agent itself | Open source | High |
| **bb** | CLI/HTTP API are first-class; headless run + Tailscale Serve documented | Not confirmed as multi-agent orchestrator | Open source | Medium |
| **anycode** | Web-based IDE (inherently thin-client); real ACP protocol integration | Codex, Claude Code, OpenCode, local models (omp not named) | Open source | High (on ACP claim) |
| **Frame** | SSH remote dev is roadmap-only, not built | Claude Code, Codex CLI, Gemini CLI only (fixed 3, no omp) | Open source | High (that it *doesn't* fit your need) |
| **EpicStaff** | Genuinely self-hostable (Docker/Podman) — but different product category (visual multi-agent orchestration, not a coding-agent remote-access tool) | N/A | **PolyForm Perimeter 1.0.0 — noncompete, source-available, not standard open source**, despite being marketed as "open-source" | High |
| **Superset** | Specific remote-host/"Superset Relay" claims were tested and refuted; the project's own docs admit ports aren't forwarded yet (roadmap item) | Marketed for 100+ parallel agents, but that specific claim also failed verification | Check repo | Low |

## Tool-by-tool findings

**Paseo** (`getpaseo/paseo`) is the strongest fit of the six. It ships an official Docker image (`docker run -p 6767:6767 -e PASEO_PASSWORD=... ghcr.io/getpaseo/paseo:latest`) bundling both the daemon and a self-hosted web UI, released about six weeks before this report. The CLI can target a daemon on a separate machine directly (`paseo --host workstation.local:6767 run "..."`), and its headless install path is explicitly documented as "useful for servers and remote machines." For reaching it from outside your network you get three real options: Paseo's hosted end-to-end-encrypted relay (zero config), your own tunnel (Tailscale or Cloudflare Tunnel), or exposing the daemon port directly behind a password. It orchestrates Claude Code, Codex, Copilot, OpenCode, and Pi agents in parallel, and can be driven from desktop, web, mobile (with voice control), or CLI. It's AGPL-3.0 — genuinely open source, not just source-available. One claim worth flagging as debunked: paseo.sh/omp reads like a dedicated "Paseo is the app for OMP" product page, but that page is one of roughly 39 near-identical, auto-generated per-agent landing pages — Paseo's real headline branding (README, app store listing) centers on Claude Code and Codex, and OMP support exists but isn't the product's core focus. Treat OMP-inside-Paseo as "supported, not flagship."

**omp.sh / oh-my-pi**, your preferred agent, ships a native `/collab` feature independent of any third-party tool: it pushes your running session to a relay (default `wss://my.omp.sh`) and hands back both an `omp join` link for another terminal and a plain browser link with a scannable QR code — the guest side needs zero install, just a browser. That's a genuinely strong match for "I can't always use my own computer": leave omp running on a cheap VPS inside tmux or a systemd unit so it survives you disconnecting, then `/collab` back in from whatever device you have on hand. Two things this doesn't do, despite some marketing-adjacent claims that didn't survive fact-checking: it does not ship a built-in SSH tool letting the agent itself operate arbitrary remote hosts, and there's no verified claim of "40+ provider" OAuth support — check the current feature set directly before relying on either.

**bb** (`get-bb/bb`) is a credible secondary pick specifically because its README states the CLI and HTTP API are first-class citizens alongside the desktop app, not an afterthought — corroborated by its own docs on running headlessly via `npx bb-app` and exposing that through Tailscale Serve, driven entirely from a browser or CLI on another device. Worth a caveat: a more specific claim (that its dev server binds to all network interfaces by default specifically for Tailscale-style access) was tested and refuted, so the general "headless and remote-controllable" story holds, but don't assume every specific networking detail matches what you read in passing.

**anycode** (`anycode-ade/anycode`) is your best "cutting-edge AI integration" pick among the six. It's a web-based, agent-agnostic IDE (Codex, Claude Code, OpenCode, local models — omp isn't named) built around the Agent Client Protocol (ACP), an emerging cross-tool standard conceptually similar to how LSP standardized language servers. This isn't just a README claim — the backend's actual dependency file references the official `agent-client-protocol` Rust crates, a 231-commit changelog through August 12 2026 shows the specific features (session resume, tool-call diff rendering, permission auto-approval) actually being built, and anycode is listed on the official ACP client registry. Being web-based, it's inherently friendly to jumping between devices.

**Frame** (`kaanozhan/Frame`), despite feeling like the newest/trendiest pick, currently fails your core requirement outright: its own roadmap lists "Remote development (SSH)" under *Planned*, not *Done*, and it only integrates three fixed CLI agents (Claude Code, Codex CLI, Gemini CLI) with no mention of omp.sh anywhere in its docs or roadmap. Not a fit today — worth revisiting if the SSH roadmap item ships.

**EpicStaff** (`EpicStaff/EpicStaff`) is a different kind of tool from the other five — a visual, self-hostable multi-agent orchestration platform (think: building agent pipelines with a UI, not driving a coding CLI remotely) — and it genuinely can run on your own VPS via Docker or Podman. The important catch: its actual license file is PolyForm Perimeter 1.0.0, a noncompete source-available license, not a standard open-source license — even though the repo's own description and several third-party directories label it "open-source." The noncompete clause specifically blocks using it to build a product that competes with EpicStaff itself; it's unclear how far that reaches for purely personal use, which is worth a direct read of the license text (or a lawyer's opinion) before you build anything you'd want to commercialize on top of it.

**Superset** (`superset-sh/superset`) is the one place this research pushes back hardest on the "trendy = good" assumption. Its README markets running 100+ parallel agents in isolated git worktrees and a "Superset Relay" for genuinely remote-hosted workspaces — but under adversarial review, the specific remote-hosting and relay-for-VPS claims were refuted, and Superset's *own* documentation admits in its "Key Limitations" section that port forwarding isn't automatic yet and is still on the roadmap; files and terminal can be proxied through the relay, but `localhost:PORT` only resolves on the host machine itself today. The one claim about Superset that did survive verification is simply that a community catalog lists it at roughly 12.9k stars as a parallel-agent terminal. Worth watching as it matures, not ready to lean on for your VPS use case right now.

## Wider landscape (directional, not independently verified to the same bar)

A broader sweep beyond your six named repos surfaced a few points worth knowing, sourced from project blogs and community catalogs rather than cross-verified primary docs — useful context, lower confidence than everything above. **OpenCode**, an open-source terminal AI coding assistant, is reported to have crossed 150,000 GitHub stars and 6.5 million monthly active users as of April 2026, with a GitHub Copilot authentication partnership from January 2026 — a sign of how fast this category is consolidating around a handful of tools. **OpenHands** markets itself as self-hostable with explicit VPC and air-gapped deployment support, which could be worth a look if EpicStaff's licensing gives you pause and you want a more conventionally-licensed self-hosted orchestration option. And a hosting-industry blog frames the broader trend bluntly: it claims roughly two-thirds of enterprise code is now AI-written, which it uses to argue that dedicated, always-on remote execution environments (rather than a laptop that sleeps) are becoming the default rather than the exception for this kind of work — directionally consistent with what you're trying to build, even if the specific percentage is a single blog's framing rather than a verified statistic.

## Physical desk setup — flagged gap, not answered here

You also asked about the best physical work desk, and this research pass has to be upfront: none of the claims that survived verification touch hardware, ergonomics, or desk layout at all — the fact-checking budget went entirely toward the software/remote-access questions, which were the more decision-critical (and more verifiable) half of your ask. A handful of 2026-dated sources were found and queued but not deep-verified: an ADHD-specific desk guide (sunaofe.com) recommending dynamic-lumbar chairs that tolerate fidgeting, dual modular monitor arms, and adjustable smart lighting; plus general 2026 developer desk setup roundups from makerstations.io, imovr.com, and positioniseverything.net. Worth a dedicated follow-up pass if you want that side researched to the same standard as the software side — happy to run it.

## Open questions worth testing yourself

Four things the research flagged as genuinely unresolved rather than guessing at an answer: whether omp.sh can run as a managed/headless agent *inside* Paseo or bb (the two strongest remote-access stories) or whether `/collab` is the only supported bridge between your preferred agent and remote access; the real-world latency and reliability of relay-based sessions (Paseo's hosted relay, omp's `/collab`) versus a direct Tailscale/VPN connection — relevant to how disruptive connection hiccups would be to focus, given ADHD sensitivity to friction; whether EpicStaff's noncompete license would actually restrict your specific use case or only someone building a directly competing hosted clone of EpicStaff; and the physical desk question above.

## Part 2 — 66 more open-source projects (breadth scan)

Seven searches ran in parallel, each pointed at a different angle, each required to actually fetch and confirm every repo it lists rather than trust a blog. A few dead ends got caught and cut in the process, which is itself a useful signal: Daytona and Vibe Kanban both now say in their own READMEs that they're unmaintained/sunsetting, decolua/9remote turned out to be closed-source despite the framing, and yarmand/webpair is abandoned. Everything below is still alive.

If you only look at eight of these, look at these — the ones that map most directly onto omp.sh plus a VPS: **Happy** and **VibeTunnel** for phone/browser control of a session running on your box, **phi** and **Taskplane** and **compozy** because they're built directly on or alongside the same "pi" agent lineage as omp.sh itself, **Coder** or **code-server** for the most battle-tested way to get a full remote dev box, **Leantime** as a self-hosted, ADHD-native task layer with an MCP endpoint, and **hetzner-mcp-server** / **mcp-digitalocean** / **mcp-ssh-tmux** for the genuinely cutting-edge idea of letting the agent manage its own VPS.

### New single-agent CLIs (alternatives/siblings to omp.sh itself)

**[Gemini CLI](https://github.com/google-gemini/gemini-cli)** — Google's open-source terminal agent with MCP support and a ReAct loop; headless and SSH-friendly, so it can run as a second engine on the same box as omp. Nightly builds, latest Aug 12, 2026.

**[Crush](https://github.com/charmbracelet/crush)** — Terminal coding agent from the Charm team, single static Go binary, multi-provider model switching mid-session. No GUI dependency, installs clean on a headless VPS. v0.75.0, June 2026.

**[Ares](https://github.com/sidmanale643/Ares)** — Minimal terminal agent with a persistent local IPython workspace and process-isolated subagents. Five days old at time of writing — about as cutting-edge as it gets.

**[memcode](https://github.com/memcode-ai/memcode)** — Go CLI that persists a versioned model of your repo (history, failed approaches, preferences) across sessions and machines — directly useful when sessions get torn down and resumed from a different device. Created Aug 9, 2026.

**[phi](https://github.com/pulseaiclub/phi)** — 12MB single-binary agent harness explicitly billed as "a sibling to Pi," crediting oh-my-pi's own hash-anchored-edit approach. Worth a direct look given your existing preference. Created Aug 3, 2026.

### Multi-agent orchestration (run several agents at once)

**[Orca](https://github.com/stablyai/orca)** — Fans one prompt across up to five agents in isolated worktrees to compare/merge results; built explicitly for "desktop, mobile and VPS" with SSH worktrees and a phone app. ~40k stars after fast 2026 growth.

**[emdash](https://github.com/generalaction/emdash)** (YC W26) — Parallel agents in isolated worktrees with a unified diff/CI/merge dashboard; explicitly supports remote machines over SSH/SFTP.

**[Genie](https://github.com/automagik-dev/genie)** — Plans a task, dispatches parallel agents into worktrees, reviews the PRs itself before you see them. Single binary, no daemon, includes a WhatsApp bridge for remote approvals.

**[AgentOS](https://github.com/saadnvd1/agent-os)** — Self-hosted, mobile-first web UI running up to four agent sessions side by side over Tailscale, with voice dictation. Built for exactly the "no reliable computer" scenario.

**[Pane](https://github.com/dcouple/Pane)** — Wraps any CLI agent in auto-managed worktrees with a diff viewer; its "Remote Pane" mode gives self-hosted browser/mobile access to sessions on another machine. AGPL-3.0.

**[Herd](https://github.com/NickGuAI/Herd)** — Meta-harness command center tracking mission state and approvals for a fleet of workers, delegating explicitly to "local hosts, SSH machines, or Tailscale boxes."

**[Amux](https://github.com/andyrewlee/amux)** — Go/tmux TUI for switching between several agents, each bound to its own worktree and tmux session — attaches/detaches cleanly over SSH.

**[Swarm-IOSM](https://github.com/rokoss21/swarm-iosm)** — Runs up to 8 parallel Claude Code subagents with file-lock conflict prevention; layers onto an existing VPS-hosted session to turn it into a coordinated swarm.

**[Paragents](https://github.com/FrankHui/paragents)** — TUI for concurrent agent sessions with permission-aware tool gating and preflight conflict checks — matters when several agents share one VPS filesystem unattended. MIT.

**[Open Agent Teams (OAT)](https://github.com/Root-IO-Labs/open-agent-teams)** — Supervisor/workers/reviewers framework, each in its own process and worktree, across 17+ LLM providers.

**[Taskplane](https://github.com/HenryLach/taskplane)** — Multi-agent orchestration built specifically around the **pi** CLI (omp's own lineage) — dependency-ordered waves of workers/reviewers/mergers with a live dashboard. Direct fit.

**[Harness Kanban](https://github.com/Orenoid/harness-kanban)** — Cloud kanban board assigning issues to fully containerized, 24/7-running agents — a PM front end for a fleet of always-on remote agents.

**[Handler](https://github.com/Launchable-AI/handler.dev)** — Control plane unifying Docker, Firecracker microVMs, and six cloud-VM backends behind one API for spawning agent sandboxes across local and cloud compute.

**[cspace](https://github.com/elliottregan/cspace)** — Spins up multiple isolated, firewalled Claude Code devcontainer instances against GitHub issues — a concrete disposable-sandbox pattern adaptable to any terminal agent.

**[IDEKUBE](https://github.com/idekube-project/idekube-container)** — Self-hosted platform running browser-accessible dev environments plus fleets of agents as containers on your own Kubernetes cluster — an on-prem Codespaces/Gitpod alternative. Small/new, active CI.

**[Herdr](https://github.com/herdrdev/herdr)**, **[Agent Deck](https://github.com/asheshgoplani/agent-deck)**, and **[CCManager](https://github.com/kbwo/ccmanager)** round out this category: Herdr is a Rust "agent multiplexer" with detachable persistent sessions and a socket API for agent-to-agent coordination; Agent Deck is a TUI command center with Docker sandboxing that explicitly manages SSH-based remote instances and can escalate stuck sessions via Telegram/Slack; CCManager is a lightweight, daemon-free Node TUI for juggling several agents (Claude Code, Gemini CLI, Cursor, Copilot, Kimi) across worktrees inside one tmux session.

### Remote/VPS access & mobile control (closest to your core ask)

**[Happy](https://github.com/slopus/happy)** — End-to-end encrypted mobile/web/desktop client that takes over a running Claude Code or Codex session so you can watch and steer it from your phone, with push notifications. 21.2k stars.

**[VibeTunnel](https://github.com/amantus-ai/vibetunnel)** — Turns any browser (phone included) into a terminal, no SSH/port-forwarding setup; ships a headless Linux server mode built to run on the VPS itself.

**[Coder](https://github.com/coder/coder)** — Self-hosted platform provisioning cloud/VPS dev environments via Terraform, reachable by browser or WireGuard tunnel, with centralized governance for running agents on your own infra.

**[code-server](https://github.com/coder/code-server)** — The canonical "install VS Code once on a VPS, code from any device" tool. Mature, still actively released (v4.126.0, June 2026).

**[DevPod](https://github.com/loft-sh/devpod)** — Client-only tool spinning up devcontainer-standard environments on any reachable remote machine, Codespaces-style workflow with no vendor lock-in.

**[Zellij](https://github.com/zellij-org/zellij)** — Rust terminal multiplexer with a built-in web client — reattach to a remote session from a plain browser tab, no SSH client needed. Solid tmux alternative for keeping agent sessions alive.

**[container-use](https://github.com/dagger/container-use)** — MCP server/CLI from Dagger giving each agent its own fresh container and git branch, with the ability to drop into any agent's terminal for takeover.

**[Claude Squad](https://github.com/smtg-ai/claude-squad)** and **[AgentAPI](https://github.com/coder/agentapi)** — Claude Squad runs several agents each in an isolated tmux pane plus worktree, manageable from a single SSH session; AgentAPI (from the Coder team) is an HTTP/REST wrapper fronting a dozen terminal agents with a uniform API, the scripting primitive for building your own remote control UI.

**[Dinotty](https://github.com/xichan96/dinotty)** — Self-hosted, mobile-first web terminal purpose-built for AI coding agents, with a file browser and dev-server preview — an agent-monitoring cockpit from any phone. Weekly releases.

**[MobileCLI](https://github.com/MobileCLI/mobilecli)** — Rust daemon plus iOS app streaming terminal sessions to your phone with push notifications when an agent needs approval.

**[OpenClaude Mobile](https://github.com/friuns2/openclaude-android)** — Android app running a full open-source coding agent entirely on-device, no server or PC — a no-VPS fallback for coding straight from a phone.

**[nodeterm](https://github.com/eneskirca/nodeterm)** — Spatial, tmux-backed session manager (draggable nodes on a canvas) with a headless "Browser Server Edition" for remote access.

**[Agent of Empires](https://github.com/agent-of-empires/agent-of-empires)** — Parallel sessions in tmux + worktree sandboxes, controllable from a TUI or an installable PWA with home-screen phone access and HTTPS auth.

**[247 / Claude Code Remote](https://github.com/QuivrHQ/247-claude-code-remote)** — Always-on remote dev environment reachable through a touch-optimized web terminal over Cloudflare Tunnel, no exposed ports. From the YC-backed Quivr team.

**[codeg](https://github.com/xintaofei/codeg)** — Collaborative workspace aggregating sessions from many agents, self-hosted, with Telegram/Lark chat-ops control for nudging a VPS-hosted session with no browser handy.

**[RemoteLab](https://github.com/trmquang93/claude-code-remote)** — Minimal self-hosted bridge (ttyd + Cloudflare Tunnel + auth-proxy) exposing agent terminal sessions to any browser over HTTPS with no open ports.

**[CodeAgent Mobile](https://github.com/edgar-durand/codeagent-mobile-clients)** — Client bridges (CLI, VS Code/Cursor/JetBrains) streaming long-running sessions to a phone for async diff approval.

**[CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui)** — Full responsive web/mobile control panel (chat, shell, file explorer, git) for driving agent sessions remotely; self-hostable or managed-cloud.

**[Soromi](https://github.com/soromi/soromi)** — Rust/Tauri daemon owning persistent agent terminal sessions where desktop app and phone browser are both just viewports on the same live session — matches "run omp.sh on a box, keep it alive, reconnect from anywhere" almost exactly.

**[CodeForge Agent](https://github.com/nanocreek/codeforge-agent)** — One-click Railway template deploying a multi-role AI engineering team in a sandboxed container, a ready pattern for hosting a full agent team on a PaaS instead of locally.

**[Web Terminal ACP](https://github.com/boydfd/web_terminal_acp)** — Self-hosted browser control plane with tmux-backed terminals and SSH-bootstrapped remote clients, built to supervise headless sessions from any browser.

**[openronin](https://github.com/openronin/openronin)** — Self-hosted daemon acting as an autonomous GitHub teammate (picks up issues, opens PRs, resolves conflicts, merges on green CI) — a demonstration of the unattended-remote-worker pattern.

**[Valet](https://github.com/tkhq/valet)** — Self-hosted background agents, each given a hosted workstation (VS Code, browser VNC, terminal) on Cloudflare Workers + Modal sandboxes — disposable hosted dev boxes per task.

**[Ptylon](https://github.com/alexfrmn/ptylon)** — Docker-composed browser terminal workspace with a persistent PTY daemon, one authenticated URL for "reconnect from any device."

### ACP & MCP ecosystem tooling (the genuinely new protocol layer)

**[aptove/bridge](https://github.com/aptove/bridge)** — Rust daemon exposing any stdio-based ACP agent over WebSocket with Tailscale/Cloudflare-tunnel transports and QR device pairing — reaches a headless agent on a remote box from your phone.

**[vcoderun/acprouter](https://github.com/vcoderun/acprouter)** — Drives any ACP agent from Telegram with inline-button approvals and diff rendering — steer a VPS-hosted session with no SSH client.

**[smagnuso/hydra-acp](https://github.com/smagnuso/hydra-acp)** — Lets several clients (editor, terminal, browser, Slack) attach simultaneously to one running ACP agent process.

**[newioapp/acp-inspector](https://github.com/newioapp/acp-inspector)** — "MCP Inspector, but for ACP" — a protocol debugger for ACP traffic, sessions, and permission requests. Useful if you end up wiring anything custom around omp.sh.

**[compozy](https://github.com/compozy/compozy)** — CLI "agent OS" running structured multi-stage workflows across ACP runtimes; its docs list **Pi** by name alongside Claude Code, Codex, and OpenCode. 2.3k stars.

**[digitalocean-labs/mcp-digitalocean](https://github.com/digitalocean-labs/mcp-digitalocean)** and **[nityeshaga/hetzner-mcp-server](https://github.com/nityeshaga/hetzner-mcp-server)** — Official-DO and community-Hetzner MCP servers letting an agent provision, reboot, or redeploy the very VPS hosting the workspace by natural language — a genuinely new "agent manages its own infrastructure" idea.

**[devnullvoid/mcp-ssh-tmux](https://github.com/devnullvoid/mcp-ssh-tmux)** — MCP server giving persistent SSH-into-tmux sessions on remote hosts, returning visual terminal snapshots instead of parsed text — more reliable remote control for an agent driving another agent.

**[JinchengGao-Infty/agent-mux](https://github.com/JinchengGao-Infty/agent-mux)** — tmux-backed agent pool plus MCP server spawning and orchestrating multiple interactive CLI agents as tmux windows.

### ADHD & focus productivity (developer-usable, open source)

**[Leantime](https://github.com/leantime/leantime)** — Self-hostable project/task manager explicitly designed around ADHD and neurodivergent workflows (time-blocking, dopamine-based prioritization, AI task breakdown) with an MCP endpoint. AGPL-3.0.

**[Super Productivity](https://github.com/johannesjo/super-productivity)** — To-do app with timeboxing, Pomodoro, and native GitHub/GitLab/Jira/Linear sync — link tasks straight to the issues your agent touches. MIT.

**[ActivityWatch](https://github.com/ActivityWatch/activitywatch)** — Privacy-first automatic time tracker with a local REST API — hard data on where terminal/agent hours actually go, countering time-blindness. MPL-2.0.

**[Focus](https://github.com/ayoisaiah/focus)** — Cross-platform CLI Pomodoro timer with a post-session hook for custom scripts — timebox agent runs without leaving the terminal. MIT (slower-moving, but solid).

**[git-leash](https://github.com/SiteRelEnby/git-leash)** — A git pre-commit hook that blocks commits during configured time windows — a boundary tool that stops late-night hyperfocus binges at the commit gate.

**[Octopus](https://github.com/SebastianElvis/octopus)** — Tauri desktop app billed as "the Claude Code frontend for ADHD developers": a kanban dispatch board for running dozens of parallel sessions with AI-generated recaps.

**[i-have-adhd](https://github.com/ayghri/i-have-adhd)**, **[Loft-Hours](https://github.com/lazyfoxjumps/Loft-Hours)**, and **[claude-adhd-skills](https://github.com/ravila4/claude-adhd-skills)** — Three open-source Claude Code skills worth adapting to omp.sh directly: one forces action-first, no-fluff agent replies; one simulates body-doubling (timer, break check-ins, session logs); one adds Obsidian journaling plus a time-based nudge/reminder hook. All MIT, all built for Claude Code specifically but the patterns port cleanly.

## Sources

Primary (project docs/repos, used for the verified findings): [github.com/getpaseo/paseo](https://github.com/getpaseo/paseo), [paseo.sh/omp](https://paseo.sh/omp), [github.com/can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), [omp.sh](https://omp.sh/), [github.com/get-bb/bb](https://github.com/get-bb/bb), [github.com/anycode-ade/anycode](https://github.com/anycode-ade/anycode), [github.com/kaanozhan/Frame](https://github.com/kaanozhan/Frame), [github.com/EpicStaff/EpicStaff](https://github.com/EpicStaff/EpicStaff), [github.com/superset-sh/superset](https://github.com/superset-sh/superset), [docs.superset.sh/remote-workspaces](https://docs.superset.sh/remote-workspaces).

Secondary/landscape (blog-quality, lighter verification): [github.com/bradagi/awesome-cli-coding-agents](https://github.com/bradagi/awesome-cli-coding-agents), [github.com/caramaschiHG/awesome-ai-agents-2026](https://github.com/caramaschiHG/awesome-ai-agents-2026), [cleverhack.com/ai-coding-landscape](https://cleverhack.com/ai-coding-landscape), [openhands.dev/blog/open-source-ai-coding-agents](https://www.openhands.dev/blog/open-source-ai-coding-agents), [northflank.com/blog/enterprise-ai-remote-coding-environments](https://northflank.com/blog/enterprise-ai-remote-coding-environments), [brainhost.ai/blog/best-vps-for-ai-agents](https://brainhost.ai/blog/best-vps-for-ai-agents), [medium.com/@0xmega — Claude Code on a VPS](https://medium.com/@0xmega/claude-code-on-a-vps-the-complete-setup-security-tmux-mobile-access-2d214f5a0b3b).

Desk/ergonomics (queued, not deep-verified): [sunaofe.com — ADHD Desk Setup Guide 2026](https://sunaofe.com/blogs/productivity-work-habits/adhd-desk-setup-guide-2026), [makerstations.io/adhd-desk-setup](https://www.makerstations.io/adhd-desk-setup/), [imovr.com/blogs/future-of-work/adhd-home-office-setup](https://www.imovr.com/blogs/future-of-work/adhd-home-office-setup), [positioniseverything.net — best desk setup for developers 2026](https://www.positioniseverything.net/best-desk-setup-for-designers-and-developers-in-2026-8-products-that-actually-make-a-difference/).

---
*Method: 5 parallel search angles → 21 sources fetched → 97 factual claims extracted → the 25 most decision-relevant claims put through independent 3-vote adversarial review (a claim needed 2/3 reviewers to actively try to refute it and fail). 15 survived, 10 were killed as overreach or unsupported, 0 came back inconclusive. Full reasoning for any individual verified or refuted claim is available on request.*
