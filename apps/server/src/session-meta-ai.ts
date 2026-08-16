/**
 * AI-generated session metadata service.
 *
 * Produces { title, tags, urgency, importance, status, summary } for a
 * session via a small cheap LLM call. Cached by FNV-1a hash of the input
 * transcript slice so repeat regen is free. Falls back to a 3-keyword
 * heuristic title + empty tags whenever the model is missing, errors out,
 * or returns unparseable JSON — the AI path must never block a session.
 *
 * The cheap default model is `OMP_SESSION_META_MODEL` env, else
 * `minimax/MiniMax-M3` if the registry knows it, else heuristic-only.
 */
import type { SessionImportance, SessionStatus, SessionUrgency } from "@omp-deck/protocol";

import type { AgentBridge, SessionHandle } from "./bridge/types.ts";
import {
	gholamDeckLLM,
	getDeckLLMRegistry,
	type DeckLLMProviderRegistry,
	type LlmChunk,
} from "./llm-registry.ts";
import { nowIso } from "./db/index.ts";
import { isSessionImportance, isSessionStatus, isSessionUrgency, patchSessionMeta } from "./db/session-meta.ts";
import { logger } from "./log.ts";

const log = logger("session-meta-ai");

export interface AiMeta {
	title: string;
	tags: string[];
	urgency: SessionUrgency;
	importance: SessionImportance;
	status: SessionStatus;
	summary: string;
}

export interface SummarizeOpts {
	bridge: AgentBridge;
	sessionId: string;
	/** Bypass the in-process cache. */
	force?: boolean;
	/** Override the default model ref (`provider/id`). Falls back to env, then registry. */
	model?: string;
}

const CACHE_MAX = 500;
const INPUT_CHAR_BUDGET = 6_000;
const TITLE_MAX = 60;
const TAGS_MAX = 5;
const SUMMARY_MAX = 200;

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "do", "for", "from",
	"has", "have", "he", "her", "his", "i", "if", "in", "is", "it", "its", "me",
	"my", "no", "not", "of", "on", "or", "she", "so", "that", "the", "their",
	"them", "they", "this", "to", "was", "we", "were", "what", "when", "where",
	"which", "who", "why", "will", "with", "you", "your",
]);

/** Map of `fingerprint → AiMeta`. Bounded by CACHE_MAX (drop oldest on overflow). */
const cache = new Map<string, AiMeta>();

/** User-rename flag per session id — true once the user has explicitly named the session. */
const userRenamed = new WeakMap<SessionHandle, boolean>();

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

function extractText(m: MessageLike): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) {
		return c
			.map((p) => {
				if (!p || typeof p !== "object" || !("text" in p)) return "";
				const t = (p as { text: unknown }).text;
				return typeof t === "string" ? t : "";
			})
			.join(" ");
	}
	return "";
}

function role(m: unknown): string {
	if (!m || typeof m !== "object") return "";
	const r = (m as { role?: unknown }).role;
	return typeof r === "string" ? r : "";
}

/** Pick the first user message + last two user/assistant messages, truncated. */
function collectInput(snapshot: { messages: unknown[] }): { text: string; firstUser: string } {
	const msgs = Array.isArray(snapshot.messages) ? snapshot.messages : [];
	let firstUser = "";
	const tail: string[] = [];
	for (let i = 0; i < msgs.length; i++) {
		const m = msgs[i];
		const r = role(m);
		const t = extractText(m as MessageLike).trim();
		if (!t) continue;
		if (r === "user" && !firstUser) firstUser = t;
		if (r === "user" || r === "assistant") {
			tail.push(`${r === "user" ? "USER" : "ASSISTANT"}: ${t}`);
		}
	}
	const head = firstUser ? `USER (first): ${firstUser}` : "";
	const tailJoined = tail.slice(-2).join("\n\n");
	const combined = [head, tailJoined].filter(Boolean).join("\n\n");
	return { text: combined.slice(0, INPUT_CHAR_BUDGET), firstUser };
}

/** FNV-1a 32-bit hex. Cheap, stable across runs, good enough for cache keys. */
function fnv1a(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

function remember(key: string, value: AiMeta): void {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, value);
	while (cache.size > CACHE_MAX) {
		const first = cache.keys().next().value;
		if (first === undefined) break;
		cache.delete(first);
	}
}

function clampTitle(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= TITLE_MAX ? t : `${t.slice(0, TITLE_MAX - 1)}…`;
}

function clampSummary(s: string): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length <= SUMMARY_MAX ? t : `${t.slice(0, SUMMARY_MAX - 1)}…`;
}

function heuristicTitle(text: string, sessionId: string): string {
	if (!text) return `Session ${sessionId.slice(0, 6)}`;
	const cleaned = text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/[*_~#>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const words = cleaned
		.split(/\s+/)
		.filter((w) => w.length > 1 && !STOPWORDS.has(w.toLowerCase()))
		.slice(0, 3);
	const phrase = words.length > 0
		? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
		: cleaned.slice(0, TITLE_MAX);
	return clampTitle(phrase || `Session ${sessionId.slice(0, 6)}`);
}

function heuristicStatus(handle: SessionHandle): SessionStatus {
	const snap = handle.snapshot();
	if (snap.isStreaming) return "active";
	if (typeof snap.sessionFile === "string" && snap.sessionFile.length > 0) return "idle";
	return "active";
}

interface RawAi {
	title?: unknown;
	tags?: unknown;
	urgency?: unknown;
	importance?: unknown;
	status?: unknown;
	summary?: unknown;
}

function parseAi(text: string): AiMeta | null {
	const trimmed = text.trim();
	// Strip optional ```json fences some models wrap around the JSON.
	const fenced = trimmed.startsWith("```") ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim() : trimmed;
	let parsed: unknown;
	try {
		parsed = JSON.parse(fenced);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const r = parsed as RawAi;
	if (typeof r.title !== "string") return null;
	if (!isSessionUrgency(r.urgency)) return null;
	if (!isSessionImportance(r.importance)) return null;
	if (!isSessionStatus(r.status)) return null;
	if (typeof r.summary !== "string") return null;
	const tags = Array.isArray(r.tags)
		? (r.tags as unknown[]).filter((t): t is string => typeof t === "string").slice(0, TAGS_MAX)
		: [];
	return {
		title: clampTitle(r.title),
		tags,
		urgency: r.urgency,
		importance: r.importance,
		status: r.status,
		summary: clampSummary(r.summary),
	};
}

async function collectText(stream: AsyncIterable<LlmChunk>): Promise<string> {
	let text = "";
	for await (const chunk of stream) {
		if (chunk.type === "text") text += chunk.delta;
		else if (chunk.type === "error") {
			throw new Error(chunk.error);
		} else if (chunk.type === "done") {
			break;
		}
	}
	return text;
}

async function resolveModelRef(override?: string): Promise<string | null> {
	const envModel = process.env.OMP_SESSION_META_MODEL?.trim();
	const candidates = [override, envModel, "minimax/MiniMax-M3"].filter((x): x is string => !!x && x.length > 0);
	const registry = _registryForTests ?? getDeckLLMRegistry();
	for (const ref of candidates) {
		const [provider, ...rest] = ref.split("/");
		if (!provider || rest.length === 0) continue;
		try {
			const resolved = await registry.resolve({ provider, id: rest.join("/") });
			if (resolved) return `${resolved.provider.id}/${resolved.model.id}`;
		} catch {
			// keep trying
		}
	}
	return null;
}

/** Module-scope test seam — overrides `getDeckLLMRegistry()` for tests. */
let _registryForTests: DeckLLMProviderRegistry | null = null;
export function __setRegistryForTests(reg: DeckLLMProviderRegistry | null): void {
	_registryForTests = reg;
}

const SYSTEM_PROMPT = [
	"You are a session-tagging assistant. Given a short transcript slice, respond with EXACTLY ONE JSON object — no prose, no code fences.",
	"Schema:",
	'{ "title": string (≤60 chars), "tags": string[] (0..5 short kebab-case tokens), "urgency": "low"|"normal"|"high"|"critical", "importance": "low"|"normal"|"high"|"critical", "status": "active"|"idle"|"archived"|"error", "summary": string (≤200 chars) }',
	"Infer urgency/importance from the user's apparent stakes. Pick status=active when the session is mid-turn, idle when it's parked. Reply with JSON only.",
].join("\n");

export const sessionMetaAI = {
	/** For tests: clear the cache + the user-rename map. */
	__resetForTests(): void {
		cache.clear();
	},

	/**
	 * Resolve an `AiMeta` for the given session. Cheap repeat calls return the
	 * cached value. On parse/validation failure the function falls back to a
	 * heuristic title and returns a fully-populated AiMeta — it never throws
	 * to the caller.
	 */
	async summarize(opts: SummarizeOpts): Promise<AiMeta> {
		const handle = opts.bridge.getSession(opts.sessionId);
		if (!handle) {
			return {
				title: `Session ${opts.sessionId.slice(0, 6)}`,
				tags: [],
				urgency: "normal",
				importance: "normal",
				status: "error",
				summary: "",
			};
		}
		const snap = handle.snapshot();
		const { text: input, firstUser } = collectInput(snap);

		const fingerprint = fnv1a(`${opts.sessionId}|${input}`);
		if (!opts.force && cache.has(fingerprint)) {
			const cached = cache.get(fingerprint)!;
			await maybeRename(handle, cached.title);
			return cached;
		}

		const fallbackTitle = heuristicTitle(firstUser, opts.sessionId);
		const fallbackStatus = heuristicStatus(handle);
		const fallback: AiMeta = {
			title: fallbackTitle,
			tags: [],
			urgency: "normal",
			importance: "normal",
			status: fallbackStatus,
			summary: "",
		};

		const modelRef = await resolveModelRef(opts.model);
		if (!modelRef) {
			remember(fingerprint, fallback);
			await maybeRename(handle, fallback.title);
			await persist(opts.sessionId, fallback);
			return fallback;
		}

		let parsed: AiMeta | null = null;
		try {
			const stream = gholamDeckLLM.complete({
				model: modelRef,
				messages: [
					{ role: "system", content: SYSTEM_PROMPT },
					{ role: "user", content: input || "(empty transcript)" },
				],
			});
			const text = await collectText(stream);
			parsed = parseAi(text);
		} catch (err) {
			log.warn(`summarize(${opts.sessionId}) LLM call failed: ${String(err)}`);
			parsed = null;
		}

		const meta: AiMeta = parsed ?? fallback;
		remember(fingerprint, meta);
		await maybeRename(handle, meta.title);
		await persist(opts.sessionId, meta);
		return meta;
	},
};

async function maybeRename(handle: SessionHandle, title: string): Promise<void> {
	if (userRenamed.get(handle)) return;
	const current = handle.snapshot().sessionName ?? "";
	if (current === title) return;
	try {
		await handle.setName(title);
	} catch (err) {
		log.warn(`setName failed for ${handle.sessionId}: ${String(err)}`);
	}
}

async function persist(sessionId: string, meta: AiMeta): Promise<void> {
	try {
		patchSessionMeta(sessionId, {
			aiSummary: meta.summary,
			aiTags: meta.tags,
			aiGeneratedAt: nowIso(),
			urgency: meta.urgency,
			importance: meta.importance,
			status: meta.status,
		});
	} catch (err) {
		log.warn(`persist session meta failed for ${sessionId}: ${String(err)}`);
	}
}