/**
 * File explorer REST surface. All paths flow through `files-service.ts`,
 * which re-validates every one against `path-guard.ts` — this router only
 * shapes HTTP in and out.
 */
import { Hono } from "hono";

import type {
	DeleteFileRequest,
	ListDirResponse,
	MakeDirRequest,
	ReadFileResponse,
	RenamePathRequest,
	WriteFileRequest,
} from "@omp-deck/protocol";

import {
	GuardError,
	NotUtf8Error,
	TooLargeError,
	deletePath,
	listDir,
	makeDir,
	readFile,
	renamePath,
	writeFile,
} from "./files-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-files");

function handleError(err: unknown): { status: 400 | 403 | 413 | 500; message: string } {
	if (err instanceof GuardError) return { status: 403, message: err.message };
	if (err instanceof TooLargeError) return { status: 413, message: err.message };
	if (err instanceof NotUtf8Error) return { status: 400, message: err.message };
	log.error("unexpected error", err);
	return { status: 500, message: "internal error" };
}

export function buildFilesRouter(): Hono {
	const app = new Hono();

	app.get("/files/list", async (c) => {
		const target = c.req.query("path")?.trim();
		if (!target) return c.json({ error: "path query param is required" }, 400);
		try {
			const result = await listDir(target);
			const body: ListDirResponse = result;
			return c.json(body);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/files/read", async (c) => {
		const target = c.req.query("path")?.trim();
		if (!target) return c.json({ error: "path query param is required" }, 400);
		try {
			const result = await readFile(target);
			const body: ReadFileResponse = result;
			return c.json(body);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.put("/files/write", async (c) => {
		let body: WriteFileRequest;
		try {
			body = (await c.req.json()) as WriteFileRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path || typeof body.content !== "string") {
			return c.json({ error: "path and content are required" }, 400);
		}
		try {
			const result = await writeFile(body.path, body.content);
			return c.json(result);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/files/mkdir", async (c) => {
		let body: MakeDirRequest;
		try {
			body = (await c.req.json()) as MakeDirRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path) return c.json({ error: "path is required" }, 400);
		try {
			const result = await makeDir(body.path);
			return c.json(result);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/files/rename", async (c) => {
		let body: RenamePathRequest;
		try {
			body = (await c.req.json()) as RenamePathRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.from || !body.to) return c.json({ error: "from and to are required" }, 400);
		try {
			const result = await renamePath(body.from, body.to);
			return c.json(result);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.delete("/files", async (c) => {
		let body: DeleteFileRequest;
		try {
			body = (await c.req.json()) as DeleteFileRequest;
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path) return c.json({ error: "path is required" }, 400);
		try {
			await deletePath(body.path, { recursive: body.recursive });
			return c.json({ ok: true });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	return app;
}
