/**
 * /api/kb — Karpathy llm-wiki viewer over `~/kb`.
 *
 * Phase 1 (T-34): tree listing + single-file read. Mutations (PUT/POST) land
 * in T-36; graph + backlinks land in T-37.
 */

import { Hono } from "hono";

import { logger } from "./log.ts";
import type { KbService } from "./kb-service.ts";

const log = logger("routes:kb");

export function buildKbRouter(service: KbService): Hono {
	const app = new Hono();

	app.get("/kb/tree", async (c) => {
		const subpath = c.req.query("path") ?? "";
		try {
			const body = await service.getTree(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getTree failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/file", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		try {
			const body = await service.getFile(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getFile failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.put("/kb/file", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		let body: { content?: unknown };
		try {
			body = (await c.req.json()) as { content?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.content !== "string") {
			return c.json({ error: "content (string) required" }, 400);
		}
		try {
			const result = await service.saveFile(subpath, body.content, "update");
			return saveResultResponse(c, result);
		} catch (err) {
			log.error(`PUT /kb/file failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/kb/file", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		let body: { content?: unknown };
		try {
			body = (await c.req.json()) as { content?: unknown };
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.content !== "string") {
			return c.json({ error: "content (string) required" }, 400);
		}
		try {
			const result = await service.saveFile(subpath, body.content, "create");
			return saveResultResponse(c, result);
		} catch (err) {
			log.error(`POST /kb/file failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/graph", async (c) => {
		try {
			const body = await service.getGraph();
			return c.json(body);
		} catch (err) {
			log.error(`getGraph failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/backlinks", async (c) => {
		const subpath = c.req.query("path");
		if (!subpath) return c.json({ error: "path required" }, 400);
		try {
			const body = await service.getBacklinks(subpath);
			if (!body) return c.json({ error: "not found" }, 404);
			return c.json(body);
		} catch (err) {
			log.error(`getBacklinks failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/search", async (c) => {
		const q = c.req.query("q") ?? "";
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 20;
		try {
			const body = await service.search(q, Number.isFinite(limit) ? limit : 20);
			return c.json(body);
		} catch (err) {
			log.error(`search failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/kb/status", async (c) => {
		try {
			const body = await service.getStatus();
			return c.json(body);
		} catch (err) {
			log.error(`getStatus failed`, err);
		return c.json(
			{ root: "", exists: false, fileCount: 0, error: String((err as Error).message ?? err) },
			500,
		);
		}
	});

	app.post("/kb/init", async (c) => {
		try {
			const body = await service.initialize();
			return c.json(body);
		} catch (err) {
			log.error(`initialize failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	return app;
}

/** Map a `KbService.saveFile` outcome to an HTTP response. */
function saveResultResponse(
	c: import("hono").Context,
	result: Awaited<ReturnType<import("./kb-service.ts").KbService["saveFile"]>>,
): Response {
	switch (result.kind) {
		case "ok":
			return c.json(result.response);
		case "not-found":
			return c.json({ error: "not found" }, 404);
		case "conflict":
			return c.json({ error: "already exists" }, 409);
		case "invalid-path":
			return c.json({ error: "invalid path (escapes kb root, excluded, or not .md)" }, 400);
		case "mkdir-failed":
			return c.json(
				{ error: `could not create directory: ${result.message}` },
				{ status: 500 },
			);
		case "invalid-frontmatter":
			return c.json({ error: `invalid frontmatter: ${result.message}` }, 400);
	}
}
