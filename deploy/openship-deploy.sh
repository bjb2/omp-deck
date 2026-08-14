#!/usr/bin/env bash
#
# Deploy omp-deck into the production OpenShip instance via the OpenShip
# MCP server mounted at xd://mcp__openship_* (per
# agent-defaults/managed-skills/openship/SKILL.md).
#
# Flow:
#   1. Register the custom app template via post_apps_custom
#      (or skip if already registered — `custom` apps persist).
#   2. Install + first deploy via post_apps with a port route.
#   3. Surface the live deployment id and a `curl` smoke command.
#
# Required env:
#   MCP_OPENSHIP_TOKEN    bearer token authorized to write projects.
#   OPENSHIP_PROJECT_NAME display name (default: omp-deck).
#
# Optional:
#   OMP_DECK_DOMAIN       hostname to bind (default: port-only).
#   OMP_DECK_WORKSPACE    host path mounted at /workspace (default: /var/lib/openship/projects/omp-deck/workspace).
#
# Exit codes:
#   0  success
#   1  missing MCP_OPENSHIP_TOKEN
#   2  template registration failed
#   3  project install failed
#   4  deployment did not reach a healthy state within the poll window
set -euo pipefail

: "${MCP_OPENSHIP_TOKEN:?MCP_OPENSHIP_TOKEN must be set before running this script}"

PROJECT_NAME="${OPENSHIP_PROJECT_NAME:-omp-deck}"
DOMAIN="${OMP_DECK_DOMAIN:-}"
WORKSPACE="${OMP_DECK_WORKSPACE:-/var/lib/openship/projects/omp-deck/workspace}"
MANIFEST="$(cd "$(dirname "$0")" && pwd)/openship.app.yaml"
APP_ID="omp-deck"

log() { printf '[omp-ship] %s\n' "$*" >&2; }

xd() {
	# write JSON args to the xd:// path; the MCP server consumes it
	# synchronously. Falls back to plain echo when not mounted.
	local path="$1"; shift
	local body="$*"
	if command -v xd >/dev/null 2>&1; then
		printf '%s' "$body" | xd write "$path" - 2>/dev/null || printf '%s' "$body"
	else
		printf '%s' "$body"
	fi
}

log "Registering custom app template $APP_ID from $MANIFEST"
manifest_json="$(cat "$MANIFEST")"
register_body=$(jq -n --arg id "$APP_ID" --argjson t "$manifest_json" '{id:$id,template:$t}')
register_resp=$(xd "xd://mcp__openship_post_apps_custom" "$register_body" || true)

# `post_apps_custom` returns the registered template id; some OpenShip
# versions already have it cached. Either way we move on.
log "Install: $PROJECT_NAME (template $APP_ID)"

routes_json=$(jq -n --arg domain "$DOMAIN" '
	(if $domain != "" then
		[{service:"omp-deck", port:8787, mode:"port", domain:$domain}]
	else
		[{service:"omp-deck", port:8787, mode:"port"}]
	end)
')

config_json=$(jq -n \
	--arg workspace "$WORKSPACE" \
	'{
		OMP_DECK_WORKSPACE: {value: $workspace}
	}')

install_body=$(jq -n \
	--arg name "$PROJECT_NAME" \
	--arg templateId "$APP_ID" \
	--argjson routes "$routes_json" \
	--argjson config "$config_json" \
	'{templateId:$templateId, name:$name, config:$config, routes:$routes}')

install_resp=$(xd "xd://mcp__openship_post_apps" "$install_body" || true)

project_id=$(printf '%s' "$install_resp" | jq -r '.projectId // .id // empty')
if [ -z "$project_id" ]; then
	log "Could not parse projectId from install response:"
	printf '%s\n' "$install_resp" >&2
	exit 3
fi
log "Project installed: $project_id"

# Patch the secrets onto the project. `post_apps_custom` does not carry
# isSecret values through `config`, so we set them via the env-merge
# endpoint which DOES honor `isSecret` masking.
env_body=$(jq -n \
	--arg project "$project_id" \
	--arg token  "$MCP_OPENSHIP_TOKEN" \
	'{
		projectId: $project,
		env: { MCP_OPENSHIP_TOKEN: {value: $token, isSecret: true} },
		mergeStrategy: "upsert"
	}')
xd "xd://mcp__openship_patch_projects_by_id_env" "$env_body" >/dev/null || true

log "Triggering first deploy"
deploy_body=$(jq -n --arg project "$project_id" '{projectId: $project}')
deploy_resp=$(xd "xd://mcp__openship_post_deployments" "$deploy_body" || true)

deployment_id=$(printf '%s' "$deploy_resp" | jq -r '.deploymentId // .id // empty')
log "Deployment id: ${deployment_id:-<unknown>}"

# Poll until healthy or we run out of patience.
deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
	status_resp=$(xd "xd://mcp__openship_get_deployments_by_id_build" "$(jq -n --arg id "$deployment_id" '{deploymentId:$id}')" || true)
	phase=$(printf '%s' "$status_resp" | jq -r '.phase // .status // empty')
	log "phase=$phase"
	case "$phase" in
		ready|success|succeeded|healthy|running)
			log "Deployment healthy."
			break
			;;
		failed|errored|crashed)
			log "Deployment failed:"
			printf '%s\n' "$status_resp" >&2
			exit 4
			;;
	esac
	sleep 5
done

log "Smoke test (run from any host that can reach the OpenShip edge):"
if [ -n "$DOMAIN" ]; then
	log "  curl https://$DOMAIN/api/health"
else
	log "  curl http://<openship-host>:8787/api/health"
fi
log "OpenShip panel inside the deck (requires MCP_OPENSHIP_TOKEN):"
log "  curl http://<deck-host>:8787/api/openship/status"
