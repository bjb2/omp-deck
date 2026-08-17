/**
 * `GET /api/storefront/installed` — per-section installed flag snapshot.
 *
 * Aggregates three sources so the storefront can render `Installed` badges
 * without each card type fetching its own list:
 *   - `plugins`  → `MarketplaceService.listInstalled()`
 *   - `skills`   → unique skill names from `SkillsService.listSkills()`
 *   - `mcps`     → keys of `mcpServers` in `~/.omp/agent/mcp.json`
 *
 * Soft-fails per section: if one source throws we still return the others
 * and surface the failure under `_errors` so the UI can decide.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { SkillsService } from "./skills-service.ts";

const log = logger("routes:storefront-installed");

interface McpConfigShape {
	mcpServers?: Record<string, unknown>;
}

function resolveMcpConfigPath(): string {
	const agentDir = loadConfig().agentDir ?? path.join(os.homedir(), ".omp", "agent");
	return path.join(agentDir, "mcp.json");
}

async function readInstalledMcps(): Promise<string[]> {
	const filePath = resolveMcpConfigPath();
	if (!existsSync(filePath)) return [];
	try {
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as McpConfigShape;
		if (parsed && typeof parsed === "object" && parsed.mcpServers && typeof parsed.mcpServers === "object") {
			return Object.keys(parsed.mcpServers);
		}
		return [];
	} catch (err) {
		log.warn(`storefront installed: mcp.json unreadable`, err);
		return [];
	}
}

export function buildStorefrontInstalledRouter(
	marketplace: MarketplaceService,
	skills: SkillsService,
): Hono {
	const app = new Hono();

	app.get("/installed", async (c) => {
		const errors: Record<string, string> = {};
		const installed: { plugins: string[]; skills: string[]; mcps: string[] } = {
			plugins: [],
			skills: [],
			mcps: [],
		};

		try {
			const plugins = await marketplace.listInstalled();
			installed.plugins = Array.from(new Set(plugins.map((p) => p.name)));
		} catch (err) {
			errors.plugins = err instanceof Error ? err.message : String(err);
		}

		try {
			const list = await skills.listSkills();
			installed.skills = Array.from(new Set(list.skills.map((s) => s.name)));
		} catch (err) {
			errors.skills = err instanceof Error ? err.message : String(err);
		}

		try {
			installed.mcps = await readInstalledMcps();
		} catch (err) {
			errors.mcps = err instanceof Error ? err.message : String(err);
		}

		return c.json({ installed, ...(Object.keys(errors).length > 0 ? { errors } : {}) });
	});

	return app;
}