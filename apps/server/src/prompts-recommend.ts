/**
 * Prompt recommendation engine.
 *
 * Three signals (project / history / usage) combined into a single corpus,
 * then scored against every prompt via cosine similarity over TF-IDF vectors.
 * Pure TS — no external ML lib. Cheap enough to run on every recommendation
 * request; results cached implicitly via the in-process library + session
 * events (the caller decides whether to dedupe further).
 *
 * #ponytail: hand-rolled tf-idf beats pulling in `natural` / `ml-distance`
 * for a corpus that tops out at a few hundred prompts. Upgrade path: move to
 * a sparse-vector cache when library size crosses ~5k prompts.
 */

import type { Prompt, PromptRecommendation, PromptRecommendationSignal } from "@omp-deck/protocol";

const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have",
	"in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "were",
	"will", "with", "you", "your", "i", "we", "they", "their", "our",
]);

function tokenize(text: string): string[] {
	const out: string[] = [];
	const re = /[a-zA-Z_][\w.-]*/g;
	for (const m of text.toLowerCase().matchAll(re)) {
		const w = m[0];
		if (w.length < 2) continue;
		if (STOPWORDS.has(w)) continue;
		out.push(w);
	}
	return out;
}

function termFreq(tokens: string[]): Map<string, number> {
	const tf = new Map<string, number>();
	for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
	// normalize so document length doesn't dominate
	const n = tokens.length || 1;
	for (const [k, v] of tf) tf.set(k, v / n);
	return tf;
}

function buildIndex(docs: string[]): {
	df: Map<string, number>;
	tfs: Map<string, number>[];
} {
	const df = new Map<string, number>();
	const tfs = docs.map((d) => {
		const tf = termFreq(tokenize(d));
		for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
		return tf;
	});
	return { df, tfs };
}

function vectorize(
	tf: Map<string, number>,
	df: Map<string, number>,
	n: number,
): Map<string, number> {
	const v = new Map<string, number>();
	for (const [term, freq] of tf) {
		const docs = df.get(term) ?? 0;
		if (docs === 0) continue;
		const idf = Math.log(1 + n / docs);
		v.set(term, freq * idf);
	}
	return v;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let dot = 0;
	let na = 0;
	let nb = 0;
	// Iterate the smaller map for fewer lookups.
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	for (const [term, w] of small) {
		const w2 = large.get(term);
		if (w2 !== undefined) dot += w * w2;
		na += w * w;
	}
	for (const w of large.values()) nb += w * w;
	if (na === 0 || nb === 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function topTerms(v: Map<string, number>, k: number): string[] {
	return [...v.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, k)
		.map(([t]) => t);
}

export interface RecommendSignals {
	/** Project-domain terms — file extensions + remote URL hostname + readme topics. */
	projectTerms: string[];
	/** Recent chat history terms — joined from session events. */
	historyTerms: string[];
	/** Per-prompt id with a usage weight (decayed by `e^(-Δdays/30)`). */
	usageWeights: Map<string, number>;
}

export interface RecommendOpts {
	signals: RecommendSignals;
	limit?: number;
}

/**
 * Score every prompt against the combined signals and return the top `limit`.
 * `usageWeights` are folded into the score post-cosine — the tf-idf step is
 * purely lexical so it can't see per-prompt counts directly.
 */
export function recommendPrompts(
	prompts: Prompt[],
	opts: RecommendOpts,
): PromptRecommendation[] {
	const limit = opts.limit ?? 5;
	const { projectTerms, historyTerms, usageWeights } = opts.signals;

	const queryDoc = [...projectTerms, ...historyTerms].join(" ");
	const queryTokens = tokenize(queryDoc);
	if (queryTokens.length === 0) return [];

	// Per-prompt document: title ∪ body ∪ tags. Tags repeat once per tag so
	// the user-tagged terms carry a little more weight than their literal count.
	const docs = prompts.map((p) => {
		const tagPart = (p.tags ?? []).join(" ");
		return `${p.title}\n${tagPart}\n${tagPart}\n${p.body}`;
	});

	const { df, tfs } = buildIndex(docs);
	const n = docs.length + 1;
	const queryTf = termFreq(queryTokens);
	const queryVec = vectorize(queryTf, df, n);

	const results: PromptRecommendation[] = [];
	for (let i = 0; i < prompts.length; i++) {
		const p = prompts[i]!;
		const v = vectorize(tfs[i]!, df, n);
		const base = cosine(queryVec, v);
		const usage = usageWeights.get(p.id) ?? 0;
		// Usage is on a 0–1ish scale; blend small but non-zero.
		const score = base + 0.15 * usage;
		if (score <= 0) continue;
		const matchedSignals: PromptRecommendationSignal[] = [];
		const projMatches = topTerms(v, 20).filter((t) =>
			projectTerms.some((pt) => pt.toLowerCase() === t),
		).length;
		const histMatches = topTerms(v, 20).filter((t) =>
			historyTerms.some((ht) => ht.toLowerCase() === t),
		).length;
		if (projMatches > 0) matchedSignals.push("project");
		if (histMatches > 0) matchedSignals.push("history");
		if (usage > 0) matchedSignals.push("usage");
		const reasons: string[] = [];
		if (projMatches > 0) reasons.push(`${projMatches} project-term match${projMatches === 1 ? "" : "es"}`);
		if (histMatches > 0) reasons.push(`${histMatches} history-term match${histMatches === 1 ? "" : "es"}`);
		if (usage > 0) reasons.push("recently used");
		const why = reasons.length > 0 ? `matches ${reasons.join(" + ")}` : "tag match";
		results.push({ prompt: p, score, why, matchedSignals });
	}
	results.sort((a, b) => b.score - a.score);
	return results.slice(0, limit);
}

/** Decay helper for usage signals. `lastUsedAtMs` may be null. */
export function decayedUsage(p: Prompt, nowMs: number = Date.now()): number {
	if (!p.lastUsedAt) return 0;
	const t = Date.parse(p.lastUsedAt);
	if (Number.isNaN(t)) return 0;
	const days = Math.max(0, (nowMs - t) / (1000 * 60 * 60 * 24));
	const decay = Math.exp(-days / 30);
	return Math.min(1, (p.usageCount / 10) * decay);
}

export function emptySignals(): RecommendSignals {
	return { projectTerms: [], historyTerms: [], usageWeights: new Map() };
}