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

import { Hono, type Context } from "hono";
import type {
	ListMcpToolsResponse,
	ToggleMcpToolRequest,
	ToggleMcpToolResponse,
} from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import { listGholamMcpToolsForServer } from "./gholam-mcp-runtime.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";

interface LogFn {
	debug: (msg: string, extra?: unknown) => void;
	info: (msg: string, extra?: unknown) => void;
	warn: (msg: string, extra?: unknown) => void;
	error: (msg: string, extra?: unknown) => void;
}

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
	disabledTools?: string[];
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

class HttpError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}

function handleMcpRouteError(c: Context, log: LogFn, err: unknown, label: string): Response {
	if (err instanceof HttpError) {
		return c.json({ ok: false, error: err.message }, err.status as 400 | 404);
	}
	log.error(label, err);
	const msg = err instanceof Error ? err.message : String(err);
	return c.json({ ok: false, error: msg }, 500);
}

function mergeMcpEntry(prev: McpServerEntry, next: McpServerEntry): McpServerEntry {
	const out: McpServerEntry = { ...prev };
	const keys: Array<keyof McpServerEntry> = [
		"type",
		"command",
		"args",
		"env",
		"url",
		"headers",
		"timeout",
		"enabled",
		"disabledTools",
	];
	for (const k of keys) {
		const v = next[k];
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function validateMergedEntry(entry: McpServerEntry): boolean {
	const isHttp = entry.type === "http" || (entry.url !== undefined && !entry.command);
	const isStdio = entry.type === "stdio" || (!entry.url && typeof entry.command === "string");
	if (!isHttp && !isStdio) return false;
	if (isHttp && !entry.url) return false;
	if (isStdio && !entry.command) return false;
	return true;
}

export function buildMcpInstallRouter(): Hono {
	const app = new Hono();

	const requireName = (raw: string | undefined): string | undefined => {
		const trimmed = raw?.trim();
		return trimmed ? trimmed : undefined;
	};

	async function withConfig<T>(
		fn: (cfg: McpConfigFile, filePath: string) => T | Promise<T>,
	): Promise<T> {
		const filePath = resolveMcpConfigPath();
		const cfg = existsSync(filePath) ? await readConfig(filePath) : {};
		return await fn(cfg, filePath);
	}

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

		// SECURITY-003: MCP stdio commands are written verbatim into
		// ~/.omp/agent/mcp.json and spawned by gholam-mcp-runtime with the deck's
		// full env. Without this guard, an authed caller can persist
		// `command: "bash"` or `command: "/bin/sh"` and pivot to arbitrary code
		// execution. Refuse shell interpreters outright and shell metacharacters
		// in the command path; the runtime layer handles arg safety.
		if (isStdio) {
		const cmd = cfg.command!.trim();
		const base = cmd.split(/[\\/]/).pop()?.toLowerCase() ?? "";
		const SHELL_INTERPRETERS: Record<string, true> = {
			sh: true,
			bash: true,
			dash: true,
			zsh: true,
			fish: true,
			"cmd.exe": true,
			"powershell.exe": true,
			pwsh: true,
			"powershell": true,
		};
		if (SHELL_INTERPRETERS[base] === true) {
			return c.json(
				{ ok: false, error: `stdio command "${cmd}" is a shell interpreter; not allowed` },
				400,
			);
		}
		const META = /[;&|`$<>\\]/;
		if (META.test(cmd)) {
			return c.json(
				{ ok: false, error: `stdio command contains shell metacharacters; not allowed` },
				400,
			);
		}
		}

		const entry: McpServerEntry = isHttp
			? {
					type: "http",
					url: cfg.url!,
					...(cfg.headers ? { headers: cfg.headers } : {}),
					...(cfg.timeout ? { timeout: cfg.timeout } : {}),
					...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
				disabledTools: cfg.disabledTools ?? [],
				}
			: {
					type: "stdio",
					command: cfg.command!,
					...(cfg.args ? { args: cfg.args } : {}),
					...(cfg.env ? { env: cfg.env } : {}),
					...(cfg.timeout ? { timeout: cfg.timeout } : {}),
					...(cfg.enabled !== undefined ? { enabled: cfg.enabled } : {}),
				disabledTools: cfg.disabledTools ?? [],
				};

		try {
			await withConfig(async (existing, filePath) => {
				const servers = existing.mcpServers ?? {};
				servers[name] = entry;
				await writeConfig(filePath, {
					mcpServers: servers,
					...(existing.disabledServers ? { disabledServers: existing.disabledServers } : {}),
				});
				log.info(`mcp install: ${name} → ${filePath}`);
				return { ok: true as const, name, path: filePath };
			});
			return c.json({ ok: true, name });
		} catch (err) {
			log.error(`mcp install failed for ${name}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: `could not write mcp.json: ${msg}` }, 500);
		}
	});

	app.post("/:name/enable", async (c) => {
		const name = requireName(c.req.param("name"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		try {
			await withConfig(async (cfg, filePath) => {
				const servers = cfg.mcpServers ?? {};
				if (!servers[name]) {
					throw new HttpError(404, `mcp server "${name}" not found`);
				}
				const disabled = (cfg.disabledServers ?? []).filter((n) => n !== name);
				await writeConfig(filePath, {
					mcpServers: servers,
					...(disabled.length > 0 ? { disabledServers: disabled } : {}),
				});
				log.info(`mcp enable: ${name}`);
			});
			return c.json({ ok: true, name, enabled: true });
		} catch (err) {
			return handleMcpRouteError(c, log, err, `enable mcp ${name}`);
		}
	});

	app.post("/:name/disable", async (c) => {
		const name = requireName(c.req.param("name"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		try {
			await withConfig(async (cfg, filePath) => {
				const servers = cfg.mcpServers ?? {};
				if (!servers[name]) {
					throw new HttpError(404, `mcp server "${name}" not found`);
				}
				const disabled = Array.from(new Set([...(cfg.disabledServers ?? []), name]));
				await writeConfig(filePath, {
					mcpServers: servers,
					disabledServers: disabled,
				});
				log.info(`mcp disable: ${name}`);
			});
			return c.json({ ok: true, name, enabled: false });
		} catch (err) {
			return handleMcpRouteError(c, log, err, `disable mcp ${name}`);
		}
	});

	app.delete("/:name", async (c) => {
		const name = requireName(c.req.param("name"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		try {
			await withConfig(async (cfg, filePath) => {
				const servers = { ...(cfg.mcpServers ?? {}) };
				if (!servers[name]) {
					throw new HttpError(404, `mcp server "${name}" not found`);
				}
				delete servers[name];
				const disabled = (cfg.disabledServers ?? []).filter((n) => n !== name);
				await writeConfig(filePath, {
					mcpServers: servers,
					...(disabled.length > 0 ? { disabledServers: disabled } : {}),
				});
				log.info(`mcp delete: ${name}`);
			});
			return c.json({ ok: true, name });
		} catch (err) {
			return handleMcpRouteError(c, log, err, `delete mcp ${name}`);
		}
	});

	app.post("/:name/update", async (c) => {
		const name = requireName(c.req.param("name"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);

		let body: McpServerEntry;
		try {
			body = (await c.req.json()) as McpServerEntry;
		} catch {
			return c.json({ ok: false, error: "invalid JSON body" }, 400);
		}
		if (!body || typeof body !== "object") {
			return c.json({ ok: false, error: "config is required" }, 400);
		}

		try {
			await withConfig(async (cfg, filePath) => {
				const servers = { ...(cfg.mcpServers ?? {}) };
				const existing = servers[name];
				if (!existing) {
					throw new HttpError(404, `mcp server "${name}" not found`);
				}
				const merged = mergeMcpEntry(existing, body);
				if (!validateMergedEntry(merged)) {
					throw new HttpError(400, "merged config must declare either command (stdio) or url (http)");
				}
				servers[name] = merged;
				await writeConfig(filePath, {
					mcpServers: servers,
					...(cfg.disabledServers ? { disabledServers: cfg.disabledServers } : {}),
				});
				log.info(`mcp update: ${name}`);
			});
			return c.json({ ok: true, name });
		} catch (err) {
			return handleMcpRouteError(c, log, err, `update mcp ${name}`);
		}
	});

	app.get("/:name/tools", async (c) => {
		const name = requireName(c.req.param("name"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		try {
			const { tools, disabledTools } = await listGholamMcpToolsForServer(name);
			const response: ListMcpToolsResponse = {
				name,
				tools: tools.map(({ name: toolName, description, inputSchema }) => ({
					name: toolName,
					...(description !== undefined ? { description } : {}),
					...(inputSchema !== undefined ? { inputSchema } : {}),
				})),
				disabledTools,
			};
			return c.json(response);
		} catch (err) {
			return handleMcpRouteError(c, log, err, `list tools for mcp ${name}`);
		}
	});

	app.post("/:name/tools/:tool/toggle", async (c) => {
		const name = requireName(c.req.param("name"));
		const tool = requireName(c.req.param("tool"));
		if (!name) return c.json({ ok: false, error: "name is required" }, 400);
		if (!tool) return c.json({ ok: false, error: "tool is required" }, 400);
		let body: ToggleMcpToolRequest;
		try {
			body = (await c.req.json()) as ToggleMcpToolRequest;
		} catch {
			return c.json({ ok: false, error: "invalid JSON body" }, 400);
		}
		if (!body || typeof body.enabled !== "boolean") {
			return c.json({ ok: false, error: "enabled (boolean) is required" }, 400);
		}
		try {
			const nextDisabled = await withConfig(async (cfg, filePath) => {
				const servers = { ...(cfg.mcpServers ?? {}) };
				const existing = servers[name];
				if (!existing) {
					throw new HttpError(404, `mcp server "${name}" not found`);
				}
				const prev = new Set(existing.disabledTools ?? []);
				if (body.enabled) prev.delete(tool);
				else prev.add(tool);
				const disabledTools = Array.from(prev);
				servers[name] = { ...existing, disabledTools };
				await writeConfig(filePath, {
					mcpServers: servers,
					...(cfg.disabledServers ? { disabledServers: cfg.disabledServers } : {}),
				});
				log.info(`mcp toggle tool: ${name}/${tool} → ${body.enabled ? "enabled" : "disabled"}`);
				return disabledTools;
			});
			broadcastBus.broadcast({
				type: "mcp_tools_changed",
				name,
				disabledTools: nextDisabled,
			});
			const response: ToggleMcpToolResponse = {
				name,
				tool,
				enabled: body.enabled,
				disabledTools: nextDisabled,
			};
			return c.json(response);
		} catch (err) {
			return handleMcpRouteError(c, log, err, `toggle tool ${tool} for mcp ${name}`);
		}
	});

	return app;
}
