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
import { ArrowLeft, Pause, RefreshCcw, Send, Trash2 } from "lucide-react";
import type { GholamChat, GholamChatMessageWire, GholamChatModelRole } from "@omp-deck/protocol";

// 8-level role picker — mirrors the OMP harness modelRoles config. The
// active role gets a highlighted background; clicking another pill PATCHes
// the chat's (modelId, role) via PUT /api/gholam/chats/:id/model.
const ROLES: ReadonlyArray<{ id: GholamChatModelRole; label: string }> = [
	{ id: "default", label: "Default" },
	{ id: "smol", label: "Smol" },
	{ id: "slow", label: "Slow" },
	{ id: "tiny", label: "Tiny" },
	{ id: "advisor", label: "Advisor" },
	{ id: "vision", label: "Vision" },
	{ id: "plan", label: "Plan" },
	{ id: "commit", label: "Commit" },
];

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
	// Composer state. The composer is a single textarea + role row above
	// the message list; GholamChatView was previously read-only — the OMP
	// chat surface needs an in-place send path so the multi-agent role
	// selector has somewhere to live.
	const [draft, setDraft] = useState<string>("");
	const [busy, setBusy] = useState<boolean>(false);
	const [role, setRole] = useState<GholamChatModelRole>("default");
	const [roleBusy, setRoleBusy] = useState<GholamChatModelRole | null>(null);

	// Sync the role pill from the chat on every fetch / refresh. Server is
	// the source of truth; if the user picks a role in another tab, this
	// chats' UI follows.
	useEffect(() => {
		if (!chat) return;
		const next = chat.modelUsed?.role ?? "default";
		setRole(next);
	}, [chat?.modelUsed?.role, chat?.id]);

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

	async function pickRole(nextRole: GholamChatModelRole): Promise<void> {
		if (!chatId) return;
		if (nextRole === role) return;
		const modelId = chat?.model?.trim() || "";
		// The server requires a non-empty modelId — disable the picker
		// until the user has chosen a model, rather than fabricate one.
		if (!modelId) {
			setError("Pick a model before choosing a role.");
			return;
		}
		setRoleBusy(nextRole);
		const previous = chat;
		setRole(nextRole);
		setChat((prev) => (prev ? { ...prev, modelUsed: { modelId, role: nextRole } } : prev));
		if (previous) {
			useStore.getState().upsertGholamChat({ ...previous, modelUsed: { modelId, role: nextRole } });
		}
		try {
			await gholamChatApi.selectModel(chatId, modelId, nextRole);
		} catch (err) {
			setError(String(err));
			setRole(role);
			if (previous) setChat(previous);
		} finally {
			setRoleBusy(null);
		}
	}

	async function sendDraft(): Promise<void> {
		if (!chatId) return;
		const text = draft.trim();
		if (!text || busy) return;
		setBusy(true);
		setError(undefined);
		try {
			const result = await gholamChatApi.appendMessage(chatId, {
				content: text,
				...(chat?.model?.trim() ? { modelId: chat!.model!.trim() } : {}),
				role,
			});
			setMessages((prev) => [...prev, result.message]);
			setChat(result.chat);
			useStore.getState().upsertGholamChat(result.chat);
			setDraft("");
		} catch (err) {
			setError(String(err));
		} finally {
			setBusy(false);
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

					{/* Multi-agent role picker. 8 pills — Default / Smol / Slow /
					    Tiny / Advisor / Vision / Plan / Commit. Click PATCHes the
					    chat's (modelId, role) via PUT /api/gholam/chats/:id/model.
					    Active pill gets an accent background; the rows disable when
					    no model is picked yet (the server requires a non-empty
					    modelId to persist a role). */}
					<div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Model role">
						{ROLES.map((r) => {
							const active = role === r.id;
							const disabled = roleBusy === r.id || !chat.model?.trim();
							return (
								<button
									key={r.id}
									type="button"
									role="radio"
									aria-checked={active}
									disabled={disabled}
									onClick={() => void pickRole(r.id)}
									className={cn(
										"rounded border px-2.5 py-1 font-mono text-2xs uppercase tracking-wider transition-colors",
										active
											? "border-accent/60 bg-accent-soft text-ink"
											: "border-line bg-paper-2 text-ink-3 hover:bg-paper-3",
										disabled && "opacity-50",
									)}
								>
									{r.label}
								</button>
							);
						})}
					</div>

					{/* Composer — textarea + send. Single-line for compact
					    rendering; the runtime loop reads the same REST surface as
					    the orchestrator. Sending passes modelId + role so the
					    server can persist the role alongside the model. */}
					<div className="flex shrink-0 items-end gap-2 rounded border border-line bg-paper-2 p-2">
						<textarea
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									void sendDraft();
								}
							}}
							placeholder="Send a follow-up — Enter sends, Shift+Enter newline"
							rows={2}
							className="flex-1 resize-y rounded border border-line bg-paper px-2 py-1 font-mono text-2xs text-ink"
						/>
						<button
							type="button"
							disabled={busy || !draft.trim()}
							onClick={() => void sendDraft()}
							className="flex items-center gap-1 rounded border border-line bg-paper px-3 py-1 font-mono text-2xs text-ink hover:bg-paper-3 disabled:opacity-50"
						>
							<Send size={12} /> Send
						</button>
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
