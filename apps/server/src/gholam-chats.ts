/**
 * Persistent Gholam chat history (§1 of docs/GENERATIVE.md).
 *
 * Mirrors the row-→-interface convention from `db/tasks.ts`:
 *   - `ChatRow` / `MessageRow` capture raw SQL columns (snake_case).
 *   - `rowToChat` / `rowToMessage` project them into the camelCase wire shape
 *     declared in `packages/protocol/src/index.ts` (GholamChat / GholamChatMessage).
 *   - All queries go through the shared `getDb()` from `db/index.ts`.
 *
 * Append-only message log: `appendMessage()` is the only writer once a chat
 * exists. `state`/`summary`/`usage_json` mutations go through `updateState()`.
 * Soft-delete is a `deleted_at` stamp; messages cascade on hard delete but
 * survive soft delete (the chat surfaces a redacted tombstone on read).
 */
import type { ChatUsage, GholamChat, GholamChatMessage, GholamChatMessageWire } from "@omp-deck/protocol";

import { getDb, id, nowIso } from "./db/index.ts";

export type GholamChatKind = "user" | "auto" | "priority";
export type GholamChatState =
	| "running"
	| "paused"
	| "awaiting_user"
	| "awaiting_tool"
	| "completed"
	| "failed";

export const GHOLAM_CHAT_STATES: readonly GholamChatState[] = [
	"running",
	"paused",
	"awaiting_user",
	"awaiting_tool",
	"completed",
	"failed",
];

export const GHOLAM_CHAT_KINDS: readonly GholamChatKind[] = ["user", "auto", "priority"];

// ─── Row types ────────────────────────────────────────────────────────────

interface ChatRow {
	id: string;
	title: string;
	kind: string;
	cwd: string;
	model: string | null;
	state: string;
	summary: string | null;
	priority_id: string | null;
	created_at: string;
	updated_at: string;
	deleted_at: string | null;
	usage_json: string | null;
}

interface MessageRow {
	id: string;
	chat_id: string;
	seq: number;
	role: string;
	content: string;
	meta_json: string | null;
	created_at: string;
}

const EMPTY_USAGE: ChatUsage = { tokensIn: 0, tokensOut: 0, costMicrocents: 0 };

function parseUsage(raw: string | null | undefined): ChatUsage {
	if (!raw) return { ...EMPTY_USAGE };
	try {
		const parsed = JSON.parse(raw) as Partial<ChatUsage>;
		return {
			tokensIn: typeof parsed.tokensIn === "number" ? parsed.tokensIn : 0,
			tokensOut: typeof parsed.tokensOut === "number" ? parsed.tokensOut : 0,
			costMicrocents:
				typeof parsed.costMicrocents === "number" ? parsed.costMicrocents : 0,
		};
	} catch {
		return { ...EMPTY_USAGE };
	}
}

function readMeta(raw: string | null | undefined): GholamChatMessageWire["meta"] | undefined {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as GholamChatMessageWire["meta"];
	} catch {
		return undefined;
	}
}

function rowToChat(r: ChatRow): GholamChat {
	const chat: GholamChat = {
		id: r.id,
		title: r.title,
		kind: r.kind as GholamChat["kind"],
		cwd: r.cwd,
		state: r.state as GholamChat["state"],
		usage: parseUsage(r.usage_json),
		createdAt: r.created_at,
		updatedAt: r.updated_at,
	};
	if (r.model !== null) chat.model = r.model;
	if (r.summary !== null) chat.summary = r.summary;
	if (r.priority_id !== null) chat.priorityId = r.priority_id;
	if (r.deleted_at !== null) chat.deletedAt = r.deleted_at;
	return chat;
}

function rowToMessage(r: MessageRow): GholamChatMessage {
	const msg: GholamChatMessage = {
		id: r.id,
		chatId: r.chat_id,
		seq: r.seq,
		role: r.role as GholamChatMessage["role"],
		content: r.content,
		createdAt: r.created_at,
	};
	const meta = readMeta(r.meta_json);
	if (meta !== undefined) msg.meta = meta;
	return msg;
}

const CHAT_COLUMNS =
	"id, title, kind, cwd, model, state, summary, priority_id, created_at, updated_at, deleted_at, usage_json";

const MESSAGE_COLUMNS = "id, chat_id, seq, role, content, meta_json, created_at";

function appendUsage(existing: ChatUsage, add: Partial<ChatUsage> | undefined): ChatUsage {
	if (!add) return existing;
	return {
		tokensIn: existing.tokensIn + (add.tokensIn ?? 0),
		tokensOut: existing.tokensOut + (add.tokensOut ?? 0),
		costMicrocents: existing.costMicrocents + (add.costMicrocents ?? 0),
	};
}

// ─── Chats ───────────────────────────────────────────────────────────────

/** Page chat history newest-first. `cursor` is an ISO `updated_at` from the
 *  previous page's last row. Soft-deleted rows are excluded by default. */
export function listChats(
	opts: { cursor?: string; kind?: GholamChatKind; cwd?: string; limit?: number } = {},
): GholamChat[] {
	const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
	const params: (string | number)[] = [];
	const where: string[] = ["deleted_at IS NULL"];
	if (opts.kind) {
		where.push("kind = ?");
		params.push(opts.kind);
	}
	if (opts.cwd) {
		where.push("cwd = ?");
		params.push(opts.cwd);
	}
	if (opts.cursor) {
		where.push("updated_at < ?");
		params.push(opts.cursor);
	}
	const sql = `SELECT ${CHAT_COLUMNS} FROM gholam_chats WHERE ${where.join(" AND ")}
		ORDER BY updated_at DESC LIMIT ?`;
	params.push(limit);
	const rows = getDb()
		.query<ChatRow, (string | number)[]>(sql)
		.all(...params) as ChatRow[];
	return rows.map(rowToChat);
}

export function getChat(idValue: string): GholamChat | null {
	const row = getDb()
		.query<ChatRow, [string]>(`SELECT ${CHAT_COLUMNS} FROM gholam_chats WHERE id = ?`)
		.get(idValue) as ChatRow | null;
	return row ? rowToChat(row) : null;
}

/**
 * Create a chat row + seed it with the initial user message. Returns the
 * `GholamChat` so the caller has a stable `id` for the runtime loop and the
 * REST broadcast. Caller-side `runGholamChat(chatId, signal)` is responsible
 * for actually driving the LLM — this function just persists state.
 */
export function createChat(input: {
	cwd: string;
	prompt: string;
	model?: string;
	title?: string;
	kind?: GholamChatKind;
	priorityId?: string;
}): GholamChat {
	const db = getDb();
	const chatId = `gc_${id().toLowerCase().slice(0, 22)}`;
	const messageId = `gm_${id().toLowerCase().slice(0, 22)}`;
	const now = nowIso();
	const kind: GholamChatKind = input.kind ?? "user";
	const title = (input.title?.trim() || deriveTitle(input.prompt)).slice(0, 200);
	db.transaction(() => {
		db.prepare<unknown, [string, string, string, string, string | null, string | null, string, string]>(
			`INSERT INTO gholam_chats (id, title, kind, cwd, model, state, summary, priority_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?)`,
		).run(
			chatId,
			title,
			kind,
			input.cwd,
			input.model ?? null,
			input.priorityId ?? null,
			now,
			now,
		);
		// Sequence 1 reserved for the seeding user message.
		db.prepare<unknown, [string, string, string, string]>(
			`INSERT INTO gholam_chat_messages (id, chat_id, seq, role, content, meta_json, created_at)
			 VALUES (?, ?, 1, 'user', ?, NULL, ?)`,
		).run(messageId, chatId, input.prompt.slice(0, 64_000), now);
	})();
	const out = getChat(chatId);
	if (!out) throw new Error(`createChat failed for ${chatId}`);
	return out;
}

/** Append a message after `seq` for a chat. `meta` is serialised as JSON. */
export function appendMessage(
	chatId: string,
	msg: {
		role: GholamChatMessage["role"];
		content: string;
		meta?: GholamChatMessageWire["meta"];
	},
): GholamChatMessage {
	const db = getDb();
	const messageId = `gm_${id().toLowerCase().slice(0, 22)}`;
	const now = nowIso();
	const metaJson = msg.meta ? JSON.stringify(msg.meta) : null;
	let insertedSeq = 0;
	db.transaction(() => {
		const lastSeqRow = db
			.query<{ seq: number | null }, [string]>(
				"SELECT MAX(seq) AS seq FROM gholam_chat_messages WHERE chat_id = ?",
			)
			.get(chatId) as { seq: number | null } | null;
		const nextSeq = (lastSeqRow?.seq ?? 0) + 1;
		db.prepare<unknown, [string, string, number, string, string, string | null, string]>(
			`INSERT INTO gholam_chat_messages (id, chat_id, seq, role, content, meta_json, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).run(messageId, chatId, nextSeq, msg.role, msg.content.slice(0, 256_000), metaJson, now);
		db.prepare<unknown, [string, string]>(
			"UPDATE gholam_chats SET updated_at = ? WHERE id = ?",
		).run(now, chatId);
		insertedSeq = nextSeq;
	})();
	const row = db
		.query<MessageRow, [string]>(
			`SELECT ${MESSAGE_COLUMNS} FROM gholam_chat_messages WHERE id = ?`,
		)
		.get(messageId) as MessageRow | null;
	if (!row) throw new Error(`appendMessage failed for ${messageId}`);
	if (insertedSeq !== row.seq) {
		// Sanity check: the transaction should always have set seq to max+1.
		throw new Error(`seq mismatch on appendMessage: expected ${insertedSeq}, got ${row.seq}`);
	}
	return rowToMessage(row);
}

/** Patch `state` (and optionally `summary` / `usage`). No-op when the chat is
 *  soft-deleted so the row stays tombstoned. */
export function updateState(
	chatId: string,
	state: GholamChatState,
	patch?: { summary?: string; usage?: ChatUsage },
): GholamChat | null {
	const existing = getChat(chatId);
	if (!existing || existing.deletedAt) return null;
	const now = nowIso();
	const nextSummary = patch?.summary ?? existing.summary ?? null;
	const usage = patch?.usage
		? appendUsage(existing.usage, patch.usage)
		: existing.usage;
	getDb()
		.prepare<unknown, [string, string | null, string, string, string]>(
			`UPDATE gholam_chats
			    SET state = ?, summary = ?, updated_at = ?, usage_json = ?
			  WHERE id = ?`,
		)
		.run(state, nextSummary, now, JSON.stringify(usage), chatId);
	return getChat(chatId);
}

/** Append-only delta read. `since` returns rows with `seq > since`. */
export function listMessages(chatId: string, since?: number): GholamChatMessage[] {
	if (since === undefined) {
		const rows = getDb()
			.query<MessageRow, [string]>(
				`SELECT ${MESSAGE_COLUMNS} FROM gholam_chat_messages WHERE chat_id = ?
				 ORDER BY seq ASC`,
			)
			.all(chatId) as MessageRow[];
		return rows.map(rowToMessage);
	}
	const rows = getDb()
		.query<MessageRow, [string, number]>(
			`SELECT ${MESSAGE_COLUMNS} FROM gholam_chat_messages WHERE chat_id = ? AND seq > ?
			 ORDER BY seq ASC`,
		)
		.all(chatId, since) as MessageRow[];
	return rows.map(rowToMessage);
}

/** Mark a chat paused. The runtime loop observes `signal.aborted` and exits. */
export function cancelChat(chatId: string): GholamChat | null {
	return updateState(chatId, "paused");
}

/** Patch the `model` registry ref on a chat row. The runtime loop reads
 *  `chat.model` on every iteration, so the next turn picks up the new
 *  model automatically. No-op on soft-deleted chats. */
export function updateChatModel(chatId: string, model: string): GholamChat | null {
	const existing = getChat(chatId);
	if (!existing || existing.deletedAt) return null;
	getDb()
		.prepare<unknown, [string, string, string]>(
			`UPDATE gholam_chats
			    SET model = ?, updated_at = ?
			  WHERE id = ?`,
		)
		.run(model, nowIso(), chatId);
	return getChat(chatId);
}

/** Patch `meta_json` on an existing message row. Shallow-merges `patch`
 *  into the existing `meta` object so callers can add a single key (e.g.
 *  `{ thinking: "..." }`) without rewriting the whole envelope. Used by
 *  `runGholamChat` to attach the joined reasoning string to the assistant
 *  message after the streaming loop finalizes — the message row was already
 *  written by `appendMessage()` with the visible text, we just enrich it. */
export function updateMessageMeta(
	chatId: string,
	messageId: string,
	patch: GholamChatMessageWire["meta"],
): GholamChatMessage | null {
	const db = getDb();
	const row = db
		.query<MessageRow, [string, string]>(
			`SELECT ${MESSAGE_COLUMNS} FROM gholam_chat_messages
			 WHERE id = ? AND chat_id = ?`,
		)
		.get(messageId, chatId) as MessageRow | null;
	if (!row) return null;
	const current = row.meta_json ? (JSON.parse(row.meta_json) as Record<string, unknown>) : {};
	const merged = { ...current, ...patch };
	db.prepare<unknown, [string, string]>(
		"UPDATE gholam_chat_messages SET meta_json = ? WHERE id = ?",
	).run(JSON.stringify(merged), messageId);
	const updated = db
		.query<MessageRow, [string]>(
			`SELECT ${MESSAGE_COLUMNS} FROM gholam_chat_messages WHERE id = ?`,
		)
		.get(messageId) as MessageRow | null;
	return updated ? rowToMessage(updated) : null;
}

/**
 * Start a new turn on an existing chat. Appends a user message and flips state
 * to `running`. The runtime loop is re-entered by the caller (POST
 * `/api/gholam/chats/:id/restart`). Soft-deleted chats are rejected.
 */
export function restartChat(chatId: string, newPrompt: string): GholamChat | null {
	const existing = getChat(chatId);
	if (!existing || existing.deletedAt) return null;
	const next = appendMessage(chatId, { role: "user", content: newPrompt });
	void next; // persistence is the side-effect we need
	return updateState(chatId, "running");
}

/** Soft-delete: stamp `deleted_at`. Hard delete is not exposed in v1. */
export function softDeleteChat(chatId: string): boolean {
	const existing = getChat(chatId);
	if (!existing) return false;
	const now = nowIso();
	const r = getDb()
		.prepare<unknown, [string, string, string]>(
			"UPDATE gholam_chats SET deleted_at = ?, updated_at = ? WHERE id = ?",
		)
		.run(now, now, chatId);
	return Number(r.changes ?? 0) > 0;
}

// ─── Small helpers ───────────────────────────────────────────────────────

function deriveTitle(prompt: string): string {
	const firstLine = prompt.split("\n", 1)[0]?.trim() ?? "";
	if (!firstLine) return "New chat";
	if (firstLine.length <= 80) return firstLine;
	return `${firstLine.slice(0, 77)}...`;
}
