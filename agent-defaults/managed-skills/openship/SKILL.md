---
name: openship
description: "Operate OpenShip (ship.v244.net) end-to-end — audit, deploy, fix, clean up — across projects, env vars, deployments, shared resources, and incident recovery. One skill, the whole surface."
---

# OpenShip

Operate the OpenShip deployment platform at **ship.v244.net**. Single skill for
audit, deploy, monitor, incident recovery, resource sharing, and bulk cleanup.
Covers everything the five prior `openship-*` skills did, deduplicated.

## MCP Mount Pattern

All OpenShip tools live under `xd://mcp__openship_<action>`. Mount names use
the literal prefix `mcp__openship__` — when not mounted in the current
session, fall back to direct REST (see end of file).

Write args as JSON to the tool's `xd://` path:

```bash
write("xd://mcp__openship_get_projects", "{}")
write("xd://mcp__openship_patch_projects_by_id_env",
      json.dumps({"id": "proj_X", "upserts": [{"key": "FOO", "value": "bar"}], "deletes": []}))
```

## Tool Map (canonical surface)

### Discovery

| Goal | Tool |
|---|---|
| List projects | `mcp__openship_get_projects` |
| Issues summary | `mcp__openship_get_issues_summary` |
| Issues detail | `mcp__openship_get_issues` |
| Force rescan | `mcp__openship_post_issues_rescan` |
| Project details | `mcp__openship_get_projects_by_id` (body: `{"id": "proj_X"}`) |
| Services | `mcp__openship_get_projects_by_id_services` |
| Connections | `mcp__openship_get_projects_by_id_connections` |
| Env vars | `mcp__openship_get_projects_by_id_env` |
| Incidents | `mcp__openship_get_projects_by_id_incidents` |
| Logs | `mcp__openship_get_projects_by_id_logs` (body: `{"id", "tail": N}`) |
| Pending actions | `mcp__openship_get_projects_by_id_pending_actions` |
| Backup policies | `mcp__openship_get_projects_by_projectid_backup_policies` |
| App settings | `mcp__openship_get_projects_by_id_app_settings` |
| App catalog | `mcp__openship_get_apps_catalog` |
| MCP auth check | `mcp__openship_get_settings` |

### Mutation

| Goal | Tool | Body |
|---|---|---|
| Trigger deploy | `mcp__openship_post_deployments` | `{"id": "proj_X"}` |
| Redeploy | `mcp__openship_post_deployments_by_id_redeploy` | `{"id": "dep_X"}` |
| Restart project | `mcp__openship_post_deployments_by_id_restart` | `{"id": "proj_X"}` |
| Restart service | `mcp__openship_post_projects_by_id_restart` | `{"id": "proj_X", "serviceId": "svc_X"}` |
| Keep partial | `mcp__openship_post_deployments_by_id_keep` | `{"id": "dep_X"}` |
| Rollback (reject) | `mcp__openship_post_deployments_by_id_reject` | `{"id": "dep_X"}` |
| Skip port check | `mcp__openship_post_deployments_by_id_skip_port_check` | `{"id": "dep_X", "target": 3000}` |
| Patch project | `mcp__openship_patch_projects_by_id` | partial project fields |
| Patch env vars | `mcp__openship_patch_projects_by_id_env` | `{"id", "upserts":[{"key","value","isSecret"}], "deletes":["OLD"]}` |
| Replace service env | `mcp__openship_put_projects_by_id_services_by_serviceid_env` | full env map (REPLACES) |
| Add connection | `mcp__openship_post_projects_by_id_connections` | `{"id", "sourceProjectId", "outputId", "envKey", "mode":"internal"}` |
| Bundle connections | `mcp__openship_post_projects_by_id_connections_bundle` | `{"id", "connections": [...]}` |
| Bind storage | `mcp__openship_post_projects_by_id_storage` | `{"id", "appId": "proj_MINIO"}` |
| Switch branch | `mcp__openship_post_projects_by_id_branch` | `{"id", "branch": "main"}` |
| Toggle auto-deploy | `mcp__openship_post_projects_by_id_auto_deploy` | `{"id", "enable": true}` |
| Disable project | `mcp__openship_post_projects_by_id_disable` | `{"id"}` |
| Enable project | `mcp__openship_post_projects_by_id_enable` | `{"id"}` |
| Retry routing | `mcp__openship_post_projects_by_id_routing_retry` | `{"id"}` |
| Install catalog app | `mcp__openship_post_apps` | `{"app": "supabase", "routes": [...]}` |
| Register custom app | `mcp__openship_post_apps_custom` | AppTemplate JSON |
| Install custom app | `mcp__openship_post_apps` | `{"templateId", "name", "config", "routes":[...]}` |
| Create project | `mcp__openship_post_projects` | `{"source": "git|local"}` |
| Delete project | `curl -X DELETE /api/projects/projects_by_id` (REST) — confirm target first |
| Run server job | `mcp__openship_post_jobs` | `{"serverId", "actionConfig": {"command", "secrets"}}` |

## Health & Issue Categories

`get_issues_summary` returns counts; treat each bucket differently:

- **outage** — service in crash loop. Immediate action.
- **action_required** — healthcheck failure or port misconfig. Decide keep/skip/reject.
- **advisory** — updates available, port warnings. Non-blocking, schedule.

## Standard Workflows

### Audit (read-only triage)

```bash
projects = json.loads(read("xd://mcp__openship_get_projects"))
issues_summary = json.loads(read("xd://mcp__openship_get_issues_summary"))
detailed = json.loads(read("xd://mcp__openship_get_issues"))
# Categorize: outage / action_required / advisory; pick projects.
```

For each suspect project: get details, services, env, incidents, logs. Read
the log excerpt first — it names the actual failure.

### Patch env vars

```bash
write("xd://mcp__openship_patch_projects_by_id_env", json.dumps({
  "id": "proj_X",
  "upserts": [{"key": "ISSUER", "value": "https://yourdomain.com", "isSecret": False}],
  "deletes": []
}))
```

### Shared resources

Install shared DB/storage/cache ONCE; wire it to consuming projects. Avoid
duplicate postgres containers per project.

```bash
# Wire shared app outputs into target project
write("xd://mcp__openship_post_projects_by_id_connections", json.dumps({
  "id": "proj_TARGET",
  "sourceProjectId": "proj_SHARED_DB",
  "outputId": "postgres",
  "envKey": "DATABASE_URL",
  "mode": "internal"
}))
# Bundle multiple outputs in one shot
write("xd://mcp__openship_post_projects_by_id_connections_bundle", json.dumps({
  "id": "proj_TARGET",
  "connections": ["postgres", "redis", "minio"]
}))
```

Known gotcha: the redis app template auto-outputs `http://redis:6379`
(wrong scheme for ioredis). Override with `REDIS_URL=redis://redis:6379`
via `patch_projects_by_id_env` BEFORE redeploy.

### Bulk cleanup

```bash
projects = json.loads(read("xd://mcp__openship_get_projects"))
# Confirm target list with user before destructive delete.
for p in projects:
    curl -X DELETE "https://ship.v244.net/api/projects/projects_by_id?id={p['id']}" \
         -H "Authorization: Bearer $TOKEN"
```

**Constraint**: MCP write tokens are read-only. Project create + delete via
REST with a PAT; install/connect via MCP. If `post_projects` returns the
login page, your token lacks write scope — use browser automation at
https://ship.v244.net instead.

## Incident Playbook

### Crash loop — missing env var

1. `get_issues` → `get_projects_by_id_incidents` → log excerpt.
2. `patch_projects_by_id_env` to add it.
3. `post_deployments_by_id_restart` (or `post_deployments`).
4. `get_issues_summary` to confirm outage cleared.

### Crash loop — code error

Fix in repo, push, redeploy. Schema errors (`integer is not defined`) =
source code, not config. Use `github` MCP for the fix.

### Crash loop — npm not found (Bun project)

Image has no npm but `startCommand` runs `npm start`. Fix:
`patch_projects_by_id` with `startCommand: "bun run src/index.ts"` and
correct `port`.

### Crash loop — native module dlopen fail (Alpine)

Alpine (musl) fails glibc-only modules (`onnxruntime-node` →
`ERR_DLOPEN_FAILED`). Edit repo `Dockerfile`: alpine → `-slim` (Debian/glibc),
push, redeploy.

### Crash loop — pnpm prune artifact corruption

`pnpm prune --prod` rewrites the store and drops runtime deps. Drop the
prune step from the repo `Dockerfile`.

### Postgres healthcheck unhealthy but logs say "ready"

Healthcheck port/test mismatch. Restart the postgres service:
`post_projects_by_id_restart` with `serviceId`.

### Port advisory

Confirm the app's real port. If advisory is wrong → `skip_port_check`. If
the app actually uses a different port → patch project config.

### Partial deployment (one service ready, others failed)

Inspect logs of each service. Accept working ones with
`post_deployments_by_id_keep`. Reject with `post_deployments_by_id_reject`
(destructive — only when nothing usable).

## Platform Quirks (OpenShip 0.6.1)

- **Healthcheck test arrays: NEVER prefix with `CMD`/`CMD-SHELL`.** OpenShip
  passes the `test` array as a SHELL string to `--health-cmd`. Use bare
  commands: `["pg_isready", "-U", "postgres", "-h", "localhost"]`.

- **`patch_projects_by_id_env` upsert can create DUPLICATE rows** (old +
  new) and keep the OLD value. Service-scoped env via
  `put_projects_by_id_services_by_serviceid_env` is the reliable override
  path — pass the FULL env map (it REPLACES).

- **`advanced.files` mounts EMPTY DIRECTORIES.** The bind-mount has no file
  inside; Kong's `kong.yml` errors "Is a directory"; Postgres init `.sql`
  never runs. Host root:
  `/var/lib/openship/app-config/<projectId>/<service>/<container-path>`.
  Workaround: write the real file via a custom job
  (`echo <b64> | base64 -d > <hostdir>/<name>`), point the app at
  `<container-path>/<name>`.

- **Custom jobs = server shell access.** `post_jobs` with `serverId` (from
  `/api/proxy/api/system/servers`) runs arbitrary commands on the OpenShip
  host. `docker exec -u postgres <id> psql ...` fixes DB state IN PLACE
  (peer auth, no password). Job `secrets` expand via `$VAR` inside double
  quotes. DELETE custom jobs after use — their `actionConfig.command`
  stores secrets.

- **Repo `Dockerfile` wins.** A repo `Dockerfile` (and
  `openship-config.json` if present) override `buildCommand`. Fix build
  issues in the repo, not the project row.

## Supabase Compose Stack Repair

The bundled supabase template has known breakages — fixable without wiping
volumes:

1. **db env lacks POSTGRES_PASSWORD/JWT_SECRET** → first init set no role
   passwords. Custom job:
   `docker exec -u postgres <dbid> psql -c "ALTER USER authenticator WITH PASSWORD '...'"`,
   also `pgbouncer`, `supabase_auth_admin`, `supabase_storage_admin`,
   `supabase_functions_admin` (CREATE ROLE first if missing),
   `supabase_admin`, `postgres`. Then `CREATE SCHEMA IF NOT EXISTS _realtime`
   (owner postgres, grant to supabase_admin), and
   `ALTER DATABASE postgres SET "app.settings.jwt_secret" TO '...'`.
2. **auth fails `must be owner of function uid`** → image pre-seeds auth
   schema; gotrue can't replace functions. As postgres:
   `ALTER OWNER` of all `auth` schema tables/sequences/functions TO
   `supabase_auth_admin` (use `\gexec` SELECTs in `psql -f`).
3. **`API_EXTERNAL_URL` unset** (no domain) → set literal
   `API_EXTERNAL_URL`/`GOTRUE_SITE_URL` and `SUPABASE_PUBLIC_URL` to
   `http://kong:8000` via service env patch (internal-only).
4. **Secret rotation** → patch EVERY service env with literal new values
   (auth, rest PGRST_DB_URI, storage DATABASE_URL/SERVICE_KEY/ANON_KEY,
   realtime DB_PASSWORD/API_JWT_SECRET, meta PG_META_DB_PASSWORD/CRYPTO_KEY,
   studio) + kong.yml host file with new ANON/SERVICE keys, then redeploy.
5. Verify via jobs: `docker exec <id> wget -qO- localhost:9999/health`,
   `curl <kong-ip>:8000/`, `PGPASSWORD=... psql -h localhost -U authenticator -c 'select 1'`.

## Custom Apps (not in catalog)

Known custom apps (as of 2026-08-10):

- **languagetool** — `erikvl87/languagetool:latest`, port 8010,
  HTTP API `/v2/check`.
- **omniroute** — `diegosouzapw/omniroute:latest`, port 20128,
  needs `JWT_SECRET` + `API_KEY_SECRET`, volume `/app/data`.

Register via `post_apps_custom` with an `AppTemplate`
(`{id, kind:"template", name, description, category, services:[...],
endpoints, configFields, custom:true}`). Model on the `redis` custom app
via `get_apps_catalog_by_id`. Install with `post_apps` `{templateId, name,
config, routes:[{service, port, mode:"port"}]}`. Verify runtime logs
after `post_deployments` — "ready" with `portCheck: false` can still mean
an exited container.

## Common Env Vars

| Var | For | Default / source |
|---|---|---|
| `ISSUER` | JWT auth | Project domain, e.g. `https://yourdomain.com` |
| `DATABASE_URL` | DB apps | Shared connection string |
| `POSTGRES_PASSWORD` | Postgres containers | Random secure string (required on fresh init) |
| `MANAGER_BOT_TOKEN` | Telegram apps | BotFather: `123456:ABC-DEF` format |
| `JWT_SECRET` / `API_KEY_SECRET` | omniroute | User-set |

## Project Groups (this instance)

- **Open Source Essentials**: bitwarden, languagetool, omnirouter — standalone.
- **Development**: botsaz, botsaz-dev, mailwiz-next-dev, version-244-dev, medusa-dev.
- **Production**: oh-my-telegram, mailwiz-next, plus other GitHub-linked.

## Troubleshooting Tree

```
Service not running?
├─ Incident crash loop?
│  ├─ Log says missing env → patch_projects_by_id_env + restart
│  ├─ Log says code error → fix in repo, push, redeploy
│  ├─ ERR_DLOPEN_FAILED → switch base alpine → -slim
│  └─ npm not found → set startCommand to `bun run ...`
└─ Deployment not ready → restart

DB not connecting?
├─ No connections → post_projects_by_id_connections from shared app
└─ Connections exist but failing → check shared app health

Storage mount issue?
├─ Not bound → post_projects_by_id_storage from MinIO
└─ Bound but failing → check bucket in MinIO console

Port advisory?
├─ App uses different port → patch project port
└─ Advisory false positive → skip_port_check
```

## Direct REST Fallback (when MCP not mounted)

```bash
HOST="https://ship.v244.net/api/proxy/api"
TOKEN="$(jq -r '.mcpServers.openship.headers.Authorization' ~/.omp/agent/mcp.json | sed 's/Bearer //')"

# JSON-RPC tools/call
curl -s -X POST "$HOST/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_projects","arguments":{}}}'

# Plain REST
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/projects"
curl -s -H "Authorization: Bearer $TOKEN" "$HOST/system/servers"
```

Deployment records expose rendered compose + env (values encrypted); use
`docker inspect` via custom jobs for plaintext runtime env.

## Safety

- Confirm with the user before: deleting projects, stopping production
  projects, bulk env resets, secret rotations, rejecting a deployment,
  running custom server jobs.
- After ANY change: `post_issues_rescan` then `get_issues_summary`,
  confirm `outage: 0` and no new `action_required`.
