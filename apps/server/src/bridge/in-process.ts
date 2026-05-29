import {
	createAgentSession,
	ModelRegistry,
	SessionManager,
	settings as ompSettings,
	type AgentSession,
} from "@oh-my-pi/pi-coding-agent";
import { getEnvApiKey } from "@oh-my-pi/pi-ai";
import { runExtensionCompact, runExtensionSetModel } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/get-commands-handler";
// `Model` is owned by `@oh-my-pi/pi-ai`, a transitive dep we don't bring in
// directly. Treat it as opaque at the bridge boundary — we only ever pass it
// back into the SDK's own methods.
type SdkModel = {
	id: string;
	name?: string;
	provider: string | { toString(): string };
	contextWindow?: number;
	input?: unknown[];
};
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type {
	AgentMessageJson,
	AgentSessionEventJson,
	ExtUiDialogResponse,
	ModelInfo,
	ModelRef,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	ServerFrame,
	SessionSnapshot,
	SessionSummary,
} from "@omp-deck/protocol";

import { logger } from "../log.ts";
import { getDeckModelRegistry } from "../auth-singleton.ts";
import { looksLikePlaceholderKey } from "../credential-quality.ts";
import { getEffectivePrelude } from "../orientation-store.ts";
import { notificationService } from "../notifications/index.ts";
import { ExtensionUIBridge } from "./ext-ui-bridge.ts";
import { PlanModeBridge } from "./plan-mode-bridge.ts";
import type {
	AgentBridge,
	CreateSessionOpts,
	EventListener,
	PlanApprovalResponse,
	ResumeSessionOpts,
	RuntimeEnvUpdate,
	SessionHandle,
	SlashDispatchResult,
} from "./types.ts";

const log = logger("bridge:in-process");


/**
 * System-prompt block prepended to every omp session created or resumed via
 * this bridge. The canonical text lives in `orientation-store.ts` so the deck
 * Settings UI can read + override it without touching server source. The
 * helper reads through to a deck-managed file on disk (`<dataDir>/prelude.md`)
 * and falls back to the bundled default when no override exists.
 */

interface Active {
	handle: InProcessSessionHandle;
	session: AgentSession;
	unsubscribe: () => void;
	/** Wall-clock ms of the last user-visible activity on this session. */
	lastActivityAt: number;
	/** True between turn_start and turn_end — never reap mid-turn. */
	turnInFlight: boolean;
	/** Set of WS connection ids currently subscribed. Reaping requires zero subscribers. */
	subscribers: Set<string>;
	/** Per-session bridge from SDK `ExtensionUIContext` calls to deck WS frames. */
	uiBridge: ExtensionUIBridge;
	/** Per-session bridge for the SDK plan-mode lifecycle. */
	planBridge: PlanModeBridge;
}

export class InProcessAgentBridge implements AgentBridge {
	private active = new Map<string, Active>();
	private disposed = false;
	private reaperTimer: ReturnType<typeof setInterval> | null = null;
	private idleTimeoutMs: number;
	private readonly reapIntervalMs: number;
	private autoStartCommand: string | null;
	/** Prompts queued to fire as soon as the named session gets its first WS subscriber. */
	private pendingAutoPrompts = new Map<string, string>();
	/** Shared SDK model registry, lazily constructed on first session create. */
	private modelRegistry: ModelRegistry | undefined;
	private modelRegistryPromise: Promise<ModelRegistry> | undefined;

	constructor(opts: {
		idleTimeoutMs?: number;
		reapIntervalMs?: number;
		autoStartCommand?: string | null;
	} = {}) {
		this.idleTimeoutMs = opts.idleTimeoutMs ?? 15 * 60_000; // 15 min default
		this.reapIntervalMs = opts.reapIntervalMs ?? 60_000; // scan once a minute
		this.autoStartCommand = opts.autoStartCommand ?? "/start";
		if (this.idleTimeoutMs > 0) this.startReaper();
	}

	async createSession(opts: CreateSessionOpts): Promise<SessionHandle> {
		const sessionManager = SessionManager.create(opts.cwd);
		const modelRegistry = await this.ensureModelRegistry();
		const result = await createAgentSession({
			cwd: opts.cwd,
			sessionManager,
			modelRegistry,
			authStorage: modelRegistry.authStorage,
			// Skip eval-tool Python warmup on session create. On Windows this otherwise
			// flashes a python.exe console window each turn-zero; on demand spawn is fine.
			skipPythonPreflight: true,
			systemPrompt: (defaults) => [getEffectivePrelude(), ...defaults],
			// Tell the SDK this session has a UI — gates the `ask` tool registration
			// and any extension that calls `ctx.ui.*`. The actual ExtensionUIContext
			// is installed via `setToolUIContext(...)` below.
			hasUI: true,
			// `opts.model` is a ModelRef ({provider,id}); the SDK's `model` option expects a
			// fully-shaped Model — resolve via the registry when present.
			...(opts.model
				? (() => {
						const m = modelRegistry.find(opts.model!.provider, opts.model!.id);
						return m ? { model: m } : {};
					})()
				: {}),
		});

		const session = result.session;
		const ext = result.extensionsResult;
		log.info(
			`createAgentSession: ${ext?.extensions?.length ?? 0} extensions loaded, ${ext?.errors?.length ?? 0} errors`,
			ext?.errors?.length ? ext.errors : undefined,
		);
		if (ext?.extensions?.length) {
			log.info(`extension paths: ${ext.extensions.map(e => (e as { path?: string }).path ?? "<unknown>").join(" | ")}`);
		}
		await this.wireExtensionRunner(session);
		const handle = this.attach(session, opts.cwd, sessionManager, result.setToolUIContext);
		if (!opts.suppressAutoStart && this.autoStartCommand) {
			this.pendingAutoPrompts.set(handle.sessionId, this.autoStartCommand);
		}
		log.info(`created session ${handle.sessionId} cwd=${opts.cwd}`);
		return handle;
	}

	async resumeSession(opts: ResumeSessionOpts): Promise<SessionHandle> {
		const sessionManager = await SessionManager.open(opts.sessionPath);
		const cwd = (sessionManager.getCwd?.() as string | undefined) ?? process.cwd();
		const modelRegistry = await this.ensureModelRegistry();
		const result = await createAgentSession({
			cwd,
			sessionManager,
			modelRegistry,
			authStorage: modelRegistry.authStorage,
			skipPythonPreflight: true,
			systemPrompt: (defaults) => [getEffectivePrelude(), ...defaults],
			hasUI: true,
		});
		const session = result.session;
		const handle = this.attach(session, cwd, sessionManager, result.setToolUIContext);
		await this.wireExtensionRunner(session);
		log.info(`resumed session ${handle.sessionId} from ${opts.sessionPath}`);
		return handle;
	}


	getSession(sessionId: string): SessionHandle | undefined {
		return this.active.get(sessionId)?.handle;
	}

	async listSessions(opts: { cwd?: string }): Promise<SessionSummary[]> {
		const raw = opts.cwd
			? await SessionManager.list(opts.cwd)
			: await SessionManager.listAll();
		return raw.map((r: any) => summarize(r));
	}

	private ensureModelRegistry(): Promise<ModelRegistry> {
		if (this.modelRegistry) return Promise.resolve(this.modelRegistry);
		if (this.modelRegistryPromise) return this.modelRegistryPromise;
		this.modelRegistryPromise = (async () => {
			const registry = await getDeckModelRegistry();
			this.modelRegistry = registry;
			return registry;
		})();
		return this.modelRegistryPromise;
	}

	async listModels(opts: { sessionId?: string } = {}): Promise<ModelInfo[]> {
		const registry = await this.ensureModelRegistry();
		const current = opts.sessionId ? this.active.get(opts.sessionId)?.handle.snapshot().model : undefined;
		return registry.getAll().map((model) => modelInfoFromSdk(model as unknown as SdkModel, registry, current));
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.reaperTimer) {
			clearInterval(this.reaperTimer);
			this.reaperTimer = null;
		}
		log.info(`disposing ${this.active.size} active session(s)`);
		const disposals = Array.from(this.active.values()).map((a) =>
			a.handle.dispose().catch((err) => log.warn(`dispose failed`, err)),
		);
		await Promise.all(disposals);
		this.active.clear();
		this.pendingAutoPrompts.clear();
	}

	/** Called by the WS hub when a connection subscribes. Pin the session against the reaper. */
	trackSubscriberAdded(sessionId: string, connectionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		const wasEmpty = a.subscribers.size === 0;
		a.subscribers.add(connectionId);
		a.lastActivityAt = Date.now();

		// First subscriber attached — flush any queued auto-prompt. Defer one
		// macrotask so the WS layer has flushed the `subscribed` snapshot frame
		// before the agent starts emitting `agent_start` / `message_*`.
		if (wasEmpty) {
			const pending = this.pendingAutoPrompts.get(sessionId);
			if (pending !== undefined) {
				this.pendingAutoPrompts.delete(sessionId);
				setTimeout(() => {
					a.handle.prompt(pending).catch((err) =>
						log.warn(`auto-start prompt failed for ${sessionId}`, err),
					);
				}, 50);
			}
		}
	}

	/** Called by the WS hub on unsubscribe / connection close. */
	trackSubscriberRemoved(sessionId: string, connectionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		a.subscribers.delete(connectionId);
		a.lastActivityAt = Date.now();
	}

	/** Bumps last-activity to now; called from prompt / abort / explicit access. */
	bumpActivity(sessionId: string): void {
		const a = this.active.get(sessionId);
		if (!a) return;
		a.lastActivityAt = Date.now();
	}

	applyEnvUpdate(update: RuntimeEnvUpdate): void {
		if (update.autoStartCommand !== undefined) {
			this.autoStartCommand = update.autoStartCommand;
			log.info(`hot-applied autoStartCommand`, { enabled: Boolean(update.autoStartCommand) });
		}
		if (update.idleTimeoutMs !== undefined && update.idleTimeoutMs !== this.idleTimeoutMs) {
			this.idleTimeoutMs = update.idleTimeoutMs;
			if (this.reaperTimer) {
				clearInterval(this.reaperTimer);
				this.reaperTimer = null;
			}
			if (this.idleTimeoutMs > 0) this.startReaper();
			log.info(`hot-applied idleTimeoutMs`, { idleTimeoutMs: this.idleTimeoutMs });
		}
	}

	private startReaper(): void {
		this.reaperTimer = setInterval(() => {
			this.reapIdle().catch((err) => log.warn(`reaper failed`, err));
		}, this.reapIntervalMs);
		// Don't keep the event loop alive for the timer alone.
		(this.reaperTimer as unknown as { unref?: () => void }).unref?.();
	}

	private async reapIdle(): Promise<void> {
		if (this.disposed) return;
		const now = Date.now();
		const cutoff = now - this.idleTimeoutMs;
		const candidates: Active[] = [];
		for (const a of this.active.values()) {
			if (a.turnInFlight) continue;
			if (a.subscribers.size > 0) continue;
			if (a.lastActivityAt > cutoff) continue;
			candidates.push(a);
		}
		if (candidates.length === 0) return;
		log.info(`reaping ${candidates.length} idle session(s)`);
		await Promise.all(
			candidates.map((a) =>
				a.handle.dispose().catch((err) => log.warn(`reap dispose failed`, err)),
			),
		);
	}

	/**
	 * Wire session-bound callbacks into the session's ExtensionRunner so the
	 * lifecycle events fire and `pi.sendUserMessage` etc. reach the right
	 * session. `createAgentSession` does extension *discovery* + runner
	 * construction internally; the embedder is responsible for installing
	 * the per-session callbacks afterward (mirrors task/executor.ts and
	 * modes/acp/acp-agent.ts). Without this, loaded extensions are inert.
	 */
	private async wireExtensionRunner(session: AgentSession): Promise<void> {
		const runner = (session as unknown as { extensionRunner?: unknown }).extensionRunner as
			| {
					initialize: (actions: unknown, contextActions: unknown) => void;
					emit: (event: { type: string }) => Promise<void> | void;
					onError: (h: (e: { extensionPath?: string; error: unknown }) => void) => void;
			  }
			| undefined;
		if (!runner) return;

		const s = session as unknown as {
			sendCustomMessage: (msg: unknown, opts?: unknown) => Promise<void>;
			sendUserMessage: (content: unknown, opts?: unknown) => Promise<void>;
			sessionManager: {
				appendCustomEntry: (customType: string, data?: unknown) => string;
				appendLabelChange: (targetId: string, label: string) => void;
				getSessionName: () => string | undefined;
				setSessionName: (name: string, source: string) => Promise<void>;
			};
			getActiveToolNames: () => string[];
			getAllToolNames: () => string[];
			setActiveToolsByName: (names: string[]) => void;
			setModel: (model: unknown) => Promise<void>;
			modelRegistry: { getApiKey: (m: unknown) => Promise<string | undefined> };
			model: unknown;
			thinkingLevel: unknown;
			setThinkingLevel: (l: unknown) => void;
			isStreaming: boolean;
			abort: () => void;
			queuedMessageCount: number;
			getContextUsage: () => unknown;
			systemPrompt: unknown;
		};

		const actions = {
			sendMessage: (message: unknown, options?: unknown) => {
				s.sendCustomMessage(message, options).catch((err: unknown) => {
					log.warn(`extension sendMessage failed`, err);
				});
			},
			sendUserMessage: (content: unknown, options?: unknown) => {
				s.sendUserMessage(content, options).catch((err: unknown) => {
					log.warn(`extension sendUserMessage failed`, err);
				});
			},
			appendEntry: (customType: string, data?: unknown) => {
				return s.sessionManager.appendCustomEntry(customType, data);
			},
			setLabel: (targetId: string, label: string) => {
				s.sessionManager.appendLabelChange(targetId, label);
			},
			getActiveTools: () => s.getActiveToolNames(),
			getAllTools: () => s.getAllToolNames(),
			setActiveTools: (toolNames: string[]) => s.setActiveToolsByName(toolNames),
			getCommands: () => getSessionSlashCommands(s as never),
			setModel: (model: unknown) => runExtensionSetModel(s as never, model as never),
			getThinkingLevel: () => s.thinkingLevel,
			setThinkingLevel: (level: unknown) => s.setThinkingLevel(level),
			getSessionName: () => s.sessionManager.getSessionName(),
			setSessionName: async (name: string) => {
				await s.sessionManager.setSessionName(name, "user");
			},
		};

		const contextActions = {
			getModel: () => s.model,
			isIdle: () => !s.isStreaming,
			abort: () => s.abort(),
			hasPendingMessages: () => s.queuedMessageCount > 0,
			shutdown: () => {},
			getContextUsage: () => s.getContextUsage(),
			getSystemPrompt: () => s.systemPrompt,
			compact: (instructionsOrOptions: unknown) =>
				runExtensionCompact(s as never, instructionsOrOptions as never),
		};

		try {
			runner.initialize(actions, contextActions);
			runner.onError((err) => {
				log.warn(`extension error in ${err.extensionPath ?? "<unknown>"}`, err.error);
			});
			await runner.emit({ type: "session_start" });
			log.info(`extension runner wired for session`);
		} catch (err) {
			log.warn(`extension runner wiring failed`, err);
		}
	}

	private attach(
		session: AgentSession,
		cwd: string,
		sessionManager: SessionManager,
		setToolUIContext: import("@oh-my-pi/pi-coding-agent").CreateAgentSessionResult["setToolUIContext"],
	): InProcessSessionHandle {
		const sessionId = (session as any).sessionId as string;
		const uiBridge = new ExtensionUIBridge(sessionId);
		// Wire the per-session UI context into the SDK's tool-context store so
		// `AskTool.execute(...)` (and any extension calling `ctx.ui.*`) reaches
		// the deck UI via WebSocket frames.
		setToolUIContext(uiBridge, true);

		const planBridge = new PlanModeBridge({
			sessionId,
			session: session as unknown as import("./plan-mode-bridge.ts").PlanModeSessionSurface,
			getArtifactsDir: () => (sessionManager as unknown as { getArtifactsDir: () => string | null }).getArtifactsDir(),
			getSessionId: () => (sessionManager as unknown as { getSessionId: () => string | null }).getSessionId(),
		});

		const handle = new InProcessSessionHandle({
			session,
			sessionManager,
			cwd,
			sessionId,
			getModelRegistry: () => this.ensureModelRegistry(),
			planBridge,
			onDispose: () => {
				uiBridge.dispose();
				planBridge.dispose();
				this.active.delete(sessionId);
				this.pendingAutoPrompts.delete(sessionId);
			},
		});

		// Bridge SDK events to handle's listeners, AND to bridge-internal activity
		// tracking so the reaper sees real agent work and won't kill an in-flight turn.
		const unsubscribe = session.subscribe((event) => {
			const entry = this.active.get(sessionId);
			if (entry) {
				entry.lastActivityAt = Date.now();
				const type = (event as { type?: string })?.type;
				if (type === "turn_start") entry.turnInFlight = true;
				else if (type === "turn_end" || type === "agent_end") entry.turnInFlight = false;
			}
			handle.emit(event as unknown as AgentSessionEventJson);
			// After the SDK's own event reaches subscribers, fire a synthetic
			// `context_usage` event on the moments where the underlying number
			// changes: a turn finishing (fresh assistant usage now available)
			// or a compaction completing (post-compaction context shrunk).
			const type = (event as { type?: string })?.type;
			if (type === "turn_end" || type === "agent_end" || type === "compaction_complete") {
				const usage = handle.getContextUsage();
				if (usage) {
					handle.emit({ type: "context_usage", contextUsage: usage } as unknown as AgentSessionEventJson);
				}
			}
			// Same pattern for todos: the SDK only fires `todo_reminder` on
			// reminder ticks (typically at turn boundaries), so the deck UI
			// shows stale todos between an agent's `todo_write` call and the
			// next reminder cycle. Synthesize `todo_phases_set` after each
			// todo_write tool result so the Inspector TodoPanel reflects the
			// current phase tree within the same tick (T-106).
			if (type === "tool_execution_end") {
				const toolName = (event as { toolName?: string }).toolName;
				if (toolName === "todo_write") {
					const phases = (session as unknown as { getTodoPhases?: () => unknown[] }).getTodoPhases?.();
					if (Array.isArray(phases)) {
						handle.emit({ type: "todo_phases_set", todoPhases: phases } as unknown as AgentSessionEventJson);
					}
				}
			}
			// Issue #4 recovery hint: when the SDK surfaces an auth-shaped error
			// (401 / "Incorrect API key") on a request to an API-key provider
			// AND a subscription (OAuth) variant of the same model name exists
			// AND is actually authenticated, fire a deck notification telling
			// the operator to switch. Without this, the chat shows the raw 401
			// inline and the operator has no idea why a fresh ChatGPT-Plus
			// install rejected their first prompt. See issue #4.
			if (type === "notice") {
				const n = event as { level?: string; message?: string };
				if (n.level === "error" && typeof n.message === "string" && looksLikeAuthError(n.message)) {
					this.maybeSuggestSubscriptionFallback(session, n.message).catch((err) =>
						log.warn("subscription-fallback hint failed", err),
					);
				}
			}
		});

		this.active.set(sessionId, {
			handle,
			session,
			unsubscribe,
			lastActivityAt: Date.now(),
			turnInFlight: false,
			subscribers: new Set(),
			uiBridge,
			planBridge,
		});
		return handle;
	}

	// ─── Extension UI dialog bridge surface ──────────────────────────────

	subscribeUiFrames(
		sessionId: string,
		listener: (
			frame: Extract<ServerFrame, { type: "ext_ui_dialog_open" | "ext_ui_dialog_cancel" }>,
		) => void,
	): () => void {
		const entry = this.active.get(sessionId);
		if (!entry) return () => {};
		// Replay any already-open dialogs to the late subscriber so a page
		// reload doesn't strand the user with an invisible blocking modal.
		for (const frame of entry.uiBridge.getPendingFrames()) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`pending UI frame replay threw`, err);
			}
		}
		return entry.uiBridge.subscribeFrames(listener);
	}

	respondToUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void {
		const entry = this.active.get(sessionId);
		if (!entry) return;
		entry.uiBridge.handleResponse(dialogId, response);
	}

	// ─── Plan-mode bridge surface ────────────────────────────────────────

	subscribePlanModeFrames(
		sessionId: string,
		listener: (
			frame: Extract<
				ServerFrame,
				{ type: "plan_mode_changed" | "plan_proposed" | "plan_proposal_resolved" }
			>,
		) => void,
	): () => void {
		const entry = this.active.get(sessionId);
		if (!entry) return () => {};
		// Replay current plan-mode state + any pending approval to the late
		// subscriber so a reconnect mid-approval re-renders the card instead
		// of waiting for the next event.
		for (const frame of entry.planBridge.getReplayFrames()) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`pending plan-mode frame replay threw`, err);
			}
		}
		return entry.planBridge.subscribeFrames(listener);
	}

	async respondToPlanApproval(
		sessionId: string,
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		const entry = this.active.get(sessionId);
		if (!entry) return "unknown";
		this.bumpActivity(sessionId);
		return entry.planBridge.respond(proposalId, response);
	}

	/**
	 * Issue #4: emit a deck notification when an inline auth error on the
	 * current model has a known recovery path (subscription provider with
	 * the same model id is authenticated). Idempotent in the failure case —
	 * if any precondition is missing we just bail silently. The notification
	 * lands in the standard dropdown + optional OS toast so the operator
	 * sees it even if the chat is scrolled past the inline error.
	 */
	private async maybeSuggestSubscriptionFallback(
		session: AgentSession,
		errorMessage: string,
	): Promise<void> {
		const snap = (session as unknown as { snapshot?: () => { model?: { provider?: string; id?: string } } }).snapshot?.();
		const current = snap?.model;
		if (!current?.provider || !current.id) return;
		// Already on a subscription provider — nothing to suggest.
		if (getSubscriptionProviders().has(current.provider)) return;
		const registry = await this.ensureModelRegistry();
		// Look for any subscription provider carrying the same model id that's
		// authenticated (auth.db has OAuth credential).
		const alternative = registry
			.getAll()
			.map((m) => m as unknown as SdkModel)
			.find((m) => {
				if (m.id !== current.id) return false;
				const provider = String(m.provider);
				if (!getSubscriptionProviders().has(provider)) return false;
				const sdkModel = m as unknown as Parameters<ModelRegistry["isUsingOAuth"]>[0];
				return registry.isUsingOAuth(sdkModel);
			});
		if (!alternative) return;
		const altProvider = String(alternative.provider);
		await notificationService.notify({
			level: "warn",
			title: `Authentication failed for ${current.provider}/${current.id}`,
			body: `You appear to be authenticated for the same model under \`${altProvider}\` (subscription). Switch in the model picker to use your subscription instead.\n\nOriginal error: ${errorMessage.slice(0, 240)}`,
			source: `bridge:auth-fallback`,
		});
	}
}

export class InProcessSessionHandle implements SessionHandle {
	readonly sessionId: string;
	readonly cwd: string;
	private session: AgentSession;
	private readonly sessionManager: SessionManager;
	private readonly modelRegistryRef: () => Promise<ModelRegistry>;
	private readonly planBridge: PlanModeBridge;
	private listeners = new Set<EventListener>();
	private onDisposeCallback: () => void;
	private disposed = false;
	/**
	 * Shadow of the SDK's pending-prompt queue. Entries are appended in
	 * `prompt()` when the SDK confirms a queue (wasStreaming = true) and
	 * removed in two ways:
	 *   - SDK drains the head as a new turn starts → caught in `emit()` on
	 *     the matching user `message_start` (matches by text, mirroring the
	 *     web reducer's drain rule).
	 *   - User explicitly cancels / edits via `cancelQueuedById` /
	 *     `editQueuedById` / `clearQueue`.
	 * The wire id (`queuedId` echoed in `prompt_queued`) is the same id used
	 * for cancel/edit targeting, so client and server agree without a
	 * separate id mapping table.
	 */
	private shadowQueue: import("@omp-deck/protocol").QueuedPromptWire[] = [];

	constructor(args: {
		session: AgentSession;
		sessionManager: SessionManager;
		cwd: string;
		sessionId: string;
		getModelRegistry: () => Promise<ModelRegistry>;
		planBridge: PlanModeBridge;
		onDispose: () => void;
	}) {
		this.session = args.session;
		this.sessionManager = args.sessionManager;
		this.cwd = args.cwd;
		this.sessionId = args.sessionId;
		this.modelRegistryRef = args.getModelRegistry;
		this.planBridge = args.planBridge;
		this.onDisposeCallback = args.onDispose;
	}

	get sessionFile(): string | undefined {
		return (this.session as any).sessionFile as string | undefined;
	}

	subscribe(listener: EventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	emit(event: AgentSessionEventJson): void {
		this.maybeDrainShadowHead(event);
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				log.warn(`listener failed`, err);
			}
		}
	}

	/**
	 * When the SDK starts a new turn it emits a `message_start` for the
	 * (non-synthetic) user message that triggered it. If that message text
	 * matches a shadowed queued prompt, the SDK drained it from the queue —
	 * pop the matching entry so the deck UI's queued-bubble disappears in
	 * lockstep with the real user bubble that appears.
	 *
	 * Match-by-text is brittle on duplicates but mirrors the web reducer's
	 * existing logic; the bridge keeps its shadow text aligned with the
	 * SDK-stored expansion (see `prompt()`) so slash-expanded prompts match.
	 */
	private maybeDrainShadowHead(event: AgentSessionEventJson): void {
		if (this.shadowQueue.length === 0) return;
		if ((event as { type?: string }).type !== "message_start") return;
		const message = (event as { message?: { role?: string; content?: unknown; synthetic?: boolean } }).message;
		if (!message || message.role !== "user" || message.synthetic) return;
		const text = extractMessageText(message.content);
		if (!text) return;
		const idx = this.shadowQueue.findIndex((q) => q.text === text);
		if (idx < 0) return;
		this.shadowQueue.splice(idx, 1);
		this.emitQueueState();
	}

	/**
	 * Broadcast the current shadow queue to subscribers so they can replace
	 * their local `queuedPrompts` wholesale. Used after cancel/edit/clear
	 * and on drain. Carries `null` for empty so the reducer can distinguish
	 * "queue actively empty" from "no state delivered yet".
	 */
	private emitQueueState(): void {
		// Direct fan-out — do NOT route through `emit()` or we'd recurse via
		// `maybeDrainShadowHead`.
		const frame = {
			type: "queue_state",
			queue: [...this.shadowQueue],
		} as unknown as AgentSessionEventJson;
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`queue_state listener failed`, err);
			}
		}
	}

	snapshot(): SessionSnapshot {
		const s = this.session as any;
		const usage = this.getContextUsage();
		const snap: SessionSnapshot = {
			sessionId: this.sessionId,
			sessionFile: this.sessionFile,
			sessionName: typeof s.sessionName === "string" ? s.sessionName : undefined,
			cwd: this.cwd,
			model:
				s.model && typeof s.model === "object"
					? { provider: String(s.model.provider), id: String(s.model.id) }
					: undefined,
			thinkingLevel: typeof s.thinkingLevel === "string" ? s.thinkingLevel : undefined,
			isStreaming: Boolean(s.isStreaming),
			messages: Array.isArray(s.messages) ? (s.messages as AgentMessageJson[]) : [],
			todoPhases: typeof s.getTodoPhases === "function" ? s.getTodoPhases() : [],
		};
		if (usage) snap.contextUsage = usage;
		const planMode = this.planBridge.getPlanModeContext();
		if (planMode) snap.planMode = planMode;
		const pendingPlan = this.planBridge.getPendingPlanApproval();
		if (pendingPlan) snap.pendingPlanApproval = pendingPlan;
		if (this.shadowQueue.length > 0) snap.queuedPrompts = [...this.shadowQueue];
		return snap;
	}

	getContextUsage(): import("@omp-deck/protocol").ContextUsage | undefined {
		// The SDK exposes `session.getContextUsage()` returning
		// `{ tokens: number | null, contextWindow: number, percent: number | null }`
		// or `undefined` when the model has no declared window. We pass it through
		// verbatim — the deck's protocol type mirrors the SDK shape.
		const s = this.session as unknown as {
			getContextUsage?: () => import("@omp-deck/protocol").ContextUsage | undefined;
		};
		if (typeof s.getContextUsage !== "function") return undefined;
		try {
			return s.getContextUsage();
		} catch (err) {
			log.warn(`getContextUsage threw`, err);
			return undefined;
		}
	}

	async compact(focus?: string): Promise<void> {
		// `session.compact(customInstructions?)` is the public SDK entry. The
		// SDK guards against concurrent compactions itself (throws "Compaction
		// already in progress") — we surface that error to the caller as-is so
		// the UI can show it.
		const s = this.session as unknown as {
			compact?: (customInstructions?: string) => Promise<unknown>;
		};
		if (typeof s.compact !== "function") {
			throw new Error("session.compact is not available on this SDK build");
		}
		await s.compact(focus && focus.trim().length > 0 ? focus.trim() : undefined);
	}

	async setModel(ref: ModelRef): Promise<void> {
		const registry = await this.modelRegistryRef();
		const model = registry.find(ref.provider, ref.id);
		if (!model) throw new Error(`unknown model: ${ref.provider}/${ref.id}`);
		if (!registry.hasConfiguredAuth(model)) {
			throw new Error(`no auth configured for ${ref.provider}/${ref.id}`);
		}
		const s = this.session as unknown as {
			setModel?: (model: unknown, role?: string) => Promise<void>;
		};
		if (typeof s.setModel !== "function") {
			throw new Error("session.setModel is not available on this SDK build");
		}
		await s.setModel(model);
		// Synthetic event so WS subscribers refresh the session header's model
		// label without waiting for the next assistant turn.
		this.emit({ type: "session_updated", snapshot: this.snapshot() } as unknown as AgentSessionEventJson);
	}

	async dispatchDeckSlashCommand(text: string): Promise<SlashDispatchResult> {
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		let result: import("../deck-slash-commands.ts").DeckSlashResult | "fallthrough";
		try {
			const { executeDeckSlashCommand } = await import("../deck-slash-commands.ts");
			result = await executeDeckSlashCommand(text, { cwd: this.cwd });
		} catch (err) {
			const message = `Slash command error: ${String((err as Error).message ?? err)}`;
			log.warn(`deck slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		if (result === "fallthrough") return { kind: "fallthrough" };
		this.emitSyntheticSlashRoundTrip(text, result.output || "Done.");
		return { kind: "consumed", output: result.output || "Done." };
	}

	async dispatchSlashCommand(text: string): Promise<SlashDispatchResult> {
		if (!text.startsWith("/")) return { kind: "fallthrough" };
		const chunks: string[] = [];
		const runtime = {
			session: this.session,
			sessionManager: this.sessionManager,
			settings: ompSettings,
			cwd: this.cwd,
			output: (line: string) => {
				if (line) chunks.push(line);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		let result: unknown;
		try {
			result = await executeAcpBuiltinSlashCommand(text, runtime as unknown as Parameters<typeof executeAcpBuiltinSlashCommand>[1]);
		} catch (err) {
			const message = `Slash command error: ${String((err as Error).message ?? err)}`;
			log.warn(`slash dispatch threw for ${text.slice(0, 40)}: ${String(err)}`);
			this.emitSyntheticSlashRoundTrip(text, message);
			return { kind: "consumed", output: message };
		}
		const output = chunks.join("\n").trim();
		if (result === false) return { kind: "fallthrough" };
		if (result && typeof result === "object" && "prompt" in result && typeof (result as { prompt: unknown }).prompt === "string") {
			this.emitSyntheticSlashRoundTrip(text, output || undefined);
			return { kind: "rewritten", output, prompt: (result as { prompt: string }).prompt };
		}
		const final = output || "Done.";
		this.emitSyntheticSlashRoundTrip(text, final);
		return { kind: "consumed", output: final };
	}

	private emitSyntheticSlashRoundTrip(userText: string, assistantText: string | undefined): void {
		const now = Date.now();
		this.emit({
			type: "message_start",
			message: {
				role: "user",
				content: userText,
				timestamp: now,
				synthetic: true,
			},
		} as unknown as AgentSessionEventJson);
		if (!assistantText) return;
		this.emit({
			type: "message_start",
			message: {
				role: "assistant",
				content: [{ type: "text", text: assistantText }],
				timestamp: now,
				synthetic: true,
			},
		} as unknown as AgentSessionEventJson);
	}

	async prompt(
		text: string,
		opts?: { streamingBehavior?: "steer" | "followUp"; images?: import("@omp-deck/protocol").ImageAttachment[] },
	): Promise<void> {
		// Snapshot the streaming flag BEFORE calling the SDK so we can tell
		// whether the SDK queued this prompt (was streaming) or ran it immediately.
		// The deck UI uses this to surface a "queued" bubble — without it, prompts
		// sent during streaming look like they vanished until the current turn ends.
		const wasStreaming = this.isStreamingNow();
		const behavior = (opts?.streamingBehavior ?? "followUp") as "steer" | "followUp";
		const promptOpts: Record<string, unknown> = {};
		if (opts?.streamingBehavior) promptOpts.streamingBehavior = opts.streamingBehavior;
		if (opts?.images && opts.images.length > 0) promptOpts.images = opts.images;
		await this.session.prompt(text, Object.keys(promptOpts).length > 0 ? (promptOpts as any) : undefined);
		if (wasStreaming) {
			const queuedId = crypto.randomUUID();
			// Align shadow text with whatever the SDK actually stored (post-
			// slash/template expansion) so head-drain matching survives expansion.
			// Falls back to the raw text when the SDK doesn't expose getQueuedMessages.
			const storedText = this.readLastQueuedText(behavior) ?? text;
			const entry: import("@omp-deck/protocol").QueuedPromptWire = {
				id: queuedId,
				text: storedText,
				behavior,
				queuedAt: Date.now(),
			};
			if (opts?.images && opts.images.length > 0) entry.images = opts.images;
			this.shadowQueue.push(entry);
			this.emit({
				type: "prompt_queued",
				queuedId,
				text: storedText,
				images: opts?.images,
				behavior,
				queueLength: this.queuedMessageCount(),
			} as unknown as AgentSessionEventJson);
			this.emitQueueState();
		}
	}

	isStreamingNow(): boolean {
		const s = this.session as unknown as { isStreaming?: boolean };
		return Boolean(s.isStreaming);
	}

	queuedMessageCount(): number {
		const s = this.session as unknown as { queuedMessageCount?: number };
		return typeof s.queuedMessageCount === "number" ? s.queuedMessageCount : 0;
	}

	getQueueSnapshot(): import("@omp-deck/protocol").QueuedPromptWire[] {
		return [...this.shadowQueue];
	}

	clearQueue(): { steering: number; followUp: number } {
		const s = this.session as unknown as {
			clearQueue?: () => { steering: string[]; followUp: string[] };
		};
		if (typeof s.clearQueue !== "function") return { steering: 0, followUp: 0 };
		const dropped = s.clearQueue();
		const counts = { steering: dropped.steering.length, followUp: dropped.followUp.length };
		const hadShadow = this.shadowQueue.length > 0;
		this.shadowQueue = [];
		if (counts.steering + counts.followUp > 0) {
			this.emit({
				type: "queue_cleared",
				cleared: counts,
			} as unknown as AgentSessionEventJson);
		}
		if (hadShadow) this.emitQueueState();
		return counts;
	}

	async cancelQueuedById(id: string): Promise<boolean> {
		const idx = this.shadowQueue.findIndex((q) => q.id === id);
		if (idx < 0) return false;
		await this.rebuildQueueExcept(idx, undefined);
		return true;
	}

	async editQueuedById(
		id: string,
		text: string,
		images?: import("@omp-deck/protocol").ImageAttachment[],
	): Promise<boolean> {
		const idx = this.shadowQueue.findIndex((q) => q.id === id);
		if (idx < 0) return false;
		await this.rebuildQueueExcept(idx, { text, images });
		return true;
	}

	/**
	 * Rebuild the SDK queue by popping every entry and re-enqueueing
	 * survivors. When `replace` is undefined the entry at `targetIdx` is
	 * dropped (cancel); when set, its text/images are substituted in place
	 * (edit). Preserves order and the `queuedId` of every other entry so
	 * client bubbles don't flicker.
	 *
	 * Safety: the operation is only safe while a turn is in flight (queue is
	 * non-empty by precondition). The pop loop is synchronous so no
	 * microtasks can run mid-loop; the re-enqueue calls are kicked off
	 * synchronously (their sync prelude all observes `isStreaming = true`
	 * because the active turn is still streaming) and awaited in parallel.
	 */
	private async rebuildQueueExcept(
		targetIdx: number,
		replace: { text: string; images?: import("@omp-deck/protocol").ImageAttachment[] } | undefined,
	): Promise<void> {
		const sdk = this.session as unknown as {
			popLastQueuedMessage?: () => string | undefined;
			isStreaming?: boolean;
		};
		if (typeof sdk.popLastQueuedMessage !== "function") {
			throw new Error("session.popLastQueuedMessage is not available on this SDK build");
		}
		// Capture survivors with original ids preserved. The edited entry
		// keeps its id so the deck bubble doesn't re-key.
		const survivors: import("@omp-deck/protocol").QueuedPromptWire[] = [];
		for (let i = 0; i < this.shadowQueue.length; i++) {
			const entry = this.shadowQueue[i]!;
			if (i === targetIdx) {
				if (!replace) continue;
				const next: import("@omp-deck/protocol").QueuedPromptWire = {
					id: entry.id,
					text: replace.text,
					behavior: entry.behavior,
					queuedAt: entry.queuedAt,
				};
				if (replace.images && replace.images.length > 0) next.images = replace.images;
				survivors.push(next);
			} else {
				survivors.push(entry);
			}
		}
		// Synchronously drain the SDK queue. popLastQueuedMessage is sync;
		// no microtask boundary inside this loop.
		while (this.queuedMessageCount() > 0) {
			sdk.popLastQueuedMessage();
		}
		// Kick off re-enqueues synchronously so each `session.prompt` sync
		// prelude sees `isStreaming = true`. Collect promises; await later.
		const promises: Promise<void>[] = [];
		for (const entry of survivors) {
			const opts: Record<string, unknown> = { streamingBehavior: entry.behavior };
			if (entry.images && entry.images.length > 0) opts.images = entry.images;
			promises.push(this.session.prompt(entry.text, opts as any));
		}
		this.shadowQueue = survivors;
		try {
			await Promise.all(promises);
			// Re-align text against the SDK's post-expansion store, by bucket.
			const bucketed = this.readQueuedTextsByBehavior();
			let stIdx = 0;
			let fuIdx = 0;
			for (const s of this.shadowQueue) {
				const bucket = s.behavior === "steer" ? bucketed.steering : bucketed.followUp;
				const i = s.behavior === "steer" ? stIdx++ : fuIdx++;
				const actual = bucket[i];
				if (typeof actual === "string") s.text = actual;
			}
		} catch (err) {
			log.warn(`re-enqueue after queue manipulation failed`, err);
			// Shadow may be ahead of reality; resync from SDK as best-effort.
			this.shadowQueue = this.resyncShadowFromSdk(this.shadowQueue);
		}
		this.emitQueueState();
	}

	private readLastQueuedText(behavior: "steer" | "followUp"): string | undefined {
		const sdk = this.session as unknown as {
			getQueuedMessages?: () => { steering: string[]; followUp: string[] };
		};
		if (typeof sdk.getQueuedMessages !== "function") return undefined;
		const q = sdk.getQueuedMessages();
		const bucket = behavior === "steer" ? q.steering : q.followUp;
		return bucket[bucket.length - 1];
	}

	private readQueuedTextsByBehavior(): { steering: string[]; followUp: string[] } {
		const sdk = this.session as unknown as {
			getQueuedMessages?: () => { steering: string[]; followUp: string[] };
		};
		if (typeof sdk.getQueuedMessages !== "function") return { steering: [], followUp: [] };
		return sdk.getQueuedMessages();
	}

	/**
	 * Last-ditch resync: if a queue manipulation lost track, rebuild the
	 * shadow from the SDK's text-only view. Re-uses caller-supplied ids
	 * positionally (steering bucket first, then followUp) so most bubbles
	 * keep their id; any extras get a fresh uuid.
	 */
	private resyncShadowFromSdk(
		previous: import("@omp-deck/protocol").QueuedPromptWire[],
	): import("@omp-deck/protocol").QueuedPromptWire[] {
		const q = this.readQueuedTextsByBehavior();
		const ordered: { text: string; behavior: "steer" | "followUp" }[] = [];
		for (const t of q.steering) ordered.push({ text: t, behavior: "steer" });
		for (const t of q.followUp) ordered.push({ text: t, behavior: "followUp" });
		const out: import("@omp-deck/protocol").QueuedPromptWire[] = [];
		for (let i = 0; i < ordered.length; i++) {
			const prev = previous[i];
			const e = ordered[i]!;
			out.push({
				id: prev?.id ?? crypto.randomUUID(),
				text: e.text,
				behavior: e.behavior,
				queuedAt: prev?.queuedAt ?? Date.now(),
				...(prev?.images ? { images: prev.images } : {}),
			});
		}
		return out;
	}

	async abort(): Promise<void> {
		// The SDK's `abort()` cancels the in-flight turn but leaves the followUp
		// queue intact, which surprises users — they pressed Stop expecting
		// "stop everything". Mirror the user intent: drop the queue first, then
		// abort. The clearQueue() emits its own `queue_cleared` event so the
		// deck UI reconciles its `queuedPrompts` list.
		this.clearQueue();
		await this.session.abort();
	}

	async setName(name: string): Promise<void> {
		// The omp SDK signature is `setSessionName(name, source?: "auto" | "user")`
		// and defaults `source` to `"auto"`. Auto-titled names are silently
		// overwritten the next time the input-controller's title generator fires
		// (typically after the first agent turn completes), so a user-supplied
		// rename made before that point would disappear once `/start` finishes.
		// Pass `"user"` so the name takes permanent precedence per SDK contract.
		const s = this.session as unknown as {
			setSessionName?: (n: string, source?: "auto" | "user") => Promise<boolean> | boolean;
		};
		if (typeof s.setSessionName !== "function") {
			throw new Error("session.setSessionName is not available on this SDK build");
		}
		const accepted = await s.setSessionName(name, "user");
		if (accepted === false) {
			throw new Error(`session rejected name (empty after sanitization?): ${JSON.stringify(name)}`);
		}
	}

	// ─── Plan-mode bridge surface ────────────────────────────────────────

	async setPlanMode(enabled: boolean): Promise<void> {
		if (enabled) {
			await this.planBridge.enter();
		} else {
			await this.planBridge.exit("user_cancelled");
		}
	}

	getPlanModeContext(): PlanModeContextWire | undefined {
		return this.planBridge.getPlanModeContext();
	}

	getPendingPlanApproval(): PendingPlanApprovalWire | undefined {
		return this.planBridge.getPendingPlanApproval();
	}

	async respondToPlanApproval(
		proposalId: string,
		response: PlanApprovalResponse,
	): Promise<"settled" | "unknown"> {
		return this.planBridge.respond(proposalId, response);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		try {
			await this.session.dispose();
		} catch (err) {
			log.warn(`session.dispose threw`, err);
		}
		this.onDisposeCallback();
	}
}

/** Normalize a SessionManager.list / listAll record into our SessionSummary. */
function summarize(raw: any): SessionSummary {
	// omp's list returns objects like:
	//   { id, path, cwd, title?, timestamp, messageCount?, modifiedAt? }
	const id = String(raw.id ?? raw.sessionId ?? raw.header?.id ?? "");
	const filePath = String(raw.path ?? raw.file ?? raw.sessionFile ?? "");
	const cwd = String(raw.cwd ?? raw.header?.cwd ?? "");
	const title =
		typeof raw.title === "string"
			? raw.title
			: typeof raw.header?.title === "string"
				? raw.header.title
				: undefined;
	const createdAt = String(raw.timestamp ?? raw.createdAt ?? raw.header?.timestamp ?? "");
	const updatedAt = String(raw.modifiedAt ?? raw.updatedAt ?? createdAt);
	const messageCount = Number(raw.messageCount ?? raw.count ?? 0);
	return {
		id,
		path: filePath,
		cwd,
		title,
		createdAt,
		updatedAt,
		messageCount,
	};
}

/**
 * Provider IDs that represent a true consumer subscription — the user
 * paid a monthly fee (Claude Pro/Max, ChatGPT Plus/Pro, Copilot, Cursor)
 * or a coding plan (Z.AI GLM, Alibaba, MiniMax, Kimi). The picker badges
 * these so users can tell subscription variants apart from API-key
 * variants of the same model name (the actual bug from issue #4).
 *
 * Intentionally an explicit allowlist, not `getOAuthProviders()` from the
 * SDK. The SDK's "OAuth providers" is a broader category that also
 * includes local runtimes (Ollama, LM Studio, vLLM), gateway services
 * (LiteLLM, Kilo, Cloudflare AI Gateway), and pure-API-tier providers
 * (Cerebras, Fireworks, Together, HuggingFace) — none of which are
 * "subscriptions" in the user-facing sense. Calling Ollama a
 * "subscription" in the model picker is actively misleading.
 *
 * Used for two purposes by `modelInfoFromSdk` and the issue-#4 hint:
 *   - Tag rows with `isSubscription: true` so the picker can badge them.
 *   - Pick recovery targets for the 401-fallback notification.
 *
 * When the SDK adds a new subscription-style provider, add it here.
 * False negatives (missing a real subscription) are graceful — the user
 * just doesn't get the badge. False positives (claiming Ollama is a
 * subscription) are confusing and that's what we're fixing here.
 */
const SUBSCRIPTION_PROVIDER_IDS: ReadonlySet<string> = new Set([
	"anthropic", // Claude Pro/Max — competes with anthropic API key for Claude models
	"openai-codex", // ChatGPT Plus/Pro — competes with openai API key for gpt-5/etc.
	"github-copilot", // Copilot subscription
	"cursor", // Cursor IDE subscription — surfaces Claude/GPT models
	"perplexity", // Perplexity Pro/Max — competes with perplexity API key
	"alibaba-coding-plan", // Alibaba Coding Plan
	"zai", // Z.AI GLM Coding Plan
	"minimax-code", // MiniMax Coding Plan (International)
	"minimax-code-cn", // MiniMax Coding Plan (China)
	"kimi-code", // Kimi Code
	"google-antigravity", // Google Antigravity (preview)
]);
function getSubscriptionProviders(): ReadonlySet<string> {
	return SUBSCRIPTION_PROVIDER_IDS;
}

/**
 * Heuristic match for "this error is an auth failure on the API call we
 * just made". Used to gate the issue-#4 subscription-fallback hint. Kept
 * narrow on purpose: false positives mean we suggest a switch when none is
 * needed, which is annoying; the worst case is silence on a less-common
 * error shape, which is the existing behavior.
 */
function looksLikeAuthError(message: string): boolean {
	const m = message.toLowerCase();
	if (m.includes("401")) return true;
	if (m.includes("incorrect api key")) return true;
	if (m.includes("invalid api key")) return true;
	if (m.includes("invalid_api_key")) return true;
	if (m.includes("unauthorized")) return true;
	if (m.includes("authentication failed")) return true;
	if (m.includes("api key is required")) return true;
	return false;
}

function modelInfoFromSdk(
	model: SdkModel,
	registry: ModelRegistry,
	current: { provider: string; id: string } | undefined,
): ModelInfo {
	const provider = String(model.provider);
	const sdkModel = model as unknown as Parameters<ModelRegistry["hasConfiguredAuth"]>[0];
	const hasAuth = registry.hasConfiguredAuth(sdkModel);
	const usingOAuth = registry.isUsingOAuth(sdkModel);
	const isSubscription = getSubscriptionProviders().has(provider);
	// `isAvailable` semantics: would a call routed to this provider succeed?
	//   - SDK reports no configured auth at all → false (keyless paths are
	//     also flagged via hasConfiguredAuth, so this also covers them).
	//   - SDK has an OAuth credential in auth.db (`isUsingOAuth`) → true,
	//     regardless of what's in process.env.
	//   - Otherwise an env-var API key is the credential source. Validate
	//     that the value isn't a known placeholder (`sk-your-…here`, etc.)
	//     — see credential-quality.ts and issue #4.
	let isAvailable = hasAuth;
	if (isAvailable && !usingOAuth) {
		const envValue = getEnvApiKey(provider);
		// Only suppress when the env-var IS the credential. An empty env var
		// with `hasConfiguredAuth=true` means auth came from somewhere else
		// (auth.db non-OAuth entry, keyless provider, foundry, etc.) — trust
		// the SDK in that case.
		if (envValue && looksLikePlaceholderKey(envValue)) {
			isAvailable = false;
		}
	}
	const info: ModelInfo = {
		provider,
		id: model.id,
		label: model.name || model.id,
		isAvailable,
	};
	if (isSubscription) info.isSubscription = true;
	if (typeof model.contextWindow === "number" && model.contextWindow > 0) {
		info.contextWindow = model.contextWindow;
	}
	if (Array.isArray(model.input) && model.input.length > 0) {
		info.inputModes = model.input.filter((m: unknown): m is "text" | "image" => m === "text" || m === "image");
	}
	if (current && current.provider === info.provider && current.id === info.id) {
		info.isCurrent = true;
	}
	return info;
}

/**
 * Extract the user-visible text from an SDK user-message `content` field.
 * Mirrors the shape variations the SDK emits: plain string, an array of
 * blocks like `{type:"text", text}`, or an object with a `.text` field.
 * Returns the empty string when nothing text-like is present (e.g.
 * image-only message).
 */
function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (typeof block === "string") parts.push(block);
			else if (block && typeof block === "object") {
				const b = block as { type?: string; text?: unknown };
				if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			}
		}
		return parts.join("");
	}
	if (content && typeof content === "object") {
		const c = content as { text?: unknown };
		if (typeof c.text === "string") return c.text;
	}
	return "";
}
