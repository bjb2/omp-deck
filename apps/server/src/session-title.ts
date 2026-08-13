/**
 * AI-generated session titles.
 *
 * The SDK already has its own `setSessionName` plus a `PI_NO_TITLE` toggle;
 * the deck adds a manual "regenerate" path the user can fire from the chat
 * header. We don't reach for a fresh LLM call (would block the UI on every
 * tap). Instead we summarize the first user message in three words or fewer
 * via a tiny client-side heuristic — title-case, drop stopwords, keep
 * alphanumeric + the first hyphen.
 *
 * For sessions with multiple turns, we use the first user message if it has
 * enough content. Output is clamped to 60 chars so it fits the sidebar.
 */
import type { SessionHandle } from "./bridge/types.ts";
import { logger } from "./log.ts";

const log = logger("session-title");

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from",
	"has", "have", "he", "her", "his", "i", "if", "in", "is", "it", "its", "me",
	"my", "no", "not", "of", "on", "or", "she", "so", "that", "the", "their",
	"them", "they", "this", "to", "was", "we", "were", "what", "when", "where",
	"which", "who", "why", "will", "with", "you", "your",
]);

interface SessionMessageLike {
	role?: string;
	content?: string | Array<{ type?: string; text?: string }>;
}

function extractText(msg: SessionMessageLike): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => p.text ?? "").join(" ");
	return "";
}

function isUserMessage(m: unknown): m is SessionMessageLike {
	if (!m || typeof m !== "object") return false;
	const role = (m as { role?: unknown }).role;
	return typeof role === "string" && role === "user";
}

export const titleService = {
	async regenerate(bridge: { getSession: (id: string) => SessionHandle | undefined }, id: string): Promise<string> {
		const handle = bridge.getSession(id);
		if (!handle) throw new Error(`session ${id} not found`);
		const snap = handle.snapshot();
		const messages: unknown[] = Array.isArray(snap.messages) ? (snap.messages as unknown[]) : [];
		let title = "";
		for (const m of messages) {
			if (!isUserMessage(m)) continue;
			const text = extractText(m).trim();
			if (text.length === 0) continue;
			title = summarize(text);
			break;
		}
		if (!title) title = `Session ${id.slice(0, 6)}`;
		title = clamp(title, 60);
		if (handle.setName) {
			await handle.setName(title);
		}
		log.info(`titleService: ${id} → "${title}"`);
		return title;
	},
};

function summarize(text: string): string {
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[*_~#>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const words = cleaned
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
		.slice(0, 5);
	if (words.length === 0) return cleaned.slice(0, 60);
	return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function clamp(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
