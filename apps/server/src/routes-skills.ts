/**
 * /api/skills — skill enumeration across every omp provider.
 *
 * - `GET /api/skills?cwd=<abs>` lists every skill `loadCapability(skillCapability.id)`
 *   returns, native-first.
 * - `GET /api/skills/:id?cwd=<abs>` returns one skill's body + co-located files.
 *   `id` is the server-issued opaque identifier carried on every list row;
 *   clients never construct it from parts.
 * - `POST /api/skills/:id/enable` flips the SKILL.md `hide:` frontmatter
 *   key to `false`.
 * - `POST /api/skills/:id/disable` flips `hide:` to `true`.
 * - `DELETE /api/skills/:id` removes the skill directory.
 * - `POST /api/skills/:id/update` re-writes SKILL.md from a new source.
 *
 * All mutations refuse to touch skills owned by a marketplace plugin — the
 * SDK loader would just overwrite them on next refresh.
 */

import { Hono } from "hono";

import { logger } from "./log.ts";
import type { SkillsService } from "./skills-service.ts";

const log = logger("routes:skills");

export function buildSkillsRouter(service: SkillsService): Hono {
	const app = new Hono();

	app.get("/skills", async (c) => {
		const cwd = c.req.query("cwd");
		try {
			const body = await service.listSkills(cwd);
			return c.json(body);
		} catch (err) {
			log.error(`listSkills failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.get("/skills/:id", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ error: "id is required" }, 400);
		try {
			const detail = await service.getSkillDetail(id, cwd);
			if (!detail) return c.json({ error: "skill not found" }, 404);
			return c.json(detail);
		} catch (err) {
			log.error(`getSkillDetail failed`, err);
			return c.json({ error: String(err) }, 500);
		}
	});

	app.post("/skills/:id/enable", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ ok: false, error: "id is required" }, 400);
		try {
			const updated = await service.setEnabled(id, true, cwd);
			if (!updated) return c.json({ ok: false, error: "skill not found or owned by plugin" }, 404);
			return c.json({ ok: true, skill: updated });
		} catch (err) {
			log.error(`setEnabled failed for ${id}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	app.post("/skills/:id/disable", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ ok: false, error: "id is required" }, 400);
		try {
			const updated = await service.setEnabled(id, false, cwd);
			if (!updated) return c.json({ ok: false, error: "skill not found or owned by plugin" }, 404);
			return c.json({ ok: true, skill: updated });
		} catch (err) {
			log.error(`setEnabled failed for ${id}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	app.delete("/skills/:id", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ ok: false, error: "id is required" }, 400);
		try {
			const removed = await service.remove(id, cwd);
			if (!removed) return c.json({ ok: false, error: "skill not found or owned by plugin" }, 404);
			return c.json({ ok: true, ...removed });
		} catch (err) {
			log.error(`remove failed for ${id}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	app.post("/skills/:id/update", async (c) => {
		const id = c.req.param("id");
		const cwd = c.req.query("cwd");
		if (!id) return c.json({ ok: false, error: "id is required" }, 400);
		let body: { source?: string };
		try {
			body = (await c.req.json()) as { source?: string };
		} catch {
			return c.json({ ok: false, error: "invalid JSON body" }, 400);
		}
		try {
			const result = await service.update(id, { ...body, cwd });
			if (!result.ok) {
				const status = result.error === "skill not found" ? 404 : 400;
				return c.json({ ok: false, error: result.error }, status);
			}
			return c.json({ ok: true, path: result.path });
		} catch (err) {
			log.error(`update failed for ${id}`, err);
			const msg = err instanceof Error ? err.message : String(err);
			return c.json({ ok: false, error: msg }, 500);
		}
	});

	return app;
}
