# omp-deck production deploy

This directory holds the self-contained production deployment artifact set for
omp-deck. The repo root's `Dockerfile` and `docker-compose.yml` are dev
artifacts; everything an operator needs to ship a fresh box lives here.

## What ships

| File | Purpose |
| --- | --- |
| `Dockerfile` | Multi-stage production image. Mirrors `./Dockerfile` so this dir is self-describing. |
| `docker-compose.yml` | Loopback-only service definition, named volume for agent state, `/workspace` mount, healthcheck. |
| `.env.example` | Documents every secret. Copy to `.env`, fill, pass via `--env-file`. |
| `openship.app.yaml` | OpenShip custom-app template (`kind: template`, `custom: true`). |
| `openship-deploy.sh` | Orchestrates `post_apps_custom` → `post_apps` → `patch_projects_by_id_env` → `post_deployments` over the OpenShip MCP. |
| `README.md` | This file. |

## Two deployment paths

### A. Bare-metal / VM via plain Docker

```bash
cp deploy/.env.example deploy/.env
# Fill MCP_OPENSHIP_TOKEN and at least one provider key.
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
curl http://127.0.0.1:8787/api/health
```

The server binds to `127.0.0.1:8787` by default. Front it with `tailscale serve`,
an SSH tunnel, or a real reverse proxy with auth — the image has no built-in
auth.

### B. OpenShip (this instance)

`OpenShip` runs the same image as a custom app. The MCP tools live at
`xd://mcp__openship_*` paths (per
`agent-defaults/managed-skills/openship/SKILL.md`).

```bash
export MCP_OPENSHIP_TOKEN="..."   # write-capable token
export OPENSHIP_PROJECT_NAME="omp-deck"
# Optional:
# export OMP_DECK_DOMAIN="deck.example.com"
# export OMP_DECK_WORKSPACE="/var/lib/openship/projects/omp-deck/workspace"
./deploy/openship-deploy.sh
```

The script:

1. Registers the template from `openship.app.yaml` via `post_apps_custom`.
2. Installs the project via `post_apps` with a port route (or domain route if
   `OMP_DECK_DOMAIN` is set).
3. Merges `MCP_OPENSHIP_TOKEN` onto the project as a secret via
   `patch_projects_by_id_env` — `post_apps` config does not carry isSecret
   values through.
4. Triggers `post_deployments` and polls `get_deployments_by_id_build` until
   the deployment phase is `ready|success|succeeded|healthy|running`.

If your MCP token is read-only, `post_apps_custom` and `post_apps` will return
a 401/403. The script exits with code 2 or 3; fall back to the OpenShip REST
auth path described at the bottom of the OpenShip skill.

## Wiring `MCP_OPENSHIP_TOKEN` once the deck is live

The deck reads `MCP_OPENSHIP_TOKEN` from its own environment at server boot.
Two places to set it:

```bash
# 1. The runtime container env (see .env.example, the docker-compose env
#    block, or the OpenShip project's env editor).
# 2. The deck's own Settings → Env page. /api/env persists values to the
#    server's env store; a restart picks them up.
```

Verify the wiring:

```bash
curl http://127.0.0.1:8787/api/openship/status
# → { "configured": true }    when the token is set and the server has restarted.
# → { "configured": false }   otherwise; the panel in /integrations shows a
#                              "connect OpenShip" hint instead of an error.
```

Once `configured: true`:

- `/api/openship/projects` — list of OpenShip projects
- `/api/openship/projects/:id` — project detail + deployment history
- `POST /api/openship/projects/:id/deploy` — trigger a deploy
- `/api/openship/deployments/:id/logs` — pull the last N log lines

All four routes flip from 503 → 200 on the same restart.

## Smoke-test command set

```bash
# 1. Server health.
curl -sS http://127.0.0.1:8787/api/health

# 2. Overview dashboard payload (real local stats + cached news).
curl -sS 'http://127.0.0.1:8787/api/overview?window=7d' | jq '{stats: (.stats|length), news: (.news|length), trending: (.trending|length), focus: .focus.nextAction}'

# 3. OpenShip bridge (only meaningful once MCP_OPENSHIP_TOKEN is set).
curl -sS http://127.0.0.1:8787/api/openship/status
curl -sS http://127.0.0.1:8787/api/openship/projects | jq '.items | length'
```

## Updating after a code change

OpenShip auto-deploys on push to the linked branch (default `main`) once auto-
deploy is enabled on the project. To force a redeploy without a push:

```bash
./deploy/openship-deploy.sh
# (the script's first step is idempotent — re-registering the template is a no-op)
```

Or via the deck's own OpenShip panel — `/integrations` → pick the project →
**Deploy**.

## What this directory deliberately does NOT do

- It does not push to GitHub. The user owns the push workflow (per the
  documented omp-deck push procedure: `git fetch origin`, reconcile ahead/behind,
  then `git push --force-with-lease`).
- It does not auto-trigger redeploys on each commit. OpenShip's
  `post_projects_by_id_auto_deploy` does that when the project is linked to a
  GitHub repo; flip it on in the OpenShip dashboard, or call it from this
  script's first deploy.
- It does not manage TLS. OpenShip terminates TLS at the edge; for the
  bare-metal path, terminate at `tailscale serve` or your reverse proxy.
