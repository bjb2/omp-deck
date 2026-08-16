/**
 * Single Gholam chat thread (§1 of docs/GENERATIVE.md).
 *
 * Mounted at /gholam/chat/:chatId. Hydrates from `/api/gholam/chats/:id`
 * + `/messages`, then subscribes to the relevant broadcast frames so the
 * thread surfaces every assistant / user / tool row the runtime loop
 * appends. Cancel/restart/delete are wired to the REST surface.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Pause, RefreshCcw, Trash2 } from "lucide-react";
import type { GholamChat, GholamChatMessageWire } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { ChatHistorySidebar } from "@/components/gholam/ChatHistorySidebar";
import { ModelPicker } from "@/components/gholam/ModelPicker";
import { gholamChatApi } from "@/lib/gholam-chat-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

function formatCost(microcents: number): string {
	if (microcents === 0) return "$0.00";
	return `$${(microcents / 100_000_000).toFixed(4)}`;
}

function Row({ msg }: { msg: GholamChatMessageWire }) {
	const meta = msg.meta as { tool?: string; error?: string } | undefined;
	if (msg.role === "user") {
		return (
			<div className="flex justify-end">
				<div className="max-w-[80%] rounded border border-line bg-paper-2 px-3 py-2 text-ink">
					<pre className="whitespace-pre-wrap font-mono text-2xs">{msg.content}</pre>
				</div>
			</div>
		);
	}
	if (msg.role === "assistant") {
		return (
			<div className="flex justify-start">
				<div className="max-w-[80%] rounded border border-accent/30 bg-accent/5 px-3 py-2 text-ink">
					<pre className="whitespace-pre-wrap font-mono text-2xs">{msg.content}</pre>
				</div>
			</div>
		);
	}
	if (msg.role === "tool_call") {
		return (
			<div className="rounded border border-dashed border-line bg-paper px-3 py-2 font-mono text-2xs text-ink-3">
				<div>tool_call {meta?.tool ? `(${meta.tool})` : ""}</div>
				<pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-ink">{msg.content}</pre>
			</div>
		);
	}
	if (msg.role === "tool_result") {
		return (
			<div className="rounded border border-dashed border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
				<div>tool_result {meta?.tool ? `(${meta.tool})` : ""}</div>
				<pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-ink">{msg.content}</pre>
			</div>
		);
	}
	// system / note
	return (
		<div className="rounded border border-amber-300/40 bg-amber-50 px-3 py-2 font-mono text-2xs text-amber-900">
			{msg.role}: {msg.content}
		</div>
	);
}

export function GholamChatView() {
	const { chatId } = useParams<{ chatId: string }>();
	const navigate = useNavigate();
	const [chat, setChat] = useState<GholamChat | null>(null);
	const [messages, setMessages] = useState<GholamChatMessageWire[]>([]);
	const [error, setError] = useState<string | undefined>();
	const counter = useStore((s) => s.gholamChatChangeCounter);

	const refresh = useCallback(async (): Promise<void> => {
		if (!chatId) return;
		try {
			const [c, m] = await Promise.all([gholamChatApi.get(chatId), gholamChatApi.messages(chatId)]);
			setChat(c);
			setMessages(m.messages);
			setError(undefined);
		} catch (err) {
			setError(String(err));
		}
	}, [chatId]);

	useEffect(() => {
		if (!chatId) return;
		void refresh();
	}, [refresh, counter]);

	const storeMessages = useStore((s) => (chatId ? s.gholamChatMessages[chatId] : undefined));
	const effective = useMemo(
		() => (storeMessages && storeMessages.length > messages.length ? storeMessages : messages),
		[storeMessages, messages],
	);

	async function cancel(): Promise<void> {
		if (!chatId) return;
		try {
			const updated = await gholamChatApi.cancel(chatId);
			setChat(updated);
		} catch (err) {
			setError(String(err));
		}
	}

	async function restart(): Promise<void> {
		if (!chatId) return;
		const prompt = window.prompt("Prompt to append to restart?") ?? "";
		if (!prompt.trim()) return;
		try {
			const updated = await gholamChatApi.restart(chatId, { prompt: prompt.trim() });
			setChat(updated);
			await refresh();
		} catch (err) {
			setError(String(err));
		}
	}

	async function remove(): Promise<void> {
		if (!chatId) return;
		if (!window.confirm("Delete this chat? This is irreversible in v1.")) return;
		try {
			await gholamChatApi.remove(chatId);
			useStore.getState().removeGholamChat(chatId);
			navigate("/gholam/chats");
		} catch (err) {
			setError(String(err));
		}
	}

	async function changeModel(nextModel: string): Promise<void> {
		if (!chatId) return;
		const trimmed = nextModel.trim();
		if (!trimmed) return;
		const previous = chat;
		// Optimistic local + store update so the picker reflects the change immediately.
		setChat((prev) => (prev ? { ...prev, model: trimmed } : prev));
		if (previous) {
			useStore.getState().upsertGholamChat({ ...previous, model: trimmed });
		}
		try {
			const { chat: updated } = await gholamChatApi.patchModel(chatId, trimmed);
			setChat(updated);
			useStore.getState().upsertGholamChat(updated);
		} catch (err) {
			setError(String(err));
			setChat(previous ?? null);
			if (previous) {
				useStore.getState().upsertGholamChat(previous);
			}
		}
	}

	if (!chatId) return null;
	if (!chat) {
		return (
			<Layout
				sidebar={<ChatHistorySidebar />}
				inspector={null}
				main={
					<div className="flex h-full items-center justify-center p-6">
						{error ? (
							<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
								{error}
							</div>
						) : (
							<div className="meta">Loading chat…</div>
						)}
					</div>
				}
			/>
		);
	}

	const stateColor: Record<string, string> = {
		running: "bg-accent/15 text-accent",
		paused: "bg-amber-200/40 text-amber-900",
		awaiting_user: "bg-paper-2 text-ink",
		awaiting_tool: "bg-paper-2 text-ink-3",
		completed: "bg-emerald-100 text-emerald-900",
		failed: "bg-red-100 text-red-900",
	};

	return (
		<Layout
			sidebar={<ChatHistorySidebar activeChatId={chat.id} />}
			inspector={null}
			main={
				<div className="flex h-full flex-col gap-3 overflow-hidden p-6">
					<header className="flex items-center gap-3">
						<Link
							to="/gholam/chats"
							className="rounded p-2 text-ink-3 hover:text-ink"
						>
							<ArrowLeft size={16} />
						</Link>
						<div className="flex-1">
							<h1 className="font-display text-xl text-ink">{chat.title}</h1>
							<p className="font-mono text-2xs text-ink-3">
								{chat.cwd} · {chat.model ?? "default"} ·{" "}
								<span
									className={cn(
										"rounded px-1.5 py-0.5 text-2xs uppercase tracking-wider",
										stateColor[chat.state] ?? "bg-paper-2 text-ink-3",
									)}
								>
									{chat.state}
								</span>
							</p>
						</div>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => void cancel()}
								className="flex items-center gap-2 rounded border border-line bg-paper-2 px-3 py-1 font-mono text-2xs text-ink hover:bg-paper"
							>
								<Pause size={12} /> Cancel
							</button>
							<button
								type="button"
								onClick={() => void restart()}
								className="flex items-center gap-2 rounded border border-line bg-paper-2 px-3 py-1 font-mono text-2xs text-ink hover:bg-paper"
							>
								<RefreshCcw size={12} /> Restart
							</button>
							<button
								type="button"
								onClick={() => void remove()}
								className="flex items-center gap-2 rounded border border-red-300 bg-red-50 px-3 py-1 font-mono text-2xs text-red-700 hover:bg-red-100"
							>
								<Trash2 size={12} />
							</button>
						</div>
					</header>

					<div className="rounded border border-line bg-paper-2 px-3 py-2 font-mono text-2xs text-ink-3">
						Cost so far: {formatCost(chat.usage.costMicrocents)} · tokens in/out:{" "}
						{chat.usage.tokensIn}/{chat.usage.tokensOut}
					</div>

					<div className="flex items-center gap-3">
						<ModelPicker
							value={chat.model ?? ""}
							onChange={(next) => void changeModel(next)}
						/>
						<span
							className={cn(
								"rounded px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wider",
								chat.state === "running"
									? "bg-emerald-100 text-emerald-900"
									: "bg-paper-2 text-ink-3",
							)}
						>
							{chat.state === "running" ? "online" : "offline"}
						</span>
						<span className="font-mono text-2xs text-ink-3">
							model: {chat.model ?? "default"}
						</span>
					</div>

					<div className="flex flex-1 flex-col gap-3 overflow-y-auto">
						{effective.length === 0 ? (
							<div className="m-auto font-mono text-2xs text-ink-3">
								No messages yet. Run the runtime loop to fill the thread.
							</div>
						) : (
							effective.map((m) => <Row key={m.id} msg={m} />)
						)}
					</div>
				</div>
			}
		/>
	);
}
