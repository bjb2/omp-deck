import type { EnvRestartTarget, EnvValueType } from "@omp-deck/protocol";

export interface EnvSchemaEntry {
	key: string;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	restartTarget?: EnvRestartTarget;
	description: string;
	options?: string[];
}

export const ENV_SCHEMA: EnvSchemaEntry[] = [
	{
		key: "OMP_DECK_HOST",
		defaultValue: "127.0.0.1",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend bind host.",
	},
	{
		key: "OMP_DECK_PORT",
		defaultValue: "8787",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Backend HTTP/WebSocket port.",
	},
	{
		key: "OMP_DECK_WEB_PORT",
		defaultValue: "5173",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Vite dev server port.",
	},
	{
		key: "OMP_DECK_DEFAULT_CWD",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default cwd for new sessions.",
	},
	{
		key: "OMP_DECK_WORKSPACES",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Comma-separated extra workspace roots.",
	},
	{
		key: "OMP_DECK_IDLE_TIMEOUT_MS",
		defaultValue: "300000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Milliseconds before unsubscribed idle sessions are reaped. 0 disables reaping.",
	},
	{
		key: "OMP_DECK_AUTO_START",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Prompt fired automatically when a new session opens. Set to `/start` after creating `~/.omp/agent/commands/start.md`. Leave empty to disable (default).",
	},
	{
		key: "OMP_DECK_WEB_DIST",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Static web bundle directory for production serving.",
	},
	{
		key: "OMP_DECK_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "SQLite database path.",
	},
	{
		key: "OMP_DECK_DB",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Legacy SQLite database path alias. Prefer OMP_DECK_DB_PATH.",
	},
	{
		key: "OMP_DECK_DATA_DIR",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Directory for deck-managed .env and audit log.",
	},
	{
		key: "OMP_DECK_GHOLAM_EXTERNAL_URL",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "External URL the deck web uses to reach the sidecar (e.g. http://localhost:47900). Empty = same-origin.",
	},
	{
		key: "OMP_DECK_GHOLAM_PORT",
		defaultValue: "47900",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Port the Gholam sidecar binds (default 47900). Restart required.",
	},
	{
		key: "OMP_DECK_KB_ROOT",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Knowledge-base root used by the deck and Gholam sidecar.",
	},
	{
		key: "OMP_DECK_PUBLIC_URL",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Public origin this deck is reached on (e.g. https://deck.example.com). Used in onboarding text, agent API hints and OAuth instructions so they stop saying localhost. Serving is same-origin and does not depend on this.",
	},
	{
		key: "OMP_DECK_AUTH_MODE",
		defaultValue: "auto",
		valueType: "enum",
		options: ["auto", "on", "off"],
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description:
			"Require sign-in. `auto` enables it whenever the server is not bound to loopback, or when a password is configured. `off` is ignored on a non-loopback bind.",
	},
	{
		key: "OMP_DECK_AUTH_USERNAME",
		defaultValue: "admin",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Username for the account created from the environment on first boot.",
	},
	{
		key: "OMP_DECK_AUTH_PASSWORD",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description:
			"Bootstrap password, hashed on boot. Re-read on every boot, so changing it resets the account password and signs out every device — the recovery path for a forgotten password. Prefer OMP_DECK_AUTH_PASSWORD_HASH.",
	},
	{
		key: "OMP_DECK_AUTH_PASSWORD_HASH",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description:
			"argon2id digest of the bootstrap password, so no plaintext lives in the environment. Applied only when creating the account.",
	},
	{
		key: "OMP_DECK_AUTH_SETUP_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description:
			"Shared secret required to complete first-run setup. Closes the window where a public deck with no account could be claimed by whoever finds it first.",
	},
	{
		key: "OMP_DECK_AUTH_SESSION_TTL_MS",
		defaultValue: "2592000000",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Session lifetime in milliseconds. Default 30 days.",
	},
	{
		key: "OMP_DECK_AUTH_COOKIE_NAME",
		defaultValue: "omp_deck_session",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Session cookie name. Change it when two decks share one hostname.",
	},
	{
		key: "OMP_DECK_AUTH_SECURE_COOKIE",
		valueType: "boolean",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description:
			"Force the Secure cookie flag. Only needed when TLS terminates upstream and the proxy does not set X-Forwarded-Proto.",
	},
	{
		key: "OMP_DECK_AUTH_MAX_ATTEMPTS",
		defaultValue: "8",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "Failed sign-ins per username+IP before a temporary lockout.",
	},
	{
		key: "OMP_DECK_AUTH_LOCKOUT_MS",
		defaultValue: "900000",
		valueType: "int",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "How long a lockout lasts, in milliseconds. Default 15 minutes.",
	},
	{
		key: "OMP_DECK_TRUSTED_ORIGINS",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description:
			"Comma-separated extra origins allowed to make state-changing requests, beyond the request host and OMP_DECK_PUBLIC_URL.",
	},
	{
		key: "OMP_DECK_API_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description:
			"Bearer token for non-browser callers (agent curl calls, the Telegram bridge, scripts). Generated and persisted in the deck data directory when unset.",
	},
	{
		key: "OMP_DECK_API_BASE",
		defaultValue: "http://127.0.0.1:8787",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: false,
		description: "Loopback API base used by standalone bridge processes. If unset, bridges derive it from OMP_DECK_HOST and OMP_DECK_PORT.",
	},
	{
		key: "OMP_AGENT_DIR",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		hotApply: false,
		description: "omp SDK session/auth data directory.",
	},
	{
		key: "LOG_LEVEL",
		defaultValue: "info",
		valueType: "enum",
		options: ["debug", "info", "warn", "error"],
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Server log threshold.",
	},
	{
		key: "PI_NO_TITLE",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Disable SDK automatic title generation when set truthy.",
	},
	{
		key: "OMP_MODEL",
		valueType: "string",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Default omp SDK model identifier.",
	},
	{
		key: "GITHUB_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: false,
		hotApply: true,
		description:
			"Personal access token powering the GitHub panel in Explorer (list/clone your repos) and authenticated git push/pull for github.com remotes. GITHUB_PERSONAL_ACCESS_TOKEN also works and is shared with the github MCP server if configured.",
	},
	{
		key: "GITHUB_PERSONAL_ACCESS_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "GitHub PAT forwarded to the Gholam sidecar for github MCP calls.",
	},
	{
		key: "MCP_OPENSHIP_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "Token forwarded to the Gholam sidecar for OpenShip MCP calls.",
	},
	{
		key: "MCP_PARALLEL_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "Token forwarded to the Gholam sidecar for Parallel MCP calls.",
	},
	{
		key: "EXA_API_KEY",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "API key forwarded to the Gholam sidecar for Exa MCP calls.",
	},
	{
		key: "TAVILY_API_KEY",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "API key forwarded to the Gholam sidecar for Tavily MCP calls.",
	},
	{
		key: "TELEGRAM_BOT_TOKEN",
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Telegram bot token used by the standalone telegram bridge. Saving it does not start the bridge process.",
	},
	{
		key: "TELEGRAM_ALLOWED_USERS",
		valueType: "string",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Comma-separated numeric Telegram user IDs allowed to DM this bot. Required; usernames are not accepted.",
	},
	{
		key: "TELEGRAM_BRIDGE_DB_PATH",
		valueType: "path",
		sensitive: false,
		restartRequired: true,
		restartTarget: "telegram-bridge",
		hotApply: false,
		description: "Optional SQLite path for Telegram chat-to-session mappings. Defaults to the deck data directory.",
	},
	...[
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"OPENROUTER_API_KEY",
		"GROQ_API_KEY",
		"GOOGLE_API_KEY",
		"XAI_API_KEY",
	].map((key): EnvSchemaEntry => ({
		key,
		valueType: "string",
		sensitive: true,
		restartRequired: true,
		hotApply: false,
		description: "Provider API key used by the omp SDK. Replace only; never revealed in list responses.",
	})),
	{
		key: "OMP_DECK_MAINTENANCE_GATE_DISABLED",
		valueType: "boolean",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Disable the maintenance-gate extension for new sessions when truthy. Honored by the deck (skips setting OMP_DECK_ORG_ROOT) and by the installed extension itself when present.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_OP_MSGS",
		defaultValue: "4",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Floor: operator messages since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_MIN_RELEASE_AGE_MS",
		defaultValue: "480000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms since the last release event before the gate may fire again.",
	},
	{
		key: "OMP_MAINTENANCE_GATE_FIRE_FLOOR_MS",
		defaultValue: "1500000",
		valueType: "int",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description: "Floor: wall-clock ms between consecutive fires (cross-session via disk state).",
	},
	{
		key: "OMP_DECK_ORG_ROOT",
		valueType: "path",
		sensitive: false,
		restartRequired: false,
		hotApply: true,
		description:
			"Deck-session org root the maintenance-gate uses to anchor captures. Set automatically by the server to ~/kb unless overridden or disabled.",
	},
];

export const ENV_SCHEMA_BY_KEY = new Map(ENV_SCHEMA.map((entry) => [entry.key, entry]));

export function validateEnvValue(entry: EnvSchemaEntry, value: string): string | undefined {
	if (entry.valueType === "int") {
		const n = Number.parseInt(value, 10);
		if (!Number.isFinite(n) || String(n) !== value.trim()) return "Expected an integer";
		if (n < 0) return "Expected a non-negative integer";
	}
	if (entry.valueType === "boolean") {
		const lower = value.trim().toLowerCase();
		if (!["", "0", "1", "true", "false", "yes", "no", "on", "off"].includes(lower)) {
			return "Expected on/off, true/false, 1/0, or empty";
		}
	}
	if (entry.valueType === "enum" && entry.options && !entry.options.includes(value.trim())) {
		return `Expected one of: ${entry.options.join(", ")}`;
	}
	return undefined;
}
