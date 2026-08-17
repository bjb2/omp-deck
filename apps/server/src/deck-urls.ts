/**
 * Where this deck lives, from three different points of view.
 *
 * A self-hosted deck has two addresses that are both correct and not
 * interchangeable, and conflating them is the bug this module exists to
 * prevent:
 *
 *   - The **loopback base** is what code running *inside* the deck's own process
 *     tree uses — the agent's `bash` + `curl`, routine HTTP steps, the Telegram
 *     bridge. It stays `127.0.0.1` even on a public server, because that traffic
 *     never leaves the box.
 *   - The **public URL** is what a *human* types, and what any link the deck
 *     hands out has to use. `127.0.0.1` in a share link, a notification, or a
 *     sign-in instruction is simply wrong once the deck is not on your laptop.
 *
 * Before this existed the deck only knew the first one, so everything it said
 * about itself said `localhost`.
 */
import { loadConfig, normalizePublicUrl } from "./config.ts";

/** The public origin, if configured. Never falls back to a loopback address. */
export function getPublicUrl(): string | undefined {
	return normalizePublicUrl(process.env.OMP_DECK_PUBLIC_URL);
}

/** Loopback API base for in-process callers, honoring a non-default port. */
export function getLoopbackApiBase(): string {
	const port = loadConfig().port;
	return `http://127.0.0.1:${port}/api`;
}

/**
 * The origin to use when building a link for a person: the configured public
 * URL when there is one, otherwise the loopback origin (correct for the laptop
 * case, which is the only case where no public URL is set).
 */
export function getUserFacingOrigin(): string {
	const publicUrl = getPublicUrl();
	if (publicUrl) return publicUrl;
	return `http://127.0.0.1:${loadConfig().port}`;
}

/**
 * How an agent session should call the deck's own API.
 *
 * Returns the loopback base plus, when authentication is on, the bearer header
 * the call needs. Once the gate is enabled an unadorned `curl` gets a 401, and
 * an agent that reads "the API is at 127.0.0.1:8787" without being told about
 * the header will conclude the deck is broken and start debugging the wrong
 * thing.
 */
export function getAgentApiHint(): string {
	const base = getLoopbackApiBase();
	const token = process.env.OMP_DECK_API_TOKEN?.trim();
	if (!token) return `\`${base}\` — reachable from any session via \`bash\` + \`curl\`.`;
	return (
		`\`${base}\` — reachable from any session via \`bash\` + \`curl\`. ` +
		`Authentication is enabled: pass \`-H "Authorization: Bearer $OMP_DECK_API_TOKEN"\` ` +
		`(the variable is already in your environment).`
	);
}

/** A ready-to-paste curl invocation, used in generated documentation. */
export function getAgentCurlExample(path: string): string {
	const base = getLoopbackApiBase();
	const token = process.env.OMP_DECK_API_TOKEN?.trim();
	const auth = token ? ` -H "Authorization: Bearer $OMP_DECK_API_TOKEN"` : "";
	return `curl -s${auth} ${base}${path}`;
}
