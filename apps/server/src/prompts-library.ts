/**
 * Prompt library storage.
 *
 * Flat JSON files under `~/.omp-deck/prompts/<id>.json`, one prompt per file.
 * Atomic writes via temp-file + rename in the same directory so concurrent
 * reads never see a half-written body.
 *
 * Shared (read-only by slug) prompts live under `~/.omp-deck/prompts/_shared/<slug>.json`.
 *
 * Variable extraction: regex `/\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g` on body.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { Prompt, PromptSource } from "@omp-deck/protocol";

import { logger } from "./log.ts";

const log = logger("prompts-library");

const PROMPTS_DIR = path.join(os.homedir(), ".omp-deck", "prompts");
const SHARED_DIR = path.join(PROMPTS_DIR, "_shared");

const VAR_RE = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

export function extractVariables(body: string): string[] {
	const out = new Set<string>();
	for (const m of body.matchAll(VAR_RE)) {
		const v = m[1];
		if (v) out.add(v);
	}
	return [...out];
}

function genId(): string {
	// 12-char base64url-ish id; collision-resistant enough for v1.
	const bytes = new Uint8Array(9);
	crypto.getRandomValues(bytes);
	let s = "";
	for (const b of bytes) s += b.toString(36).padStart(2, "0");
	return s.slice(0, 12);
}

function genShareSlug(): string {
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString("base64url").slice(0, 8);
}

function nowIso(): string {
	return new Date().toISOString();
}

async function ensureDirs(): Promise<void> {
	await mkdir(PROMPTS_DIR, { recursive: true });
	await mkdir(SHARED_DIR, { recursive: true });
}

async function atomicWrite(absPath: string, content: string): Promise<void> {
	const dir = path.dirname(absPath);
	await mkdir(dir, { recursive: true });
	const tmp = path.join(dir, `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`);
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, absPath);
	} catch (err) {
		log.error(`atomic save failed at ${absPath}`, err);
		try {
			await rm(tmp, { force: true });
		} catch {
			// best-effort
		}
		throw err;
	}
}

function safeId(id: string): string {
	// Reject anything that could escape the prompts dir; ids are short base36.
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id)) throw new Error(`invalid prompt id: ${id}`);
	return id;
}

function safeSlug(slug: string): string {
	if (!/^[a-zA-Z0-9_-]{1,32}$/.test(slug)) throw new Error(`invalid share slug: ${slug}`);
	return slug;
}

async function readPrompt(abs: string): Promise<Prompt> {
	const raw = await readFile(abs, "utf8");
	const parsed = JSON.parse(raw) as Prompt;
	// Always re-derive variables from body — saves may have stale vars.
	parsed.variables = extractVariables(parsed.body);
	if (!parsed.createdAt) parsed.createdAt = nowIso();
	if (!parsed.updatedAt) parsed.updatedAt = parsed.createdAt;
	if (typeof parsed.usageCount !== "number") parsed.usageCount = 0;
	if (typeof parsed.pinned !== "boolean") parsed.pinned = false;
	return parsed;
}

export interface CreatePromptInput {
	title: string;
	body: string;
	category?: string;
	tags?: string[];
	share?: boolean;
	source?: PromptSource;
}

export interface UpdatePromptInput {
	title?: string;
	body?: string;
	category?: string;
	tags?: string[];
	share?: boolean;
	pinned?: boolean;
}

export class PromptsLibrary {
	async list(): Promise<Prompt[]> {
		await ensureDirs();
		const entries = await readdir(PROMPTS_DIR);
		const prompts: Prompt[] = [];
		for (const e of entries) {
			if (e.startsWith(".") || e === "_shared") continue;
			if (!e.endsWith(".json")) continue;
			try {
				prompts.push(await readPrompt(path.join(PROMPTS_DIR, e)));
			} catch (err) {
				log.warn(`skip unreadable prompt ${e}`, err);
			}
		}
		prompts.sort((a, b) => {
			if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
			const at = a.updatedAt;
			const bt = b.updatedAt;
			return bt.localeCompare(at);
		});
		return prompts;
	}

	async get(id: string): Promise<Prompt | undefined> {
		await ensureDirs();
		const safe = safeId(id);
		const abs = path.join(PROMPTS_DIR, `${safe}.json`);
		if (!existsSync(abs)) return undefined;
		return readPrompt(abs);
	}

	async create(input: CreatePromptInput): Promise<Prompt> {
		await ensureDirs();
		const title = input.title.trim();
		if (!title) throw new Error("title required");
		const body = input.body ?? "";
		const id = genId();
		const now = nowIso();
		const shareSlug = input.share ? genShareSlug() : undefined;
		const prompt: Prompt = {
			id,
			title,
			body,
			category: input.category ?? "general",
			tags: input.tags ?? [],
			variables: extractVariables(body),
			createdAt: now,
			updatedAt: now,
			usageCount: 0,
			lastUsedAt: null,
			pinned: false,
			...(shareSlug ? { shareSlug } : {}),
			...(input.source ? { source: input.source } : {}),
		};
		await atomicWrite(path.join(PROMPTS_DIR, `${id}.json`), JSON.stringify(prompt, null, 2));
		if (shareSlug) {
			await atomicWrite(path.join(SHARED_DIR, `${shareSlug}.json`), JSON.stringify(prompt, null, 2));
		}
		return prompt;
	}

	async update(id: string, patch: UpdatePromptInput): Promise<Prompt> {
		const safe = safeId(id);
		const existing = await this.get(safe);
		if (!existing) throw new Error(`prompt not found: ${safe}`);
		const next: Prompt = {
			...existing,
			...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
			...(patch.body !== undefined ? { body: patch.body } : {}),
			...(patch.category !== undefined ? { category: patch.category } : {}),
			...(patch.tags !== undefined ? { tags: patch.tags } : {}),
			...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
			updatedAt: nowIso(),
		};
		next.variables = extractVariables(next.body);
		// Share flag toggles shareSlug presence.
		if (patch.share === true && !existing.shareSlug) {
			next.shareSlug = genShareSlug();
		} else if (patch.share === false && existing.shareSlug) {
			try {
				await rm(path.join(SHARED_DIR, `${existing.shareSlug}.json`), { force: true });
			} catch (err) {
				log.warn(`failed to remove shared file for ${safe}`, err);
			}
			delete next.shareSlug;
		} else if (existing.shareSlug) {
			next.shareSlug = existing.shareSlug;
		}
		await atomicWrite(path.join(PROMPTS_DIR, `${safe}.json`), JSON.stringify(next, null, 2));
		if (next.shareSlug) {
			await atomicWrite(path.join(SHARED_DIR, `${next.shareSlug}.json`), JSON.stringify(next, null, 2));
		}
		return next;
	}

	async delete(id: string): Promise<boolean> {
		const safe = safeId(id);
		const existing = await this.get(safe);
		if (!existing) return false;
		try {
			await rm(path.join(PROMPTS_DIR, `${safe}.json`), { force: true });
		} catch (err) {
			log.error(`delete failed for ${safe}`, err);
			throw err;
		}
		if (existing.shareSlug) {
			try {
				await rm(path.join(SHARED_DIR, `${existing.shareSlug}.json`), { force: true });
			} catch {
				// best-effort
			}
		}
		return true;
	}

	async bumpUsage(id: string): Promise<Prompt | undefined> {
		const safe = safeId(id);
		const existing = await this.get(safe);
		if (!existing) return undefined;
		const next: Prompt = {
			...existing,
			usageCount: existing.usageCount + 1,
			lastUsedAt: nowIso(),
		};
		await atomicWrite(path.join(PROMPTS_DIR, `${safe}.json`), JSON.stringify(next, null, 2));
		if (existing.shareSlug) {
			try {
				await atomicWrite(path.join(SHARED_DIR, `${existing.shareSlug}.json`), JSON.stringify(next, null, 2));
			} catch {
				// best-effort
			}
		}
		return next;
	}

	async getBySlug(slug: string): Promise<Prompt | undefined> {
		await ensureDirs();
		const safe = safeSlug(slug);
		const abs = path.join(SHARED_DIR, `${safe}.json`);
		if (!existsSync(abs)) return undefined;
		return readPrompt(abs);
	}

	async exportPrompt(id: string): Promise<Prompt> {
		const p = await this.get(id);
		if (!p) throw new Error(`prompt not found: ${id}`);
		return p;
	}

	async importPrompt(data: unknown): Promise<Prompt> {
		if (!data || typeof data !== "object") throw new Error("invalid prompt payload");
		const obj = data as Partial<Prompt>;
		const title = typeof obj.title === "string" ? obj.title.trim() : "";
		if (!title) throw new Error("title required");
		return this.create({
			title,
			body: typeof obj.body === "string" ? obj.body : "",
			category: typeof obj.category === "string" ? obj.category : "imported",
			tags: Array.isArray(obj.tags) ? obj.tags.filter((t): t is string => typeof t === "string") : [],
			source: obj.source ?? { kind: "user", url: "", capturedAt: nowIso() },
		});
	}
}

export const promptsLibrary = new PromptsLibrary();