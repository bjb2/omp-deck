/**
 * Skill-level enumeration across every omp provider.
 *
 * Built on top of the SDK's capability system: `loadCapability(skillCapability.id, { cwd })`
 * returns the union of skills from every registered provider (`native`,
 * `claude-plugins`, `claude`, `codex`, `opencode`, ...) each tagged with
 * `_source.provider`, `_source.providerName`, and `level`.
 *
 * The marketplace-only T-27 implementation has been replaced. The deck stays
 * omp-native: it shows what omp loads, with `native` (the user's own
 * `~/.omp/agent/skills/`) sorted first. Marketplace plugins are one source
 * among many.
 *
 * Watcher fan-out (broadcasting `skills_changed`) lives in `skills-watcher.ts`
 * next to the other server-level wiring.
 */

import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { skillCapability, type Skill as SdkSkill } from "@oh-my-pi/pi-coding-agent/capability/skill";

import type {
	ListSkillsResponse,
	SkillDetailResponse,
	SkillFile,
	SkillFrontmatter,
	SkillProvider,
	SkillSummary,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import type { MarketplaceService } from "./marketplace-service.ts";

const log = logger("skills");

/**
 * Display labels for known providers. Falls through to `providerName` from the
 * SDK's source metadata for anything we haven't styled — that ensures new
 * providers show up coherently without a deck release.
 */
const PROVIDER_LABEL: Readonly<Record<string, string>> = {
	native: "OMP",
	"claude-plugins": "Claude Plugins",
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	cursor: "Cursor",
	windsurf: "Windsurf",
	cline: "Cline",
	gemini: "Gemini",
	agents: "Subagents",
	custom: "Custom",
};

/**
 * Provider priority for default sort. Lower wins. Unknown providers land at
 * the end (parity with arbitrary string compare).
 */
const PROVIDER_PRIORITY: Readonly<Record<string, number>> = {
	native: 0,
	"claude-plugins": 1,
	claude: 2,
	codex: 3,
	opencode: 4,
	cursor: 5,
	windsurf: 6,
	cline: 7,
	gemini: 8,
	agents: 9,
	custom: 10,
};

export class SkillsService {
	constructor(
		private readonly config: Config,
		private readonly marketplace: MarketplaceService,
	) {}

	async listSkills(cwd?: string): Promise<ListSkillsResponse> {
		const resolvedCwd = cwd?.trim() || this.config.defaultCwd;
		const pluginIndex = await this.buildPluginIndex();

		const result = await loadCapability<SdkSkill>(skillCapability.id, { cwd: resolvedCwd });

		const skills: SkillSummary[] = [];
		for (const item of result.items) {
			const summary = this.toSummary(item, pluginIndex);
			if (summary) skills.push(summary);
		}

		// Stable order: provider priority, then by displayed name, then dirName
		// as a final tiebreaker. The UI can re-sort, but native-first is the
		// default the omp-deck cockpit lives by.
		skills.sort((a, b) => {
			const pa = PROVIDER_PRIORITY[a.provider] ?? 100;
			const pb = PROVIDER_PRIORITY[b.provider] ?? 100;
			if (pa !== pb) return pa - pb;
			const n = a.name.localeCompare(b.name);
			if (n !== 0) return n;
			return a.dirName.localeCompare(b.dirName);
		});

		if (result.warnings.length > 0) {
			log.debug(`loadCapability warnings`, result.warnings);
		}

		return { skills };
	}

	async getSkillDetail(id: string, cwd?: string): Promise<SkillDetailResponse | undefined> {
		const skillPath = decodeIdToPath(id);
		if (!skillPath) return undefined;

		// Always re-run the capability load so we authoritatively prove this
		// path was discoverable. Refusing to read arbitrary disk paths is the
		// security gate — if `loadCapability` didn't surface it, we don't
		// serve it.
		const list = await this.listSkills(cwd);
		const summary = list.skills.find((s) => s.skillPath === skillPath);
		if (!summary) return undefined;

		let raw: string;
		try {
			raw = await readFile(skillPath, "utf8");
		} catch {
			return undefined;
		}

		const body = stripFrontmatter(raw);
		const skillDir = path.dirname(skillPath);
		const files = await walkSkillFiles(skillDir);

		return { ...summary, body, files };
	}

	/**
	 * Toggle the `hide:` frontmatter flag on a SKILL.md. This is the only
	 * "enabled" signal the SDK's capability loader honors (see toSummary,
	 * `enabled: !(item.frontmatter?.hide === true)`). YAML round-trip is
	 * used to preserve every other key the user authored.
	 *
	 * Refuses to mutate skills owned by a marketplace plugin — those files
	 * belong to the plugin cache and would be clobbered on the next refresh.
	 */
	async setEnabled(id: string, enabled: boolean, cwd?: string): Promise<SkillSummary | undefined> {
		const resolved = await this.resolveOwnedSkill(id, cwd, "setEnabled");
		if (!resolved) return undefined;
		const { skillPath } = resolved;

		const raw = await readFile(skillPath, "utf8");
		const { fmText, body, hasFm } = splitFrontmatter(raw);
		const fmDoc = hasFm && fmText.trim() ? (parseYaml(fmText) as Record<string, unknown> | null) ?? {} : {};
		if (enabled) delete fmDoc.hide;
		else fmDoc.hide = true;
		const fmSerialized = stringifyYaml(fmDoc).trimEnd();
		const next = hasFm
			? `---\n${fmSerialized}\n---\n${body}`
			: `---\n${fmSerialized}\n---\n${body}`;
		await atomicWrite(skillPath, next);
		log.info(`skills setEnabled: ${path.basename(path.dirname(skillPath))} → ${enabled}`);

		// Refetch so the response reflects the freshly toggled state.
		const list = await this.listSkills(cwd);
		return list.skills.find((s) => s.skillPath === skillPath);
	}

	/**
	 * Delete a skill directory. Refuses to remove skills owned by a
	 * marketplace plugin (the plugin cache owns those files; deleting
	 * breaks the plugin until refresh and confuses the user).
	 */
	async remove(id: string, cwd?: string): Promise<{ name: string; path: string } | undefined> {
		const resolved = await this.resolveOwnedSkill(id, cwd, "remove");
		if (!resolved) return undefined;
		const { skillPath } = resolved;
		const skillDir = path.dirname(skillPath);
		await rm(skillDir, { recursive: true, force: false });
		log.info(`skills remove: ${skillDir}`);
		return { name: path.basename(skillDir), path: skillDir };
	}

	/**
	 * Re-write SKILL.md from a new source. Source may be raw markdown or an
	 * http(s) URL; the same fetch + scaffold rules as install apply. Refuses
	 * to mutate skills owned by a marketplace plugin.
	 */
	async update(
		id: string,
		body: { source?: string; cwd?: string },
	): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
		const resolved = await this.resolveOwnedSkill(id, body.cwd, "update");
		if (!resolved) return { ok: false, error: "skill not found" };
		const { skillPath } = resolved;
		if (!body.source || !body.source.trim()) {
			return { ok: false, error: "source is required to update an existing skill" };
		}
		const content = await fetchSkillSource(body.source.trim());
		await atomicWrite(skillPath, content);
		log.info(`skills update: ${skillPath}`);
		return { ok: true, path: skillPath };
	}

	/**
	 * Resolve a server-issued skill id back to its disk path and verify it is
	 * NOT owned by a marketplace plugin. Returns the discovered skill path
	 * or `undefined` if the id is invalid, the skill is gone, or the skill
	 * belongs to a plugin (in which case the caller should 4xx).
	 */
	private async resolveOwnedSkill(
		id: string,
		cwd: string | undefined,
		_label: string,
	): Promise<{ skillPath: string } | undefined> {
		const skillPath = decodeIdToPath(id);
		if (!skillPath) return undefined;

		const list = await this.listSkills(cwd);
		const summary = list.skills.find((s) => s.skillPath === skillPath);
		if (!summary) return undefined;
		if (summary.provider === "claude-plugins") {
			log.warn(`skills: refused mutation — skill is owned by plugin "${summary.pluginName ?? summary.pluginId ?? "?"}"`);
			return undefined;
		}
		return { skillPath };
	}

	/**
	 * Build a `{ installPath -> { id, name, marketplace } }` index so skills
	 * whose source path lives under a marketplace install can be attributed
	 * to their owning plugin. Reads through `MarketplaceService.listInstalled`
	 * so it's one disk hit, not one per skill.
	 */
	private async buildPluginIndex(): Promise<PluginIndex> {
		const installed = await this.marketplace.listInstalled();
		const byPath = new Map<string, { id: string; name: string; marketplace: string }>();
		for (const p of installed) {
			byPath.set(normalize(p.installPath), {
				id: p.id,
				name: p.name,
				marketplace: p.marketplace,
			});
		}
		return byPath;
	}

	private toSummary(item: SdkSkill, pluginIndex: PluginIndex): SkillSummary | undefined {
		const skillPath = item.path;
		if (!skillPath) return undefined;

		const provider = (item._source?.provider ?? "custom") as SkillProvider;
		const providerName = item._source?.providerName ?? PROVIDER_LABEL[provider] ?? provider;
		const providerLabel = PROVIDER_LABEL[provider] ?? providerName;

		const dirName = path.basename(path.dirname(skillPath));
		const frontmatter = normalizeFrontmatter(item.frontmatter, item.name, dirName);

		const summary: SkillSummary = {
			id: encodePathToId(skillPath),
			name: frontmatter.name,
			dirName,
			provider,
			providerLabel,
			level: item.level,
			skillPath,
			frontmatter,
			enabled: !(item.frontmatter?.hide === true),
		};

		if (provider === "claude-plugins") {
			const owner = findPluginOwner(skillPath, pluginIndex);
			if (owner) {
				summary.pluginId = owner.id;
				summary.pluginName = owner.name;
				summary.marketplace = owner.marketplace;
			}
		}

		return summary;
	}
}

type PluginIndex = Map<string, { id: string; name: string; marketplace: string }>;

function normalize(p: string): string {
	// Windows paths arrive with backslashes from the SDK; canonicalize to
	// forward slashes plus lowercase drive letter so the prefix-match below
	// works regardless of how the path was constructed.
	return p.replace(/\\/g, "/").replace(/^([a-z]):/i, (_, d: string) => `${d.toLowerCase()}:`);
}

function findPluginOwner(
	skillPath: string,
	pluginIndex: PluginIndex,
): { id: string; name: string; marketplace: string } | undefined {
	const candidate = normalize(skillPath);
	for (const [installPath, owner] of pluginIndex) {
		// Path-prefix attribution. `installPath` ends at the plugin root; any
		// skill under it (`<installPath>/skills/<name>/SKILL.md`) belongs to
		// that plugin. Trailing-slash insensitive.
		const prefix = installPath.endsWith("/") ? installPath : `${installPath}/`;
		if (candidate.startsWith(prefix)) return owner;
	}
	return undefined;
}

function normalizeFrontmatter(
	raw: Record<string, unknown> | undefined,
	skillName: string,
	dirName: string,
): SkillFrontmatter {
	const out: SkillFrontmatter = {
		name: typeof raw?.name === "string" && raw.name.trim() ? raw.name.trim() : skillName || dirName,
	};
	const description = raw?.description;
	if (typeof description === "string" && description.trim()) out.description = description.trim();
	const model = raw?.model;
	if (typeof model === "string" && model.trim()) out.model = model.trim();
	const triggers = raw?.triggers;
	if (Array.isArray(triggers)) {
		const cleaned = triggers.filter((t): t is string => typeof t === "string" && t.length > 0);
		if (cleaned.length > 0) out.triggers = cleaned;
	}
	const tags = raw?.tags;
	if (Array.isArray(tags)) {
		const cleaned = tags.filter((t): t is string => typeof t === "string" && t.length > 0);
		if (cleaned.length > 0) out.tags = cleaned;
	}
	return out;
}

/** Encode an absolute path into a URL-safe id. Reversible via decodeIdToPath. */
function encodePathToId(p: string): string {
	const bytes = Buffer.from(p, "utf8");
	return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeIdToPath(id: string): string | undefined {
	try {
		const b64 = id.replace(/-/g, "+").replace(/_/g, "/");
		const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
		return Buffer.from(b64 + pad, "base64").toString("utf8");
	} catch {
		return undefined;
	}
}

/**
 * Strip a leading `---\n…\n---\n?` frontmatter block from a SKILL.md body.
 * Mirrors the SDK's loader so the two never disagree about where the body
 * starts.
 */
function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return text;
	let cursor = end + 4;
	if (text[cursor] === "\r") cursor += 1;
	if (text[cursor] === "\n") cursor += 1;
	return text.slice(cursor);
}

/**
 * Split a SKILL.md file into its frontmatter block and body. Returns
 * `hasFm=false` when the file has no frontmatter (in which case `fmText`
 * is the whole file). Used by `setEnabled` so we can round-trip YAML
 * without clobbering the body the user authored.
 */
function splitFrontmatter(
	text: string,
): { fmText: string; body: string; hasFm: boolean } {
	if (!text.startsWith("---")) return { fmText: text, body: text, hasFm: false };
	const end = text.indexOf("\n---", 3);
	if (end < 0) return { fmText: text, body: text, hasFm: false };
	const fmText = text.slice(3, end).replace(/^\n/, "");
	let cursor = end + 4;
	if (text[cursor] === "\r") cursor += 1;
	if (text[cursor] === "\n") cursor += 1;
	return { fmText, body: text.slice(cursor), hasFm: true };
}

/**
 * Atomic write — same tmp+rename pattern as `routes-skills-install.ts`.
 * The skill path is guaranteed to exist by `resolveOwnedSkill`, so we
 * skip the `mkdir` step; only `writeFile` + `rename` are needed.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, "utf8");
	await rename(tmp, filePath);
}

/**
 * Resolve a skill source string. http(s) URLs are fetched as the SKILL.md
 * body; everything else is treated as raw markdown text. Mirrors
 * `routes-skills-install.ts#fetchSource` without importing from a route
 * module (cross-module layering would couple the service to a route).
 */
async function fetchSkillSource(source: string): Promise<string> {
	if (!/^https?:\/\//i.test(source)) return source;
	const res = await fetch(source);
	if (!res.ok) throw new Error(`source download failed (HTTP ${res.status})`);
	return await res.text();
}

// Cap depth and total entries so a misconfigured plugin (e.g. checked-in
// node_modules) can't blow up the response. Skill trees are typically a
// handful of files; 500 entries is generous and bounds the wire size.
const SKILL_WALK_MAX_ENTRIES = 500;
const SKILL_WALK_MAX_DEPTH = 6;
const SKILL_WALK_EXCLUDE = new Set([
	"node_modules",
	"__pycache__",
	".git",
	".venv",
	"venv",
	"dist",
	"build",
]);

async function walkSkillFiles(skillDir: string): Promise<SkillFile[]> {
	const out: SkillFile[] = [];

	async function recurse(absDir: string, relParent: string, depth: number): Promise<void> {
		if (out.length >= SKILL_WALK_MAX_ENTRIES) return;
		if (depth > SKILL_WALK_MAX_DEPTH) return;
		let entries;
		try {
			entries = await readdir(absDir, { withFileTypes: true });
		} catch (err) {
			log.warn(`walk: readdir failed at ${absDir}`, err);
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			if (out.length >= SKILL_WALK_MAX_ENTRIES) return;
			if (SKILL_WALK_EXCLUDE.has(entry.name)) continue;
			if (entry.isSymbolicLink()) continue;
			const relPath = relParent ? `${relParent}/${entry.name}` : entry.name;
			const absPath = path.join(absDir, entry.name);

			if (entry.isDirectory()) {
				out.push({ relPath, name: entry.name, kind: "dir" });
				await recurse(absPath, relPath, depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			if (depth === 0 && entry.name === "SKILL.md") continue;
			let st;
			try {
				st = await stat(absPath);
			} catch (err) {
				log.warn(`walk: stat failed at ${absPath}`, err);
				continue;
			}
			out.push({
				relPath,
				name: entry.name,
				kind: "file",
				size: st.size,
				mtime: st.mtime.toISOString(),
			});
		}
	}

	await recurse(skillDir, "", 0);
	return out;
}

export type { SkillSummary, SkillFrontmatter, SkillDetailResponse, SkillFile, ListSkillsResponse };
