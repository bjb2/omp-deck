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
	return app;
}
