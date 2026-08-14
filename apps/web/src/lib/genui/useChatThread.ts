/**
 * `useChatThread` — thin wrapper around `@ai-sdk/react`'s `useChat` (§5 of
 * docs/GENERATIVE.md).
 *
 * AI SDK v4 `useChat` returns `{ messages, sendMessage, setMessages, … }` —
 * there is no `input` / `handleInputChange` / `handleSubmit` (those are
 * pre-v4 APIs). The hook surfaces that shape; callers bind their own input
 * element via the WS client. We deliberately do NOT touch `Composer.tsx`
 * (Worker C owns that file's wiring) — see E5 in the worker brief.
 *
 * The WS bus is the source of truth for session events. We subscribe to
 * the existing `session_event` frames and append a synthetic assistant
 * `UIMessage` so the AI SDK's reactive state mirrors the live transcript.
 * Tool-call details are forwarded via `onToolCall` so listeners can wire
 * `<GenButton>` clicks to actual sidecar invocations.
 */

import { useEffect, useRef } from "react";
import { useChat, type UseChatHelpers, type UIMessage } from "@ai-sdk/react";

import { WsClient } from "@/lib/ws";
import { useStore } from "@/lib/store";

interface UseChatThreadOptions {
	/** Optional seed messages for replay on mount (Worker D's chat history). */
	initialMessages?: UIMessage[];
	/** Fired when a tool-call-style server frame arrives. The renderer can
	 *  listen to wire `<GenButton>` clicks to actual sidecar invocations. */
	onToolCall?: (kind: string, payload: Record<string, unknown>) => void;
}

/** Hook returning the AI SDK `useChat` shape wired to the deck WS bus. */
export function useChatThread(options: UseChatThreadOptions = {}): UseChatHelpers<UIMessage> {
	const { initialMessages, onToolCall } = options;
	const ws: WsClient | null = useStore((s) => s.ws);
	const onToolCallRef = useRef(onToolCall);
	onToolCallRef.current = onToolCall;

	const chat = useChat({
		...(initialMessages ? { messages: initialMessages } : {}),
		experimental_throttle: 50,
	});

	useEffect(() => {
		if (!ws) return;
		const unsub = ws.subscribe((frame) => {
			// `session_event` is the actual server→client surface for tool
			// calls in this deck. We forward the raw event into the chat
			// state as a synthetic assistant message so subscribers can
			// re-render the live transcript.
			if (frame.type === "session_event") {
				const msg: UIMessage = {
					id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					role: "assistant",
					parts: [
						{
							type: "text",
							text: typeof frame.event === "string" ? frame.event : JSON.stringify(frame.event),
						},
					],
				};
				chat.setMessages((prev) => [...prev, msg]);
				const ev = frame.event as { type?: string; [k: string]: unknown } | undefined;
				const kind = typeof ev?.type === "string" ? ev.type : "session_event";
				onToolCallRef.current?.(kind, ev ?? {});
			}
		});
		return unsub;
	}, [ws, chat]);

	return chat;
}

// Re-export the AI SDK `UIMessage` type for callers that need to seed
// `initialMessages`.
export type { UIMessage };