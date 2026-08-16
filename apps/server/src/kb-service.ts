/**
 * KB Cockpit backend.
 *
 * Walks the user's Karpathy-style llm-wiki at `~/kb` (or `OMP_DECK_KB_ROOT`),
 * caches an inventory of every reachable markdown file, and resolves
 * `[[wikilinks]]` against it. The deck cockpit's `/kb` view + graph view
 * consume the output of this service.
 *
 * Design highlights (per docs/proposals/kb-cockpit.md):
 * - Top-level skip set matches orphan-census.py's conventions, PLUS the
 *   user-approved `projects/` exclusion. Mixed-signal projects/ tree stays
 *   out of v1.
 * - Symlinks/junctions (e.g. `cryptocracy/`) are followed once, by tracking
 *   visited absolute paths to break cycles.
 * - Wikilink resolution is stem-first with subpath fallback; code blocks
 *   are stripped before extraction so regex-literal noise (`[[:alpha:]]`)
 *   doesn't leak into the link table.
 * - YAML frontmatter parsing uses the `yaml` package — kb files have real
 *   arrays / nested objects and a header-grep approach is insufficient.
 *
 * The service is read-only at v1; T-36 introduces PUT/POST. The watcher
 * (T-34 bottom) fires `kb_changed` on any mutation so subsequent reads see
 * fresh data after `rebuildIndex()` is called by the watcher.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import YAML from "yaml";

import type {
	KbBacklink,
	KbBacklinksResponse,
	KbFileResponse,
	KbGraphEdge,
	KbGraphNode,
	KbGraphResponse,
	KbTreeEntry,
	KbTreeResponse,
	KbWikilink,
	KbSearchMatchKind,
	KbSearchResponse,
	KbSearchResult,
} from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { atomicWriteSync } from "./env-store.ts";

const log = logger("kb");

// Top-level (anywhere in the tree) directory names to skip. Mirrors the
// canonical set in my-org-new/scripts/orphan-census.py — vendor-noise
// directories that nobody wants in a knowledge graph. To add your own
// (e.g. a personal `drafts/` folder, a `private/` subtree), set
// `OMP_DECK_KB_EXCLUDE_DIRS` to a comma-separated list and restart.
//
// The list is intentionally minimal by default: omp-deck shows your kb the
// way you organized it on disk. If you want to keep a directory out of the
// cockpit (e.g. it's full of vendor markdown or a checked-in node_modules),
// either add it to the env override below or rely on the built-in
// vendor-noise filter (which already catches .venv, node_modules, etc).
const SKIP_DIR_NAMES = new Set<string>([
	".git",
	".github",
	"node_modules",
	"target",
	".venv",
	"venv",
	"__pycache__",
	"dist",
	"build",
	".next",
	".nuxt",
	".idea",
	".vscode",
	...parseExcludeDirsFromEnv(),
]);

function parseExcludeDirsFromEnv(): string[] {
	const raw = process.env.OMP_DECK_KB_EXCLUDE_DIRS;
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

// Skill-creator and related .agents/skills dirs we don't want surfaced.
const SKIP_PATH_FRAGMENTS = [".agents/skills"];

// Ambiguous stems that should never resolve by stem-match alone. Force the
// author to use a subpath. Mirrors orphan-census.py's `AMBIGUOUS_STEMS`.
const AMBIGUOUS_STEMS = new Set<string>([
	"readme",
	"index",
	"profile",
	"skill",
	"summary",
	"notes",
]);

// Search match kinds, ranked by precedence. Lower rank = stronger match.
// Used to pick the "best" kind to show in the result UI when a file
// matches multiple ways.
const KIND_RANK: Record<KbSearchMatchKind, number> = {
	stem: 0,
	title: 1,
	tag: 2,
	body: 3,
};

/**
 * Build a single-line snippet centered on a body match. Avoids walking
 * across line boundaries so the snippet reads cleanly even when the hit
 * is mid-paragraph. Capped at SNIPPET_WIDTH chars with ellipsis on either
 * side.
 */
function makeSnippet(text: string, matchIdx: number, matchLen: number): string {
	const SNIPPET_WIDTH = 160;
	const lineStart = Math.max(0, text.lastIndexOf("\n", matchIdx) + 1);
	const lineEnd = text.indexOf("\n", matchIdx);
	const end = lineEnd === -1 ? text.length : lineEnd;
	const line = text.slice(lineStart, end);
	if (line.length <= SNIPPET_WIDTH) return line.trim();
	const relIdx = matchIdx - lineStart;
	const half = Math.floor((SNIPPET_WIDTH - matchLen) / 2);
	const from = Math.max(0, relIdx - half);
	const to = Math.min(line.length, from + SNIPPET_WIDTH);
	const prefix = from > 0 ? "…" : "";
	const suffix = to < line.length ? "…" : "";
	return (prefix + line.slice(from, to) + suffix).trim();
}
// Wikilink: `[[target|label]]`. Target may include `dir/path` and `#anchor`.
// We deliberately exclude `]` and `|` from the target capture so labels work.
const WIKILINK_RE = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;

// Fenced code blocks and inline backtick spans — wikilinks inside them are
// almost always documentation/regex noise (`[[:alpha:]]`), not real links.
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

// Cap the graph payload at v1 so a runaway kb doesn't blow the wire. Sized
// generously for the current ~600-node kb with headroom for several years
// of growth. Bumping this is safe; the UI surfaces a `truncated` warning.
const GRAPH_MAX_NODES = 10_000;

interface GraphCache {
	nodes: KbGraphNode[];
	edges: KbGraphEdge[];
	backlinks: Map<string, KbBacklink[]>;
	unresolvedCount: number;
}
interface FileRecord {
	relPath: string; // forward-slash kb-relative
	absPath: string;
	dir: string; // forward-slash relative dir, "" for root
	stem: string; // lowercase filename stem (no .md)
	size: number;
	mtime: Date;
}

export interface KbServiceOptions {
	root: string;
}

export class KbService {
	readonly root: string;
	private records: FileRecord[] = [];
	private byRelPath = new Map<string, FileRecord>();
	private byStem = new Map<string, FileRecord[]>();
	private indexReady = false;
	private indexPromise: Promise<void> | undefined;
	private graphCache: GraphCache | undefined;

	constructor(opts: KbServiceOptions) {
		// Always store the root as an absolute path with native separators.
		this.root = path.resolve(opts.root);
	}

	/** Lazy build on first request; subsequent calls reuse the cache. */
	async ensureIndex(): Promise<void> {
		if (this.indexReady) return;
		if (this.indexPromise) return this.indexPromise;
		this.indexPromise = this.buildIndex();
		try {
			await this.indexPromise;
		} finally {
			this.indexPromise = undefined;
		}
	}

	/** Invalidate cache + rebuild on next request. Called by the watcher. */
	invalidate(): void {
		this.indexReady = false;
		this.graphCache = undefined;
	}

	/**
	 * Bootstrap status for the welcome panel: does the kb root exist, and
	 * how many indexed files does it have? An empty/missing kb triggers the
	 * "Create starter kb" CTA in the web UI.
	 */
	async getStatus(): Promise<{ root: string; exists: boolean; fileCount: number }> {
		await this.ensureIndex();
		return {
			root: this.root,
			exists: existsSync(this.root),
			fileCount: this.records.length,
		};
	}

	/**
	 * Create the kb root (if missing) and write a starter README.md. Refuses
	 * to clobber: if the root already has indexed markdown content, the call
	 * no-ops and returns the existing status. Otherwise scaffolds README.md
	 * and rebuilds the index so the UI sees it on the next read.
	 */
	async initialize(): Promise<{
		root: string;
		exists: boolean;
		fileCount: number;
		created: boolean;
		refusedReason?: string;
	}> {
		const beforeExists = existsSync(this.root);
		if (beforeExists) {
			await this.ensureIndex();
			if (this.records.length > 0) {
				return {
					root: this.root,
					exists: true,
					fileCount: this.records.length,
					created: false,
					refusedReason: "kb root already has content; init is a no-op",
				};
			}
		}

		try {
			await mkdir(this.root, { recursive: true });
		} catch (err) {
			log.error(`mkdir failed at ${this.root}`, err);
			throw err;
		}
		const readme = path.join(this.root, "README.md");
		if (!existsSync(readme)) {
			const today = new Date().toISOString().slice(0, 10);
			await writeFile(readme, renderStarterReadme(today), "utf8");
		}

		this.invalidate();
		await this.ensureIndex();
		return {
			root: this.root,
			exists: true,
			fileCount: this.records.length,
			created: true,
		};
	}

	/**
	 * Return a single directory listing. `subpath` is forward-slash relative
	 * to the kb root; empty / "/" means root. Returns `undefined` if the
	 * path doesn't exist or escapes the kb root.
	 */
	async getTree(subpath: string = ""): Promise<KbTreeResponse | undefined> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		// Reject traversal into any path whose segments include an excluded
		// directory — keeps `/api/kb/tree?path=projects` 404 even though
		// `projects` exists on disk.
		if (this.pathIsExcluded(cleanRel)) return undefined;
		const absDir = this.resolveAbs(cleanRel);
		if (!absDir) return undefined;
		try {
			const st = await stat(absDir);
			if (!st.isDirectory()) return undefined;
		} catch {
			return undefined;
		}

		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch (err) {
			log.warn(`readdir failed at ${absDir}`, err);
			return { path: cleanRel, dirs: [], files: [] };
		}

		const dirs: KbTreeEntry[] = [];
		const files: KbTreeEntry[] = [];
		for (const entry of entries) {
			if (this.shouldSkip(entry.name, joinRel(cleanRel, entry.name))) continue;
			const relPath = joinRel(cleanRel, entry.name);
			const abs = path.join(absDir, entry.name);

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				let isDir = entry.isDirectory();
				let isSymlink = entry.isSymbolicLink();
				if (isSymlink) {
					try {
						const st = await stat(abs); // follows
						isDir = st.isDirectory();
					} catch {
						continue;
					}
				}
				if (!isDir) continue;
				const mdCount = this.recursiveMdCount(relPath);
				const item: KbTreeEntry = {
					name: entry.name,
					path: relPath,
					kind: "dir",
					mdCount,
				};
				if (isSymlink) item.symlink = true;
				dirs.push(item);
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;
			let st;
			try {
				st = await stat(abs);
			} catch {
				continue;
			}
			files.push({
				name: entry.name,
				path: relPath,
				kind: "file",
				size: st.size,
				mtime: st.mtime.toISOString(),
			});
		}

		// Stable ordering: dirs by name asc; files by name asc. Future: surface
		// hubs first within a dir — out of v1.
		dirs.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));
		return { path: cleanRel, dirs, files };
	}

	/**
	 * Read a single file's parsed body. `subpath` is forward-slash
	 * relative; must end in `.md` (caller usually clicked a tree entry).
	 * Returns undefined when the path is missing, isn't a file, or escapes
	 * the kb root.
	 */
	async getFile(subpath: string): Promise<KbFileResponse | undefined> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		if (!cleanRel) return undefined;
		if (this.pathIsExcluded(cleanRel)) return undefined;
		const abs = this.resolveAbs(cleanRel);
		if (!abs) return undefined;

		let raw: string;
		let st;
		try {
			st = await stat(abs);
			if (!st.isFile()) return undefined;
			raw = await readFile(abs, "utf8");
		} catch {
			return undefined;
		}

		const { frontmatter, frontmatterError, body } = parseFrontmatter(raw);
		const sourceDir = path.posix.dirname(cleanRel);
		const outgoingLinks = this.extractWikilinks(body, sourceDir === "." ? "" : sourceDir);
		const bodyForRender = this.rewriteBodyForRender(body, sourceDir === "." ? "" : sourceDir);

		const resp: KbFileResponse = {
			path: cleanRel,
			absolutePath: abs,
			frontmatter,
			body,
			rawContent: raw,
			bodyForRender,
			outgoingLinks,
			size: st.size,
			mtime: st.mtime.toISOString(),
		};
		if (frontmatterError) resp.frontmatterError = frontmatterError;
		return resp;
	}

	/**
	 * Atomic write at `subpath`. `mode` controls the create-vs-update
	 * semantics:
	 *  - "update" (PUT): destination must already exist. Returns
	 *    `{ kind: "not-found" }` otherwise.
	 *  - "create" (POST): destination must NOT exist. Returns
	 *    `{ kind: "conflict" }` otherwise. Creates parent dirs.
	 *
	 * Frontmatter is validated by re-running parseFrontmatter on the incoming
	 * content. Invalid YAML returns `{ kind: "invalid-frontmatter", message }`
	 * so the editor can surface the parser's complaint. Writes go through a
	 *    temp + writeFile + fsync + rename pair (the shared `atomicWriteSync`
	 *    helper from env-store.ts) so concurrent reads never see a half-written
	 *    file and a crash mid-write leaves the previous contents intact.
	 */
	async saveFile(
		subpath: string,
		content: string,
		mode: "update" | "create",
	): Promise<
		| { kind: "ok"; response: KbFileResponse }
		| { kind: "not-found" }
		| { kind: "conflict" }
		| { kind: "invalid-path" }
		| { kind: "invalid-frontmatter"; message: string }
	> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		if (!cleanRel) return { kind: "invalid-path" };
		if (this.pathIsExcluded(cleanRel)) return { kind: "invalid-path" };
		const abs = this.resolveAbs(cleanRel);
		if (!abs) return { kind: "invalid-path" };
		if (!cleanRel.toLowerCase().endsWith(".md")) return { kind: "invalid-path" };

		// Frontmatter validation: if the content claims a frontmatter block,
		// it has to be parseable YAML before we'll write.
		const { frontmatterError } = parseFrontmatter(content);
		if (frontmatterError) return { kind: "invalid-frontmatter", message: frontmatterError };

		const exists = existsSync(abs);
		if (mode === "update" && !exists) return { kind: "not-found" };
		if (mode === "create" && exists) return { kind: "conflict" };

		// Ensure parent dir exists for create. Update is a no-op since the
		// existence check above guarantees the dir.
		if (mode === "create") {
			const parent = path.dirname(abs);
			try {
				await mkdir(parent, { recursive: true });
			} catch (err) {
				log.error(`mkdir failed at ${parent}`, err);
				return { kind: "invalid-path" };
			}
		}

		// Durability: routed through atomicWriteSync from env-store.ts so
		// every user-writable surface (kb, env, session pins, custom
		// providers, the gholam token) goes through one tmp+fsync+rename
		// implementation. Concurrent readers never see a half-written file;
		// the tmp is fsync'd before the rename, so a crash leaves either the
		// old contents or the new contents — never a torn write. Single-drive
		// assumption (rename across drives would fail; decision 4 rationale).
		try {
			await atomicWriteSync(abs, content);
		} catch (err) {
			log.error(`atomic save failed at ${abs}`, err);
			throw err;
		}

		// Force a fresh index next read so the new file (or new content)
		// affects wikilink resolution everywhere. The watcher will also fire
		// but we don't want to race it.
		this.invalidate();

		const response = await this.getFile(cleanRel);
		if (!response) {
			// Shouldn't happen — we just wrote it — but guard anyway.
			return { kind: "invalid-path" };
		}
		return { kind: "ok", response };
	}

	/**
	 * Full wiki-link graph + frontmatter-tag aggregation. Built lazily on
	 * first request and cached until the watcher invalidates the index. For
	 * the v1 scale (~600 visible nodes) the build cost is dominated by file
	 * reads — runs in under a second even cold.
	 *
	 * Caps the response at GRAPH_MAX_NODES; sets `truncated: true` when the
	 * cap fires so the UI can warn the user.
	 */
	async getGraph(): Promise<KbGraphResponse> {
		await this.ensureIndex();
		if (!this.graphCache) {
			this.graphCache = await this.buildGraph();
		}
		return shapeGraphResponse(this.graphCache);
	}

	async getBacklinks(subpath: string): Promise<KbBacklinksResponse | undefined> {
		await this.ensureIndex();
		const cleanRel = normalizeRel(subpath);
		if (!cleanRel) return undefined;
		if (this.pathIsExcluded(cleanRel)) return undefined;
		if (!this.byRelPath.has(cleanRel)) return undefined;
		if (!this.graphCache) {
			this.graphCache = await this.buildGraph();
		}
		const backlinks = this.graphCache.backlinks.get(cleanRel) ?? [];
		return { path: cleanRel, backlinks };
	}

	/**
	 * Hybrid scored search across the indexed kb. Cheap enough at v1 scale
	 * (~1k files) to run end-to-end on every request; we don't pre-build an
	 * inverted index yet. Scoring layers:
	 *
	 *   stem   filename matches the query (100 exact, 80 prefix, 60 contains)
	 *   title  frontmatter `name` matches (60 exact, 40 prefix, 25 contains)
	 *   tag    one of `frontmatter.tags` matches (50 exact, 20 contains)
	 *   body   substring hit in the body (10 base + 1 per extra hit, capped)
	 *
	 * Body matches read each file once (this can grow expensive — at 1k
	 * files of 9KB avg that's 9MB which still runs in ~50ms cold; we'll
	 * revisit if the kb grows past 5k or queries get hammered). The first
	 * body hit is centered into a 160-char snippet.
	 */
	async search(query: string, limit: number): Promise<KbSearchResponse> {
		await this.ensureIndex();
		const q = query.trim().toLowerCase();
		if (!q) return { query, results: [], totalMatches: 0, truncated: false };
		const cap = Math.max(1, Math.min(limit | 0 || 20, 100));

		type Acc = { score: number; matchKind: KbSearchMatchKind; snippet: string };
		const scored = new Map<string, Acc>();

		const bump = (relPath: string, score: number, kind: KbSearchMatchKind, snippet: string): void => {
			const prev = scored.get(relPath);
			if (!prev) {
				scored.set(relPath, { score, matchKind: kind, snippet });
				return;
			}
			prev.score += score;
			// Promote to a stronger match kind if this one outranks the existing.
			if (KIND_RANK[kind] < KIND_RANK[prev.matchKind]) {
				prev.matchKind = kind;
			}
			if (!prev.snippet && snippet) prev.snippet = snippet;
		};

		// Pass 1 — stem / title / tag against the cached index. No disk reads.
		for (const r of this.records) {
			const stem = r.stem; // already lowercased
			if (stem === q) bump(r.relPath, 100, "stem", "");
			else if (stem.startsWith(q)) bump(r.relPath, 80, "stem", "");
			else if (stem.includes(q)) bump(r.relPath, 60, "stem", "");
		}

		// Pass 2 — title (frontmatter.name) and tags via the graph cache nodes.
		if (!this.graphCache) this.graphCache = await this.buildGraph();
		for (const node of this.graphCache.nodes) {
			const title = node.title.toLowerCase();
			if (title === q) bump(node.path, 60, "title", "");
			else if (title.startsWith(q)) bump(node.path, 40, "title", "");
			else if (title.includes(q)) bump(node.path, 25, "title", "");
			for (const tag of node.tags) {
				const t = tag.toLowerCase();
				if (t === q) bump(node.path, 50, "tag", "");
				else if (t.includes(q)) bump(node.path, 20, "tag", "");
			}
		}

		// Pass 3 — body substring with snippet. Sequential reads (parallel
		// here doesn't help much: the index is already in OS page cache from
		// the graph build).
		for (const r of this.records) {
			let raw: string;
			try {
				raw = await readFile(r.absPath, "utf8");
			} catch {
				continue;
			}
			const lc = raw.toLowerCase();
			const first = lc.indexOf(q);
			if (first < 0) continue;
			// Count additional hits (capped) for tiebreak signal.
			let extra = 0;
			let cursor = lc.indexOf(q, first + q.length);
			while (cursor >= 0 && extra < 20) {
				extra += 1;
				cursor = lc.indexOf(q, cursor + q.length);
			}
			const snippet = makeSnippet(raw, first, q.length);
			bump(r.relPath, 10 + extra, "body", snippet);
		}

		// Materialize results sorted by score desc, then path asc for stability.
		const all: KbSearchResult[] = [];
		for (const [relPath, acc] of scored) {
			const record = this.byRelPath.get(relPath);
			if (!record) continue;
			const node = this.graphCache?.nodes.find((n) => n.path === relPath);
			const dir = record.dir.split("/")[0] ?? "";
			all.push({
				path: relPath,
				title: node?.title ?? record.stem,
				dir,
				score: acc.score,
				matchKind: acc.matchKind,
				snippet: acc.snippet,
			});
		}
		all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
		const truncated = all.length > cap;
		const results = truncated ? all.slice(0, cap) : all;
		return { query, results, totalMatches: all.length, truncated };
	}

	/**
	 * Walk every record, parse its body, extract wikilinks, build:
	 *   - nodes[]: one per file with degree counts + tags
	 *   - edges[]: one per resolved wikilink (deduplicated per source+target pair)
	 *   - backlinks: target → KbBacklink[]
	 *
	 * Unresolved wikilinks bump the global counter only; they don't get a
	 * placeholder node (the UI can prompt-create via the existing flow).
	 */
	private async buildGraph(): Promise<GraphCache> {
		const t0 = performance.now();
		const nodes = new Map<string, KbGraphNode>();
		const edges: KbGraphEdge[] = [];
		const backlinks = new Map<string, KbBacklink[]>();
		const edgeSeen = new Set<string>();
		let unresolvedCount = 0;

		// Pass 1: seed nodes (so unreached files still appear as orphans).
		for (const r of this.records) {
			const dir = r.dir.split("/")[0] ?? "";
			nodes.set(r.relPath, {
				id: r.relPath,
				path: r.relPath,
				title: r.stem,
				dir,
				inbound: 0,
				outbound: 0,
				tags: [],
			});
		}

		// Pass 2: read each file in parallel batches, parse frontmatter (for
		// tags + title), extract wikilinks. Chunked at 32 to avoid opening
		// too many fds on Windows where ENFILE shows up around 200+. At v1
		// scale (805 files) this brings cold build from ~10s down to ~1s.
		const CHUNK = 32;
		for (let i = 0; i < this.records.length; i += CHUNK) {
			const chunk = this.records.slice(i, i + CHUNK);
			const reads = await Promise.all(
				chunk.map((r) =>
					readFile(r.absPath, "utf8").then(
						(raw) => ({ r, raw }),
						() => ({ r, raw: undefined as string | undefined }),
					),
				),
			);
			for (const { r, raw } of reads) {
				if (raw === undefined) continue;
			const { frontmatter, body } = parseFrontmatter(raw);
			const node = nodes.get(r.relPath);
			if (!node) continue;
			if (typeof frontmatter.name === "string" && (frontmatter.name as string).trim()) {
				node.title = (frontmatter.name as string).trim();
			}
			if (Array.isArray(frontmatter.tags)) {
				node.tags = (frontmatter.tags as unknown[]).filter((t): t is string => typeof t === "string");
			}

			const sourceDir = r.dir;
			const wikilinks = this.extractWikilinks(body, sourceDir);
			for (const wl of wikilinks) {
				if (!wl.resolved) {
					unresolvedCount += 1;
					continue;
				}
				const key = `${r.relPath}\0${wl.resolved}`;
				if (edgeSeen.has(key)) continue;
				edgeSeen.add(key);
				edges.push({ source: r.relPath, target: wl.resolved });
				node.outbound += 1;
				const targetNode = nodes.get(wl.resolved);
				if (targetNode) targetNode.inbound += 1;

				const list = backlinks.get(wl.resolved) ?? [];
				list.push({
					source: r.relPath,
					label: wl.label,
					snippet: extractSnippet(body, wl.raw),
				});
				backlinks.set(wl.resolved, list);
			}
			}
		}

		const ms = (performance.now() - t0).toFixed(1);
		log.info(`built kb graph: ${nodes.size} nodes, ${edges.length} edges, ${unresolvedCount} unresolved (${ms}ms)`);
		return {
			nodes: Array.from(nodes.values()),
			edges,
			backlinks,
			unresolvedCount,
		};
	}
	// ─── internals ───────────────────────────────────────────────────────

	private async buildIndex(): Promise<void> {
		const t0 = performance.now();
		this.records = [];
		this.byRelPath.clear();
		this.byStem.clear();

		if (!existsSync(this.root)) {
			log.warn(`kb root does not exist: ${this.root}`);
			this.indexReady = true;
			return;
		}

		const visited = new Set<string>();
		await this.walk(this.root, "", visited);

		for (const r of this.records) {
			this.byRelPath.set(r.relPath, r);
			const list = this.byStem.get(r.stem);
			if (list) list.push(r);
			else this.byStem.set(r.stem, [r]);
		}

		const ms = (performance.now() - t0).toFixed(1);
		log.info(`indexed ${this.records.length} md files under ${this.root} in ${ms}ms`);
		this.indexReady = true;
	}

	private async walk(absDir: string, relDir: string, visited: Set<string>): Promise<void> {
		let real;
		try {
			real = await realpath(absDir);
		} catch {
			return;
		}
		if (visited.has(real)) return;
		visited.add(real);

		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch (err) {
			log.warn(`readdir failed: ${absDir}`, err);
			return;
		}

		for (const entry of entries) {
			const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
			if (this.shouldSkip(entry.name, rel)) continue;
			const abs = path.join(absDir, entry.name);

			if (entry.isDirectory() || entry.isSymbolicLink()) {
				try {
					const st = await stat(abs);
					if (st.isDirectory()) {
						await this.walk(abs, rel, visited);
					}
				} catch {
					// stat failure on symlink target; skip silently
				}
				continue;
			}

			if (!entry.isFile()) continue;
			if (!entry.name.toLowerCase().endsWith(".md")) continue;

			try {
				const st = await stat(abs);
				const stem = entry.name.slice(0, -3).toLowerCase();
				this.records.push({
					relPath: rel,
					absPath: abs,
					dir: relDir,
					stem,
					size: st.size,
					mtime: st.mtime,
				});
			} catch {
				// best-effort
			}
		}
	}

	private shouldSkip(name: string, rel: string): boolean {
		if (SKIP_DIR_NAMES.has(name)) return true;
		for (const frag of SKIP_PATH_FRAGMENTS) {
			if (rel.includes(frag)) return true;
		}
		return false;
	}

	private pathIsExcluded(rel: string): boolean {
		if (!rel) return false;
		for (const seg of rel.split("/")) {
			if (SKIP_DIR_NAMES.has(seg)) return true;
		}
		for (const frag of SKIP_PATH_FRAGMENTS) {
			if (rel.includes(frag)) return true;
		}
		return false;
	}

	private resolveAbs(rel: string): string | undefined {
		// Reject any rel that escapes the root via `..` or absolute paths.
		if (rel.includes("..") || path.isAbsolute(rel)) return undefined;
		const abs = rel ? path.join(this.root, rel) : this.root;
		const resolved = path.resolve(abs);
		const rootResolved = path.resolve(this.root);
		if (!resolved.startsWith(rootResolved)) return undefined;
		return resolved;
	}

	private recursiveMdCount(relDir: string): number {
		// Cheap O(n) scan against the cached index. n ~ 600 for this kb.
		if (!relDir) return this.records.length;
		const prefix = `${relDir}/`;
		let n = 0;
		for (const r of this.records) {
			if (r.relPath.startsWith(prefix)) n++;
		}
		return n;
	}

	private extractWikilinks(body: string, sourceDir: string): KbWikilink[] {
		const stripped = body.replace(FENCED_CODE_RE, "").replace(INLINE_CODE_RE, "");
		const out: KbWikilink[] = [];
		for (const m of stripped.matchAll(WIKILINK_RE)) {
			const rawTargetMatch = m[1];
			if (rawTargetMatch === undefined) continue;
			const rawTarget = rawTargetMatch.trim();
			const label = (m[2] ?? rawTarget).trim();
			let target = rawTarget;
			let anchor: string | null = null;
			const hashAt = target.indexOf("#");
			if (hashAt >= 0) {
				anchor = target.slice(hashAt + 1) || null;
				target = target.slice(0, hashAt);
			}
			target = target.trim();
			const raw = m[2] !== undefined ? `${target}${anchor ? `#${anchor}` : ""}|${label}` : `${target}${anchor ? `#${anchor}` : ""}`;
			const link: KbWikilink = {
				raw,
				target,
				label,
				anchor,
				resolved: null,
			};
			if (!target) {
				link.unresolvedReason = "no-match";
				out.push(link);
				continue;
			}
			const resolution = this.resolveTarget(target, sourceDir);
			if (resolution.resolved) {
				link.resolved = resolution.resolved;
			} else {
				link.unresolvedReason = resolution.reason;
			}
			out.push(link);
		}
		return out;
	}

	/**
	 * Replace `[[name|label]]` syntax with markdown links the web client
	 * renders via its custom `a` component. Resolved → `[label](kb-link:<path>?anchor=<a>)`;
	 * unresolved → `[label](kb-unresolved:<target>)`. Wikilinks inside fenced
	 * code blocks or inline backtick spans are NOT rewritten — they're noise
	 * (e.g. regex literals like `[[:alpha:]]`).
	 */
	private rewriteBodyForRender(body: string, sourceDir: string): string {
		// Walk the body marking code-block ranges so we can skip them. A single
		// linear pass is plenty for the scale we see (~9KB per file).
		const codeRanges = collectCodeRanges(body);
		let out = "";
		let cursor = 0;
		const re = /\[\[([^\]|\n]+?)(?:\|([^\]\n]+?))?\]\]/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(body)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			// Emit the body up to this match.
			out += body.slice(cursor, start);
			cursor = end;
			if (insideAnyRange(codeRanges, start)) {
				out += m[0]; // leave wikilinks inside code blocks alone
				continue;
			}
			const rawTargetMatch = m[1];
			if (rawTargetMatch === undefined) continue;
			const rawTarget = rawTargetMatch.trim();
			const labelRaw = (m[2] ?? rawTarget).trim();
			let target = rawTarget;
			let anchor: string | null = null;
			const hashAt = target.indexOf("#");
			if (hashAt >= 0) {
				anchor = target.slice(hashAt + 1) || null;
				target = target.slice(0, hashAt);
			}
			target = target.trim();
			const safeLabel = labelRaw.replace(/[\[\]]/g, "");
			if (!target) {
				out += `[${safeLabel}](kb-unresolved:)`;
				continue;
			}
			const { resolved } = this.resolveTarget(target, sourceDir);
			if (resolved) {
				const q = anchor ? `?anchor=${encodeURIComponent(anchor)}` : "";
				out += `[${safeLabel}](kb-link:${encodeURI(resolved)}${q})`;
			} else {
				out += `[${safeLabel}](kb-unresolved:${encodeURIComponent(target)})`;
			}
		}
		out += body.slice(cursor);
		return out;
	}

	private resolveTarget(
		target: string,
		sourceDir: string,
	): { resolved: string | null; reason?: KbWikilink["unresolvedReason"] } {
		const normalized = target.replace(/\\/g, "/").replace(/^\/+/, "");
		// Subpath form: contains a slash → resolve as relative to kb root.
		if (normalized.includes("/")) {
			const withExt = normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
			const rec = this.byRelPath.get(withExt);
			if (rec) return { resolved: rec.relPath };
			return { resolved: null, reason: "no-match" };
		}

		// Stem-only form.
		const stem = normalized.toLowerCase().endsWith(".md")
			? normalized.slice(0, -3).toLowerCase()
			: normalized.toLowerCase();
		if (AMBIGUOUS_STEMS.has(stem)) {
			return { resolved: null, reason: "ambiguous-stem" };
		}
		const candidates = this.byStem.get(stem);
		if (!candidates || candidates.length === 0) {
			return { resolved: null, reason: "no-match" };
		}
		const only = candidates[0];
		if (candidates.length === 1 && only) return { resolved: only.relPath };

		// Tiebreaker: prefer same-directory, then nearest-ancestor, then
		// alphabetical relPath.
		const sameDir = candidates.find((c) => c.dir === sourceDir);
		if (sameDir) return { resolved: sameDir.relPath };
		const sorted = [...candidates].sort((a, b) => a.relPath.localeCompare(b.relPath));
		const first = sorted[0];
		if (first) return { resolved: first.relPath };
		return { resolved: null, reason: "no-match" };
	}
}

// ─── helpers ───────────────────────────────────────────────────────────────

function normalizeRel(p: string): string {
	if (!p) return "";
	// Strip leading/trailing slashes, collapse repeated slashes, force forward.
	return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinRel(parent: string, child: string): string {
	if (!parent) return child;
	return `${parent}/${child}`;
}

/**
 * Frontmatter parser: extracts the leading `---\n…\n---\n` block (if any),
 * runs it through `yaml`, and returns `{ frontmatter, frontmatterError,
 * body }`. Body is the file content with the block stripped (one trailing
 * newline consumed). When YAML parsing fails we return the raw block as a
 * string under `frontmatter._raw` with an error message, so the editor can
 * surface the problem instead of silently dropping the metadata.
 */
function parseFrontmatter(text: string): {
	frontmatter: Record<string, unknown>;
	frontmatterError?: string;
	body: string;
} {
	if (!text.startsWith("---")) return { frontmatter: {}, body: text };
	// Find the closing `---` fence. Tolerate both LF and CRLF line endings; on
	// Windows-saved kb files the closer is `\r\n---` so we search for that
	// shape first and fall back to bare LF.
	let openerEnd = 3;
	if (text[3] === "\r") openerEnd = 4;
	if (text[openerEnd] === "\n") openerEnd += 1;
	else return { frontmatter: {}, body: text };

	const closeLF = text.indexOf("\n---", openerEnd);
	if (closeLF < 0) return { frontmatter: {}, body: text };
	// Normalize the block to LF before handing to YAML — a trailing `\r`
	// before the closing fence is what yanks the parser into
	// "Unexpected scalar at node end" on CRLF files.
	const rawBlock = text.slice(openerEnd, closeLF).replace(/\r\n/g, "\n").replace(/\r$/, "");
	let cursor = closeLF + 4;
	if (text[cursor] === "\r") cursor += 1;
	if (text[cursor] === "\n") cursor += 1;
	const body = text.slice(cursor);

	let frontmatter: Record<string, unknown> = {};
	let frontmatterError: string | undefined;
	try {
		const parsed = YAML.parse(rawBlock);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			frontmatter = parsed as Record<string, unknown>;
		} else if (parsed !== null) {
			frontmatter = { _raw: rawBlock };
			frontmatterError = "frontmatter was not a YAML mapping";
		}
	} catch (err) {
		frontmatter = { _raw: rawBlock };
		frontmatterError = (err as Error).message;
	}
	return frontmatterError ? { frontmatter, frontmatterError, body } : { frontmatter, body };
}

/**
 * Collect `(start, end)` ranges in the body that belong to a fenced code
 * block (``` … ```) or an inline backtick span. Used by `rewriteBodyForRender`
 * so wikilinks inside code stay verbatim.
 */
function collectCodeRanges(text: string): Array<[number, number]> {
	const ranges: Array<[number, number]> = [];
	// Fenced blocks first — they consume their content (including stray backticks).
	const fenceRe = /```[\s\S]*?(?:```|$)/g;
	let fenceMatch: RegExpExecArray | null;
	const fenceCovered: Array<[number, number]> = [];
	while ((fenceMatch = fenceRe.exec(text)) !== null) {
		const r: [number, number] = [fenceMatch.index, fenceMatch.index + fenceMatch[0].length];
		ranges.push(r);
		fenceCovered.push(r);
	}
	// Inline spans, skipping anything already inside a fence.
	const inlineRe = /`[^`\n]+`/g;
	let inlineMatch: RegExpExecArray | null;
	while ((inlineMatch = inlineRe.exec(text)) !== null) {
		const start = inlineMatch.index;
		if (insideAnyRange(fenceCovered, start)) continue;
		ranges.push([start, start + inlineMatch[0].length]);
	}
	ranges.sort((a, b) => a[0] - b[0]);
	return ranges;
}

function insideAnyRange(ranges: Array<[number, number]>, pos: number): boolean {
	// Linear scan — n is bounded by the number of code spans in one file.
	for (const [s, e] of ranges) {
		if (pos >= s && pos < e) return true;
		if (s > pos) return false;
	}
	return false;
}

/**
 * Convert the in-memory `GraphCache` to a wire response with the v1
 * truncation cap applied. Drops orphan nodes only as a last resort — we
 * sort by inbound+outbound degree desc and keep the top GRAPH_MAX_NODES.
 */
function shapeGraphResponse(cache: GraphCache): KbGraphResponse {
	const total = cache.nodes.length;
	if (total <= GRAPH_MAX_NODES) {
		return {
			nodes: cache.nodes,
			edges: cache.edges,
			unresolvedCount: cache.unresolvedCount,
			totalNodes: total,
			truncated: false,
		};
	}
	const sortedNodes = [...cache.nodes].sort(
		(a, b) => b.inbound + b.outbound - (a.inbound + a.outbound),
	);
	const keep = new Set(sortedNodes.slice(0, GRAPH_MAX_NODES).map((n) => n.path));
	const nodes = cache.nodes.filter((n) => keep.has(n.path));
	const edges = cache.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
	return {
		nodes,
		edges,
		unresolvedCount: cache.unresolvedCount,
		totalNodes: total,
		truncated: true,
	};
}

/**
 * Best-effort snippet for a backlink: return the line containing `raw`, or
 * an empty string if not found. Lines are 1-indexed in the surrounding
 * code, but the snippet itself just stands on its own.
 */
function extractSnippet(body: string, raw: string): string {
	const needle = `[[${raw}]]`;
	const idx = body.indexOf(needle);
	if (idx < 0) return "";
	const lineStart = body.lastIndexOf("\n", idx) + 1;
	const lineEnd = body.indexOf("\n", idx);
	const end = lineEnd === -1 ? body.length : lineEnd;
	const line = body.slice(lineStart, end).trim();
	if (line.length <= 200) return line;
	// Long line — center the snippet on the wikilink.
	const lineRelativeIdx = idx - lineStart;
	const window = 100;
	const from = Math.max(0, lineRelativeIdx - window);
	const to = Math.min(line.length, lineRelativeIdx + window);
	return (from > 0 ? "…" : "") + line.slice(from, to) + (to < line.length ? "…" : "");
}

/**
 * Initial README rendered when a fresh user runs `init`. Includes the
 * frontmatter convention so the first file already demonstrates the shape.
 * The body explains the cockpit's relationship to omp memory + the
 * progressive-disclosure model so the user has the mental hooks before
 * they start authoring.
 */
function renderStarterReadme(today: string): string {
	return [
		"---",
		"type: knowledge",
		`created: ${today}`,
		`updated: ${today}`,
		"tags: [meta, readme]",
		"---",
		"",
		"# Welcome to your KB",
		"",
		"This is a fresh knowledge base, scaffolded by omp-deck. The cockpit reads",
		"this folder (`~/kb` by default; overridable via `OMP_DECK_KB_ROOT`) as a",
		"Karpathy-style llm-wiki: hand-tended markdown with frontmatter metadata and",
		"`[[wiki-links]]` between articles.",
		"",
		"## How it works",
		"",
		"- **Each file** is a markdown article with YAML frontmatter at the top.",
		"  The cockpit parses `type`, `created`, `updated`, and `tags` automatically.",
		"- **Wiki-links** like `[[some-other-file]]` resolve by filename stem. Use",
		"  `[[dir/path]]` for explicit paths and `[[target|label]]` to rename the",
		"  rendered text.",
		"- **Hubs** are index files (e.g. `tools/index.md`) that collect related",
		"  articles in one place. They keep your wiki from becoming a sea of",
		"  orphan notes.",
		"",
		"## Where to start",
		"",
		"1. Drop a file into any subdirectory of this kb. The tree refreshes live.",
		"2. Reference it from this README with `[[your-new-file]]`.",
		"3. Open the **Graph** tab to see the constellation grow.",
		"",
		"## What this is NOT",
		"",
		"This kb is *not* the same as omp's session memory. omp's memory backends",
		"(`local` rolling summaries, `hindsight` vector store) handle short-term",
		"recall during a session; this kb is your long-term, hand-tended knowledge.",
		"They complement each other.",
		"",
		"Happy authoring.",
		"",
	].join("\n");
}

export function resolveKbRoot(): string {
	const fromEnv = process.env.OMP_DECK_KB_ROOT;
	if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv.trim());
	return path.join(os.homedir(), "kb");
}
