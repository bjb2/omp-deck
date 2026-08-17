import { Hono } from "hono";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	EnvEntry,
	EnvValueSource,
	ListEnvSettingsResponse,
	PatchEnvSettingsRequest,
	PatchEnvSettingsResponse,
	RestartServerResponse,
	RevealEnvValueResponse,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { parseAutoStart, parseInt10, splitList } from "./config.ts";
import { ENV_SCHEMA, ENV_SCHEMA_BY_KEY, type EnvSchemaEntry, validateEnvValue } from "./env-schema.ts";
import {
	MANAGED_ENV_KEYS_LOADED,
	appendEnvAudit,
	applyManagedEnvUpdatesToProcess,
	getDataDir,
	getManagedEnvPath,
	readManagedEnvFile,
	writeManagedEnvUpdates,
} from "./env-store.ts";
import { setLogLevel } from "./log.ts";
import type { AgentBridge } from "./bridge/types.ts";
import { guardWorkspacePath } from "./path-guard.ts";
import { isAdminPrincipal } from "./auth/guard.ts";

export function buildSettingsRouter(
	bridge: AgentBridge,
	config: Config,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/settings/env", (c) => c.json(buildEnvResponse()));

	app.get("/settings/env/:key", async (c) => {
		if (c.req.query("reveal") !== "1") return c.json({ error: "reveal=1 required" }, 400);
		if (!isLoopbackRequest(c.req.raw)) return c.json({ error: "secret reveal requires loopback" }, 403);
		const key = c.req.param("key");
		const entry = ENV_SCHEMA_BY_KEY.get(key);
		if (!entry) return c.json({ error: "unknown env key" }, 404);
		const current = resolveEntry(entry);
		await appendEnvAudit("reveal", [key]);
		const body: RevealEnvValueResponse = {
			key,
			value: current.value ?? "",
			masked: maskValue(current.value ?? "", entry.sensitive),
			isSet: isNonEmpty(current.value),
			source: current.source,
		};
		return c.json(body);
	});

	app.patch("/settings/env", async (c) => {
		// SECURITY-004: env mutations can rotate provider keys, the deck API
		// token, MCP secrets. Any authed user was previously able to clobber
		// them. Gate behind admin principal — mirror routes-llm.ts:isAdminPrincipal.
		const access = isAdminPrincipal(c.req.raw);
		if (!access) return c.json({ error: "admin required" }, 403);

		let body: PatchEnvSettingsRequest;
		try {
			body = (await c.req.json()) as PatchEnvSettingsRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		const updates = body.updates ?? {};
		const clean: Record<string, string | null> = {};
		for (const [key, value] of Object.entries(updates)) {
			const entry = ENV_SCHEMA_BY_KEY.get(key);
			if (!entry) return c.json({ error: `unknown env key: ${key}` }, 400);
			if (value !== null && typeof value !== "string") {
				return c.json({ error: `invalid env value for ${key}` }, 400);
			}
			if (value !== null) {
				const err = validateEnvValue(entry, value);
				if (err) return c.json({ error: `${key}: ${err}` }, 400);
			}
			clean[key] = value;
		}

		await writeManagedEnvUpdates(clean);
		applyManagedEnvUpdatesToProcess(clean);
		await appendEnvAudit("set", Object.keys(clean).filter((key) => clean[key] !== null));
		await appendEnvAudit("unset", Object.keys(clean).filter((key) => clean[key] === null));

		const appliedHot = applyHotUpdates(clean, bridge, config);
		const response = buildEnvResponse() as PatchEnvSettingsResponse;
		response.appliedHot = appliedHot;
		return c.json(response);
	});

	app.post("/server/restart", (c) => {
		if (!isLoopbackRequest(c.req.raw)) return c.json({ error: "restart requires loopback" }, 403);
		const resp = opts.restartServer?.() ?? { ok: false, message: "Restart is unavailable" };
		return c.json(resp);
	});

	app.post("/settings/install-focus-guard", async (c) => {
		let body: { cwd?: string };
		try {
			body = (await c.req.json()) as { cwd?: string };
		} catch {
			return c.json({ ok: false, path: "" }, 400);
		}
		const cwd = body.cwd?.trim();
		if (!cwd) {
			return c.json({ ok: false, path: "" }, 400);
		}
		const guard = guardWorkspacePath(cwd, { mustExist: true });
		if (!guard.ok) {
			return c.json({ ok: false, path: "" }, 400);
		}
		try {
			const gitDir = path.join(cwd, ".git");
			// The hook lives inside an existing repo, not into a freshly
			// created folder — refuse the install rather than fabricating
			// a `.git` tree on the caller's behalf.
			if (!fs.existsSync(gitDir)) {
				return c.json({ ok: false, path: "" }, 400);
			}
			const hookDir = path.join(gitDir, "hooks");
			fs.mkdirSync(hookDir, { recursive: true });
			const hookPath = path.join(hookDir, "pre-commit");
			const script = `#!/bin/sh
# OMP Deck Focus Guard pre-commit hook
if [ -f "$HOME/.omp/focus_active" ]; then
  echo "[focus-guard] Focus mode active. Commit blocked."
  exit 1
fi
exit 0\n`;
			fs.writeFileSync(hookPath, script, { mode: 0o755 });
			return c.json({ ok: true, path: hookPath });
		} catch {
			return c.json({ ok: false, path: "" }, 500);
		}
	});

	return app;
}

function buildEnvResponse(): ListEnvSettingsResponse {
	const entries = ENV_SCHEMA.map((entry) => toResponseEntry(entry));
	return {
		entries,
		envFilePath: getManagedEnvPath(),
		dataDir: getDataDir(),
		restartRequired: entries.some((entry) => entry.restartTarget === "server" && entry.source === "env-file"),
	};
}

function toResponseEntry(entry: EnvSchemaEntry): EnvEntry {
	const current = resolveEntry(entry);
	return {
		key: entry.key,
		masked: maskValue(current.value ?? "", entry.sensitive),
		isSet: isNonEmpty(current.value),
		source: current.source,
		...(entry.defaultValue !== undefined ? { defaultValue: entry.defaultValue } : {}),
		valueType: entry.valueType,
		sensitive: entry.sensitive,
		restartRequired: entry.restartRequired,
		hotApply: entry.hotApply,
		description: entry.description,
		...(entry.options ? { options: entry.options } : {}),
		...(entry.restartRequired ? { restartTarget: entry.restartTarget ?? "server" } : {}),
	};
}

function isNonEmpty(value: string | undefined): boolean {
	return value !== undefined && value !== "";
}

function resolveEntry(entry: EnvSchemaEntry): { source: EnvValueSource; value?: string } {
	const file = readManagedEnvFile();
	const fileValue = file.values.get(entry.key);
	const processValue = process.env[entry.key];
	if (processValue !== undefined && !(MANAGED_ENV_KEYS_LOADED.has(entry.key) && processValue === fileValue)) {
		return { source: "process-env", value: processValue };
	}
	if (fileValue !== undefined) return { source: "env-file", value: fileValue };
	if (entry.defaultValue !== undefined) return { source: "default", value: entry.defaultValue };
	return { source: "unset" };
}

function maskValue(value: string, sensitive: boolean): string {
	if (!value) return "unset";
	if (!sensitive) return value;
	const tail = value.slice(-4);
	return tail ? `••••••••${tail}` : "••••••••";
}

function applyHotUpdates(
	updates: Record<string, string | null>,
	bridge: AgentBridge,
	config: Config,
): string[] {
	const applied: string[] = [];
	const effective = new Map(ENV_SCHEMA.map((entry) => [entry.key, resolveEntry(entry).value]));

	if ("LOG_LEVEL" in updates) {
		if (setLogLevel(effective.get("LOG_LEVEL") ?? "info")) applied.push("LOG_LEVEL");
	}
	if ("OMP_DECK_IDLE_TIMEOUT_MS" in updates) {
		const next = parseInt10(effective.get("OMP_DECK_IDLE_TIMEOUT_MS"), 5 * 60_000);
		config.idleTimeoutMs = next;
		bridge.applyEnvUpdate?.({ idleTimeoutMs: next });
		applied.push("OMP_DECK_IDLE_TIMEOUT_MS");
	}
	if ("OMP_DECK_AUTO_START" in updates) {
		const next = parseAutoStart(effective.get("OMP_DECK_AUTO_START"));
		config.autoStartCommand = next;
		bridge.applyEnvUpdate?.({ autoStartCommand: next });
		applied.push("OMP_DECK_AUTO_START");
	}
	if ("OMP_DECK_DEFAULT_CWD" in updates) {
		const next = effective.get("OMP_DECK_DEFAULT_CWD")?.trim() || os.homedir();
		config.defaultCwd = path.resolve(next);
		applied.push("OMP_DECK_DEFAULT_CWD");
	}
	if ("OMP_DECK_WORKSPACES" in updates) {
		config.extraWorkspaces = splitList(effective.get("OMP_DECK_WORKSPACES")).map((p) => path.resolve(p));
		applied.push("OMP_DECK_WORKSPACES");
	}
	return applied;
}

function isLoopbackRequest(req: Request): boolean {
	const host = new URL(req.url).hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

