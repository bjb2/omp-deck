import * as path from "node:path";

import { loadConfig, parseInt10 } from "../../../server/src/config.ts";
import { getDataDir, loadManagedEnvIntoProcess } from "../../../server/src/env-store.ts";

export interface TelegramBridgeConfig {
	botToken: string;
	allowedUserIds: Set<string>;
	deckApiBase: string;
	deckWsUrl: string;
	/** Bearer token for the deck API; undefined when the deck has auth disabled. */
	deckApiToken?: string;
	defaultCwd: string;
	dbPath: string;
	pollTimeoutSeconds: number;
	editIntervalMs: number;
}

export function loadTelegramBridgeConfig(): TelegramBridgeConfig {
	loadManagedEnvIntoProcess();
	const deck = loadConfig();
	const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
	if (!botToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

	const allowedUserIds = parseAllowedUsers(process.env.TELEGRAM_ALLOWED_USERS);
	if (allowedUserIds.size === 0) {
		throw new Error("TELEGRAM_ALLOWED_USERS must contain at least one numeric Telegram user id");
	}

	const deckApiBase = normalizeBaseUrl(process.env.OMP_DECK_API_BASE?.trim() || `http://127.0.0.1:${deck.port}`);
	const deckWsUrl = toWsUrl(deckApiBase);
	const dbPath = path.resolve(process.env.TELEGRAM_BRIDGE_DB_PATH?.trim() || path.join(getDataDir(), "telegram-bridge.db"));

	// Present once the deck requires authentication. The supervisor puts it in
	// the bridge's environment; an empty value simply means auth is off.
	const deckApiToken = process.env.OMP_DECK_API_TOKEN?.trim() || undefined;

	return {
		botToken,
		allowedUserIds,
		deckApiBase,
		deckWsUrl,
		deckApiToken,
		defaultCwd: deck.defaultCwd,
		dbPath,
		pollTimeoutSeconds: clamp(parseInt10(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 30), 1, 50),
		editIntervalMs: clamp(parseInt10(process.env.TELEGRAM_EDIT_INTERVAL_MS, 700), 250, 5000),
	};
}

function parseAllowedUsers(raw: string | undefined): Set<string> {
	const out = new Set<string>();
	if (!raw) return out;
	for (const part of raw.split(/[\s,]+/)) {
		const trimmed = part.trim();
		if (!trimmed) continue;
		if (!/^\d+$/.test(trimmed)) throw new Error(`TELEGRAM_ALLOWED_USERS contains a non-numeric id: ${trimmed}`);
		out.add(trimmed);
	}
	return out;
}

function normalizeBaseUrl(raw: string): string {
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`OMP_DECK_API_BASE must be http or https, got ${url.protocol}`);
	}
	url.pathname = url.pathname.replace(/\/+$/, "");
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/$/, "");
}

function toWsUrl(httpBase: string): string {
	const url = new URL(httpBase);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.pathname = "/ws";
	return url.toString();
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.max(min, Math.min(max, value));
}
