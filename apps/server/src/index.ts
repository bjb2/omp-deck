// MUST be first — patches Bun.spawn to redirect python.exe → pythonw.exe on
// Windows so the eval-py kernel doesn't pop a console window. See the file's
// own docblock for the full rationale and shape.
import "./silence-python.ts";
import { loadManagedEnvIntoProcess } from "./env-store.ts";

loadManagedEnvIntoProcess();

import type { Server, ServerWebSocket } from "bun";
import * as path from "node:path";

import { InProcessAgentBridge } from "./bridge/in-process.ts";
import { RoutinesRunner } from "./routines-runner.ts";
import { closeDb, openDb } from "./db/index.ts";
import { loadConfig } from "./config.ts";
import { logger } from "./log.ts";
import { resolveBunExecutable } from "./runtime-bun.ts";
import { primeUpdateCheckOnBoot } from "./update-check.ts";
import { buildRouter } from "./routes.ts";
import { initAuthConfig } from "./auth/config.ts";
import { bootstrapAuth } from "./auth/bootstrap.ts";
import {
	isAllowedOrigin,
	isPublicApiPath,
	needsFirstRunSetup,
	resolvePrincipal,
	unauthorizedResponse,
} from "./auth/guard.ts";
import { WsHub, type ConnectionData } from "./ws.ts";
import { MarketplaceService } from "./marketplace-service.ts";
import { marketplaceExtras } from "./marketplace-extras.ts";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { SkillsService } from "./skills-service.ts";
import { startSkillsWatcher } from "./skills-watcher.ts";
import { KbService, resolveKbRoot } from "./kb-service.ts";
import { startKbWatcher } from "./kb-watcher.ts";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { KbProtocolHandler } from "./kb-protocol.ts";
import { getMcpHealthProbe } from "./mcp-health.ts";
import { installStarterSkills } from "./starter-skills.ts";
import { installStarterExtensions } from "./starter-extensions.ts";
import { buildDefaultBridgeSupervisor } from "./bridge-supervisor.ts";
import {
	BrowserNotificationChannel,
	notificationService,
} from "./notifications/index.ts";
import { setGholamCompanion } from "./gholam.ts";
import { gholamOverviewProvider, setGenuiProvider, type GenuiProvider } from "./genui-llm.ts";
import { WebPushChannel } from "./notifications/channels/web-push.ts";
import type { RestartServerResponse } from "@omp-deck/protocol";
import { createHash } from "node:crypto";
import { watch as fsWatch } from "node:fs";

const log = logger("server");

// Deck rebuild state lives in its own module so routes-harness can read it
// without an import cycle. Re-export the setters here for legacy callers.
export { setLatestDeployState, getLatestDeployState } from "./deploy-state.ts";

// ─── Bundle-hash watcher ───────────────────────────────────────────────────────
// Watches the web dist's index.html for content changes and pushes a
// `reload_available` frame so the client can soft-reload with the new
// bundle. Falls back to a full ?v= reload if the soft path is unavailable.
let lastBundleHash: string | undefined;
// Tracks in-flight fetch handlers so `safeShutdown` can wait for them to
// drain before forcing `server.stop(true)` — otherwise an in-progress
// upstream call (`router.fetch(...)` -> SDK agent RPC) would be cut
// mid-await and the client would see a connection-reset rather than a
// graceful response. Capped at the number of concurrent connections
// Bun will accept, which is far below the WS rate limit so memory
// pressure is not a concern.
const inFlight = new Set<Promise<unknown>>();
function watchBundle(distDir: string | undefined, hub: { broadcast: (frame: { type: "reload_available"; bundleHash: string; ts: number }) => void }): void {
	if (!distDir) return;
	const indexHtml = path.join(distDir, "index.html");
	let watcher: ReturnType<typeof fsWatch> | undefined;
	try {
		watcher = fsWatch(indexHtml, { persistent: false }, async () => {
			await emitReload();
		});
	} catch (err) {
		log.warn(`bundle watcher setup failed (${indexHtml})`, err);
		return;
	}
	async function emitReload(): Promise<void> {
		const file = Bun.file(indexHtml);
		if (!(await file.exists())) return;
		const buf = await file.arrayBuffer();
		const hash = createHash("sha256").update(Buffer.from(buf)).digest("hex").slice(0, 16);
		if (hash === lastBundleHash) return;
		lastBundleHash = hash;
		log.info(`web bundle changed; broadcasting reload_available (${hash})`);
		hub.broadcast({ type: "reload_available", bundleHash: hash, ts: Date.now() });
	}
	process.on("beforeExit", () => watcher?.close());
}

async function main(): Promise<void> {
	const config = loadConfig();
	// Wire the SSL CA bundle BEFORE anything that may clone a git source
	// (marketplace plugin install, MCP server install, starter skills).
	marketplaceExtras.applySslFix();
	log.info(`omp-deck server starting`, {
		host: config.host,
		port: config.port,
		defaultCwd: config.defaultCwd,
		webDist: config.webDist,
		devMode: config.devMode,
	});

	// Tell the maintenance-gate extension (~/.omp/agent/extensions/maintenance-gate)
	// that every session this server spawns IS a deck-managed org root, regardless
	// of session cwd. Without this, the extension stays inactive in deck sessions
	// because cwd rarely has the flat-file org markers (inbox/, tasks/, knowledge/)
	// that the upstream detector looks for. Routine agent subprocesses inherit
	// this env via Bun.spawn defaults, so a single set here covers both surfaces.
	//
	// Honors OMP_DECK_MAINTENANCE_GATE_DISABLED (set via Settings → Orientation):
	// when truthy we don't set the org root, so even an unaltered installed copy
	// of the extension stays inactive. The extension itself also checks the flag.
	const gateDisabledRaw = (process.env.OMP_DECK_MAINTENANCE_GATE_DISABLED ?? "").trim().toLowerCase();
	const gateDisabled = ["1", "true", "yes", "on"].includes(gateDisabledRaw);
	if (!process.env.OMP_DECK_ORG_ROOT && !gateDisabled) {
		process.env.OMP_DECK_ORG_ROOT = resolveKbRoot();
	}

	// Register the deck's `kb://` URI handler on the SDK's process-global
	// router so `read kb://system/foo.md` resolves the same way the user's
	// configured KB root (OMP_DECK_KB_ROOT or ~/kb) is served over REST.
	// MUST run before the first `createAgentSession` — the router is a
	// process singleton consulted by the `read` tool on every call.
	InternalUrlRouter.instance().register(new KbProtocolHandler());

	openDb({ path: config.dbPath });

	// Initialize the SDK's global `theme` so tools that reference symbols
	// (e.g. ask -> getDoneOptionLabel -> `theme.status.success`) don't throw
	// "undefined is not an object (evaluating 'theme.status')" when invoked
	// from the deck. `dark` is a built-in theme JSON so no filesystem touch.
	// Without this the `ask` tool fails at the first `askSingleQuestion`
	// call, even though the deck UI doesn't render any SDK glyphs.
	try {
		const darkTheme = await getThemeByName("dark");
		if (darkTheme) setThemeInstance(darkTheme);
	} catch (err) {
		log.warn(`SDK theme init failed; ask tool labels may not render`, err);
	}
	// Sync bundled starter skills into ~/.omp/agent/skills/ before the watcher
	// spins up. Idempotent — never overwrites a user-edited target — so this
	// is safe on every boot. Disable with OMP_DECK_INSTALL_STARTER_SKILLS=0.
	await installStarterSkills();
	await installStarterExtensions();

	// Wire the GenUI LLM provider into `setGenuiProvider` so the overview
	// route (`GET /api/genui/stream?route=/`) renders via `gholamDeckLLM`.
	// The provider captures `config` so the prompt can call
	// `loadOverviewForPrompt({ config })` per request.
	const overviewGenuiProvider: GenuiProvider = {
	complete: (req) => gholamOverviewProvider({ ...req, config }),
};
	setGenuiProvider(overviewGenuiProvider);

	// Register notification channels. Browser broadcasts to whatever's
	// connected right now over the live WebSocket; web-push reaches a closed
	// tab or backgrounded phone via the service worker — the case the mobile
	// PWA install exists to serve, and the one the WS channel structurally
	// cannot cover. Both self-register here without engine changes.
	notificationService.register(new BrowserNotificationChannel());
	notificationService.register(new WebPushChannel());


	const bridge = new InProcessAgentBridge({
		idleTimeoutMs: config.idleTimeoutMs,
		autoStartCommand: config.autoStartCommand,
	});
	// Authentication is resolved against the bind host: a loopback-only dev
	// server stays frictionless, while any non-loopback bind — which is every
	// self-hosted deployment — requires a real account. Must run after openDb,
	// since the bootstrap account and session table live in that database.
	const authConfig = initAuthConfig(config.host);
	await bootstrapAuth(authConfig, config.host);

	const routinesRunner = new RoutinesRunner();
	routinesRunner.start();
	// Boot the MCP health probe so the WS broadcast loop is alive before
	// the first user request hits /api/mcp/health. Without this the badge
	// in the chrome StatusBar stays empty until a manual probe request.
	getMcpHealthProbe().start();
	let server: Server<ConnectionData>;
	const supervisor = buildDefaultBridgeSupervisor();
	const marketplaceService = new MarketplaceService();
	const skillsService = new SkillsService(config, marketplaceService);
	const kbService = new KbService({ root: resolveKbRoot() });
	const router = buildRouter(
		bridge,
		config,
		routinesRunner,
		supervisor,
		marketplaceService,
		skillsService,
		kbService,
		{ restartServer: () => scheduleRestart(server) },
	);

	// Seed the canonical Anthropic marketplace on first boot. The deck ships
	// no marketplace registry, so a fresh container boots with an empty
	// catalog and the marketplace / storefront / prompts-discover /
	// discovery-search surfaces all show empty. Idempotent: only runs when
	// the registry has zero entries, so user-added marketplaces and later
	// boots both no-op. Non-fatal: network/SSL failures are logged and
	// swallowed so a broken seed never blocks the HTTP listener from
	// coming up — the marketplace surface can recover later via POST
	// /api/marketplaces (which now runs ensureSslFix itself).
	try {
		if (await marketplaceService.isRegistryEmpty()) {
			await marketplaceService.addMarketplace(
				"https://github.com/anthropics/claude-plugins-official.git",
			);
			log.info(`seeded canonical marketplace: anthropics/claude-plugins-official`);
		}
	} catch (err) {
		log.warn(`marketplace seed skipped`, err);
	}

	const skillsWatcherDispose = startSkillsWatcher(config);
	const kbWatcherDispose = startKbWatcher(kbService);
	const ws = new WsHub(bridge);
	routinesRunner.setWsHub(ws);
	setGholamCompanion({ bridge, wsHub: ws });

	server = Bun.serve<ConnectionData>({
		hostname: config.host,
		port: config.port,
		fetch(req, srv) {
			const url = new URL(req.url);

			// ── Authentication gate ──────────────────────────────────────
			//
			// Everything that carries privilege converges here: the API, the
			// WebSocket that drives agent sessions, and the uploads reader.
			// Gating inside the Hono router alone would leave /ws and
			// /uploads open, so the check lives at the one point all three
			// share.
			//
			// Static assets stay ungated on purpose — the SPA bundle holds
			// no secrets, and serving it anonymously is what allows a login
			// screen to render at all.
			const privileged =
				url.pathname === "/ws" ||
				url.pathname.startsWith("/api/") ||
				url.pathname.startsWith("/uploads/") ||
				url.pathname.startsWith("/hooks/") ||
				// Completing a provider sign-in writes credentials into the agent's
				// auth store, so the landing alias is gated like the API it proxies.
				url.pathname === "/oauth/callback";

			if (authConfig.enabled && privileged && !isPublicApiPath(url.pathname)) {
				if (!isAllowedOrigin(req, authConfig, config.publicUrl)) {
					return new Response(
						JSON.stringify({ error: "forbidden", message: "Cross-origin request rejected." }),
						{ status: 403, headers: { "content-type": "application/json; charset=utf-8" } },
					);
				}
				if (!resolvePrincipal(req, authConfig)) {
					// 401 on the socket too. A browser can't read the body of a
					// failed upgrade, but the status is what the client's retry
					// logic needs to tell "signed out" from "server down".
					return unauthorizedResponse(
						needsFirstRunSetup()
							? "This deck has no account yet. Open it in this browser to finish setup."
							: "Sign in to use the deck.",
					);
				}
			}

			if (url.pathname === "/ws") {
				const data = ws.createConnectionData();
				const upgraded = srv.upgrade(req, { data });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname.startsWith("/api/")) {
				const trimmed = new URL(req.url);
				trimmed.pathname = url.pathname.slice(4) || "/";
				// Track in-flight router work so safeShutdown can drain
				// it. The promise removes itself from the set in its own
				// finally — a throw or hang still cleans up.
				const work = Promise.resolve().then(() =>
					router.fetch(new Request(trimmed.toString(), req)),
				);
				inFlight.add(work);
				work.finally(() => inFlight.delete(work));
				return work as unknown as Promise<Response>;
			}

			// Short alias for the OAuth landing route. A provider redirect that
			// died on the browser's own `localhost:54545` can be completed by
			// editing just the host of that URL, so the path after the host has
			// to match what the provider produced: `/callback?code=…`. Nesting it
			// under `/api/auth/oauth/` would mean retyping the path too.
			if (url.pathname === "/oauth/callback") {
				const rewritten = new URL(req.url);
				rewritten.pathname = "/auth/oauth/callback";
				const work = Promise.resolve().then(() =>
					router.fetch(new Request(rewritten.toString(), req)),
				);
				inFlight.add(work);
				work.finally(() => inFlight.delete(work));
				return work as unknown as Promise<Response>;
			}

			// Pasted-image uploads. The uploads route returns URLs rooted at
			// `/uploads/...` so they work for both browser <img src> and agent-
			// written markdown. Stream the file straight off disk; reject path
			// traversal the same way the SPA static handler does.
			if (url.pathname.startsWith("/uploads/")) {
				return serveUpload(req, config.uploadsRoot);
			}

			// Serve built web assets if a dist directory is available; otherwise
			// fall back to the landing stub. Vite dev server proxies through us
			// for /api and /ws, so its own routes never reach this branch.
			if (config.webDist) {
				return serveStatic(req, config.webDist);
			}

			if (url.pathname === "/" || url.pathname === "/index.html") {
				return new Response(LANDING_HTML, {
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			}

			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(socket: ServerWebSocket<ConnectionData>) {
				ws.onOpen(socket);
			},
			async message(socket: ServerWebSocket<ConnectionData>, raw) {
				await ws.onMessage(socket, raw as string | Buffer);
			},
			close(socket: ServerWebSocket<ConnectionData>) {
				ws.onClose(socket);
			},
			perMessageDeflate: false,
		},
	});

	log.info(`listening on http://${server.hostname}:${server.port}`);
	watchBundle(config.webDist, ws);

	// Background: prime the npm registry update check cache so the
	// /api/version route returns a real answer on first call. Fire-and-
	// forget; failures are logged and ignored.
	primeUpdateCheckOnBoot();

	let shuttingDown = false;
	async function safeShutdown(reason: string): Promise<void> {
		if (shuttingDown) return;
		shuttingDown = true;
		log.info(`shutdown via ${reason}`);
		// Drain in-flight HTTP work before tearing down the router.
		// `server.stop(true)` (called from the signal handlers right
		// after this returns) closes the listening socket immediately
		// — any handler still mid-await on router.fetch would be cut
		// off, surfacing as a connection-reset to the caller. Give
		// them up to 10s to finish naturally. `allSettled` so a slow
		// failing handler doesn't prevent shutdown entirely; the
		// remaining ones are reaped when `server.stop(true)` runs.
		const drainDeadlineMs = 10_000;
		const drainStart = Date.now();
		const inflightSnapshot = Array.from(inFlight);
		if (inflightSnapshot.length > 0) {
			log.info(`draining ${inflightSnapshot.length} in-flight request(s) before shutdown`);
			await Promise.race([
				Promise.allSettled(inflightSnapshot),
				new Promise<void>((resolve) => setTimeout(resolve, drainDeadlineMs)),
			]);
			const elapsedMs = Date.now() - drainStart;
			const stillPending = inFlight.size;
			if (stillPending > 0) {
				log.warn(
					`drain reached ${drainDeadlineMs}ms with ${stillPending} request(s) still in-flight; ` +
						`elapsed=${elapsedMs}ms — proceeding with shutdown`,
				);
			} else {
				log.info(`drain complete in ${elapsedMs}ms`);
			}
		}
		try {
			routinesRunner.dispose();
		} catch (err) {
			log.error(`runner dispose threw`, err);
		}
		try {
			skillsWatcherDispose();
		} catch (err) {
			log.error(`skills watcher dispose threw`, err);
		}
		try {
			kbWatcherDispose();
		} catch (err) {
			log.error(`kb watcher dispose threw`, err);
		}
		try {
			await supervisor.shutdown();
		} catch (err) {
			log.error(`bridge supervisor shutdown threw`, err);
		}
		try {
			await bridge.dispose();
		} catch (err) {
			log.error(`bridge dispose threw`, err);
		}
		try {
			closeDb();
		} catch (err) {
			log.error(`db close threw`, err);
		}
	}

	process.once("SIGINT", () => {
		void safeShutdown("SIGINT").then(() => {
			server.stop(true);
			process.exit(0);
		});
	});
	process.once("SIGTERM", () => {
		void safeShutdown("SIGTERM").then(() => {
			server.stop(true);
			process.exit(0);
		});
	});
	// Last-resort safety net for non-signal exit paths (Bun crash, unhandled
	// rejection escalated to abort, etc). beforeExit fires when the loop drains.
	process.on("beforeExit", () => {
		void safeShutdown("beforeExit");
	});
}

function scheduleRestart(server: Server<ConnectionData>): RestartServerResponse {
	// `process.execPath` directly here would suffer the same staleness issue
	// as the bridge supervisor (issue #6 — user's bun moves between deck
	// start and restart). Route through the shared resolver which falls back
	// to a PATH lookup if the captured execPath is gone.
	const cmd = [resolveBunExecutable(), ...process.argv.slice(1)];
	const cwd = process.cwd();
	setTimeout(() => {
		log.info(`restart requested`, { cmd });
		try {
			server.stop(true);
		} catch (err) {
			log.warn(`server stop before restart failed`, err);
		}
		const env = Object.fromEntries(
			Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
		);
		const child = Bun.spawn({
			cmd,
			cwd,
			env,
			stdin: "ignore",
			stdout: "inherit",
			stderr: "inherit",
			detached: true,
		});
		child.unref();
		setTimeout(() => process.exit(0), 80);
	}, 100);
	return { ok: true, message: "Restart scheduled" };
}

const LANDING_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>omp-deck server</title>
<style>body{font-family:system-ui;max-width:48em;margin:4em auto;padding:0 1em;color:#e6edf3;background:#0d1117}code{background:#161b22;padding:.1em .4em;border-radius:.3em}a{color:#58a6ff}</style>
</head><body>
<h1>omp-deck server</h1>
<p>Backend is running. The browser UI is served by the <code>@omp-deck/web</code> Vite dev server (typically <a href="http://127.0.0.1:5173">http://127.0.0.1:5173</a> in dev), or the built static assets in production.</p>
<p>API base: <code>/api</code> &nbsp;&nbsp; WebSocket: <code>/ws</code></p>
</body></html>`;

main().catch((err) => {
	log.error(`fatal`, err);
	process.exit(1);
});

async function serveStatic(req: Request, root: string): Promise<Response> {
	const url = new URL(req.url);
	let rel = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
	if (rel === "" || rel === "index.html") rel = "index.html";

	// Reject path traversal.
	if (rel.includes("..")) return new Response("forbidden", { status: 403 });

	const full = path.join(root, rel);
	const resolved = path.resolve(full);
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved)) {
		return new Response("forbidden", { status: 403 });
	}

	const direct = Bun.file(resolved);
	if (await direct.exists()) {
		// HTML must revalidate so the latest bundle is picked up; hashed
		// assets (vite writes /assets/<name>-<hash>.js) are immutable.
		const headers: Record<string, string> = {};
		if (rel.endsWith(".html")) {
			headers["cache-control"] = "no-cache, must-revalidate";
		} else if (/\.(js|css|svg|woff2)$/.test(rel)) {
			headers["cache-control"] = "public, max-age=31536000, immutable";
		}
		return new Response(direct, headers);
	}

	// SPA fallback — serve index.html so client-side routing works.
	const index = Bun.file(path.join(rootResolved, "index.html"));
	if (await index.exists()) {
		return new Response(index, {
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-cache, must-revalidate",
			},
		});
	}
	return new Response("not found", { status: 404 });
}

/**
 * Serve a file from the uploads root. URL prefix `/uploads/` strips before
 * resolving, so `/uploads/2026/05/abc.png` maps to `<uploadsRoot>/2026/05/abc.png`.
 * No SPA fallback — a 404 here means the URL is bad.
 *
 * Path-traversal protection mirrors `serveStatic`: any `..` in the relative
 * path is rejected outright, and the resolved absolute path must remain
 * inside `uploadsRoot`.
 */
async function serveUpload(req: Request, root: string): Promise<Response> {
	const url = new URL(req.url);
	const rel = decodeURIComponent(url.pathname.replace(/^\/+uploads\/+/, ""));
	if (!rel || rel.includes("..")) return new Response("forbidden", { status: 403 });

	const resolved = path.resolve(path.join(root, rel));
	const rootResolved = path.resolve(root);
	if (!resolved.startsWith(rootResolved + path.sep) && resolved !== rootResolved) {
		return new Response("forbidden", { status: 403 });
	}

	const file = Bun.file(resolved);
	if (await file.exists()) {
		// Long-lived caching is safe because the on-disk filename is content-
		// addressed (sha256 prefix). If the bytes change, the URL changes.
		return new Response(file, {
			headers: { "cache-control": "public, max-age=31536000, immutable" },
		});
	}
	return new Response("not found", { status: 404 });
}
