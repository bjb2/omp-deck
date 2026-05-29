/**
 * Heuristics for detecting placeholder / invalid provider credential values.
 *
 * Motivating bug (issue #4): a user demoed the deck and a viewer clicked
 * `gpt-5`, expecting their ChatGPT Plus subscription to drive the request.
 * Instead OpenAI returned `401 Incorrect API key provided: sk-your-****here`.
 * The literal placeholder `sk-your-...here` had been sitting in their
 * environment (common .env.example value); the SDK saw a non-empty
 * `OPENAI_API_KEY`, marked the openai-provider variant of `gpt-5` as
 * available, and that beat the openai-codex (subscription) variant of the
 * same model name in the picker.
 *
 * `looksLikePlaceholderKey` is what the deck's model-availability layer
 * uses to suppress these false-positive credentials so the picker only
 * surfaces models the user can actually call. It's intentionally
 * conservative — we'd rather hide a few real-but-weird keys than ship a
 * model that 401s on click.
 */

/**
 * Patterns that match values commonly seen in tutorial `.env.example` files
 * or "I'll fill this in later" stubs. Matched case-insensitively against the
 * trimmed value.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
	// `sk-your-XXXXhere`, `sk-your-api-key-here`, ...
	/^sk-your[-_]/i,
	// `sk-XXXXXX`, `sk-XXX...`
	/^sk-x{3,}/i,
	// `your-api-key`, `your_api_key_here`, `YOUR-OPENAI-KEY`, ...
	/^your[-_ ]?(api|openai|anthropic|google|key)/i,
	// `<your-key>`, `<api-key>`, ...
	/^<.*>$/,
	// `changeme`, `change-me`, `change_me`
	/^change[-_ ]?me/i,
	// `example`, `example-key`, `example_value`
	/^example([-_ ]|$)/i,
	// `placeholder`, `placeholder-key`, ...
	/^placeholder/i,
	// `dummy`, `dummy-key`, ...
	/^dummy([-_ ]|$)/i,
	// `test-key`, `testkey`, `test_key` — too short to be a real secret
	/^test[-_]?key/i,
	// Unsubstituted shell variable references: `${OPENAI_API_KEY}`, `$VAR`
	/^\$\{/,
	/^\$[A-Z_][A-Z0-9_]*$/,
	// All-X or all-? values
	/^x+$/i,
	/^\?+$/,
	// All-zero placeholder
	/^0+$/,
];

/**
 * Minimum length for a value that doesn't otherwise look like a placeholder,
 * keyed by recognizable prefix. Real provider keys are well over these
 * bounds; anything shorter is almost certainly a stub.
 */
function minimumReasonableLength(value: string): number {
	if (value.startsWith("sk-ant-")) return 40; // Anthropic keys ~108 chars
	if (value.startsWith("sk-or-")) return 40; // OpenRouter
	if (value.startsWith("sk-")) return 40; // OpenAI ~51 chars
	if (value.startsWith("AIza")) return 30; // Google API keys 39 chars
	if (value.startsWith("xai-")) return 40; // xAI
	if (value.startsWith("gsk_")) return 40; // Groq
	return 16; // Generic floor — narrower would catch real values
}

/**
 * Returns true when `value` is empty or matches a known placeholder pattern.
 * Empty/whitespace counts as a placeholder because the caller treats `true`
 * as "do not advertise this credential as usable."
 */
export function looksLikePlaceholderKey(value: string | undefined | null): boolean {
	if (value === undefined || value === null) return true;
	const v = value.trim();
	if (v.length === 0) return true;
	for (const re of PLACEHOLDER_PATTERNS) {
		if (re.test(v)) return true;
	}
	if (v.length < minimumReasonableLength(v)) return true;
	return false;
}
