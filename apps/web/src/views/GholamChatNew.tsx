/**
 * Start a new Gholam chat (§1 of docs/GENERATIVE.md).
 *
 * Mounted at /gholam/chat/new?cwd=&prompt=. Reads the initial cwd + prompt
 * from the query string, lets the user edit either in place, and POSTs to
 * `/api/gholam/chats`. On success, navigates to /gholam/chat/:chatId where
 * the thread surface hydrates from history + live broadcasts.
 */
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Send } from "lucide-react";

import { Layout } from "@/components/Layout";
import { ModelPicker } from "@/components/gholam/ModelPicker";
import { RichEditor } from "@/components/RichEditor";
import { gholamChatApi } from "@/lib/gholam-chat-api";
import { useStore } from "@/lib/store";

export function GholamChatNew() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const defaultCwd = useStore((s) => s.defaultCwd);
	const modelSelection = useStore((s) => s.modelSelection);
	const [cwd, setCwd] = useState<string>(params.get("cwd") ?? defaultCwd ?? "");
	const [prompt, setPrompt] = useState<string>(params.get("prompt") ?? "");
	const [title, setTitle] = useState<string>("");
	const [model, setModel] = useState<string>(
		modelSelection ? `${modelSelection.provider}/${modelSelection.id}` : "",
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	async function submit(): Promise<void> {
		if (!cwd.trim() || !prompt.trim()) {
			setError("cwd and prompt required");
			return;
		}
		setBusy(true);
		setError(undefined);
		try {
			const chat = await gholamChatApi.create({
				cwd: cwd.trim(),
				prompt: prompt.trim(),
				...(title.trim() ? { title: title.trim() } : {}),
				...(model.trim() ? { model: model.trim() } : {}),
			});
			useStore.getState().upsertGholamChat(chat);
			useStore.getState().setActiveChatId(chat.id);
			navigate(`/gholam/chat/${chat.id}`);
		} catch (e) {
			setError(String(e));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Layout
			sidebar={null}
			inspector={null}
			main={
				<div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
					<header className="flex items-center gap-4">
						<button
							type="button"
							onClick={() => navigate("/gholam/chats")}
							className="rounded p-2 text-ink-3 hover:text-ink"
						>
							<ArrowLeft size={16} />
						</button>
						<div>
							<h1 className="font-display text-2xl text-ink">New Gholam chat</h1>
							<p className="font-mono text-2xs text-ink-3">
								One prompt, one conversation. The runtime loop takes over once the chat row lands.
							</p>
						</div>
					</header>

					{error && (
						<div className="rounded border border-red-300 bg-red-50 p-3 font-mono text-2xs text-red-700">
							{error}
						</div>
					)}

					<label className="flex flex-col gap-1 font-mono text-2xs text-ink-3">
						Cwd
						<input
							value={cwd}
							onChange={(ev) => setCwd(ev.target.value)}
							placeholder="/abs/path"
							className="rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink"
						/>
					</label>

					<label className="flex flex-col gap-1 font-mono text-2xs text-ink-3">
						Title (optional)
						<input
							value={title}
							onChange={(ev) => setTitle(ev.target.value)}
							placeholder="Imported legacy brief"
							className="rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink"
						/>
					</label>

					<label className="flex flex-col gap-1 font-mono text-2xs text-ink-3">
						Model (optional, provider/id)
						<ModelPicker value={model} onChange={setModel} />
					</label>

					<label className="flex flex-col gap-1 font-mono text-2xs text-ink-3">
						Prompt
						<RichEditor
							value={prompt}
							onChange={(v) => setPrompt(v)}
							rows={10}
							placeholder="What should the twin do?"
							disableRichText
							className="rounded border border-line bg-paper-2 px-2 py-1 font-mono text-2xs text-ink"
						/>
					</label>

					<div className="flex justify-end">
						<button
							type="button"
							disabled={busy}
							onClick={() => void submit()}
							className="flex items-center gap-2 rounded border border-accent/40 bg-accent/10 px-3 py-2 font-mono text-2xs text-accent hover:bg-accent/20 disabled:opacity-50"
						>
							<Send size={14} /> Start chat
						</button>
					</div>
				</div>
			}
		/>
	);
}
