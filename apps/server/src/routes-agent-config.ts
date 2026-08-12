/**
 * Agent-config manager REST surface: browse/edit `OMP_AGENT_DIR`, and the
 * stage → review → apply import flow described in `agent-config-service.ts`.
 */
import { Hono } from "hono";
import { createReadStream } from "node:fs";

import type { RestartServerResponse } from "@omp-deck/protocol";

import {
	GuardError,
	ImportError,
	NoAgentDirError,
	applyStagedImport,
	deleteAgentPath,
	discardStagedImport,
	exportAgentDirZip,
	listAgentDir,
	listBackups,
	readAgentFile,
	restoreBackup,
	stageImport,
	writeAgentFile,
} from "./agent-config-service.ts";
import { logger } from "./log.ts";

const log = logger("routes-agent-config");

function handleError(err: unknown): { status: 400 | 403 | 404 | 500; message: string } {
	if (err instanceof GuardError) return { status: 403, message: err.message };
	if (err instanceof NoAgentDirError) return { status: 404, message: err.message };
	if (err instanceof ImportError) return { status: 400, message: err.message };
	log.error("unexpected error", err);
	return { status: 500, message: "internal error" };
}

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export function buildAgentConfigRouter(opts: { restartServer?: () => RestartServerResponse } = {}): Hono {
	const app = new Hono();

	app.get("/agent-config/list", async (c) => {
		const sub = c.req.query("path") ?? "";
		try {
			return c.json(await listAgentDir(sub));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/agent-config/read", async (c) => {
		const target = c.req.query("path")?.trim();
		if (!target) return c.json({ error: "path query param is required" }, 400);
		try {
			return c.json(await readAgentFile(target));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.put("/agent-config/write", async (c) => {
		let body: { path?: string; content?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path || typeof body.content !== "string") return c.json({ error: "path and content are required" }, 400);
		try {
			return c.json(await writeAgentFile(body.path, body.content));
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.delete("/agent-config/path", async (c) => {
		let body: { path?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path) return c.json({ error: "path is required" }, 400);
		try {
			await deleteAgentPath(body.path);
			return c.json({ ok: true });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.get("/agent-config/export", async (c) => {
		try {
			const { zipPath, cleanup } = await exportAgentDirZip();
			const stream = createReadStream(zipPath);
			// Node streams -> web ReadableStream; clean up the temp file once the
			// download finishes or the client disconnects, whichever comes first.
			const body = new ReadableStream({
				start(controller) {
					stream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
					stream.on("end", () => {
						controller.close();
						void cleanup();
					});
					stream.on("error", (err) => {
						controller.error(err);
						void cleanup();
					});
				},
				cancel() {
					stream.destroy();
					void cleanup();
				},
			});
			return new Response(body, {
				headers: {
					"content-type": "application/zip",
					"content-disposition": `attachment; filename="omp-agent-export-${Date.now()}.zip"`,
				},
			});
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/agent-config/import/stage", async (c) => {
		const contentLength = Number(c.req.header("content-length") ?? "0");
		if (contentLength > MAX_UPLOAD_BYTES) {
			return c.json({ error: `upload is over the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` }, 400);
		}
		let form: FormData;
		try {
			form = await c.req.formData();
		} catch {
			return c.json({ error: "expected multipart/form-data with a 'file' field" }, 400);
		}
		const file = form.get("file");
		const mode = form.get("mode");
		if (!(file instanceof File)) return c.json({ error: "file field is required" }, 400);
		if (mode !== "merge" && mode !== "full-reset") return c.json({ error: "mode must be 'merge' or 'full-reset'" }, 400);
		if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: `file is over the ${MAX_UPLOAD_BYTES / 1024 / 1024}MB limit` }, 400);
		try {
			const buffer = Buffer.from(await file.arrayBuffer());
			const plan = await stageImport(buffer, mode);
			return c.json(plan);
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/agent-config/import/:stagingId/apply", async (c) => {
		const stagingId = c.req.param("stagingId");
		try {
			const result = await applyStagedImport(stagingId);
			log.info(`agent-config import applied; restarting to load it`);
			const restart = opts.restartServer?.() ?? { ok: false, message: "Restart is unavailable on this server." };
			return c.json({ ...result, restart });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	app.post("/agent-config/import/:stagingId/discard", async (c) => {
		await discardStagedImport(c.req.param("stagingId"));
		return c.json({ ok: true });
	});

	app.get("/agent-config/backups", async (c) => {
		return c.json({ backups: await listBackups() });
	});

	app.post("/agent-config/backups/restore", async (c) => {
		let body: { path?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "invalid json body" }, 400);
		}
		if (!body.path) return c.json({ error: "path is required" }, 400);
		try {
			const result = await restoreBackup(body.path);
			const restart = opts.restartServer?.() ?? { ok: false, message: "Restart is unavailable on this server." };
			return c.json({ ...result, restart });
		} catch (err) {
			const { status, message } = handleError(err);
			return c.json({ error: message }, status);
		}
	});

	return app;
}
