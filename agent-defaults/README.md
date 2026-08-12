# Agent defaults

The starting contents of the omp agent directory (`~/.omp/agent`, or wherever
`OMP_AGENT_DIR` points). `scripts/seed-agent-dir.sh` copies these in at
container start.

This exists because a container begins with an empty agent directory. On a
laptop that directory accumulates over months — subagents, skills, extensions,
rules, MCP servers, model routing — and it is most of what makes the agent
behave like *yours*. Without a seed, every image rebuild keeps the deck and
loses the agent's character.

## What's here

| Path | What it is |
|---|---|
| `agents/` | Subagent definitions the agent can delegate to |
| `managed-skills/` | Skills available via `skill://<name>` |
| `extensions/` | Session extensions loaded by the SDK |
| `rules/`, `RULES.md`, `AGENTS.md` | Standing instructions |
| `WATCHDOG.md`, `WATCHDOG.yml` | Watchdog notes and config |
| `config.yml` | omp agent configuration |
| `smithery.json` | Smithery registry config |
| `*.tmpl` | Configs containing credentials — see below |

## The `.tmpl` files

`mcp.json` and `models.yml` carry API keys and bearer tokens. They are stored
here as templates with `${VAR}` placeholders and rendered at container start
from the environment. Keeping the real values out of the image is what lets
this directory live in a public repository.

Set these where you configure the rest of the deck's environment:

**MCP servers**

| Variable | Server |
|---|---|
| `MCP_OPENSHIP_TOKEN` | openship |
| `MCP_PARALLEL_TOKEN` | parallel |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | github |
| `EXA_API_KEY` | exa |
| `TAVILY_API_KEY` | tavily (already referenced by URL) |

**Model providers** — `OMP_PROVIDER_<NAME>_API_KEY` for each provider in
`models.yml.tmpl`: `GROQ`, `INCEPTION`, `CODEXHUB`, `9ROUTER`, `OMNI`,
`OPEN_GO`, `GEPETE`, `NGH_CLAUDE`.

An unset variable renders empty rather than leaving a literal `${VAR}` in the
config: a server that fails to authenticate is easier to diagnose than one whose
token is the string `${MCP_FOO_TOKEN}`.

Subscription providers (Anthropic, OpenAI) don't belong here at all — sign those
in through Settings → Providers, which stores OAuth credentials in the agent
database on the volume.

## Rules of the road

**Existing files are never overwritten.** The seed only writes what's missing,
so anything edited in the volume — by you or by the agent — survives restarts
and redeploys. To re-apply the image's copy over the top, set
`OMP_DECK_SEED_FORCE=1` and restart.

**Never commit a real credential here.** The whole directory ships in a public
image and repository. If a value is secret, it belongs in a `.tmpl` placeholder
and an environment variable.

**stdio MCP servers must be runnable in the container.** These configs came from
a Windows machine and originally invoked `cmd.exe /c C:\nvm4w\nodejs\npx.CMD`;
they are ported to plain `npx`. A server whose command doesn't exist in the
image will simply fail to start — and the `github` server shells out to
`docker`, which is not available inside the container unless you mount a Docker
socket.
