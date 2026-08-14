/**
 * `POST /api/mcp/install` — append an entry to the user's `~/.omp/agent/mcp.json`.
 *
 * Mirrors the config shape used by `mcp-health.ts`: `{ mcpServers, disabledServers }`.
 * Each install writes atomically (tmp + rename) so a partial write never leaves
 * the file half-updated. Errors are plain English; raw stack traces from
 * `Bun.spawn` / `fs` are stripped before being returned.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";

const log = logger("routes:mcp-install");

interface McpServerEntry {
	type?: "stdio" | "http";
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	timeout?: number;
	enabled?: boolean;
}

interface McpConfigFile {
	mcpServers?: Record<string, McpServerEntry>;
	disabledServers?: string[];
}

interface InstallBody {
	name: string;
	config: McpServerEntry;
}

function resolveMcpConfigPath(): string {
	const agentDir = loadConfig().agentDir ?? path.join(os.homedir(), ".omp", "agent");
	return path.join(agentDir, "mcp.json");
}

async function readConfig(filePath: string): Promise<McpConfigFile> {
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as McpConfigFile;
		if (parsed && typeof parsed === "object") return parsed;
		return {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw err;
	}
}

async function writeConfig(filePath: string, cfg: McpConfigFile): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
	await fs.rename(tmp, filePath);
}

export function buildMcpInstallRouter(): Hono {
	const app = new Hono();

	app.post("/install", async (c) => {
		let body: InstallBody;
		try {
			body = (await c.req.json()) as InstallBody;
		} catch {
			return c.json({ ok: false, error: "invalid JSON body" }, 400);
		}

		const name = body.name?.trim();
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		if (!body.config || typeof body.config !== "object") {
			return c.json({ ok: false, error: "config is required" }, 400);
		}

		const cfg = body.config;
		const isHttp = cfg.type === "http" || (cfg.url && !cfg.command);
		const isStdio = cfg.type === "stdio" || (!cfg.url && typeof cfg.command === "string");

		if (!isHttp && !isStdio) {
			return c.json(
				{ ok: false, error: "config must declare either command (stdio) or url (http)" },
				400,
			);
		}
		if (isHttp && !cfg.url) {
			return c.json({ ok: false, error: "http server requires url" }, 400);
		}
		if (isStdio && !cfg.command) {
			return c.json({ ok: false, error: "stdio server requires command" }, 400);
		}

		const entry: McpServerEntry = isHttp
			? {
					type: "http",
					url: cfg.url!,
					...(cfg.headers ? { headers: cfg.headers } : {}),
					...(cfg.timeout ? { timeout: cfg.timeout } : {}),
					...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
				}
			: {
					type: "stdio",
					command: cfg.command!,
					...(cfg.args ? { args: cfg.args } : {}),
					...(cfg.env ? { env: cfg.env } : {}),
					...(cfg.timeout ? { timeout: cfg.timeout } : {}),
					...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
				};

		const filePath = resolveMcpConfigPath();
		try {
			const existing = existsSync(filePath) ? await readConfig(filePath) : {};
			const servers = existing.mcpServers ?? {};
			servers[name] = entry;
			const next: McpConfigFile = {
				...(existing.mcpServers ? { mcpServers: servers } : { mcpServers: servers }),
				...(existing.disabledServers ? { disabledServers: existing.disabledServers } : {}),
			};
			await writeConfig(filePath, next);
			log.info(`mcp install: ${name} → ${filePath}`);
			return c.json({ ok: true, name, path: filePath });
		} catch (err) {
			log.error(`mcp install failed for ${name}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: `could not write mcp.json: ${msg}` }, 500);
		}
	});

	return app;
}