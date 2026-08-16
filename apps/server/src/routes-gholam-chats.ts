/**
 * Persistent Gholam chat REST surface (§1 of docs/GENERATIVE.md).
 *
 * Mounted under `/gholam/chats` by `routes.ts`. Sibling to the legacy
 * `/api/gholam/*` control surface (`routes-harness.ts`) — that one drives the
 * sidecar's start/stop, priorities, and live heartbeat; this one drives
 * persisted chat history (create/list/read, post messages, cancel, restart,
 * soft-delete).
 *
 * `resolvePrincipal(req)` gates every route. WS-only callers with a sidecar
 * `internal` principal can still read messages on demand (the
 * `?internal=1` query flag) so sidecar bookkeeping doesn't require a
 * cookie-bearing shell.
 */
import { Hono } from "hono";

import type {
	CreateGholamChatMessageRequest,
	CreateGholamChatRequest,
	GholamChat,
	GholamChatMessage,
	ListGholamChatMessagesResponse,
	ListGholamChatsResponse,
	RestartGholamChatRequest,
} from "@omp-deck/protocol";

import { resolvePrincipal } from "./auth/guard.ts";
import { getAuthConfig } from "./auth/config.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { startGholamChat } from "./gholam-chat.ts";
import {
	appendMessage,
	cancelChat,
	createChat,
	getChat,
	listChats,
	listMessages,
	restartChat,
	softDeleteChat,
	updateChatModel,
	updateState,
} from "./gholam-chats.ts";
import { logger } from "./log.ts";

const log = logger("routes:gholam-chats");

function principalFromReq(req: Request): { allowed: boolean; internal: boolean } {
	const cfg = getAuthConfig();
	if (!cfg.enabled) return { allowed: true, internal: false };
	const principal = resolvePrincipal(req, cfg);
	if (!principal) return { allowed: false, internal: false };
	if (principal.kind === "internal") return { allowed: true, internal: true };
	return { allowed: true, internal: false };
}

function requireChat(id: string): GholamChat | Response {
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "chat not found" }, { status: 404 });
	if (chat.deletedAt) return Response.json({ error: "chat deleted" }, { status: 410 });
	return chat;
}

export function buildGholamChatsRouter(): Hono {
	const app = new Hono();

	// LIST ────────────────────────────────────────────────────────────────
	app.get("/gholam/chats", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const cursor = c.req.query("cursor");
		const kind = c.req.query("kind");
		const cwd = c.req.query("cwd");
		const limitRaw = c.req.query("limit");
		const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 50)) : 50;
		try {
			const chats = listChats({
				...(cursor ? { cursor } : {}),
				...(kind === "user" || kind === "auto" || kind === "priority" ? { kind } : {}),
				...(cwd ? { cwd } : {}),
				limit,
			});
			const body: ListGholamChatsResponse = { chats };
			return c.json(body);
		} catch (err) {
			log.error("list chats failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	// READ ONE ────────────────────────────────────────────────────────────
	app.get("/gholam/chats/:id", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const chat = getChat(id);
		if (!chat) return c.json({ error: "chat not found" }, 404);
		return c.json(chat);
	});

	// MESSAGES ────────────────────────────────────────────────────────────
	app.get("/gholam/chats/:id/messages", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const chat = getChat(id);
		if (!chat) return c.json({ error: "chat not found" }, 404);
		const internalFlag = c.req.query("internal") === "1";
		if (chat.deletedAt && !(internalFlag || access.internal)) {
			return c.json({ error: "chat deleted" }, 410);
		}
		const sinceRaw = c.req.query("since");
		const since = sinceRaw !== undefined ? Number.parseInt(sinceRaw, 10) : undefined;
		if (since !== undefined && !Number.isFinite(since)) {
			return c.json({ error: "since must be an integer" }, 400);
		}
		const messages: GholamChatMessage[] = listMessages(id, since);
		const body: ListGholamChatMessagesResponse = { messages };
		return c.json(body);
	});

	// CREATE ──────────────────────────────────────────────────────────────
	app.post("/gholam/chats", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		let body: CreateGholamChatRequest;
		try {
			body = (await c.req.json()) as CreateGholamChatRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.cwd !== "string" || !body.cwd.trim()) {
			return c.json({ error: "cwd required" }, 400);
		}
		if (typeof body.prompt !== "string" || !body.prompt.trim()) {
			return c.json({ error: "prompt required" }, 400);
		}
		try {
			const chat = createChat({
				cwd: body.cwd.trim(),
				prompt: body.prompt,
				...(body.model ? { model: body.model } : {}),
				...(body.title ? { title: body.title } : {}),
				...(body.kind ? { kind: body.kind } : {}),
				...(body.priorityId ? { priorityId: body.priorityId } : {}),
			});
			broadcastBus.broadcast({ type: "gholam_chat_state", chatId: chat.id, state: chat.state, usage: chat.usage });
			// Kick the runtime loop off in the background. The loop persists
			// its own messages; the creator has a stable id to subscribe to.
			startGholamChat(chat.id);
			return c.json(chat, 201);
		} catch (err) {
			log.error("create chat failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	// APPEND USER MESSAGE ────────────────────────────────────────────────
	app.post("/gholam/chats/:id/messages", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const chat = requireChat(id);
		if (chat instanceof Response) return chat;
		let body: CreateGholamChatMessageRequest;
		try {
			body = (await c.req.json()) as CreateGholamChatMessageRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.content !== "string" || !body.content.trim()) {
			return c.json({ error: "content required" }, 400);
		}
		try {
			const msg = appendMessage(id, { role: "user", content: body.content });
			const next = updateState(id, "running") ?? chat;
			broadcastBus.broadcast({
				type: "gholam_chat_message",
				chatId: id,
				message: msg,
			});
			broadcastBus.broadcast({ type: "gholam_chat_state", chatId: id, state: next.state, usage: next.usage });
			startGholamChat(id);
			return c.json({ message: msg, chat: next }, 201);
		} catch (err) {
			log.error("append message failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	// PATCH MODEL ────────────────────────────────────────────────────────
	app.patch("/gholam/chats/:id", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const chat = requireChat(id);
		if (chat instanceof Response) return chat;
		let body: { model?: unknown };
		try { body = await c.req.json(); } catch { return c.json({ error: "invalid json" }, 400); }
		const model = typeof body.model === "string" ? body.model.trim() : "";
		if (!model) return c.json({ error: "model required" }, 400);
		const updated = updateChatModel(id, model);
		if (!updated) return c.json({ error: "chat not found" }, 404);
		broadcastBus.broadcast({ type: "gholam_chat_state", chatId: id, state: updated.state, usage: updated.usage });
		return c.json({ chat: updated });
	});

	// CANCEL ──────────────────────────────────────────────────────────────
	app.post("/gholam/chats/:id/cancel", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const next = cancelChat(id);
		if (!next) return c.json({ error: "chat not found" }, 404);
		broadcastBus.broadcast({ type: "gholam_chat_state", chatId: id, state: next.state, usage: next.usage });
		return c.json(next);
	});

	// RESTART ─────────────────────────────────────────────────────────────
	app.post("/gholam/chats/:id/restart", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const chat = getChat(id);
		if (!chat) return c.json({ error: "chat not found" }, 404);
		let body: RestartGholamChatRequest;
		try {
			body = (await c.req.json()) as RestartGholamChatRequest;
		} catch {
			return c.json({ error: "invalid json" }, 400);
		}
		if (typeof body.prompt !== "string" || !body.prompt.trim()) {
			return c.json({ error: "prompt required" }, 400);
		}
		try {
			const updated = restartChat(id, body.prompt);
			if (!updated) return c.json({ error: "chat not found" }, 404);
			broadcastBus.broadcast({ type: "gholam_chat_state", chatId: id, state: updated.state, usage: updated.usage });
			startGholamChat(id);
			return c.json(updated);
		} catch (err) {
			log.error("restart chat failed", err);
			return c.json({ error: String((err as Error).message ?? err) }, 500);
		}
	});

	// SOFT DELETE ────────────────────────────────────────────────────────
	app.delete("/gholam/chats/:id", async (c) => {
		const access = principalFromReq(c.req.raw);
		if (!access.allowed) return c.json({ error: "unauthorized" }, 401);
		const id = c.req.param("id");
		const ok = softDeleteChat(id);
		if (!ok) return c.json({ error: "chat not found" }, 404);
		broadcastBus.broadcast({ type: "gholam_chat_state", chatId: id, state: "failed", usage: { tokensIn: 0, tokensOut: 0, costMicrocents: 0 } });
		return c.json({ ok: true });
	});

	return app;
}
