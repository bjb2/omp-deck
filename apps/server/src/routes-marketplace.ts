import { Hono } from "hono";
import type {
	AddMarketplaceRequest,
	DryRunInstallRequest,
	DryRunInstallResponse,
	InstallPluginErrorResponse,
	InstallPluginRequest,
	InstallPluginResponse,
	ListMarketplaceResponse,
	ListMarketplaceUpdatesResponse,
	MarketplaceSource,
	UninstallPluginRequest,
	UpgradePluginRequest,
} from "@omp-deck/protocol";

interface SetPluginEnabledBody {
	enabled: boolean;
	scope?: "user" | "project";
}

import { logger } from "./log.ts";
import type { MarketplaceService } from "./marketplace-service.ts";

const log = logger("routes:marketplace");

/**
 * Walk the error chain (current error + each `cause`) and pick the most
 * specific user-facing code. `MarketplaceService` is the only thrower in
 * this surface; raw `git clone` / `Bun.spawn` failures bubble through
 * `err.message` (the SDK wraps them) so message heuristics cover the
 * child-process layer too.
 */
function translateInstallError(err: unknown, ctx: { name: string; marketplace: string }): { status: number; body: InstallPluginErrorResponse } {
	const messages: string[] = [];
	for (let e: unknown = err; e; e = (e as { cause?: unknown })?.cause) {
		if (e instanceof Error && e.message) messages.push(e.message);
		else if (typeof e === "string") messages.push(e);
		else break;
	}
	const haystack = messages.join("\n");
	const message = messages[0] ?? "install failed";
	if (/Marketplace ".*" not found/.test(haystack)) {
		return {
			status: 400,
			body: {
				error: "marketplace_not_found",
				message: `Marketplace "${ctx.marketplace}" not found.`,
				marketplace: ctx.marketplace,
				hint: "Try refreshing the catalog (Refresh button).",
			},
		};
	}
	if (/Plugin ".*" not found in marketplace/.test(haystack)) {
		return {
			status: 400,
			body: {
				error: "plugin_not_found",
				message: `Plugin "${ctx.name}" not found in marketplace "${ctx.marketplace}".`,
				name: ctx.name,
				marketplace: ctx.marketplace,
				hint: "The catalog may be stale. Refresh and try again.",
			},
		};
	}
	if (/is already installed/.test(haystack)) {
		return {
			status: 409,
			body: {
				error: "install_failed",
				message,
				name: ctx.name,
				marketplace: ctx.marketplace,
				hint: "The plugin is already installed. Use force=true to reinstall.",
			},
		};
	}
	if (/relative source path but marketplace.*added via URL/.test(haystack)) {
		return {
			status: 422,
			body: {
				error: "install_failed",
				message,
				name: ctx.name,
				marketplace: ctx.marketplace,
				hint: "The marketplace was added via URL but the plugin uses a relative path. Re-add the marketplace as a git repo.",
			},
		};
	}
	if (/unsupported source type|npm plugin sources/.test(haystack)) {
		return {
			status: 422,
			body: {
				error: "unsupported_source",
				message,
				name: ctx.name,
				marketplace: ctx.marketplace,
				hint: "npm-typed plugin sources are not yet supported by the SDK. Use a git-based source instead.",
			},
		};
	}
	if (/SSL CA cert|Problem with the SSL/i.test(haystack)) {
		return {
			status: 422,
			body: {
				error: "ssl_ca_failed",
				message,
				hint: "Set GIT_SSL_CAINFO or GIT_SSL_NO_VERIFY, then restart the server.",
			},
		};
	}
	if (/fatal:|could not resolve|unable to access|Cloning into/.test(haystack)) {
		const urlMatch = /https?:\/\/\S+/.exec(haystack);
		return {
			status: 422,
			body: {
				error: "git_clone_failed",
				message,
				...(urlMatch ? { url: urlMatch[0] } : {}),
				hint: "Check your network access to github.com and the marketplace repo.",
			},
		};
	}
	return {
		status: 500,
		body: {
			error: "install_failed",
			message,
			name: ctx.name,
			marketplace: ctx.marketplace,
			hint: "Run Test Install to see the full failure.",
		},
	};
}
export function buildMarketplaceRouter(service: MarketplaceService): Hono {
	const app = new Hono();

	app.get("/marketplace", async (c) => {
		try {
			const body: ListMarketplaceResponse = await service.listCatalog();
			return c.json(body);
		} catch (err) {
			log.error(`listCatalog failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/install", async (c) => {
		let body: InstallPluginRequest;
		try {
			body = (await c.req.json()) as InstallPluginRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name || !body.marketplace) {
			return c.json({ error: "name and marketplace are required" }, 400);
		}
		try {
			const installed = await service.install({
				name: body.name,
				marketplace: body.marketplace,
				...(body.scope ? { scope: body.scope } : {}),
				...(body.force ? { force: true } : {}),
			});
			const resp: InstallPluginResponse = { ok: true, installed };
			return c.json(resp);
		} catch (err) {
			log.error(`install failed`, err);
			const translated = translateInstallError(err, { name: body.name, marketplace: body.marketplace });
			return c.json(translated.body, translated.status as 400 | 409 | 422 | 500);
		}
	});

	app.delete("/marketplace/install/:pluginId", async (c) => {
		const pluginId = c.req.param("pluginId");
		if (!pluginId) return c.json({ error: "pluginId is required" }, 400);
		try {
			await service.uninstall({ id: pluginId });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`uninstall failed for ${pluginId}`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/install/dry-run", async (c) => {
		let body: DryRunInstallRequest;
		try {
			body = (await c.req.json()) as DryRunInstallRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.name || !body.marketplace) {
			return c.json({ error: "name and marketplace are required" }, 400);
		}
		try {
			const resp: DryRunInstallResponse = await service.dryRun({
				name: body.name,
				marketplace: body.marketplace,
				...(body.scope ? { scope: body.scope } : {}),
			});
			return c.json(resp);
		} catch (err) {
			log.warn(`install dry-run failed`, err);
			const translated = translateInstallError(err, { name: body.name, marketplace: body.marketplace });
			return c.json(translated.body, translated.status as 400 | 409 | 422 | 500);
		}
	});

	app.post("/marketplace/uninstall", async (c) => {
		let body: UninstallPluginRequest;
		try {
			body = (await c.req.json()) as UninstallPluginRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.id) return c.json({ error: "id is required" }, 400);
		try {
			await service.uninstall({ id: body.id, ...(body.scope ? { scope: body.scope } : {}) });
			return c.json({ ok: true });
		} catch (err) {
			log.error(`uninstall failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/refresh", async (c) => {
		try {
			await service.refresh();
			return c.json({ ok: true });
		} catch (err) {
			log.error(`refresh failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplaces", async (c) => {
		let body: AddMarketplaceRequest;
		try {
			body = (await c.req.json()) as AddMarketplaceRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (!body.source) return c.json({ error: "source is required" }, 400);
		try {
			const added: MarketplaceSource = await service.addMarketplace(body.source);
			return c.json({ ok: true, marketplace: added });
		} catch (err) {
			log.error(`addMarketplace failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.delete("/marketplaces/:name", async (c) => {
		const name = c.req.param("name");
		try {
			await service.removeMarketplace(name);
			return c.json({ ok: true });
		} catch (err) {
			log.error(`removeMarketplace failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/plugins/:id/enabled", async (c) => {
		const id = c.req.param("id");
		if (!id) return c.json({ error: "id is required" }, 400);
		let body: SetPluginEnabledBody;
		try {
			body = (await c.req.json()) as SetPluginEnabledBody;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body?.enabled !== "boolean") {
			return c.json({ error: "enabled must be a boolean" }, 400);
		}
		try {
			await service.setEnabled(id, body.enabled, body.scope);
			return c.json({ ok: true, id, enabled: body.enabled });
		} catch (err) {
			log.error(`setEnabled failed`, err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	app.post("/marketplace/plugins/:id/upgrade", async (c) => {
		const id = c.req.param("id");
		if (!id) return c.json({ error: "id is required" }, 400);
		let body: UpgradePluginRequest = {};
		try {
			const raw = await c.req.json().catch(() => ({}));
			body = (raw ?? {}) as UpgradePluginRequest;
		} catch {
			/* tolerate empty body — scope defaults to undefined */
}
		try {
			const installed = await service.upgradePlugin({
				id,
				...(body.scope ? { scope: body.scope } : {}),
	});
			return c.json({ ok: true, installed });
		} catch (err) {
			log.error(`upgrade failed for ${id}`, err);
			const translated = translateInstallError(err, {
				name: id.split("@")[0] ?? id,
				marketplace: id.split("@")[1] ?? "",
	});
			return c.json(translated.body, translated.status as 400 | 409 | 422 | 500);
}
	});

	app.get("/marketplace/updates", async (c) => {
		try {
			const updates = await service.listUpdates();
			const body: ListMarketplaceUpdatesResponse = { updates };
			return c.json(body);
		} catch (err) {
			log.error("listUpdates failed", err);
			return c.json({ updates: [] }, 200);
}
	});

	return app;
}
