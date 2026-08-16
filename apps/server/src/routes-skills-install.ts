/**
 * `POST /api/skills/install` — install a skill by name.
 *
 * Skills land in `~/.omp/agent/skills/<name>/SKILL.md` (or `<cwd>/.omp/skills/<name>/SKILL.md`
 * for project scope). `source` may be:
 *   - a URL (http/https) — fetched as the SKILL.md body
 *   - raw markdown text — written as-is (must include frontmatter if metadata needed)
 *
 * If `source` is omitted we scaffold an empty SKILL.md so the install is durable
 * and visible to the SDK on next refresh; the user can edit it later.
 *
 * Modeled on `skillsMP.install` (skillsmp.ts) — same target dir, same write
 * pattern — but entry-point only: no SkillsMP API fetch, no marketplace clone.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { guardWorkspacePath } from "./path-guard.ts";

const log = logger("routes:skills-install");

interface InstallBody {
	name: string;
	source?: string;
	scope?: "user" | "project";
	cwd?: string;
}

function safeName(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	// Skills directory segments: alphanumeric + dashes/underscores/dots.
	if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return undefined;
	if (trimmed === "." || trimmed === "..") return undefined;
	return trimmed;
}

function resolveTargetDir(name: string, scope: "user" | "project", cwd?: string): string {
	if (scope === "project") {
		const rawBase = cwd?.trim() || process.cwd();
		// Project scope writes `<cwd>/.omp/skills/<name>`. The cwd comes
		// from the client — confine it through the shared workspace guard
		// so it can never escape an allowed root, and fall back to
		// process.cwd() only after the guard admits it.
		const guard = guardWorkspacePath(rawBase);
		const base = guard.ok && guard.resolved ? guard.resolved : process.cwd();
		return path.join(base, ".omp", "skills", name);
	}
	const agentDir = loadConfig().agentDir ?? path.join(os.homedir(), ".omp", "agent");
	return path.join(agentDir, "skills", name);
}

async function fetchSource(source: string): Promise<string> {
	if (!/^https?:\/\//i.test(source)) return source;
	// SECURITY-002 (SSRF guard): refuse loopback, private networks, link-local,
	// and metadata IPs. Without this, an authed caller can hit the deck's own
	// loopback-only API endpoints (which the auth gate skips because the
	// request looks internal) or cloud-instance metadata services.
	const url = new URL(source);
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`unsupported scheme: ${url.protocol}`);
	}
	const hostname = url.hostname.toLowerCase();
	const denyPatterns = [
		/^localhost$/i,
		/^127\./,
		/^0\.0\.0\.0$/,
		/^10\./,
		/^172\.(1[6-9]|2\d|3[01])\./,
		/^192\.168\./,
		/^169\.254\./,
		/^::1$/,
		/^fe80:/i,
		/^fc[0-9a-f]{2}:/i,
		/^fd[0-9a-f]{2}:/i,
	];
	if (denyPatterns.some((re) => re.test(hostname))) {
		throw new Error(`refusing to fetch from non-public host: ${hostname}`);
	}
	const res = await fetch(source);
	if (!res.ok) throw new Error(`source download failed (HTTP ${res.status})`);
	return await res.text();
}

function scaffoldBody(name: string): string {
	return `---\nname: ${name}\n---\n\n# ${name}\n\nReplace this with your skill instructions.\n`;
}

export function buildSkillsInstallRouter(): Hono {
	const app = new Hono();

	app.post("/install", async (c) => {
		let body: InstallBody;
		try {
			body = (await c.req.json()) as InstallBody;
		} catch {
			return c.json({ ok: false, error: "invalid JSON body" }, 400);
		}

		const name = safeName(body.name ?? "");
		if (!name) {
			return c.json({ ok: false, error: "name must be alphanumeric (with -, _, .)" }, 400);
		}

		const scope = body.scope === "project" ? "project" : "user";
		const targetDir = resolveTargetDir(name, scope, body.cwd);
		const targetFile = path.join(targetDir, "SKILL.md");

		let content: string;
		try {
			content = body.source !== undefined && body.source !== ""
				? await fetchSource(body.source)
				: scaffoldBody(name);
		} catch (err) {
			log.warn(`skills install: source fetch failed for ${name}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: `could not load source: ${msg}` }, 400);
		}

		try {
			await fs.mkdir(targetDir, { recursive: true });
			const tmp = `${targetFile}.tmp-${process.pid}-${Date.now()}`;
			await fs.writeFile(tmp, content, "utf8");
			await fs.rename(tmp, targetFile);
			log.info(`skills install: ${name} → ${targetFile}`);
			return c.json({ ok: true, name, path: targetFile });
		} catch (err) {
			log.error(`skills install failed for ${name}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: `could not write SKILL.md: ${msg}` }, 500);
		}
	});

	return app;
}