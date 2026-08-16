import type { ImageAttachment, ServerFrame } from "@omp-deck/protocol";

import { loadTelegramBridgeConfig, type TelegramBridgeConfig } from "./config.ts";
import { DeckClient, SessionNotActiveError } from "./deck.ts";
import { nowIso, TelegramBridgeStore, type ChatSessionMapping } from "./store.ts";
import { TelegramApi, type TelegramCallbackQuery, type TelegramMessage, type TelegramPhotoSize, type TelegramUpdate } from "./telegram.ts";

const TELEGRAM_TEXT_LIMIT = 3900;

class TelegramBridge {
	private readonly telegram: TelegramApi;
	private readonly deck: DeckClient;
	private readonly store: TelegramBridgeStore;
	private readonly queues = new Map<string, Promise<void>>();
	private readonly subscribedSessions = new Set<string>();
	private offset: number | undefined;
	private stopping = false;

	constructor(private readonly config: TelegramBridgeConfig) {
		this.telegram = new TelegramApi(config.botToken);
		this.deck = new DeckClient(config.deckApiBase, config.deckWsUrl, config.deckApiToken);
		this.store = new TelegramBridgeStore(config.dbPath);
	}

	async run(): Promise<void> {
		console.info("telegram bridge started", {
			deckApiBase: this.config.deckApiBase,
			defaultCwd: this.config.defaultCwd,
			dbPath: this.config.dbPath,
			allowedUsers: this.config.allowedUserIds.size,
		});
		this.schedulePlanListener();
		while (!this.stopping) {
			try {
				const updates = await this.telegram.getUpdates(this.offset, this.config.pollTimeoutSeconds);
				for (const update of updates) this.acceptUpdate(update);
			} catch (err) {
				if (!this.stopping) {
					console.error("telegram poll failed", err);
					await sleep(3000);
				}
			}
		}
		await Promise.allSettled(this.queues.values());
		this.store.close();
	}

	stop(): void {
		this.stopping = true;
	}

	private acceptUpdate(update: TelegramUpdate): void {
		this.offset = Math.max(this.offset ?? 0, update.update_id + 1);
		if (update.message) {
			this.dispatchByChat(String(update.message.chat.id), () => this.handleMessage(update.message!));
		} else if (update.callback_query) {
			this.dispatchByChat(this.callbackChatKey(update.callback_query), () =>
				this.handleCallbackQuery(update.callback_query!),
			);
		}
	}

	private callbackChatKey(query: TelegramCallbackQuery): string {
		// The originating chat is on the message the button was attached to.
		// Fall back to the callback's `chat` field for older Telegram clients.
		const id = query.message?.chat.id ?? query.chat?.id;
		return id !== undefined ? String(id) : "callback:unknown";
	}

	private dispatchByChat(chatId: string, work: () => Promise<void>): void {
		const prev = this.queues.get(chatId) ?? Promise.resolve();
		const next = prev
			.catch(() => undefined)
			.then(() => work())
			.catch((err) => console.error("telegram update handling failed", { chatId, err }))
			.finally(() => {
				if (this.queues.get(chatId) === next) this.queues.delete(chatId);
			});
		this.queues.set(chatId, next);
	}

	private async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
		const data = query.data;
		if (!data) return;
		const match = /^plan:([^:]+):([^:]+):(approve|deny)$/.exec(data);
		if (!match) {
			await this.telegram.answerCallbackQuery(query.id, "Unknown action");
			return;
		}
		const [, sessionId, proposalId, decision] = match;
		const approved = decision === "approve";
		try {
			await this.deck.respondToPlanApproval(sessionId!, proposalId!, approved);
		} catch (err) {
			console.warn("plan_response failed", { sessionId, proposalId, err });
			await this.telegram.answerCallbackQuery(query.id, "Bridge error");
			return;
		}
		const label = approved ? "Approved" : "Denied";
		await this.telegram.answerCallbackQuery(query.id, label);
		const originating = query.message;
		if (originating) {
			try {
				await this.telegram.editMessageText(
					originating.chat.id,
					originating.message_id,
					`Plan ${label.toLowerCase()}.`,
				);
			} catch (err) {
				console.warn("plan approval message edit failed", { err });
			}
		}
	}

	/**
	 * Subscribe to every mapped session through a single WebSocket, route
	 * `plan_proposed` frames to the corresponding chat, and reconnect on
	 * failure with backoff. Each session is subscribed at most once to
	 * avoid duplicate frames.
	 */
	private schedulePlanListener(): void {
		this.runPlanListener().catch((err) => {
			if (!this.stopping) console.warn("plan listener terminated", err);
		});
	}

	private async runPlanListener(): Promise<void> {
		while (!this.stopping) {
			try {
				await this.runPlanListenerOnce();
			} catch (err) {
				if (this.stopping) return;
				console.warn("plan listener reconnect after error", err);
				await sleep(5000);
			}
		}
	}

	private async runPlanListenerOnce(): Promise<void> {
		const ws = new WebSocket(
			this.deck.wsUrl,
			this.deck.apiToken ? { headers: { authorization: `Bearer ${this.deck.apiToken}` } } : undefined,
		);
		try {
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = () => reject(new Error("plan listener websocket failed"));
			});
		} catch (err) {
			try {
				ws.close();
			} catch {
				// already closed
			}
			throw err;
		}
		const pending: Record<string, Promise<void>> = {};
		const sessionIds = this.store.all().map((m) => m.sessionId);
		for (const sessionId of sessionIds) {
			ws.send(JSON.stringify({ type: "subscribe", sessionId }));
			this.subscribedSessions.add(sessionId);
		}
		await new Promise<void>((resolve) => {
			ws.onmessage = (ev) => {
				let frame: ServerFrame;
				try {
					frame = JSON.parse(String(ev.data)) as ServerFrame;
				} catch {
					return;
				}
				if (frame.type === "plan_proposed") {
					// Fire-and-forget: don't block the WS read loop on a Telegram send.
					pending[frame.proposalId] = this.handlePlanProposed(frame).finally(() => {
						delete pending[frame.proposalId];
					});
				}
			};
			ws.onerror = () => {
				// Surfaced via the close handler below.
			};
			ws.onclose = () => resolve();
		});
		try {
			ws.close();
		} catch {
			// already closed
		}
		await Promise.allSettled(Object.values(pending));
		this.subscribedSessions.clear();
	}

	private async handlePlanProposed(frame: Extract<ServerFrame, { type: "plan_proposed" }>): Promise<void> {
		const mapping = this.store.findBySessionId(frame.sessionId);
		if (!mapping) return;
		const chatId = mapping.chatId;
		const sessionId = frame.sessionId;
		const proposalId = frame.proposalId;
		const preview = truncateTelegramText(frame.planContent || frame.suggestedTitle);
		const text = `Plan proposed: ${frame.suggestedTitle}\n\n${preview}`;
		const buttons = [
			[
				{ text: "Approve", callbackData: `plan:${sessionId}:${proposalId}:approve` },
				{ text: "Deny", callbackData: `plan:${sessionId}:${proposalId}:deny` },
			],
		];
		try {
			await this.telegram.sendMessageWithKeyboard(chatId, text, buttons);
		} catch (err) {
			console.warn("plan proposal telegram send failed", { sessionId, proposalId, err });
		}
	}

	private async handleMessage(message: TelegramMessage): Promise<void> {
		if (message.chat.type !== "private") return;
		const fromId = message.from?.id;
		if (fromId === undefined || message.from?.is_bot) return;
		if (!this.config.allowedUserIds.has(String(fromId))) {
			await this.telegram.sendMessage(message.chat.id, "This omp-deck bot is private.", message.message_id);
			return;
		}

		const text = (message.text ?? message.caption ?? "").trim();
		if (text === "/reset") {
			await this.resetChat(message);
			return;
		}

		const photos = message.photo ?? [];
		if (!text && photos.length === 0) {
			await this.telegram.sendMessage(message.chat.id, "Send text or a photo with an optional caption.", message.message_id);
			return;
		}

		const images = await this.downloadImages(photos);
		const prompt = text || "Please analyze this image.";
		let mapping = await this.ensureMapping(String(message.chat.id));
		const reply = new TelegramReply(this.telegram, message.chat.id, message.message_id, this.config.editIntervalMs);
		try {
			const finalText = await this.deck.promptSession({
				sessionId: mapping.sessionId,
				text: prompt,
				...(images.length > 0 ? { images } : {}),
				onText: (next) => reply.update(next),
			});
			await reply.finish(finalText);
		} catch (err) {
			if (err instanceof SessionNotActiveError) {
				mapping = await this.resumeOrReplaceMapping(mapping);
				const finalText = await this.deck.promptSession({
					sessionId: mapping.sessionId,
					text: prompt,
					...(images.length > 0 ? { images } : {}),
					onText: (next) => reply.update(next),
				});
				await reply.finish(finalText);
				return;
			}
			await reply.finish(`Bridge error: ${String(err)}`);
		}
	}

	private async resetChat(message: TelegramMessage): Promise<void> {
		const chatId = String(message.chat.id);
		const mapping = this.store.get(chatId);
		if (mapping) {
			try {
				await this.deck.deleteSession(mapping.sessionId);
			} catch (err) {
				console.warn("deck session reset failed", { chatId, err });
			}
			this.store.delete(chatId);
		}
		await this.telegram.sendMessage(message.chat.id, "Telegram bridge session reset. Send a new message to start fresh.", message.message_id);
	}

	private async ensureMapping(chatId: string): Promise<ChatSessionMapping> {
		const existing = this.store.get(chatId);
		if (existing) return existing;
		return this.createMapping(chatId, { cwd: this.config.defaultCwd });
	}

	private async resumeOrReplaceMapping(mapping: ChatSessionMapping): Promise<ChatSessionMapping> {
		if (mapping.sessionFile) {
			try {
				return await this.createMapping(mapping.chatId, { cwd: mapping.cwd, resumeFromPath: mapping.sessionFile });
			} catch (err) {
				console.warn("session resume failed; creating a fresh telegram session", { chatId: mapping.chatId, err });
			}
		}
		return this.createMapping(mapping.chatId, { cwd: mapping.cwd });
	}

	private async createMapping(chatId: string, opts: { cwd: string; resumeFromPath?: string }): Promise<ChatSessionMapping> {
		const created = await this.deck.createSession(opts);
		const now = nowIso();
		const existing = this.store.get(chatId);
		const mapping: ChatSessionMapping = {
			chatId,
			sessionId: created.sessionId,
			...(created.sessionFile ? { sessionFile: created.sessionFile } : {}),
			cwd: created.cwd,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};
		this.store.upsert(mapping);
		return mapping;
	}

	private async downloadImages(photos: TelegramPhotoSize[]): Promise<ImageAttachment[]> {
		if (photos.length === 0) return [];
		const largest = photos[photos.length - 1];
		if (!largest) return [];
		const image = await this.telegram.downloadPhoto(largest);
		return [{ type: "image", data: image.data, mimeType: image.mimeType }];
	}
}

class TelegramReply {
	private sent: Promise<{ message_id: number }> | undefined;
	private latest = "";
	private rendered = "";
	private timer: ReturnType<typeof setTimeout> | undefined;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private readonly telegram: TelegramApi,
		private readonly chatId: number,
		private readonly replyToMessageId: number,
		private readonly editIntervalMs: number,
	) {}

	update(text: string): void {
		this.latest = text;
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.enqueueFlush();
		}, this.editIntervalMs);
	}

	async finish(text: string): Promise<void> {
		this.latest = text || this.latest || "Turn complete.";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.chain;
		const chunks = splitTelegramText(this.latest);
		await this.editRendered(chunks[0]!);
		for (const chunk of chunks.slice(1)) await this.telegram.sendMessage(this.chatId, chunk);
	}

	private enqueueFlush(): Promise<void> {
		this.chain = this.chain.then(() => this.flush()).catch((err) => console.warn("telegram reply edit failed", err));
		return this.chain;
	}

	private async flush(): Promise<void> {
		const next = truncateTelegramText(this.latest || "Working...");
		if (next === this.rendered) return;
		await this.editRendered(next);
	}

	private async editRendered(text: string): Promise<void> {
		if (text === this.rendered) return;
		const sent = await this.ensureSent();
		try {
			await this.telegram.editMessageText(this.chatId, sent.message_id, text);
			this.rendered = text;
		} catch (err) {
			if (!String(err).includes("message is not modified")) throw err;
		}
	}

	private ensureSent(): Promise<{ message_id: number }> {
		this.sent ??= this.telegram.sendMessage(this.chatId, "Working...", this.replyToMessageId);
		return this.sent;
	}
}

function splitTelegramText(text: string): string[] {
	const trimmed = text.trim() || "Turn complete.";
	const chunks: string[] = [];
	let rest = trimmed;
	while (rest.length > TELEGRAM_TEXT_LIMIT) {
		let cut = rest.lastIndexOf("\n", TELEGRAM_TEXT_LIMIT);
		if (cut < TELEGRAM_TEXT_LIMIT * 0.6) cut = TELEGRAM_TEXT_LIMIT;
		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}
	chunks.push(rest);
	return chunks;
}

function truncateTelegramText(text: string): string {
	const chunks = splitTelegramText(text);
	return chunks.length === 1 ? chunks[0]! : `${chunks[0]!}\n\n...`;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
	const bridge = new TelegramBridge(loadTelegramBridgeConfig());
	process.once("SIGINT", () => bridge.stop());
	process.once("SIGTERM", () => bridge.stop());
	await bridge.run();
}

main().catch((err) => {
	console.error("telegram bridge fatal", err);
	process.exit(1);
});
