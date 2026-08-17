---
name: infrastructure-operations
description: "Deploy, diagnose, secure, monitor, back up, and recover Docker, Dokploy, Coolify, Cloudflare, network, and storage systems."
---

# Infrastructure Operations

## Workflow
1. Establish target, current state, ownership, and rollback path.
2. Read live config/logs/health before changing anything.
3. Prefer platform APIs and existing deployment definitions over ad-hoc shell changes.
4. Change one causal layer at a time: DNS → TLS/proxy → container → app → data.
5. Preserve volumes, secrets, and service identity.
6. Verify externally through the real domain and internally through health/log evidence.

## Safety
Back up config/data before destructive migrations. Never print credentials. Confirm deletion, reset, or irreversible operations. For production, keep rollback and restore proof.

## Current docs
Query official platform docs for version-sensitive fields and APIs. Do not rely on remembered flags.

## Archived runbooks
Incident-specific Dokploy, Coolify, proxy, email, WAHA, PasarGuard, and network procedures live in archived skill directories. Search by exact product/error and read only matching runbook.

## Dokploy MCP
Instance `https://dok.v244.net`, REST auth header `x-api-key`. Projects: Version 244 CRM, Automations, Arzket, Essentials, Personal Projects, AI Utilities. Tools mount as devices at `xd://mcp__dokploy_<tool>`: invoke by writing the JSON argument object as `content` with `write`; `read` the device path for full docs and schema. Server segments are sanitized, so confirm the exact path from the session's own `xd://` inventory instead of trusting a hardcoded one.

### Read first
1. `project-all` (no args) — inventory of projects and ids.
2. `project-one`(projectId) — drill into one project; `environment-byProjectId`(projectId) for its environments.
3. `application-one`(applicationId) or `compose-one`(composeId) — config and status of the service.
4. `deployment-all`(applicationId) or `deployment-allByCompose`(composeId) — build/deploy history.
5. Logs: `application-readLogs`(applicationId), `postgres-readLogs`(postgresId), or `compose-readLogs`(composeId, containerId) after `compose-loadServices`(composeId).

Ids are required arguments and are never guessable — take each from the preceding list call. When only a label is known, use `application-search`, `compose-search`, or `postgres-search` to resolve it.

### Families
Fifteen resource prefixes. Read the device schema per tool; do not assume arguments.
- `project`, `environment` — ownership containers for every service.
- `application`, `compose` — deployable services, the usual target.
- `postgres`, `redis` — managed databases.
- `domain` — routing: `domain-byApplicationId`, `domain-byComposeId`.
- `deployment` — deploy history and queues.
- `backup`, `volumeBackups`, `destination`, `schedule` — data protection and cron.
- `settings` — server scope: `settings-health`, `settings-checkInfrastructureHealth`, `settings-getDockerDiskUsage`, Traefik config, Docker pruning.
- `tag`, `github` — labels and git provider metadata.

### Write and destructive
Confirm with the user before calling `application-delete`, `application-stop`, `compose-delete`, `postgres-remove`, `redis-remove`, `project-remove`, `environment-remove`, `domain-delete`, `backup-remove`, `volumeBackups-delete`, `destination-remove`, `deployment-removeDeployment`, `settings-cleanAll`, or `settings-cleanUnusedVolumes`. Name the exact target — project, service, and id — in that confirmation.
Prefer the reversible operation first: `application-redeploy`, `application-reload`, `application-start`, `compose-redeploy`, `compose-start`, `postgres-reload`.
Manual backup and restore runs write to live systems too: confirm `backup-manualBackupPostgres`, `backup-manualBackupCompose`, `volumeBackups-runManually`, and `schedule-runManually` before firing.

### Notes
crawl4ai and firecrawl are compose services in the AI Utilities project on this instance; diagnose their outages here — `compose-one` status, then `compose-readLogs` — before blaming the research tooling.
The mounted surface is filtered by `DOKPLOY_ENABLED_TAGS` in `~/.omp/agent/mcp.json`; narrowing that list is the lever when 221 tools cost too much context.
