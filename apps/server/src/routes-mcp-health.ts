import { Hono } from "hono";

import type { McpHealthResponse } from "@omp-deck/protocol";

import type { McpHealthProbe } from "./mcp-health.ts";

export function buildMcpHealthRouter(probe: McpHealthProbe): Hono {
	const app = new Hono();
	app.get("/mcp/health", (c) => {
		const body: McpHealthResponse = {
			status: probe.snapshot(),
			probedAt: new Date().toISOString(),
		};
		return c.json(body);
	});
	// ponytail: one route. `runOnce` is the only entry point the UI needs to
	// nudge the loop; no schema, no payload. The probe itself broadcasts
	// `mcp_health` after each cycle so the UI just re-renders.
	app.post("/mcp/probe-now", (c) => {
		void probe.runOnce();
		return c.json({ ok: true });
	});
	return app;
}
