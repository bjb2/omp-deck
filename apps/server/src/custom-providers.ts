/**
 * Custom providers registry — wires user-defined providers (e.g. OmniRoute
 * gateway, OpenRouter, any OpenAI/Anthropic-compatible endpoint) into the SDK
 * `ModelRegistry` at runtime, with hot-reload on `models.yml` changes.
 *
 * Replaces the old static `models.yml`-on-disk approach with two layers:
 *
 *   1. Built-in providers shipped with OMP (always present).
 *   2. Custom providers registered by the user via Settings → Providers or
 *      dropped into `~/.omp/agent/models.yml`. Hot-reloaded on every change.
 *
 * Each custom provider carries an `id`, a human-readable `label`, a `baseUrl`,
 * an `apiKey` (the raw secret value), and a list of model overrides (id,
 * displayName, context window, max tokens, reasoning effort).
 *
 * The registry is a process-singleton — the same `ModelRegistry` instance the
 * bridge and the OAuth routes already share. We register/unregister providers
 * on the shared instance via `ModelRegistry.registerProvider` (and the inverse
 * `unregisterProvider` when the user removes one), so OAuth flows and live
 * sessions see the updated model list without restart.
 */
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import YAML from "yaml";

import { getDeckModelRegistry } from "./auth-singleton.ts";
import { logger } from "./log.ts";

const log = logger("custom-providers");

export type CustomProviderApi =
	| "openai-completions"
	| "openai-responses"
	| "anthropic-messages"
	| "google-generative-ai";

export interface CustomProviderModel {
	id: string;
	displayName?: string;
	contextWindow?: number;
	maxTokens?: number;
	supportsTools?: boolean;
	supportsReasoning?: boolean;
	reasoningEfforts?: string[];
}

export interface CustomProvider {
	id: string; // e.g. "omniroute"
	label: string; // e.g. "OmniRoute"
	api: CustomProviderApi;
	baseUrl: string;
	apiKey: string; // secret value (never logged)
	authHeader?: boolean;
	headers?: Record<string, string>;
	models: CustomProviderModel[];
	// Where the API key lives in the process env so the SDK resolver can pick it up.
	apiKeyEnv?: string;
}

export interface CustomProvidersFile {
	version: 1;
	providers: CustomProvider[];
}

const EMPTY_FILE: CustomProvidersFile = { version: 1, providers: [] };

export class CustomProvidersRegistry {
	private filePath: string | undefined;
	private fileMtime = 0;
	// Whether `fileMtime` reflects a completed load. Tracked separately from
	// `providers.size` because a perfectly valid load can legitimately yield
	// zero providers — gating the mtime cache on a non-empty result made
	// every poll re-read and re-log for any file that produces none.
	private hasLoadedMtime = false;
	private providers: Map<string, CustomProvider> = new Map();
	private fileWatcher: ReturnType<typeof setInterval> | undefined;
	private refreshInFlight: Promise<void> | undefined;
	private listeners = new Set<() => void>();

	resolvePath(): string {
		if (this.filePath) return this.filePath;
		const ompDir = process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent");
		this.filePath = path.join(ompDir, "models.yml");
		return this.filePath;
	}

	async load(): Promise<CustomProvidersFile> {
		const fp = this.resolvePath();
		try {
			const raw = await fs.readFile(fp, "utf-8");
			const parsed = YAML.parse(raw) as CustomProvidersFile | null;
			if (!parsed || typeof parsed !== "object") return EMPTY_FILE;
			// `$OMP_AGENT_DIR/models.yml` is shared with the OMP agent itself,
			// which uses a different shape (`providers` keyed by id, no
			// `version`). That file is not ours to consume and not an error —
			// it just means no deck-managed custom providers are configured.
			if (parsed.version === undefined && !Array.isArray(parsed.providers)) {
				log.debug("models.yml: agent-owned format; no deck-managed providers");
				return EMPTY_FILE;
			}
			if (parsed.version !== 1) {
				log.warn(`models.yml: unsupported version ${String(parsed.version)}`);
				return EMPTY_FILE;
			}
			const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
			return { version: 1, providers };
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return EMPTY_FILE;
			log.warn(`models.yml: read failed`, err);
			return EMPTY_FILE;
		}
	}

	async save(file: CustomProvidersFile): Promise<void> {
		const fp = this.resolvePath();
		const dir = path.dirname(fp);
		await fs.mkdir(dir, { recursive: true });
		// Atomic write: tmp → rename. Preserves last-known-good if the write is interrupted.
		const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tmp, YAML.stringify(file), "utf-8");
		await fs.rename(tmp, fp);
		this.fileMtime = (await fs.stat(fp)).mtimeMs;
		this.hasLoadedMtime = true;
		this.providers.clear();
		for (const p of file.providers) this.providers.set(p.id, p);
	}

	async upsertProvider(provider: CustomProvider): Promise<CustomProvidersFile> {
		const file = await this.load();
		const existing = file.providers.findIndex((p) => p.id === provider.id);
		if (existing >= 0) file.providers[existing] = provider;
		else file.providers.push(provider);
		await this.save(file);
		await this.sync();
		return file;
	}

	async removeProvider(id: string): Promise<CustomProvidersFile> {
		const file = await this.load();
		file.providers = file.providers.filter((p) => p.id !== id);
		await this.save(file);
		await this.sync();
		return file;
	}

	async reloadFromDisk(): Promise<{ changed: boolean }> {
		const fp = this.resolvePath();
		let mtime = 0;
		try {
			mtime = (await fs.stat(fp)).mtimeMs;
		} catch {
			// File absent — treat as empty registry.
			this.hasLoadedMtime = false;
			if (this.providers.size === 0) return { changed: false };
			await this.applyToRegistry([]);
			this.providers.clear();
			return { changed: true };
		}
		if (mtime === this.fileMtime && this.hasLoadedMtime) return { changed: false };
		this.fileMtime = mtime;
		this.hasLoadedMtime = true;
		const file = await this.load();
		await this.applyToRegistry(file.providers);
		this.providers.clear();
		for (const p of file.providers) this.providers.set(p.id, p);
		return { changed: true };
	}

	/** Register/unregister with the live `ModelRegistry`. */
	private async applyToRegistry(providers: CustomProvider[]): Promise<void> {
		const registry: ModelRegistry = await getDeckModelRegistry();
		const validIds = new Set(providers.map((p) => p.id));
		for (const existing of new Set(this.providers.keys())) {
			if (!validIds.has(existing)) {
				try {
					registry.unregisterProvider(existing);
				} catch (err) {
					log.warn(`unregisterProvider(${existing}) failed`, err);
				}
			}
		}
		for (const provider of providers) {
			try {
				registry.registerProvider(provider.id, {
					baseUrl: provider.baseUrl,
					apiKey: provider.apiKey,
					api: provider.api,
					authHeader: provider.authHeader ?? true,
					headers: provider.headers,
					models: provider.models.map((m) => ({
						id: m.id,
						name: m.displayName ?? m.id,
						contextWindow: m.contextWindow ?? 128_000,
						maxTokens: m.maxTokens ?? 16_384,
						supportsTools: m.supportsTools ?? true,
						reasoning: m.supportsReasoning ?? false,
						input: ["text", "image"] as ("text" | "image")[],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						...(m.supportsReasoning
							? { reasoningEfforts: m.reasoningEfforts ?? ["off", "low", "medium", "high"] }
							: {}),
					})),
				});
				// Mirror the key into process.env so the SDK resolver finds it
				// under the conventional name without an extra round trip.
				if (provider.apiKeyEnv) {
					process.env[provider.apiKeyEnv] = provider.apiKey;
				}
			} catch (err) {
				log.warn(`registerProvider(${provider.id}) failed`, err);
			}
		}
	}

	async sync(): Promise<void> {
		if (this.refreshInFlight) return this.refreshInFlight;
		this.refreshInFlight = (async () => {
			const file = await this.load();
			await this.applyToRegistry(file.providers);
			this.providers.clear();
			for (const p of file.providers) this.providers.set(p.id, p);
			for (const fn of this.listeners) {
				try {
					fn();
				} catch (err) {
					log.warn(`custom-providers listener threw`, err);
				}
			}
		})().finally(() => {
			this.refreshInFlight = undefined;
		});
		return this.refreshInFlight;
	}

	async snapshot(): Promise<CustomProvider[]> {
		const file = await this.load();
		return file.providers.map((p) => ({ ...p, apiKey: maskKey(p.apiKey) }));
	}

	startWatcher(intervalMs = 1500): () => void {
		if (this.fileWatcher) return () => this.stopWatcher();
		this.fileWatcher = setInterval(() => {
			void this.reloadFromDisk().then(({ changed }) => {
				if (changed) {
					for (const fn of this.listeners) {
						try {
							fn();
						} catch (err) {
							log.warn(`custom-providers listener threw`, err);
						}
					}
				}
			});
		}, intervalMs);
		// Initial sync — picks up any pre-existing file on disk.
		void this.sync();
		return () => this.stopWatcher();
	}

	stopWatcher(): void {
		if (this.fileWatcher) {
			clearInterval(this.fileWatcher);
			this.fileWatcher = undefined;
		}
	}

	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
}

function maskKey(k: string): string {
	if (!k) return "";
	if (k.length <= 8) return "•".repeat(k.length);
	return `${k.slice(0, 4)}${"•".repeat(Math.max(4, k.length - 8))}${k.slice(-4)}`;
}

let _instance: CustomProvidersRegistry | undefined;
export function getCustomProviders(): CustomProvidersRegistry {
	if (!_instance) _instance = new CustomProvidersRegistry();
	return _instance;
}

/**
 * Boot-time convenience: ensure the registry exists, start the file watcher,
 * and return a dispose function. Mounted from `routes.ts` so every request
 * can rely on the file being polled for changes.
 */
export function startCustomProvidersWatcher(): () => void {
	const reg = getCustomProviders();
	return reg.startWatcher();
}
