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
 * Tool-call dispatch uses the same `gholam.ts` sidecar frame the deck
 * `gholam.edit()` path uses. The runtime loop listens for the matching
 * `mcp_reply` and resolves the pending promise; a 30s deadline bounds the
 * open socket so a stuck sidecar can't keep a chat "running" forever.
 */
import type { GholamChatMessage } from "@omp-deck/protocol";

import { onGholamFrame, sendGholamFrame } from "./gholam.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { checkGholamFramePermissions } from "./auth/gholam-permissions.ts";
import { appendMessage, getChat, listMessages, restartChat, updateState } from "./gholam-chats.ts";
import { updateMessageMeta } from "./gholam-chats.ts";
import { gholamDeckLLM } from "./llm-registry.ts";
import type { LlmChunk } from "./llm-registry.ts";
import { logger } from "./log.ts";

const log = logger("gholam-chat");

const SIDECAR_TIMEOUT_MS = 30_000;
const MAX_LOOP_ITERATIONS = 25;

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
			// doesn't have to re-derive it. `name` stays populated as the
			// fall-back for legacy rows + older callers.
			const toolCallId = meta.toolCallId ?? r.id;
			return [{
				role: "tool_call",
				content: r.content,
				...(toolCallId ? { toolCallId, name: toolCallId } : {}),
				toolCall: {
					id: toolCallId,
					tool: meta.tool ?? "",
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

function callSidecar(
	tc: Extract<LlmChunk, { type: "tool_call" }>,
	signal: AbortSignal,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
	const { promise, resolve } = Promise.withResolvers<{ ok: boolean; result?: unknown; error?: string }>();
	if (signal.aborted) {
		resolve({ ok: false, error: "aborted" });
		return promise;
	}
	const dispose = onGholamFrame((frame) => {
		if (frame.type === "mcp_reply" && frame.id === tc.id) {
			signal.removeEventListener("abort", onAbort);
			clearTimeout(timer);
			dispose();
			if (frame.ok) resolve({ ok: true, result: frame.result });
			else resolve({ ok: false, error: typeof frame.error === "string" ? frame.error : "mcp call failed" });
		}
	});
	const onAbort = (): void => {
		clearTimeout(timer);
		dispose();
		resolve({ ok: false, error: "aborted" });
	};
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		dispose();
		resolve({ ok: false, error: "sidecar timeout" });
	}, SIDECAR_TIMEOUT_MS);
	signal.addEventListener("abort", onAbort, { once: true });
	sendGholamFrame({
		type: "mcp_call",
		id: tc.id,
		server: tc.tool,
		method: "invoke",
		params: tc.args,
	});
	return promise;
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

	try {
		for (let i = 0; i < MAX_LOOP_ITERATIONS && !signal.aborted; i++) {
			const prior = listMessages(chatId);
			const llmMessages = messagesToLlm(prior);

			const toolCalls: Extract<LlmChunk, { type: "tool_call" }>[] = [];
			let assistantText = "";
			let thinkingBuffer = "";
			let sawError: string | undefined;
			for await (const chunk of gholamDeckLLM.complete({ model, messages: llmMessages, signal })) {
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
				const reply = await callSidecar(tc, signal);
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
