#!/bin/sh
# Seed the omp agent directory from the image's bundled defaults.
#
# Why this exists: the agent directory holds everything that makes the agent
# *yours* — subagent definitions, skills, extensions, rules, MCP servers, model
# routing. On a laptop it accumulates over months in `~/.omp/agent`. A container
# starts empty every time, so without a seed step a rebuilt image is a lobotomy:
# same deck, none of the behavior.
#
# Two problems it solves beyond copying files.
#
# 1. The agent directory has two names. `OMP_AGENT_DIR` points the SDK's session
#    and auth storage somewhere persistent, but parts of the deck and the SDK
#    still resolve `~/.omp/agent` directly (slash commands, installed skills).
#    In a container `~` is not on a volume, so those writes vanish on restart.
#    We make `~/.omp/agent` a symlink to the real directory, so both names
#    address the same persistent place.
#
# 2. Config files carry credentials. `mcp.json` and `models.yml` ship as
#    `.tmpl` files with `${VAR}` placeholders instead of tokens, and are
#    rendered here from the environment. That is what lets the defaults live in
#    a public git repository at all.
#
# Existing files are never overwritten: the seed is a starting point, and
# anything the user has since edited in the volume wins. Set
# OMP_DECK_SEED_FORCE=1 to re-apply the image's copy over the top.

set -eu

DEFAULTS_DIR="${OMP_DECK_AGENT_DEFAULTS:-/app/agent-defaults}"
AGENT_DIR="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
FORCE="${OMP_DECK_SEED_FORCE:-0}"

log() { printf '[seed-agent-dir] %s\n' "$1" >&2; }

if [ ! -d "$DEFAULTS_DIR" ]; then
	log "no defaults at $DEFAULTS_DIR — nothing to seed"
	exit 0
fi

mkdir -p "$AGENT_DIR"

# ── Make ~/.omp/agent and $OMP_AGENT_DIR the same directory ────────────────
HOME_AGENT="$HOME/.omp/agent"
CANON_AGENT=$(cd "$AGENT_DIR" && pwd -P)
if [ "$(cd "$HOME_AGENT" 2>/dev/null && pwd -P || echo "")" != "$CANON_AGENT" ]; then
	mkdir -p "$(dirname "$HOME_AGENT")"
	if [ -e "$HOME_AGENT" ] && [ ! -L "$HOME_AGENT" ]; then
		# A real directory already sits there. Move its contents into the
		# persistent location rather than discarding them, then replace it.
		if [ -n "$(ls -A "$HOME_AGENT" 2>/dev/null)" ]; then
			log "migrating existing $HOME_AGENT into $CANON_AGENT"
			cp -rn "$HOME_AGENT/." "$CANON_AGENT/" 2>/dev/null || true
		fi
		rm -rf "$HOME_AGENT"
	fi
	[ -L "$HOME_AGENT" ] && rm -f "$HOME_AGENT"
	ln -s "$CANON_AGENT" "$HOME_AGENT"
	log "linked $HOME_AGENT -> $CANON_AGENT"
fi

# ── Copy plain files and directories ───────────────────────────────────────
if [ "$FORCE" = "1" ]; then
	log "OMP_DECK_SEED_FORCE=1 — overwriting existing files"
	(cd "$DEFAULTS_DIR" && find . -name '*.tmpl' -prune -o -type f -print) | while read -r rel; do
		mkdir -p "$AGENT_DIR/$(dirname "$rel")"
		cp -f "$DEFAULTS_DIR/$rel" "$AGENT_DIR/$rel"
	done
else
	# -n: never clobber. Portable across busybox and GNU cp.
	(cd "$DEFAULTS_DIR" && find . -name '*.tmpl' -prune -o -type f -print) | while read -r rel; do
		if [ ! -e "$AGENT_DIR/$rel" ]; then
			mkdir -p "$AGENT_DIR/$(dirname "$rel")"
			cp "$DEFAULTS_DIR/$rel" "$AGENT_DIR/$rel"
		fi
	done
fi

# Is $1 a parseable config? Only files we render are checked, and only for
# the two syntaxes we emit. A file we cannot validate counts as valid — the
# goal is to catch corruption we caused, never to police the user's edits.
#
# This exists because "keep whatever is in the volume" has a failure mode:
# if a *broken* config ever lands there (a duplicate YAML key shipped in a
# template, a truncated write during a crash), it is preserved forever and
# the server retries parsing it on a loop. Re-rendering only the files that
# actually fail to parse heals that without touching anything the user
# customised.
config_is_valid() {
	_file="$1"
	case "$_file" in
	*.json)
		# bun is always present in this image; it is the server runtime.
		bun -e 'JSON.parse(await Bun.file(process.argv[1]).text())' "$_file" >/dev/null 2>&1
		;;
	*.yml | *.yaml)
		bun -e '
			const y = await import("yaml");
			y.default.parse(await Bun.file(process.argv[1]).text());
		' "$_file" >/dev/null 2>&1
		;;
	*)
		return 0
		;;
	esac
}

# ── Render *.tmpl, substituting ${VAR} from the environment ────────────────
#
# Unset variables render as empty. That is deliberate: a half-configured MCP
# server that fails to authenticate is easier to diagnose than one whose config
# still contains the literal text `${MCP_FOO_TOKEN}`.
for tmpl in "$DEFAULTS_DIR"/*.tmpl; do
	[ -e "$tmpl" ] || continue
	base=$(basename "$tmpl" .tmpl)
	target="$AGENT_DIR/$base"
	if [ -e "$target" ] && [ "$FORCE" != "1" ]; then
		if config_is_valid "$target"; then
			log "keeping existing $base"
			continue
		fi
		# Corrupt. Preserve the operator's copy for diagnosis, then re-render
		# so the server actually boots with a working config.
		log "existing $base is not parseable — backing up and re-rendering"
		cp "$target" "$target.corrupt.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
	fi
	if command -v envsubst >/dev/null 2>&1; then
		envsubst < "$tmpl" > "$target"
	else
		# envsubst lives in gettext, which slim images often omit. awk is always
		# present and handles the only syntax we emit: bare ${NAME}.
		awk '{
			while (match($0, /\$\{[A-Za-z_][A-Za-z0-9_]*\}/)) {
				name = substr($0, RSTART + 2, RLENGTH - 3)
				value = ENVIRON[name]
				$0 = substr($0, 1, RSTART - 1) value substr($0, RSTART + RLENGTH)
			}
			print
		}' "$tmpl" > "$target"
	fi
	log "rendered $base"
done

log "agent directory ready at $CANON_AGENT"
