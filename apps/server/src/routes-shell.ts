/**
 * In-deck shell routes. Wraps `shell-service.ts` over HTTP:
 *
 *   GET    /api/shell              — list all shells (running + recently exited)
 *   POST   /api/shell              — create a shell { command, cwd? }
 *   GET    /api/shell/:id          — single shell summary
 *   GET    /api/shell/:id/tail     — last ~64KB of captured stdout/stderr (JSON { text })
 *   POST   /api/shell/:id/input    — write a line to stdin { input }
 *   DELETE /api/shell/:id          — kill (SIGTERM)
 *   GET    /api/shell/:id/stream   — SSE stream of chunks; emits `[exit N]` last
 *
 * SSE framing: `data: <chunk>\n\n`. Each `chunk` is a UTF-8 string,
 * already color-marked (stderr chunks wrapped in ANSI yellow).
 *
 * Cwd guard: `cwd` is path-guard validated (workspace or agent dir roots)
 * by `shell-service.resolveCwd`. Clients may send empty/absent cwd to
 * fall back to OMP_DECK_DEFAULT_CWD.
 *
 * Loopback-only by convention — the transport-level auth gate covers
 * non-loopback hosts. No additional middleware here.
 */
import { Hono } from "hono";
import { logger } from "./log.ts";
import { shell } from "./shell-service.ts";

const log = logger("routes-shell");

interface CreateBody {
	command?: unknown;
	cwd?: unknown;
}

interface InputBody {
	input?: unknown;
}

function handleShellError(err: unknown): { status: 400 | 500; message: string } {
	if (err instanceof Error && /cwd not under/.test(err.message)) {
		return { status: 400, message: err.message };
	}
	log.error("shell route error", err);
	return { status: 500, message: "internal error" };
}

export function buildShellRouter(): Hono {
	const app = new Hono();

	app.get("/shell", (c) => c.json({ shells: shell.list() }));

	app.post("/shell", async (c) => {
		const body = (await c.req.json().catch(() => ({}))) as CreateBody;
		const command = typeof body.command === "string" ? body.command : "";
		const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
		const result = shell.create(command, cwd);
		if (!result.ok) {
			const { status, message } = handleShellError(new Error(result.error));
			return c.json({ error: message }, status);
		}
		return c.json({ ok: true, process: result.process }, 201);
	});

	app.get("/shell/:id", (c) => {
		const id = c.req.param("id");
		const s = shell.get(id);
		if (!s) return c.json({ error: "not found" }, 404);
		return c.json(s);
	});

	app.get("/shell/:id/tail", (c) => {
		const id = c.req.param("id");
		const buf = shell.tail(id);
		if (!buf) return c.json({ text: "", status: "unknown" });
		const summary = shell.get(id);
		return c.json({ text: buf.toString("utf-8"), status: summary?.status ?? "unknown" });
	});

	app.post("/shell/:id/input", async (c) => {
		const id = c.req.param("id");
		const body = (await c.req.json().catch(() => ({}))) as InputBody;
		const input = typeof body.input === "string" ? body.input : "";
		const result = shell.write(id, input);
		if (!result.ok) return c.json({ error: result.error ?? "write failed" }, 400);
		return c.json({ ok: true });
	});

	app.delete("/shell/:id", (c) => {
		const id = c.req.param("id");
		const result = shell.kill(id);
		if (!result.ok) return c.json({ error: result.error ?? "kill failed" }, 400);
		return c.json({ ok: true });
	});

	app.get("/shell/:id/stream", (c) => {
		const id = c.req.param("id");
		const summary = shell.get(id);
		if (!summary) return c.json({ error: "not found" }, 404);

		let unsubscribe: (() => void) | null = null;
		let heartbeat: ReturnType<typeof setInterval> | null = null;
		let closed = false;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const encoder = new TextEncoder();
				const send = (data: string): void => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(`data: ${data}\n\n`));
					} catch {
						close();
					}
				};

				const initial = shell.tail(id);
				if (initial && initial.length > 0) send(initial.toString("utf-8"));

				unsubscribe = shell.subscribe(id, (chunk) => send(chunk));

				heartbeat = setInterval(() => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(": ping\n\n"));
					} catch {
						close();
					}
					const s = shell.get(id);
					if (s?.status === "exited" && heartbeat) {
						clearInterval(heartbeat);
						heartbeat = null;
						setTimeout(close, 250);
					}
				}, 15_000);

				const close = (): void => {
					if (closed) return;
					closed = true;
					if (unsubscribe) { unsubscribe(); unsubscribe = null; }
					if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
					try { controller.close(); } catch { /* already closed */ }
				};
			},
			cancel() {
				closed = true;
				if (unsubscribe) { unsubscribe(); unsubscribe = null; }
				if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				"connection": "keep-alive",
				"x-accel-buffering": "no",
			},
		});
	});

	return app;
}
