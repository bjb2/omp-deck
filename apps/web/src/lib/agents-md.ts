// Client-side helper for the repo-root AGENTS.md.
// Thin wrapper over `agentConfigApi.read('AGENTS.md')` plus pure {{TOKEN}} substitution.
// Server already exposes /api/agent-config/*; no new route needed.
import { agentConfigApi } from "./agent-config-api";

export type AgentsMdVars = Record<string, string>;

export const DEFAULT_AGENTS_MD_VARS: AgentsMdVars = {
	PROJECT: "os-cwd-basename",
	USER_NAME: "whoami",
	FOCUS: "inbox",
	LANG: "en",
	TIMEZONE: "UTC",
	"YYYY-MM-DD": "1970-01-01",
};

/**
 * Replace `{{TOKEN}}` placeholders with values from `vars`.
 * Unknown tokens are left as literals — a typo stays visible.
 * Pure: same input → same output, no I/O.
 * Adding a new placeholder is a one-line change in `DEFAULT_AGENTS_MD_VARS`.
 */
export function resolveAgentsMdVariables(raw: string, vars: AgentsMdVars): string {
 	return raw.replace(/\{\{([A-Z][A-Z0-9_-]*)\}\}/g, (match) => vars[match.slice(2, -2)] ?? match);
}

/**
 * Fetch the AGENTS.md file from the server and substitute variables.
 * Returns the raw file with YAML frontmatter; substitution also fills
 * frontmatter values like `user_name: {{USER_NAME}}`, which is intentional
 * and keeps the file valid YAML.
 * TODO(server): confirm a dedicated /api/agents-md route exists; today we
 *               read through agent-config, which already serves the file.
 */
export async function loadAgentsMd(vars: AgentsMdVars = DEFAULT_AGENTS_MD_VARS): Promise<string> {
	const res = await agentConfigApi.read("AGENTS.md");
	return resolveAgentsMdVariables(res.content, vars);
}
