/**
 * Gholam chat runtime loop (§1 of docs/GENERATIVE.md).
 *
 * Drives one chat at a time: pull chat history + persisted messages,
 * dispatch to the LLM registry, gate any tool calls through the permissions
 * surface, persist every delta, then loop until the model stops emitting
 * tool calls or the user cancels (`signal.aborted`).
 *
 * Each iteration is append-only — every assistant text, every tool call,
 * every tool result lands in `gholam_chat_messages` before the next move.
 * Cost telemetry is aggregated into `gholam_chats.usage_json` and broadcast
 * via `gholam_chat_usage` so the inspector pane updates without polling.
 *
 * Tool-call dispatch goes straight to the in-process deck MCP runtime
 * (`./gholam-mcp-runtime.ts`) — same process, no socket hop. The deck
 * `gholam.edit()` path keeps using the `gholam.ts` sidecar frame; only the
 * chat runtime loop runs tools inline.
 */
import type { GholamChatMessage } from "@omp-deck/protocol";

import { broadcastBus } from "./broadcast-bus.ts";
import { checkGholamFramePermissions } from "./auth/gholam-permissions.ts";
import { appendMessage, getChat, listMessages, restartChat, updateState } from "./gholam-chats.ts";
import { updateMessageMeta } from "./gholam-chats.ts";
import { gholamDeckLLM } from "./llm-registry.ts";
import type { LlmChunk, LlmToolSpec } from "./llm-registry.ts";
import { callGholamMcpTool, loadGholamMcpTools } from "./gholam-mcp-runtime.ts";
import { logger } from "./log.ts";

const log = logger("gholam-chat");

const MAX_LOOP_ITERATIONS = 25;
/** Deck-side MCP tool specs, cached briefly so a long chat doesn't re-hit
 *  the mcp.json loader on every iteration. 60s covers a normal chat; longer
 *  tool installs pick up on the next chat. */
const MCP_TOOLS_TTL_MS = 60_000;
let mcpToolsCache: { specs: LlmToolSpec[]; expiresAt: number } | undefined;

type LlmMessageInput = Parameters<typeof gholamDeckLLM.complete>[0]["messages"];

function messagesToLlm(rows: GholamChatMessage[]): LlmMessageInput {
	return rows.flatMap((r): LlmMessageInput => {
		if (r.role === "tool_call") {
			const meta = (r.meta ?? {}) as { tool?: string; toolCallId?: string; requiredPermissions?: string[] };
			let args: Record<string, unknown> = {};
			try {
				const parsed = JSON.parse(r.content) as Record<string, unknown>;
				if (parsed && typeof parsed === "object") args = parsed;
			} catch {
				/* tool_call content wasn't JSON — surface as empty args */
			}
			// SDK `toolCall.id` is the canonical pairing key. Mirror it on the
			// `toolCallId` field (added in v1) so downstream `llmMessagesToSdk`
			// doesn't have to re-derive it.
			// `meta.tool` carries the SDK-returned `serverName::toolName`
			// pairing. Forward it on both `name` and `toolCall.tool` so the
			// downstream SDK re-parses for the actual server split.
			const toolCallId = meta.toolCallId ?? r.id;
			const toolName = meta.tool ?? "";
			return [{
				role: "tool_call",
				content: r.content,
				...(toolCallId ? { toolCallId } : {}),
				name: toolName,
				toolCall: {
					id: toolCallId,
					tool: toolName,
					args,
					...(meta.requiredPermissions ? { requiredPermissions: meta.requiredPermissions } : {}),
				},
			}];
		}
		if (r.role === "tool_result") {
			const meta = (r.meta ?? {}) as { toolCallId?: string; tool?: string };
			return [{
				role: "tool_result",
				content: r.content,
				// Prefer the typed pairing key; `name` is preserved for legacy rows
				// that wrote the id there. Both fields set so the SDK's
				// `ToolResultMessage.toolCallId` resolver (see
				// `apps/server/src/llm-registry.ts#llmMessagesToSdk`) lands on the
				// new field.
				...(meta.toolCallId ? { toolCallId: meta.toolCallId, name: meta.toolCallId } : {}),
			}];
		}
		if (r.role === "user" || r.role === "assistant" || r.role === "system") {
			return [{ role: r.role, content: r.content }];
		}
		// 'tool_call', 'tool_result', 'note' handled above; anything else (note)
		// is internal scaffolding the LLM doesn't need.
		return [];
	});
}

function persistAssistantText(chatId: string, text: string, model: string | undefined): GholamChatMessage {
	const meta = model ? { model } : undefined;
	return appendMessage(chatId, {
		role: "assistant",
		content: text,
		...(meta ? { meta } : {}),
	});
}

/** Attach the joined SDK reasoning buffer to an existing assistant message's
 *  `meta_json.thinking`. Called after `persistAssistantText()` writes the
 *  visible text — `appendMessage` is append-only and we don't have the row
 *  id until after it returns. No-op when the update fails (row deleted,
 *  chat soft-tombstoned) so the runtime loop still resolves cleanly. */
function attachThinkingToMessage(chatId: string, messageId: string, thinking: string): void {
	const updated = updateMessageMeta(chatId, messageId, { thinking });
	if (!updated) {
		log.warn(`attachThinkingToMessage: message ${messageId} not found in chat ${chatId}`);
	}
}

function persistToolCall(
	chatId: string,
	tc: Extract<LlmChunk, { type: "tool_call" }>,
): GholamChatMessage {
	const content = JSON.stringify(tc.args);
	return appendMessage(chatId, {
		role: "tool_call",
		content,
		meta: {
			tool: tc.tool,
			toolCallId: tc.id,
			...(tc.requiredPermissions ? { requiredPermissions: tc.requiredPermissions } : {}),
		},
	});
}

function persistToolResult(chatId: string, tc: Extract<LlmChunk, { type: "tool_call" }>, reply: unknown): GholamChatMessage {
	return appendMessage(chatId, {
		role: "tool_result",
		content: JSON.stringify(reply),
		meta: { tool: tc.tool, toolCallId: tc.id },
	});
}

/** Invoke a deck MCP tool directly in-process. Replaces the old sidecar
 *  `mcp_call` round-trip — the runtime runs inside the same process as the
 *  deck, so the WebSocket hop bought nothing and added a 30s failure
 *  surface. Splits `tc.tool` on `::` into `[serverName, toolName]`. */
async function callDeckMcp(
	tc: Extract<LlmChunk, { type: "tool_call" }>,
	signal: AbortSignal,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
	const [serverName, toolName] = tc.tool.split("::");
	if (!serverName || !toolName) {
		return { ok: false, error: `malformed_tool_name:${tc.tool}` };
	}
	if (signal.aborted) return { ok: false, error: "aborted" };
	try {
		const result = await callGholamMcpTool(serverName, toolName, tc.args, signal);
		return { ok: true, result };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: msg };
	}
}

/**
 * Drive one chat to completion (or pause / failure / cancel). Resolves when
 * the loop exits. Idempotent over `signal.aborted` — calling twice cancels
 * the prior run cleanly.
 */
export async function runGholamChat(chatId: string, signal: AbortSignal): Promise<void> {
	const chat = getChat(chatId);
	if (!chat) {
		log.warn(`runGholamChat: chat ${chatId} not found`);
		return;
	}
	const model = chat.model ?? process.env.OMP_DECK_DEFAULT_MODEL ?? "minimax/MiniMax-M3";

	// Lazy refresh the MCP tool cache. Missing file or loader error → fall
	// back to a tool-less run, matching the previous behaviour before MCP
	// wiring landed.
	const now = Date.now();
	let toolSpecs: LlmToolSpec[] | undefined;
	if (!mcpToolsCache || mcpToolsCache.expiresAt <= now) {
		try {
			const tools = await loadGholamMcpTools();
			toolSpecs = tools.map((t) => ({
				name: `${t.server}::${t.name}`,
				description: t.description ?? "",
				schema: (t.inputSchema ?? {}) as Record<string, unknown>,
			}));
			mcpToolsCache = { specs: toolSpecs, expiresAt: now + MCP_TOOLS_TTL_MS };
		} catch (err) {
			log.warn(`loadGholamMcpTools failed; running without tools`, err);
		}
	} else {
		toolSpecs = mcpToolsCache.specs;
	}

	try {
		for (let i = 0; i < MAX_LOOP_ITERATIONS && !signal.aborted; i++) {
			const prior = listMessages(chatId);
			const llmMessages = messagesToLlm(prior);

			const completeOpts = toolSpecs && toolSpecs.length > 0
				? { model, messages: llmMessages, tools: toolSpecs, signal }
				: { model, messages: llmMessages, signal };

			const toolCalls: Extract<LlmChunk, { type: "tool_call" }>[] = [];
			let assistantText = "";
			let thinkingBuffer = "";
			let sawError: string | undefined;
			for await (const chunk of gholamDeckLLM.complete(completeOpts)) {
			if (signal.aborted) break;
				if (chunk.type === "text") {
					assistantText += chunk.delta;
			} else if (chunk.type === "thinking") {
				thinkingBuffer += chunk.delta;
				} else if (chunk.type === "tool_call") {
					toolCalls.push(chunk);
				} else if (chunk.type === "error") {
					sawError = chunk.error;
			}
				}
				if (signal.aborted) break;

			if (assistantText && toolCalls.length === 0) {
			const msg = persistAssistantText(chatId, assistantText, model);
			// Attach the joined reasoning string to the just-persisted assistant
			// row. Empty buffer means the SDK didn't surface reasoning; skip the
			// write so the meta_json stays clean.
			if (thinkingBuffer) attachThinkingToMessage(chatId, msg.id, thinkingBuffer);
				updateState(chatId, "awaiting_user");
				broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "awaiting_user" });
				return;
			}
			if (sawError) {
				appendMessage(chatId, {
					role: "note",
					content: `runtime error: ${sawError}`,
					meta: { error: sawError, ...(model ? { model } : {}) },
				});
				updateState(chatId, "failed");
				broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "failed" });
				return;
			}
			if (assistantText) {
			const msg = persistAssistantText(chatId, assistantText, model);
			if (thinkingBuffer) attachThinkingToMessage(chatId, msg.id, thinkingBuffer);
			}

			let awaitingExit = false;
			for (const tc of toolCalls) {
				if (signal.aborted) break;
				persistToolCall(chatId, tc);
				const perm = await checkGholamFramePermissions(tc.requiredPermissions ?? []);
				if (!perm.ok) {
					const denied = persistToolResult(chatId, tc, {
						ok: false,
						error: `missing_permissions:${perm.missing.join(",")}`,
					});
					broadcastBus.broadcast({
						type: "gholam_chat_message",
						chatId,
						message: denied,
					});
					updateState(chatId, "awaiting_user");
					broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "awaiting_user" });
					awaitingExit = true;
					break;
				}
				const reply = await callDeckMcp(tc, signal);
				const resultMsg = persistToolResult(chatId, tc, reply);
				broadcastBus.broadcast({
					type: "gholam_chat_message",
					chatId,
					message: resultMsg,
				});
			}
			if (awaitingExit || signal.aborted) return;
			updateState(chatId, "running");
		}
		updateState(chatId, "completed");
		broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "completed" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error(`runGholamChat(${chatId}) failed`, err);
		appendMessage(chatId, { role: "note", content: `runtime failure: ${msg}`, meta: { error: msg } });
		updateState(chatId, "failed");
		broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "failed" });
	} finally {
		if (signal.aborted) {
			updateState(chatId, "paused");
			broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: "paused" });
		}
	}
}

/** Kick off a chat after `POST /api/gholam/chats`. Returns the abort handle. */
export function startGholamChat(chatId: string): AbortController {
	const ctl = new AbortController();
	void runGholamChat(chatId, ctl.signal).catch((err) => {
		log.warn(`background runGholamChat(${chatId}) crashed`, err);
	});
	return ctl;
}

/** Convenience: append a user message + flip state + relaunch. */
export function restartGholamChat(chatId: string, newPrompt: string): AbortController | null {
	const updated = restartChat(chatId, newPrompt);
	if (!updated) return null;
	broadcastBus.broadcast({ type: "gholam_chat_state", chatId, state: updated.state, usage: updated.usage });
	return startGholamChat(chatId);
}
