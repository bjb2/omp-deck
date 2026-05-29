import { Hono } from "hono";
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	ListModelsResponse,
	ListSessionsResponse,
	ListWorkspacesResponse,
	RestartServerResponse,
	WorkspaceEntry,
} from "@omp-deck/protocol";

import type { Config } from "./config.ts";
import { logger } from "./log.ts";
import { getBuildInfo, getUptimeSecs } from "./build-info.ts";
import type { AgentBridge } from "./bridge/types.ts";

const log = logger("routes");

import { buildTasksRouter } from "./routes-tasks.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { buildUtilityRouter } from "./routes-cron.ts";
import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";
import { buildFsRouter } from "./routes-fs.ts";
import { buildBridgesRouter } from "./routes-bridges.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildUploadsRouter } from "./routes-uploads.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { buildAuthOAuthRouter } from "./routes-auth-oauth.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import type { RoutinesRunner } from "./routines-runner.ts";
import type { BridgeSupervisor } from "./bridge-supervisor.ts";
import type { MarketplaceService } from "./marketplace-service.ts";
import type { SkillsService } from "./skills-service.ts";
import type { KbService } from "./kb-service.ts";

export function buildRouter(
	bridge: AgentBridge,
	config: Config,
	runner: RoutinesRunner,
	supervisor: BridgeSupervisor,
	marketplace: MarketplaceService,
	skills: SkillsService,
	kb: KbService,
	opts: { restartServer?: () => RestartServerResponse } = {},
): Hono {
	const app = new Hono();

	app.get("/health", (c) => {
		const info = getBuildInfo();
		return c.json({
			ok: true,
			pid: info.pid,
			defaultCwd: config.defaultCwd,
			extraWorkspaces: config.extraWorkspaces,
			serverStartedAt: info.serverStartedAt,
			version: info.version,
			buildSha: info.buildSha,
			uptimeSecs: getUptimeSecs(),
		});
	});

	app.get("/workspaces", async (c) => {
		const allSessions = await bridge.listSessions({});
		const counts = new Map<string, number>();
		for (const s of allSessions) {
			if (!s.cwd) continue;
			counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		}

		// Always include default + extras even if zero sessions.
		const known = new Set<string>([config.defaultCwd, ...config.extraWorkspaces]);
		for (const cwd of counts.keys()) known.add(cwd);

		const workspaces: WorkspaceEntry[] = Array.from(known)
			.map((cwd) => ({
				cwd,
				label: deriveLabel(cwd),
				sessionCount: counts.get(cwd) ?? 0,
			}))
			.sort((a, b) => b.sessionCount - a.sessionCount || a.label.localeCompare(b.label));

		const body: ListWorkspacesResponse = {
			workspaces,
			defaultCwd: config.defaultCwd,
		};
		return c.json(body);
	});

	app.get("/sessions", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const sessions = await bridge.listSessions(cwd ? { cwd } : {});
			const body: ListSessionsResponse = { sessions };
			return c.json(body);
		} catch (err) {
			log.error(`listSessions failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions", async (c) => {
		let body: CreateSessionRequest;
		try {
			body = (await c.req.json()) as CreateSessionRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}

		const cwd = body.cwd?.trim() || config.defaultCwd;

		try {
			const handle = body.resumeFromPath
				? await bridge.resumeSession({ sessionPath: body.resumeFromPath })
				: await bridge.createSession({
						cwd,
						...(body.model ? { model: body.model } : {}),
						...(body.suppressAutoStart ? { suppressAutoStart: true } : {}),
					});
			const resp: CreateSessionResponse = {
				sessionId: handle.sessionId,
				sessionFile: handle.sessionFile,
				cwd: handle.cwd,
			};
			return c.json(resp);
		} catch (err) {
			log.error(`createSession failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/abort", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		try {
			await handle.abort();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`abort failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/sessions/:id/compact", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		// Body is optional — accept missing/empty JSON without bouncing.
		let body: { focus?: string } = {};
		try {
			const raw = await c.req.text();
			if (raw.trim().length > 0) body = JSON.parse(raw) as { focus?: string };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			await handle.compact(body.focus);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`compact failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.patch("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found or not active" }, 404);
		let body: { name?: string; model?: { provider?: unknown; id?: unknown } };
		try {
			body = (await c.req.json()) as { name?: string; model?: { provider?: unknown; id?: unknown } };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		try {
			if (typeof body.name === "string") {
				await handle.setName(body.name.trim());
			}
			if (body.model && typeof body.model === "object") {
				const provider = typeof body.model.provider === "string" ? body.model.provider : "";
				const modelId = typeof body.model.id === "string" ? body.model.id : "";
				if (!provider || !modelId) {
					return c.json({ error: "model requires provider and id strings" }, 400);
				}
				await handle.setModel({ provider, id: modelId });
			}
			return c.json({ ok: true, sessionId: id });
		} catch (err) {
			log.error(`patch session failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.get("/models", async (c) => {
		const sessionId = c.req.query("sessionId");
		try {
			const opts: { sessionId?: string } = {};
			if (sessionId) opts.sessionId = sessionId;
			const models = await bridge.listModels(opts);
			const active = models.find((m) => m.isCurrent);
			const body: ListModelsResponse = {
				models,
				...(active ? { active: { provider: active.provider, id: active.id } } : {}),
			};
			return c.json(body);
		} catch (err) {
			log.error(`listModels failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/sessions/:id", async (c) => {
		const id = c.req.param("id");
		const handle = bridge.getSession(id);
		if (!handle) return c.json({ error: "session not found" }, 404);
		try {
			await handle.dispose();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`dispose failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.route("/", buildTasksRouter());
	app.route("/", buildUploadsRouter({ uploadsRoot: config.uploadsRoot }));
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
	app.route("/", buildInboxRouter());
	app.route("/", buildUtilityRouter());
	app.route("/", buildSlashCommandsRouter());
	app.route("/", buildFsRouter());
	app.route("/", buildSettingsRouter(bridge, config, opts));
	app.route("/", buildOrientationRouter());
	app.route("/", buildBridgesRouter(supervisor));
	app.route("/", buildMarketplaceRouter(marketplace));
	app.route("/", buildSkillsRouter(skills));
	app.route("/", buildKbRouter(kb));
	app.route("/auth/oauth", buildAuthOAuthRouter());
	app.route("/onboarding", buildOnboardingRouter());

	return app;
}

function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
