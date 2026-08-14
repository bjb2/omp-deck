/**
 * Chat history list (§1 of docs/GENERATIVE.md).
 *
 * Mounted at /gholam/chats. Fetches the chat list once, mirrors broadcast
 * frames into the zustand `gholamChats` slice, and offers:
 *   - filter chips for kind (user / auto / priority) and cwd
 *   - a "New chat" button that deep-links to /gholam/chat/new?cwd=
 *   - per-row delete + navigate to /gholam/chat/:chatId
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Plus, Trash2 } from "lucide-react";
import type { GholamChat, GholamChatKind } from "@omp-deck/protocol";

import { Layout } from "@/components/Layout";
import { gholamChatApi } from "@/lib/gholam-chat-api";
import { useStore } from "@/lib/store";

const KINDS: GholamChatKind[] = ["user", "auto", "priority"];

function formatCost(microcents: number): string {
	if (microcents === 0) return "$0.00";
	if (microcents < 100_000) return `$${(microcents / 100_000_000).toFixed(4)}`;
	return `$${(microcents / 100_000_000).toFixed(2)}`;
}

export function GholamChats() {
	const navigate = useNavigate();
	const [params, setParams] = useSearchParams();
	const kind = params.get("kind");
	const cwd = params.get("cwd");
	const hydrated = useStore((s) => Object.values(s.gholamChats).length > 0);
	const chatCounter = useStore((s) => s.gholamChatChangeCounter);
	const defaultCwd = useStore((s) => s.defaultCwd);
	const [chats, setChats] = useState<GholamChat[]>([]);
	const [error, setError] = useState<string | undefined>();

	const refresh = useCallback(async () => {
		try {
			const res = await gholamChatApi.list({
				...(kind && (KINDS as readonly string[]).includes(kind) ? { kind } : {}),
				...(cwd ? { cwd } : {}),
				limit: 100,
			});
			setChats(res.chats);
			setError(undefined);
		} catch (e) {
			setError(String(e));
		}
	}, [kind, cwd]);

	useEffect(() => {
		void refresh();
	}, [refresh, chatCounter, hydrated]);

	const filtered = useMemo(() => chats, [chats]);

	async function remove(id: string): Promise<void> {
		try {
			await gholamChatApi.remove(id);
			useStore.getState().removeGholamChat(id);
			setChats((prev) => prev.filter((c) => c.id !== id));
		} catch (e) {
			setError(String(e));
		}
	}

	function openNew(): void {
		const target = `/gholam/chat/new?cwd=${encodeURIComponent(defaultCwd)}`;
		navigate(target);
	}

	function setParam(name: string, value: string | undefined): void {
		setParams((p) => {
			const next = new URLSearchParams(p);
			if (value) next.set(name, value);
			else next.delete(name);
			return next;
		});
	}

	return (
		<Layout
			sidebar={null}
			inspector={null}
			main={
				<div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
					<header className="flex items-center justify-between">
						<div>
							<h1 className="font-display text-2xl text-ink">Gholam chats</h1>
							<p className="font-mono text-2xs text-ink-3">
								Persistent conversation history — start, replay, cancel, or restart any chat.
							</p>
						</div>
						<button
							type="button"
							onClick={openNew}
							className="flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-3 py-2 font-mono text-2xs text-accent hover:bg-accent/20"
						>
							<Plus size={14} /> New chat
						</button>
					</header>

					<div className="flex flex-wrap items-center gap-2 border-b border-line pb-3">
						{KINDS.map((k) => (
							<button
								key={k}
								type="button"
								onClick={() => setParam("kind", kind === k ? undefined : k)}
								className={`rounded px-3 py-1 font-mono text-2xs uppercase tracking-wider ${
									kind === k ? "bg-accent/15 text-accent" : "bg-paper-2 text-ink-3 hover:text-ink"
								}`}
							>
								{k}
							</button>
						))}
						<input
							type="search"
							value={cwd ?? ""}
							placeholder="filter by cwd…"
							onChange={(ev) => setParam("cwd", ev.target.value || undefined)}
							className="ml-2 rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink placeholder:text-ink-3"
						/>
					</div>

					{error && (
						<div className="rounded border border-red-300 bg-red-50 p-3 font-mono text-2xs text-red-700">
							{error}
						</div>
					)}

					{filtered.length === 0 ? (
						<div className="rounded border border-dashed border-line p-12 text-center font-mono text-2xs text-ink-3">
							No chats yet. Create one to see it land here.
						</div>
					) : (
						<table className="w-full border-separate border-spacing-y-1 font-mono text-2xs">
							<thead>
								<tr className="text-left text-ink-3">
									<th className="px-3 py-1">Title</th>
									<th className="px-3 py-1">Cwd</th>
									<th className="px-3 py-1">Model</th>
									<th className="px-3 py-1">State</th>
									<th className="px-3 py-1 text-right">Cost</th>
									<th className="px-3 py-1" />
								</tr>
							</thead>
							<tbody>
								{filtered.map((c) => (
									<tr key={c.id} className="rounded bg-paper-2">
										<td className="px-3 py-2">
											<Link
												to={`/gholam/chat/${c.id}`}
												className="font-display text-sm text-ink hover:text-accent"
											>
												{c.title}
											</Link>
											<div className="text-ink-3">{c.kind}</div>
										</td>
										<td className="px-3 py-2 text-ink">{c.cwd || "—"}</td>
										<td className="px-3 py-2 text-ink-3">{c.model ?? "default"}</td>
										<td className="px-3 py-2 text-ink">
											<span className="rounded bg-paper px-2 py-0.5 text-2xs uppercase tracking-wider">
												{c.state}
											</span>
										</td>
										<td className="px-3 py-2 text-right text-ink">{formatCost(c.usage.costMicrocents)}</td>
										<td className="px-3 py-2 text-right">
											<button
												type="button"
												title="Delete chat"
												onClick={() => void remove(c.id)}
												className="text-ink-3 hover:text-red-600"
											>
												<Trash2 size={14} />
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
				</div>
			}
		/>
	);
}
