/**
 * SkillsMP-backed skill marketplace integration.
 *
 * SkillsMP (https://skillsmp.com) is the community skill registry the SDK
 * surfaces through `MarketplaceManager`. The deck layers a friendly API over
 * it: a search endpoint that hits the SkillsMP API, a featured list, and an
 * install path that drops the skill into `~/.omp/agent/skills/<slug>` so the
 * SDK picks it up on next refresh.
 *
 * The SkillsMP API is the canonical registry. Where it's unreachable (e.g.
 * offline, blocked network), `search` returns the locally-installed skills as
 * a graceful fallback so the marketplace surface never goes blank.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("skillsmp");

const SKILLSMP_BASE = process.env.SKILLSMP_BASE_URL ?? "https://skillsmp.com/api/v1";

export interface SkillMPEntry {
	slug: string;
	name: string;
	description: string;
	author?: string;
	homepage?: string;
	downloads?: number;
	stars?: number;
	tags?: string[];
	featured?: boolean;
	installed?: boolean;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T | undefined> {
	try {
		const res = await fetch(url, { ...init, headers: { "accept": "application/json", ...(init?.headers ?? {}) } });
		if (!res.ok) {
			log.warn(`SkillsMP ${url} returned ${res.status}`);
			return undefined;
		}
		return (await res.json()) as T;
	} catch (err) {
		log.warn(`SkillsMP fetch failed: ${url}`, err);
		return undefined;
	}
}

export const skillsMP = {
	async search(query: string, limit = 30): Promise<SkillMPEntry[]> {
		const params = new URLSearchParams();
		if (query) params.set("q", query);
		params.set("limit", String(limit));
		const remote = await fetchJson<{ results?: SkillMPEntry[] }>(
			`${SKILLSMP_BASE}/skills/search?${params.toString()}`,
		);
		if (remote?.results) return remote.results;
		// Fallback: list installed skills.
		return this.localSkills();
	},

	async featured(limit = 12): Promise<SkillMPEntry[]> {
		const remote = await fetchJson<{ results?: SkillMPEntry[] }>(
			`${SKILLSMP_BASE}/skills/featured?limit=${limit}`,
		);
		if (remote?.results) return remote.results;
		return this.localSkills().then((s) => s.slice(0, limit));
	},

	async localSkills(): Promise<SkillMPEntry[]> {
		const dir = path.join(process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "skills");
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });
			const out: SkillMPEntry[] = [];
			for (const e of entries) {
				if (!e.isDirectory() && !e.isFile()) continue;
				const slug = e.name;
				const skillMd = await readSkillMd(path.join(dir, slug));
				out.push({
					slug,
					name: skillMd.frontmatter.name ?? slug,
					description: skillMd.frontmatter.description ?? skillMd.firstLine,
					installed: true,
					featured: false,
				});
			}
			return out;
		} catch {
			return [];
		}
	},

	async install(slug: string, scope: "user" | "project" = "user"): Promise<{ ok: boolean; installedPath?: string; error?: string }> {
		// Try to fetch the canonical skill from SkillsMP.
		const meta = await fetchJson<{ archive_url?: string; manifest?: { path?: string } }>(
			`${SKILLSMP_BASE}/skills/${encodeURIComponent(slug)}`,
		);
		if (!meta?.archive_url) {
			return { ok: false, error: "SkillsMP did not return archive_url for this slug" };
		}
		const targetDir = scope === "project"
			? path.join(process.cwd(), ".omp", "skills", slug)
			: path.join(process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"), "skills", slug);
		await fs.mkdir(targetDir, { recursive: true });
		// Download + extract via Bun's stream APIs.
		try {
			const res = await fetch(meta.archive_url);
			if (!res.ok) return { ok: false, error: `archive download failed: ${res.status}` };
			const buf = new Uint8Array(await res.arrayBuffer());
			// Bun.write handles raw files only — caller is responsible for tars
			// already being expanded by SkillsMP's CDN. Fallback: assume the
			// response is the raw SKILL.md content.
			const target = path.join(targetDir, meta.manifest?.path ?? "SKILL.md");
			await Bun.write(target, buf);
			log.info(`SkillsMP installed ${slug} → ${target}`);
			return { ok: true, installedPath: targetDir };
		} catch (err) {
			return { ok: false, error: String((err as Error).message ?? err) };
		}
	},
};

async function readSkillMd(dir: string): Promise<{ frontmatter: Record<string, string>; firstLine: string }> {
	const p = path.join(dir, "SKILL.md");
	try {
		const text = await fs.readFile(p, "utf-8");
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text);
		if (fmMatch) {
			const fm: Record<string, string> = {};
			for (const line of fmMatch[1]!.split(/\r?\n/)) {
				const idx = line.indexOf(":");
				if (idx < 0) continue;
				fm[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
			const body = text.slice(fmMatch[0]!.length).trim();
			return { frontmatter: fm, firstLine: body.split(/\r?\n/)[0] ?? "" };
		}
		return { frontmatter: {}, firstLine: text.split(/\r?\n/)[0] ?? "" };
	} catch {
		return { frontmatter: {}, firstLine: "" };
	}
}
