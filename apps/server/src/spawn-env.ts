/**
 * Spawn-environment allow-lists.
 *
 * The deck process holds every provider secret (ANTHROPIC_API_KEY,
 * GITHUB_TOKEN, MCP_*, TELEGRAM_*, …) in process.env. Bun.spawn's default
 * `env` is process.env, which means every child process — shell-service,
 * routine `run` steps, `git`, bridge subprocesses — inherits the full
 * credential set.
 *
 * SECURITY-001/019/027/030: an authed attacker who lands prompt-injection or
 * a malicious routine body gains full keychain access via `printenv` /
 * `env | curl`. We close that path by spawning children with a sanitized
 * subset of process.env. Each helper in this file returns an allow-list
 * tailored to one spawn surface:
 *
 *   - `shellSpawnEnv()`        — interactive user shells (deck UI ShellView).
 *   - `routineRunSpawnEnv()`   — routine `run` step bodies (less trusted).
 *   - `gitSpawnEnv()`          — git subprocesses (need GH token, nothing else).
 *   - `bridgeSpawnEnv(extra)`  — bridge subprocesses (per-bridge requiredEnv).
 *
 * The deck process itself still has the full env — only what crosses the
 * spawn boundary is restricted.
 */

const SHELL_ALLOW: Record<string, true> = {
	PATH: true,
	Path: true,
	HOME: true,
	USERPROFILE: true,
	TMPDIR: true,
	TMP: true,
	TEMP: true,
	LANG: true,
	LC_ALL: true,
	LC_CTYPE: true,
	TERM: true,
	SHELL: true,
	EDITOR: true,
	VISUAL: true,
	PAGER: true,
	OMP_DECK_AGENT_DIR: true,
	OMP_DECK_API_BASE: true,
};

const ROUTINE_RUN_ALLOW: Record<string, true> = {
	PATH: true,
	Path: true,
	HOME: true,
	USERPROFILE: true,
	TMPDIR: true,
	TMP: true,
	TEMP: true,
	LANG: true,
	LC_ALL: true,
	LC_CTYPE: true,
	OMP_DECK_AGENT_DIR: true,
	OMP_INTERNAL_RUN_ID: true,
	OMP_INTERNAL_TOKEN: true,
};

const GIT_ALLOW: Record<string, true> = {
	PATH: true,
	Path: true,
	HOME: true,
	USERPROFILE: true,
	TMPDIR: true,
	TMP: true,
	TEMP: true,
	LANG: true,
	LC_ALL: true,
	LC_CTYPE: true,
	GIT_TERMINAL_PROMPT: true,
	GIT_AUTHOR_NAME: true,
	GIT_AUTHOR_EMAIL: true,
	GIT_COMMITTER_NAME: true,
	GIT_COMMITTER_EMAIL: true,
	GIT_CONFIG_GLOBAL: true,
	GIT_CONFIG_SYSTEM: true,
	GITHUB_TOKEN: true,
	GH_TOKEN: true,
	GITHUB_PERSONAL_ACCESS_TOKEN: true,
};

const BRIDGE_ALLOW_BASE: Record<string, true> = {
	PATH: true,
	Path: true,
	HOME: true,
	USERPROFILE: true,
	TMPDIR: true,
	TMP: true,
	TEMP: true,
	LANG: true,
	LC_ALL: true,
	OMP_DECK_AGENT_DIR: true,
	OMP_DECK_API_BASE: true,
	OMP_DECK_API_TOKEN: true,
};

function pick(source: Record<string, string | undefined>, allow: Record<string, true>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(source)) {
		if (allow[key] !== true) continue;
		const v = source[key];
		if (typeof v === "string") out[key] = v;
	}
	return out;
}

export function shellSpawnEnv(): Record<string, string> {
	return pick(process.env as Record<string, string | undefined>, SHELL_ALLOW);
}

export function routineRunSpawnEnv(): Record<string, string> {
	return pick(process.env as Record<string, string | undefined>, ROUTINE_RUN_ALLOW);
}

export function gitSpawnEnv(): Record<string, string> {
	return pick(process.env as Record<string, string | undefined>, GIT_ALLOW);
}

export function bridgeSpawnEnv(extra: readonly string[] = []): Record<string, string> {
	const allow: Record<string, true> = { ...BRIDGE_ALLOW_BASE };
	for (const k of extra) allow[k] = true;
	return pick(process.env as Record<string, string | undefined>, allow);
}
