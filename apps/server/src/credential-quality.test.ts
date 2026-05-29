import { describe, expect, test } from "bun:test";
import { looksLikePlaceholderKey } from "./credential-quality.ts";

describe("looksLikePlaceholderKey", () => {
	test("treats undefined / null / empty as placeholder", () => {
		expect(looksLikePlaceholderKey(undefined)).toBe(true);
		expect(looksLikePlaceholderKey(null)).toBe(true);
		expect(looksLikePlaceholderKey("")).toBe(true);
		expect(looksLikePlaceholderKey("   ")).toBe(true);
		expect(looksLikePlaceholderKey("\n\t")).toBe(true);
	});

	test("rejects the exact value from issue #4", () => {
		// The literal string OpenAI echoed back in the 401 from the bug report.
		expect(looksLikePlaceholderKey("sk-your-XXXXXXXXXXXXXXXXhere")).toBe(true);
		expect(looksLikePlaceholderKey("sk-your-api-key-here")).toBe(true);
	});

	test("rejects common .env.example placeholders", () => {
		const cases = [
			"sk-XXXXXXXXXXXXXXXX",
			"sk-XXX",
			"your-api-key",
			"your_api_key_here",
			"YOUR-OPENAI-KEY",
			"<your-anthropic-key>",
			"<api-key>",
			"changeme",
			"change-me",
			"change_me",
			"CHANGEME",
			"example",
			"example-key",
			"example_value",
			"placeholder",
			"placeholder-token",
			"dummy",
			"dummy-key",
			"test-key",
			"testkey",
			"${OPENAI_API_KEY}",
			"$OPENAI_API_KEY",
			"xxx",
			"XXXXXX",
			"?????",
			"00000000000000000000",
		];
		for (const c of cases) {
			expect(looksLikePlaceholderKey(c)).toBe(true);
		}
	});

	test("rejects keys that are too short to be real for their family", () => {
		expect(looksLikePlaceholderKey("sk-short")).toBe(true); // OpenAI floor 40
		expect(looksLikePlaceholderKey("sk-ant-short")).toBe(true); // Anthropic floor 40
		expect(looksLikePlaceholderKey("AIza-short")).toBe(true); // Google floor 30
		expect(looksLikePlaceholderKey("xai-short")).toBe(true); // xAI floor 40
		expect(looksLikePlaceholderKey("gsk_short")).toBe(true); // Groq floor 40
	});

	test("accepts realistic-looking keys", () => {
		// Realistic-shape values (random, not real). We accept anything that's
		// the right shape and length for its prefix family.
		expect(
			looksLikePlaceholderKey(
				"sk-proj-Ab9cD3fGh2jKl4mNo5pQr6sTu7vWx8yZ0a1bC2dE3fG4hI5jK6lM7nO8pQ9r",
			),
		).toBe(false);
		expect(
			looksLikePlaceholderKey(
				"sk-ant-api03-aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4cD5eF6gH7iJ8kL9mN0o-AbCdEf",
			),
		).toBe(false);
		expect(looksLikePlaceholderKey("AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUv")).toBe(false);
		expect(
			looksLikePlaceholderKey("gsk_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj"),
		).toBe(false);
		// Generic 32+ char hex token (no recognizable prefix)
		expect(
			looksLikePlaceholderKey("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
		).toBe(false);
	});

	test("accepts OAuth bearer tokens with the standard JWT-ish shape", () => {
		// OAuth tokens stored in env (e.g. OPENAI_CODEX_OAUTH_TOKEN) are
		// typically long base64-ish blobs. Make sure we don't false-positive.
		expect(
			looksLikePlaceholderKey(
				"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
			),
		).toBe(false);
	});
});
