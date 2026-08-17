export interface TelegramUpdate {
	update_id: number;
	message?: TelegramMessage;
	callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
	message_id: number;
	chat: { id: number; type: string };
	from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
	text?: string;
	caption?: string;
	photo?: TelegramPhotoSize[];
}

export interface TelegramPhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface TelegramCallbackQuery {
	id: string;
	from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
	chat?: { id: number; type: string };
	message?: { message_id: number; chat: { id: number; type: string } };
	data?: string;
}

export interface InlineKeyboardButton {
	text: string;
	callbackData: string;
}

interface TelegramResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
}

interface TelegramSentMessage {
	message_id: number;
	chat: { id: number };
	text?: string;
}

interface TelegramFile {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export class TelegramApi {
	private readonly apiBase: string;
	private readonly fileBase: string;

	constructor(private readonly botToken: string) {
		this.apiBase = `https://api.telegram.org/bot${botToken}`;
		this.fileBase = `https://api.telegram.org/file/bot${botToken}`;
	}

	getUpdates(offset: number | undefined, timeout: number): Promise<TelegramUpdate[]> {
		return this.call<TelegramUpdate[]>("getUpdates", {
			...(offset !== undefined ? { offset } : {}),
			timeout,
			allowed_updates: ["message", "callback_query"],
		});
	}

	sendMessage(chatId: number | string, text: string, replyToMessageId?: number): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("sendMessage", {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
			...(replyToMessageId !== undefined ? { reply_to_message_id: replyToMessageId } : {}),
		});
	}

	editMessageText(chatId: number | string, messageId: number, text: string): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("editMessageText", {
			chat_id: chatId,
			message_id: messageId,
			text,
			disable_web_page_preview: true,
		});
	}

	sendMessageWithKeyboard(
		chatId: number | string,
		text: string,
		buttons: InlineKeyboardButton[][],
	): Promise<TelegramSentMessage> {
		return this.call<TelegramSentMessage>("sendMessage", {
			chat_id: chatId,
			text,
			disable_web_page_preview: true,
			reply_markup: {
				inline_keyboard: buttons.map((row) =>
					row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
				),
			},
		});
	}

	async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
		try {
			await this.call<boolean>("answerCallbackQuery", {
				callback_query_id: callbackQueryId,
				...(text !== undefined ? { text } : {}),
			});
		} catch (err) {
			// Telegram requires acknowledgement within ~30s; if the API is briefly
			// flaky we still want the rest of the flow to proceed.
			console.warn("answerCallbackQuery failed", err);
		}
	}

	async downloadPhoto(photo: TelegramPhotoSize): Promise<{ data: string; mimeType: string }> {
		const file = await this.call<TelegramFile>("getFile", { file_id: photo.file_id });
		if (!file.file_path) throw new Error("Telegram getFile returned no file_path");
		const res = await fetch(`${this.fileBase}/${file.file_path}`);
		if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return { data: bytes.toString("base64"), mimeType: mimeTypeForTelegramPath(file.file_path) };
	}

	private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
		const res = await fetch(`${this.apiBase}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		let payload: TelegramResponse<T>;
		try {
			payload = (await res.json()) as TelegramResponse<T>;
		} catch {
			throw new Error(`Telegram ${method} failed: HTTP ${res.status}`);
		}
		if (!res.ok || !payload.ok || payload.result === undefined) {
			throw new Error(`Telegram ${method} failed: ${payload.description ?? `HTTP ${res.status}`}`);
		}
		return payload.result;
	}
}

function mimeTypeForTelegramPath(filePath: string): string {
	const lower = filePath.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	return "image/jpeg";
}
