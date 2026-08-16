/**
 * Chat history sidebar for the Gholam chat-thread view.
 *
 * Fetches the last 25 chats from `GET /api/gholam/chats` (same surface as
 * `GholamChats.tsx`) and mirrors the zustand `gholamChats` slice so live
 * updates light up without a manual refresh. The active `:chatId` is
 * highlighted; each row links to `/gholam/chat/:id`.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageSquarePlus } from "lucide-react";
import type { GholamChat } from "@omp-deck/protocol";

import { gholamChatApi } from "@/lib/gholam-chat-api";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

interface Props {
	activeChatId?: string;
}

export function ChatHistorySidebar({ activeChatId }: Props) {
	const chatCounter = useStore((s) => s.gholamChatChangeCounter);
	const storeChats = useStore((s) => s.gholamChats);
	const [chats, setChats] = useState<GholamChat[]>([]);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async () => {
		try {
			const res = await gholamChatApi.list({ limit: 25 });
			setChats(res.chats);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh, chatCounter]);

	// When the store has fresher rows (e.g. a chat the sidebar hasn't fetched
	// yet), surface them. Cap at 25 to match the request — keeps the list
	// stable while the user scrolls.
	const merged =
		chats.length > 0
			? chats
			: Object.values(storeChats)
					.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
					.slice(0, 25);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center justify-between border-b border-line px-3 py-2">
				<div className="meta">Recent chats</div>
				<Link
					to="/gholam/chat/new"
					className="flex items-center gap-1 rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink hover:bg-paper"
					title="Start a new chat"
				>
					<MessageSquarePlus size={12} /> New
				</Link>
			</div>

			{error ? (
				<div className="m-3 rounded border border-red-300 bg-red-50 p-2 font-mono text-2xs text-red-700">
					{error}
				</div>
			) : null}

			{merged.length === 0 ? (
				<div className="m-3 font-mono text-2xs text-ink-3">
					No chats yet. Start one from the new-chat form.
				</div>
			) : (
				<ul className="min-h-0 flex-1 overflow-y-auto p-2">
					{merged.map((c) => {
						const isActive = c.id === activeChatId;
						return (
							<li key={c.id}>
								<Link
									to={`/gholam/chat/${c.id}`}
									className={cn(
										"block rounded px-2 py-1.5 font-mono text-2xs",
										isActive
											? "bg-accent/10 text-accent"
											: "text-ink hover:bg-paper-2",
									)}
								>
									<div className="truncate">{c.title || "Untitled"}</div>
									<div className="mt-0.5 flex items-center gap-2 text-ink-3">
										<span className="truncate">{c.model ?? "default"}</span>
										<span className="rounded bg-paper-2 px-1 text-2xs uppercase tracking-wider">
											{c.state}
										</span>
									</div>
								</Link>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}
