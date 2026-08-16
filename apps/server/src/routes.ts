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
import { getUpdateCheck } from "./update-check.ts";
import type { AgentBridge } from "./bridge/types.ts";
import {
	decorateSessions,
	isSessionImportance,
	isSessionStatus,
	isSessionUrgency,
	patchSessionMeta,
	deleteSessionMeta,
} from "./db/session-meta.ts";
import { resolveWorktreeDir } from "./worktree-service.ts";
import type {
	GroupedSessionsResponse,
	PatchSessionRequest,
	SessionSummary,
} from "@omp-deck/protocol";
import { existsSync } from "node:fs";

const log = logger("routes");

const VALID_GROUP_BY = new Set(["repo", "status", "urgency", "importance"]);

import { buildTasksRouter } from "./routes-tasks.ts";
import { buildAutoKanbanRouter } from "./routes-auto-kanban.ts";
import { buildSettingsRouter } from "./routes-settings.ts";
import { buildRoutinesRouter } from "./routes-routines.ts";
import { buildHooksRouter } from "./routes-hooks.ts";
import { buildInboxRouter } from "./routes-inbox.ts";
import { buildUtilityRouter } from "./routes-cron.ts";
import { buildSlashCommandsRouter } from "./routes-slash-commands.ts";
import { buildFsRouter } from "./routes-fs.ts";
import {
	buildWorkspacesRouter,
	extraWorkspaces,
	seedExtraWorkspaces,
} from "./routes-workspaces.ts";
import { buildBridgesRouter } from "./routes-bridges.ts";
import { buildMarketplaceRouter } from "./routes-marketplace.ts";
import { buildSkillsRouter } from "./routes-skills.ts";
import { buildKbRouter } from "./routes-kb.ts";
import { buildUploadsRouter } from "./routes-uploads.ts";
import { buildOrientationRouter } from "./routes-orientation.ts";
import { buildAuthOAuthRouter } from "./routes-auth-oauth.ts";
import { buildAuthRouter } from "./routes-auth.ts";
import { getAuthConfig } from "./auth/config.ts";
import { buildOnboardingRouter } from "./routes-onboarding.ts";
import { buildFilesRouter } from "./routes-files.ts";
import { buildShellRouter } from "./routes-shell.ts";
import { buildGitRouter } from "./routes-git.ts";
import { buildGitHubRouter } from "./routes-github.ts";
import { buildReposRouter } from "./routes-repos.ts";
import { buildWorktreesRouter } from "./routes-worktrees.ts";
import { buildAgentConfigRouter } from "./routes-agent-config.ts";
import { buildPushRouter } from "./routes-push.ts";
import { buildHarnessRouter } from "./routes-harness.ts";
import { buildDiscoveryRouter } from "./discovery/routes.ts";
import { buildStorefrontRouter } from "./routes-storefront.ts";
import { buildPromptsRouter } from "./routes-prompts.ts";
import { buildMcpInstallRouter } from "./routes-mcp-install.ts";
import { buildSkillsInstallRouter } from "./routes-skills-install.ts";
import { buildStorefrontInstalledRouter } from "./routes-storefront-installed.ts";
import { buildTranscribeRouter } from "./routes-transcribe.ts";
import { buildGholamChatsRouter } from "./routes-gholam-chats.ts";
import { buildRoutesOverview } from "./routes-overview.ts";
import { buildLLMRouter } from "./routes-llm.ts";
import { buildGenuiRouter } from "./routes-genui.ts";
import { buildPreviewRouter } from "./routes-preview.ts";
import { buildOpenshipRouter } from "./routes-openship.ts";
import { getMcpHealthProbe } from "./mcp-health.ts";
import { buildMcpHealthRouter } from "./routes-mcp-health.ts";
import { buildSessionAttachRouter, buildSessionAttachWebRouter } from "./routes-session-attach.ts";
import { startCustomProvidersWatcher } from "./custom-providers.ts";
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

	// Hard cap on request body size. Most endpoints deal with small
	// JSON messages; a 4MB ceiling is well above any legitimate body
	// and far below what a request-flood attack can push at a per-
	// socket Hono handler. Routes that genuinely need larger payloads
	// (pasted-image uploads, full agent-config tarballs) opt out via
	// URL prefix matching against `LARGE_BODY_BYPASS_PREFIXES` below.
	// Mounted as the FIRST middleware so it rejects before auth or
	// routing cost.
	const MAX_BODY_BYTES = 4 * 1024 * 1024;
	const LARGE_BODY_BYPASS_PREFIXES = ["/api/uploads/", "/api/agent-config/import"];
	app.use("*", async (c, next) => {
		const method = c.req.method.toUpperCase();
		// Only methods that carry a body. GET/HEAD/OPTIONS never have
		// request bodies that consume server memory, so they're outside
		// this guard.
		if (method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
			return next();
		}
		const path = c.req.path;
		if (LARGE_BODY_BYPASS_PREFIXES.some((p) => path.startsWith(p))) {
			return next();
		}
		const lenStr = c.req.header("content-length");
		if (lenStr) {
			const len = Number(lenStr);
			if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
				return c.json(
					{ error: "payload too large", limit: MAX_BODY_BYTES, received: len },
					413,
				);
			}
		}
		// No Content-Length header (chunked) — let it through; Hono's
		// downstream handlers can stream-read and bound their own reads.
		// The known-attack surface is forged Content-Length on hostile
		// clients, which this middleware just caught.
		return next();
	});

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

	app.get("/version", async (c) => {
		const info = getBuildInfo();
		const body = await getUpdateCheck({ currentVersion: info.version });
		return c.json(body);
	});

	app.get("/workspaces", async (c) => {
		const allSessions = await bridge.listSessions({});
		const counts = new Map<string, number>();
		for (const s of allSessions) {
			if (!s.cwd) continue;
			counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
		}

		// Always include default + extras even if zero sessions.
		const known = new Set<string>([config.defaultCwd, ...extraWorkspaces]);
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
		const includeArchived = c.req.query("archived") === "1";
		const filterRepoId = c.req.query("repoId")?.trim() || undefined;
		const filterUrgency = c.req.query("urgency");
		const filterImportance = c.req.query("importance");
		try {
			const sessions = await bridge.listSessions(cwd ? { cwd } : {});
			let decorated: SessionSummary[] = decorateSessions(
				sessions.map((s) => ({ ...s })),
			) as SessionSummary[];
			if (!includeArchived) {
				decorated = decorated.filter((s) => s.archived !== true);
			}
			if (filterRepoId) {
				decorated = decorated.filter((s) => s.repoId === filterRepoId);
			}
			if (filterUrgency && isSessionUrgency(filterUrgency)) {
				decorated = decorated.filter((s) => s.urgency === filterUrgency);
			}
			if (filterImportance && isSessionImportance(filterImportance)) {
				decorated = decorated.filter((s) => s.importance === filterImportance);
			}
			const body: ListSessionsResponse = { sessions: decorated };
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

		let cwd = body.cwd?.trim() || config.defaultCwd;
		let repoIdForBind: string | null = null;
		let worktreeForBind: string | null = null;
		if (
			typeof body.repoId === "string" &&
			typeof body.worktreeBranch === "string" &&
			body.repoId &&
			body.worktreeBranch
		) {
			const slash = body.repoId.indexOf("/");
			if (slash <= 0 || slash === body.repoId.length - 1) {
				return c.json({ error: "repoId must be in <owner>/<repo> form" }, 400);
			}
			const owner = body.repoId.slice(0, slash);
			const repo = body.repoId.slice(slash + 1);
			const wtDir = resolveWorktreeDir(owner, repo, body.worktreeBranch);
			if (!existsSync(wtDir)) {
				return c.json({ error: `worktree path not found: ${wtDir}` }, 400);
			}
			cwd = wtDir;
			repoIdForBind = body.repoId;
			worktreeForBind = body.worktreeBranch;
		}

		try {
			const handle = body.resumeFromPath
				? await bridge.resumeSession({ sessionPath: body.resumeFromPath })
				: await bridge.createSession({
						cwd,
						...(body.model ? { model: body.model } : {}),
						...(body.suppressAutoStart ? { suppressAutoStart: true } : {}),
					});
			if (repoIdForBind && worktreeForBind) {
				patchSessionMeta(handle.sessionId, {
					repoId: repoIdForBind,
					worktree: worktreeForBind,
				});
			}
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
		// PATCH operates on metadata for any session (active or not) so the
		// UI can archive / re-urgency a session that is no longer running.
		// Title and model edits still need an in-memory handle, so those
		// are guarded by `handle` presence.
		let body: PatchSessionRequest & { model?: { provider?: unknown; id?: unknown } };
		try {
			body = (await c.req.json()) as typeof body;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		const metaPatch: Parameters<typeof patchSessionMeta>[1] = {};
		if (body.archived !== undefined) metaPatch.archived = body.archived;
		if (isSessionUrgency(body.urgency)) metaPatch.urgency = body.urgency;
		if (isSessionImportance(body.importance)) metaPatch.importance = body.importance;
		if (isSessionStatus(body.status)) metaPatch.status = body.status;
		if (Object.keys(metaPatch).length > 0) {
			patchSessionMeta(id, metaPatch);
		}
		const handle = bridge.getSession(id);
		try {
			if (typeof body.title === "string" && handle) {
				await handle.setName(body.title.trim());
			}
			if (handle && body.model && typeof body.model === "object") {
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

	app.get("/sessions/grouped", async (c) => {
		const groupBy = c.req.query("groupBy") ?? "";
		if (!VALID_GROUP_BY.has(groupBy)) {
			return c.json({ error: `groupBy must be one of: ${[...VALID_GROUP_BY].join(", ")}` }, 400);
		}
		try {
			const decorated = decorateSessions(
				(await bridge.listSessions({})).map((s) => ({ ...s })),
			) as SessionSummary[];
			const groups = new Map<string, SessionSummary[]>();
			for (const s of decorated) {
				// `groupBy` is already validated against VALID_GROUP_BY above,
				// so the switch below is exhaustive — we still default-throw
				// for safety, but the compiler can prove that path is unreachable.
				let key: string;
				switch (groupBy as string) {
					case "repo":
						key = s.repoId ?? "(none)";
						break;
					case "status":
						key = s.status ?? "active";
						break;
					case "urgency":
						key = s.urgency ?? "normal";
						break;
					case "importance":
						key = s.importance ?? "normal";
						break;
					default:
						throw new Error(`unreachable groupBy: ${groupBy}`);
				}
				const bucket = groups.get(key);
				if (bucket) bucket.push(s);
				else groups.set(key, [s]);
			}
			const resp: GroupedSessionsResponse = {
				groups: [...groups.entries()].map(([key, sessions]) => ({ key, sessions })),
			};
			return c.json(resp);
		} catch (err) {
			log.error(`grouped sessions failed`, err);
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
		// Best-effort live disposal. If the session isn't active (it may
		// have been disposed earlier or never loaded into the bridge), we
		// still want DELETE to succeed for the persisted meta row so the
		// chat sidebar can remove the entry.
		if (handle) {
			try {
				await handle.dispose();
			} catch (err) {
				log.warn(`dispose failed for ${id} (continuing to meta delete): ${String(err)}`);
			}
		}
		const removed = deleteSessionMeta(id);
		if (!handle && !removed) return c.json({ error: "session not found" }, 404);
		try {
			return c.json({ ok: true });
		} catch (err) {
			log.error(`delete session failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.route("/", buildTasksRouter(bridge));
	app.route("/", buildAutoKanbanRouter());
	app.route("/", buildReposRouter());
	app.route("/", buildWorktreesRouter());
	app.route("/", buildUploadsRouter({ uploadsRoot: config.uploadsRoot }));
	// Voice transcription sidecar (`whisper-cpp`). Returns 501 without
	// WHISPER_BIN in the environment; otherwise shells out per request.
	app.route("/", buildTranscribeRouter());
	app.route("/", buildRoutinesRouter(runner));
	app.route("/", buildHooksRouter(runner));
	app.route("/", buildInboxRouter());
	app.route("/", buildUtilityRouter());
	app.route("/", buildSlashCommandsRouter());
	app.route("/", buildFsRouter());
	// Workspace registration: picker calls POST /api/workspaces/register to
	// add a directory the user picked from /fs/dialog to the remembered
	// extras list. Shares the mutable list with the GET /api/workspaces
	// handler above (seeded once at startup from Config.extraWorkspaces).
	seedExtraWorkspaces(config.extraWorkspaces);
	app.route("/", buildWorkspacesRouter());
	app.route("/", buildSettingsRouter(bridge, config, opts));
	app.route("/", buildOrientationRouter());
	app.route("/", buildBridgesRouter(supervisor));
	app.route("/", buildMarketplaceRouter(marketplace));
	app.route("/", buildSkillsRouter(skills));
	app.route("/", buildKbRouter(kb));
	app.route("/", buildFilesRouter());
	app.route("/", buildShellRouter());
	app.route("/", buildGitRouter());
	app.route("/", buildGitHubRouter());
	app.route("/", buildAgentConfigRouter({ restartServer: opts.restartServer }));
	app.route("/", buildPushRouter());
	app.route("/auth/oauth", buildAuthOAuthRouter());
	// Deck sign-in. Mounted after /auth/oauth so the more specific provider
	// routes win; this router only declares leaf paths (/login, /session, …)
	// so the two never overlap.
	app.route("/auth", buildAuthRouter(getAuthConfig(), () => config.publicUrl));
	app.route("/onboarding", buildOnboardingRouter());

	app.route("/", buildHarnessRouter(bridge));
	app.route("/", buildPromptsRouter());
	app.route("/", buildDiscoveryRouter());
	app.route("/", buildStorefrontRouter());
	app.route("/", buildMcpHealthRouter(getMcpHealthProbe()));
	// Per-section install endpoints + installed-flags snapshot.
	// Mounted at the parent path used by the existing /api/mcp and /api/skills
	// routers so client dispatch (InstallButton) lands on /api/mcp/install,
	// /api/skills/install, /api/storefront/installed without prefix collisions.
	app.route("/mcp", buildMcpInstallRouter());
	app.route("/skills", buildSkillsInstallRouter());
	app.route("/storefront", buildStorefrontInstalledRouter(marketplace, skills));
	// Persistent Gholam chat history — §1 of docs/GENERATIVE.md. Mounted
	// flat under "/gholam/chats" so the legacy "/api/gholam/*" control
	// surface in buildHarnessRouter stays conflict-free.
	app.route("/", buildGholamChatsRouter());
	app.route("/", buildRoutesOverview({ config }));
	// Typed LLM registry — §2. GET /api/llm/providers + POST /api/llm/test.
	app.route("/", buildLLMRouter());
	// §3 + §4 of docs/GENERATIVE.md — generative UI stream + pre-update
	// preview. Mounted below the existing routers so their more specific
	// paths (`/api/genui/*`, `/api/preview/*`) take precedence; the routers
	// declare leaf paths so no overlap with the ones above.
	app.route("/", buildGenuiRouter());
	app.route("/", buildPreviewRouter());
	app.route("/", buildOpenshipRouter());
	app.route("/api", buildSessionAttachRouter());
	app.route("/attach", buildSessionAttachWebRouter());
	startCustomProvidersWatcher();
	return app;
}

function deriveLabel(cwd: string): string {
	if (!cwd) return "(unknown)";
	const parts = cwd.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}
