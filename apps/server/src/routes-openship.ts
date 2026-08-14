/**
 * OpenShip REST surface — first-class project/deploy view + trigger for
 * the web deck. Mounted under `/openship` by `routes.ts`. Same `401`
 * gate as `routes-gholam-chats.ts`: `resolvePrincipal(req, cfg)` —
 * cookie-bearing users and sidecar internal callers both allowed.
 */
import { Hono } from "hono";

import { resolvePrincipal } from "./auth/guard.ts";
import { getAuthConfig } from "./auth/config.ts";
import {
	OpenshipApiError,
	OpenshipAuthError,
	OpenshipTimeoutError,
	deploymentLogs as svcDeploymentLogs,
	getProject as svcGetProject,
	hasOpenshipToken,
	listProjects as svcListProjects,
	triggerDeploy as svcTriggerDeploy,
} from "./openship-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-openship");

function principalFromReq(req: Request): { allowed: boolean } {
	const cfg = getAuthConfig();
	const principal = resolvePrincipal(req, cfg);
	return { allowed: Boolean(principal) };
}

function authGuard(c: { req: { raw: Request } }): { status: 401; body: { error: string } } | null {
	return principalFromReq(c.req.raw).allowed ? null : { status: 401, body: { error: "unauthorized" } };
}

function tokenGuard(): { status: 503; body: { error: string } } | null {
	return hasOpenshipToken()
		? null
		: { status: 503, body: { error: "OpenShip is not configured — set MCP_OPENSHIP_TOKEN in env" } };
}

function handleError(err: unknown): { status: number; message: string } {
	if (err instanceof OpenshipAuthError) return { status: 503, message: err.message };
	if (err instanceof OpenshipTimeoutError) return { status: 504, message: err.message };
	if (err instanceof OpenshipApiError) return { status: 502, message: err.message };
	log.error("unexpected openship error", err);
	return { status: 500, message: "internal error" };
}

/** Project id segment validator. OpenShip uses opaque ids (`proj_XXX`); we
 *  refuse anything that smells like path traversal or query smuggling so a
 *  stray `../` can't reach `getProject`. */
const PROJECT_ID = /^[A-Za-z0-9._-]+$/;
const PROJECT_ID_MAX = 128;

function validateProjectId(raw: string | undefined): string | { error: string } {
	if (!raw) return { error: "project id required" };
	if (raw.length > PROJECT_ID_MAX) return { error: "project id too long" };
	if (raw === "." || raw === ".." || !PROJECT_ID.test(raw)) return { error: "invalid project id" };
	return raw;
}

export function buildOpenshipRouter(): Hono {
	const app = new Hono();

	app.get("/openship/status", (c) => {
		const gate = authGuard(c);
		if (gate) return c.json(gate.body, gate.status);
		return c.json({ configured: hasOpenshipToken() });
	});

	app.get("/openship/projects", async (c) => {
		const gate = authGuard(c);
		if (gate) return c.json(gate.body, gate.status);
		const tok = tokenGuard();
		if (tok) return c.json(tok.body, tok.status);
		try {
			const items = await svcListProjects();
			return c.json({ items });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status as 400 | 401 | 403 | 500 | 502 | 503 | 504);
		}
	});

	app.get("/openship/projects/:id", async (c) => {
		const gate = authGuard(c);
		if (gate) return c.json(gate.body, gate.status);
		const tok = tokenGuard();
		if (tok) return c.json(tok.body, tok.status);
		const idOrErr = validateProjectId(c.req.param("id"));
		if (typeof idOrErr !== "string") return c.json({ error: idOrErr.error }, 400);
		try {
			const { project, deployments } = await svcGetProject(idOrErr);
			return c.json({ project, deployments });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status as 400 | 401 | 403 | 500 | 502 | 503 | 504);
		}
	});

	app.post("/openship/projects/:id/deploy", async (c) => {
		const gate = authGuard(c);
		if (gate) return c.json(gate.body, gate.status);
		const tok = tokenGuard();
		if (tok) return c.json(tok.body, tok.status);
		const idOrErr = validateProjectId(c.req.param("id"));
		if (typeof idOrErr !== "string") return c.json({ error: idOrErr.error }, 400);
		try {
			const { deploymentId } = await svcTriggerDeploy(idOrErr);
			return c.json({ deploymentId });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status as 400 | 401 | 403 | 500 | 502 | 503 | 504);
		}
	});

	app.get("/openship/deployments/:id/logs", async (c) => {
		const gate = authGuard(c);
		if (gate) return c.json(gate.body, gate.status);
		const tok = tokenGuard();
		if (tok) return c.json(tok.body, tok.status);
		const idOrErr = validateProjectId(c.req.param("id"));
		if (typeof idOrErr !== "string") return c.json({ error: idOrErr.error }, 400);
		const tailRaw = c.req.query("tail");
		const tail = tailRaw ? Math.max(1, Math.min(2000, Number.parseInt(tailRaw, 10) || 200)) : 200;
		try {
			const lines = await svcDeploymentLogs(idOrErr, tail);
			return c.json({ lines });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status as 400 | 401 | 403 | 500 | 502 | 503 | 504);
		}
	});

	return app;
}
