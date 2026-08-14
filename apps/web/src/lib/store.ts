import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type {
	DeployState,
	ExtUiDialogResponse,
	GholamChat,
	GholamChatMessageWire,
	GholamChatState,
	McpHealthResponse,
	McpHealthStatus,
	Prompt,
	PromptRecommendation,
	ListSessionsResponse,
	ListWorkspacesResponse,
	NotificationLevel,
	PendingPlanApprovalWire,
	PlanModeContextWire,
	SessionSummary,
	ServerFrame,
	WorkspaceEntry,
} from "@omp-deck/protocol";

/**
 * In-app notification record. Mirrors the wire frame plus client-side
 * metadata: `receivedAtMs` for ordering, `deliveredOs` so the OS-level
 * Notification renderer only fires once per item.
 */
export interface NotificationItem {
	id: string;
	level: NotificationLevel;
	title: string;
	body?: string;
	sound?: boolean;
	source?: string;
	actionUrl?: string;
	timestamp: string;
	receivedAtMs: number;
	deliveredOs: boolean;
	dismissed: boolean;
}

/** Max notifications retained in the in-app queue. Older items fall off. */
const MAX_NOTIFICATIONS = 50;

import { api } from "./api";
import { applyEvent, initSession } from "./reducer";
import type { SessionUi } from "./types";
import { WsClient, type WsStatus } from "./ws";

function readBool(key: string, fallback: boolean): boolean {
	if (typeof localStorage === "undefined") return fallback;
	const raw = localStorage.getItem(key);
	if (raw === null) return fallback;
	return raw === "1";
}

/** Matches the Tailwind `lg` breakpoint (1024px) used by `Layout`. Below this
 * width the sidebar and inspector behave as overlay drawers, so persisting
 * "open" state would auto-open them on every mobile load and bury the main
 * content under a backdrop.  */
function isDesktopViewport(): boolean {
	return typeof window !== "undefined" && window.matchMedia("(min-width: 1024px)").matches;
}

/** Chrome panel state is only persisted on desktop. On mobile we always start
 * with the panel closed and never write back, so toggling on a phone does not
 * pollute the desktop preference. */
function readChromeOpen(key: string, desktopFallback: boolean): boolean {
	if (!isDesktopViewport()) return false;
	return readBool(key, desktopFallback);
}

/** Per-chat record kept in the store. Same shape as `GholamChat`, tracked
 *  here so the reducer can splice updates on every broadcast without
 *  re-fetching the list. */
type GholamChatRecord = GholamChat;

interface ModelUsageRow {
	model: string;
	costMicrocents: number;
	tokensIn: number;
	tokensOut: number;
}

interface StoreState {
	ws: WsClient | null;
	wsStatus: WsStatus;
	connectionId?: string;

	workspaces: WorkspaceEntry[];
	defaultCwd: string;
	sessions: SessionSummary[];

	activeId?: string;
	sessionsById: Record<string, SessionUi>;

	// Track subscriptions to avoid duplicate subscribe messages.
	subscribed: Set<string>;

	/**
	 * Tool-card view state. `allCollapsed` is the bulk default; `perCard` holds
	 * user overrides (key = toolCallId, value = isOpen). On bulk toggle we clear
	 * `perCard` so the new default applies to every card uniformly.
	 */
	toolView: {
		allCollapsed: boolean;
		perCard: Record<string, boolean>;
	};

	/** Composer pre-fill used by `Open in chat` from the Tasks view. */
	pendingDraft?: { text: string };

	/** Shared chrome state — each view can open/close the inspector and sidebar. */
	sidebarOpen: boolean;
	inspectorOpen: boolean;

	/**
	 * Monotonic counter bumped every time the server broadcasts a `tasks_changed`
	 * frame (any kanban mutation, whether triggered by the deck UI, a deck slash
	 * command, or an agent calling the REST API). Views that own a local tasks
	 * cache (e.g. TasksView) subscribe to this counter and refetch when it
	 * changes — keeps the kanban view live without polling.
	 */
	tasksChangeCounter: number;

	/**
	 * Mirror of {@link tasksChangeCounter} for the skill catalog. Bumped on every
	 * `skills_changed` frame (plugin install / uninstall / enable / disable, or
	 * a SKILL.md mutation under the plugins cache dir). Drives live refetch in
	 * `SkillsView` without polling.
	 */
	skillsChangeCounter: number;

	/**
	 * Counter for `kb_changed` broadcasts. Bumped on any mutation under the
	 * watched kb root; `KbView` watches it and refetches the current file +
	 * tree. Same pattern as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	kbChangeCounter: number;

	/**
	 * Per-session open extension-UI dialog (currently used by the SDK `ask`
	 * tool, but the channel is shape-typed to cover any extension dialog).
	 * At most one dialog per session is open at a time because the SDK awaits
	 * each `ctx.ui.*` call serially; if a second open arrives it replaces the
	 * first (the server-side bridge already cancelled the predecessor before
	 * sending the new one). Cleared on `ext_ui_dialog_cancel` and on local
	 * response submission.
	 */
	pendingDialogs: Record<string, Extract<ServerFrame, { type: "ext_ui_dialog_open" }>>;

	/**
	 * Latest heartbeat the server has broadcast. `lastHeartbeatAt` is the
	 * client's local Date.now() at the moment we received the frame, NOT the
	 * server's `timestamp` — the gap drives the connection indicator and must
	 * be measured in the client's clock.
	 */
	heartbeat: {
		lastReceivedAtMs: number;
		serverStartedAt: string;
		pid: number;
		uptimeSecs: number;
		buildSha: string | null;
		version: string;
	} | null;

	/**
	 * In-app notification queue. Each `notification` frame is appended; the
	 * notification renderer pops from here when delivering an OS notification
	 * + audio cue, and a small toast surface reads from here too. Capped at
	 * MAX_NOTIFICATIONS via prune; oldest fall off.
	 */
	notifications: NotificationItem[];

	/**
	 * Latest deploy_state the server has broadcast. Null until the first
	 * frame arrives. The DeployStatusBadge reads this; the routines runner
	 * and gholam sidecar emit it.
	 */
	deployState: DeployState | null;

	/**
	 * Realtime storefront pulse. `byId` mirrors the last `store_item_added`
	 * insertion (epoch-ms) so any view can render an entry-glow without
	 * subscribing to the WS bus directly; `counter` is bumped on every
	 * `store_item_added` / `store_item_updated` / `store_item_removed` /
	 * `discovery_added` frame as a "something changed, refetch" signal —
	 * same shape as `tasksChangeCounter` / `skillsChangeCounter`.
	 */
	storefrontPulse: { byId: Record<string, number>; counter: number };

	/**
	 * Latest MCP health snapshot merged from successive `mcp_health` frames.
	 * The server emits one frame per server after each probe; we union by
	 * `McpHealthStatus.id` and stamp `lastReceivedAtMs` so the strip can
	 * mark itself stale after 60s without a frame.
	 */
	mcpHealth: { response: McpHealthResponse | null; lastReceivedAtMs: number | null };

	/**
	 * Cached prompt library for the active user. Mirrors the server-side
	 * `~/.omp-deck/prompts/` tree; views (`PromptsLibrary`,
	 * `PromptsDiscover`) hydrate from `promptsApi.list()` and mutate via
	 * the same API. Cleared on logout / reconnect.
	 */
	promptsLibrary: Prompt[];
	/**
	 * Latest recommendation payload from `GET /api/prompts/recommend`.
	 * Re-fetched by `<PromptSuggestions />` on mount + every 60s while
	 * the composer sits empty; never broadcast (each tab is best served
	 * by its own fetch — the corpus is small).
	 */
	promptsRecommendations: PromptRecommendation[];

	// ─── Persistent Gholam chat (§1 of docs/GENERATIVE.md) ────────────────
	/** Last fetch of chat history — list view hydrates from here. */
	gholamChats: Record<string, GholamChatRecord>;
	/** Selected chat for the chat-thread surface. */
	activeChatId?: string;
	/** Live message buffer. Flat per-chat map of `seq → wire shape`. */
	gholamChatMessages: Record<string, GholamChatMessageWire[]>;
	/** Selected model for the composer; mirrored from
	 *  `localStorage["omp-deck:model-selection"]`. */
	modelSelection?: { provider: string; id: string };
	/** Per-model daily usage for the inspector pane. Rolling sum; v1
	 *  accumulates in-memory only (persisted scope TBD). */
	modelUsage: Record<string, ModelUsageRow>;
	/** Bump on `gholam_chat_state`/`gholam_chat_message`/`gholam_chat_usage`
	 *  so list-view components can refetch on demand. */
	gholamChatChangeCounter: number;

	// ─── Actions ─────────────────────────────────────────────────────────
	bootstrap(): Promise<void>;
	connect(): void;
	disconnect(): void;
	refreshWorkspaces(): Promise<void>;
	refreshSessions(cwd?: string): Promise<void>;
	createSession(opts: { cwd: string; resumeFromPath?: string }): Promise<string>;
	selectSession(id: string): void;
	sendPrompt(text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
	abort(): void;
	/** Drop every queued (followUp / steering) prompt for the active session.
	 *  Server echoes a `queue_cleared` session event that reconciles
	 *  `queuedPrompts` in the reducer. */
	clearQueue(): void;
	/** Cancel a single queued prompt by its server-assigned id. Server echoes
	 *  a `queue_state` session event with the new ordered queue. */
	cancelQueued(queuedId: string): void;
	/** Edit a queued prompt's text (and optionally images) in place. */
	editQueued(queuedId: string, text: string, images?: import("@omp-deck/protocol").ImageAttachment[]): void;
	disposeSession(id: string): Promise<void>;
	renameSession(id: string, name: string): Promise<void>;
	toggleAllToolCards(): void;
	setToolCardOpen(id: string, open: boolean): void;
	setPendingDraft(draft: { text: string } | undefined): void;
	setSidebarOpen(open: boolean): void;
	setInspectorOpen(open: boolean): void;
	/** Send a dialog response over the WS and clear it locally. */
	respondToExtUiDialog(sessionId: string, dialogId: string, response: ExtUiDialogResponse): void;
	/**
	 * Toggle plan mode on the active session (T-105). Idempotent on the wire;
	 * server emits `plan_mode_changed` which the reducer mirrors back.
	 */
	setPlanMode(enabled: boolean): void;
	/**
	 * Reply to a `plan_proposed` card. Optimistically clears
	 * `pendingPlanApproval` so the UI hides immediately; the server emits
	 * `plan_proposal_resolved`, and on `error` (stale proposalId) the next
	 * `plan_proposed` replay on subscribe will restore it.
	 */
	respondToPlanApproval(args: {
		sessionId: string;
		proposalId: string;
		approved: boolean;
		finalPath?: string;
		editedContent?: string;
	}): void;
	/** Mark a notification as delivered to the OS so the renderer only fires once. */
	markNotificationDelivered(id: string): void;
	/** Hide an in-app toast for a notification (does not affect an already-delivered OS notif). */
	dismissNotification(id: string): void;
	/** Replace the cached prompt library (e.g. after create/edit/delete). */
	setPromptsLibrary(prompts: Prompt[]): void;
	/** Bump usage counter locally + ping `/use` endpoint so the server records it. */
	promptUsageBump(promptId: string): void;
	/** Cache the latest recommendation payload from `<PromptSuggestions />`. */
	setPromptRecommendations(recs: PromptRecommendation[]): void;
	// ─── Gholam chat actions ───────────────────────────────────────────
	hydrateGholamChats(chats: GholamChat[]): void;
	upsertGholamChat(chat: GholamChat): void;
	removeGholamChat(id: string): void;
	setActiveChatId(id?: string): void;
	appendGholamChatMessage(message: GholamChatMessageWire): void;
	setGholamChatState(chatId: string, state: GholamChatState, usage?: GholamChat["usage"]): void;
	recordModelUsage(model: string, usage: GholamChat["usage"]): void;
	setModelSelection(sel: { provider: string; id: string }): void;
	/** Drop the cached mcp_health when no frame has arrived for 60s. */
	markMcpHealthStale(): void;
}

export const useStore = create<StoreState>()(
	subscribeWithSelector((set, get) => ({
		ws: null,
		wsStatus: "closed",
		workspaces: [],
		defaultCwd: "",
		sessions: [],
		sessionsById: {},
		subscribed: new Set<string>(),
		toolView: { allCollapsed: false, perCard: {} },
		tasksChangeCounter: 0,
		skillsChangeCounter: 0,
		kbChangeCounter: 0,
		pendingDialogs: {},
		heartbeat: null,
		notifications: [],
		deployState: null,
		storefrontPulse: { byId: {}, counter: 0 },
		mcpHealth: { response: null, lastReceivedAtMs: null },
		promptsLibrary: [],
		promptsRecommendations: [],
		// Persistent Gholam chat state (§1).
		gholamChats: {},
		gholamChatMessages: {},
		modelUsage: {},
		modelSelection: readModelSelection(),
		gholamChatChangeCounter: 0,
		// Hydrate chrome state from localStorage at module init so first render
		// matches the user's last preference — but only on desktop. On mobile the
		// panels are overlay drawers and always start closed.
		sidebarOpen: readChromeOpen("omp-deck:sidebar-open", true),
		inspectorOpen: readChromeOpen("omp-deck:inspector-open", false),

		async bootstrap() {
			get().connect();
			await Promise.all([get().refreshWorkspaces(), get().refreshSessions()]);
		},

		connect() {
			if (get().ws) return;
			const ws = new WsClient();
			ws.onStatus((status) => set({ wsStatus: status }));
			ws.subscribe((frame) => handleFrame(frame, set, get));
			ws.connect();
			set({ ws });
		},

		disconnect() {
			get().ws?.dispose();
			set({ ws: null, wsStatus: "closed" });
		},

		async refreshWorkspaces() {
			try {
				const resp: ListWorkspacesResponse = await api.listWorkspaces();
				set({ workspaces: resp.workspaces, defaultCwd: resp.defaultCwd });
			} catch (err) {
				console.warn("listWorkspaces failed", err);
			}
		},

		async refreshSessions(cwd?: string) {
			try {
				const resp: ListSessionsResponse = await api.listSessions(cwd);
				set({ sessions: resp.sessions });
			} catch (err) {
				console.warn("listSessions failed", err);
			}
		},

		async createSession(opts) {
			const created = await api.createSession({
				cwd: opts.cwd,
				...(opts.resumeFromPath ? { resumeFromPath: opts.resumeFromPath } : {}),
			});
			// Subscribe immediately; reducer will hydrate from the `subscribed` snapshot.
			get().ws?.send({ type: "subscribe", sessionId: created.sessionId });
			get().subscribed.add(created.sessionId);
			set({ activeId: created.sessionId });
			// Background-refresh sidebar to reflect the new entry.
			void get().refreshSessions();
			void get().refreshWorkspaces();
			return created.sessionId;
		},

		selectSession(id: string) {
			set({ activeId: id });
			if (!get().subscribed.has(id)) {
				get().ws?.send({ type: "subscribe", sessionId: id });
				get().subscribed.add(id);
			}
		},

		sendPrompt(text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "prompt", sessionId: id, text, images }
				: { type: "prompt", sessionId: id, text };
			get().ws?.send(frame);
		},

		abort() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "abort", sessionId: id });
		},

		clearQueue() {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "clear_queue", sessionId: id });
		},

		cancelQueued(queuedId: string) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "cancel_queued", sessionId: id, queuedId });
		},

		editQueued(queuedId, text, images) {
			const id = get().activeId;
			if (!id) return;
			const frame: Parameters<NonNullable<StoreState["ws"]>["send"]>[0] = images && images.length > 0
				? { type: "edit_queued", sessionId: id, queuedId, text, images }
				: { type: "edit_queued", sessionId: id, queuedId, text };
			get().ws?.send(frame);
		},

		async disposeSession(id: string) {
			try {
				await api.disposeSession(id);
			} catch (err) {
				console.warn("dispose failed", err);
			}
			set((s) => {
				const next = { ...s.sessionsById };
				delete next[id];
				return {
					sessionsById: next,
					activeId: s.activeId === id ? undefined : s.activeId,
				};
			});
		},

		async renameSession(id, name) {
			// Re-throw on failure so the caller (ChatHeader) can keep the input
			// open + surface the error. Silently swallowing makes Windows-EPERM
			// failures from the SDK's atomic-rename journal save look like the
			// UI is broken when it's actually the FS rejecting the rename
			// because the journal file is held open by the live session.
			await api.renameSession(id, name);
			set((s) => {
				const existing = s.sessionsById[id];
				const next = existing
					? { ...s.sessionsById, [id]: { ...existing, sessionName: name } }
					: s.sessionsById;
				const sessions = s.sessions.map((r) => (r.id === id ? { ...r, title: name } : r));
				return { sessionsById: next, sessions };
			});
		},

		toggleAllToolCards() {
			set((s) => ({
				toolView: { allCollapsed: !s.toolView.allCollapsed, perCard: {} },
			}));
		},

		setToolCardOpen(id, open) {
			set((s) => ({
				toolView: {
					allCollapsed: s.toolView.allCollapsed,
					perCard: { ...s.toolView.perCard, [id]: open },
				},
			}));
		},

		setPendingDraft(draft) {
			set({ pendingDraft: draft });
		},

		setSidebarOpen(open) {
			// Only persist on desktop so toggling on mobile (where the panel is an
			// ephemeral overlay) doesn't auto-open it the next time the user lands
			// on the page from a wider screen.
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("omp-deck:sidebar-open", open ? "1" : "0");
				} catch {}
			}
			set({ sidebarOpen: open });
		},

		setInspectorOpen(open) {
			if (isDesktopViewport()) {
				try {
					localStorage.setItem("omp-deck:inspector-open", open ? "1" : "0");
				} catch {}
			}
			set({ inspectorOpen: open });
		},

		respondToExtUiDialog(sessionId, dialogId, response) {
			// Clear local state first — the dialog modal closes immediately —
			// then send the response over the WS so the SDK call settles.
			set((s) => {
				const current = s.pendingDialogs[sessionId];
				if (!current || current.dialogId !== dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[sessionId];
				return { pendingDialogs: next };
			});
			get().ws?.send({
				type: "ext_ui_dialog_response",
				sessionId,
				dialogId,
				...response,
			});
		},

		setPlanMode(enabled) {
			const id = get().activeId;
			if (!id) return;
			get().ws?.send({ type: "set_plan_mode", sessionId: id, enabled });
		},

		respondToPlanApproval({ sessionId, proposalId, approved, finalPath, editedContent }) {
			// Optimistically clear the local approval card so the UI hides
			// immediately. Server emits `plan_proposal_resolved`; if the
			// proposalId is stale (sibling tab won the race), the bridge's
			// own replay-on-subscribe will restore the next pending proposal
			// (if any) without us having to roll back here.
			set((s) => {
				const prev = s.sessionsById[sessionId];
				if (!prev || !prev.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			get().ws?.send({
				type: "plan_response",
				sessionId,
				proposalId,
				approved,
				...(finalPath !== undefined ? { finalPath } : {}),
				...(editedContent !== undefined ? { editedContent } : {}),
			});
		},

		markNotificationDelivered(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.deliveredOs) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, deliveredOs: true };
				return { notifications: next };
			});
		},

		dismissNotification(id) {
			set((s) => {
				const i = s.notifications.findIndex((n) => n.id === id);
				if (i < 0 || s.notifications[i]?.dismissed) return {};
				const next = s.notifications.slice();
				const target = next[i];
				if (!target) return {};
				next[i] = { ...target, dismissed: true };
				return { notifications: next };
			});
		},

	setPromptsLibrary(prompts) {
		set({ promptsLibrary: prompts });
		},

	promptUsageBump(promptId) {
		// Optimistic local bump so the sidebar "recently used" re-ranks without
		// waiting for a refetch. Fire-and-forget the server call — failure is
		// logged but not surfaced (the server reconciles via the next list).
			set((s) => {
			const next = s.promptsLibrary.map((p) =>
				p.id === promptId
					? { ...p, usageCount: p.usageCount + 1, lastUsedAt: new Date().toISOString() }
					: p,
);
			return { promptsLibrary: next };
			});
		void fetch(`/api/prompts/library/${encodeURIComponent(promptId)}/use`, {
			method: "POST",
		}).catch(() => {});
		},

	setPromptRecommendations(recs) {
		set({ promptsRecommendations: recs });
		},

	hydrateGholamChats(chats) {
		const next: Record<string, GholamChatRecord> = {};
		for (const c of chats) next[c.id] = c;
		set({ gholamChats: next });
		},

	upsertGholamChat(chat) {
		set((s) => ({
			gholamChats: { ...s.gholamChats, [chat.id]: chat },
			gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
		}));
		},

	removeGholamChat(id) {
		set((s) => {
			const next = { ...s.gholamChats };
			delete next[id];
			const nextMsgs = { ...s.gholamChatMessages };
			delete nextMsgs[id];
			return {
				gholamChats: next,
				gholamChatMessages: nextMsgs,
				activeChatId: s.activeChatId === id ? undefined : s.activeChatId,
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
		},

	setActiveChatId(id) {
		set({ activeChatId: id });
		},

	appendGholamChatMessage(message) {
		set((s) => {
			const list = s.gholamChatMessages[message.chatId] ?? [];
			if (list.some((m) => m.id === message.id)) return {};
			const next = [...list, message].sort((a, b) => a.seq - b.seq);
			return {
				gholamChatMessages: { ...s.gholamChatMessages, [message.chatId]: next },
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
		},

	setGholamChatState(chatId, state, usage) {
		set((s) => {
			const existing = s.gholamChats[chatId];
			const updated: GholamChatRecord = existing
				? { ...existing, state, updatedAt: new Date().toISOString(), usage: usage ?? existing.usage }
				: {
						id: chatId,
						title: "(loading)",
						kind: "user",
						cwd: "",
						state,
						usage: usage ?? { tokensIn: 0, tokensOut: 0, costMicrocents: 0 },
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
			return {
				gholamChats: { ...s.gholamChats, [chatId]: updated },
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
		},

	recordModelUsage(model, usage) {
		set((s) => {
			const existing = s.modelUsage[model] ?? { model, costMicrocents: 0, tokensIn: 0, tokensOut: 0 };
			const updated = {
				model,
				costMicrocents: existing.costMicrocents + usage.costMicrocents,
				tokensIn: existing.tokensIn + usage.tokensIn,
				tokensOut: existing.tokensOut + usage.tokensOut,
			};
			return { modelUsage: { ...s.modelUsage, [model]: updated } };
		});
		},

	setModelSelection(sel) {
		try {
			localStorage.setItem("omp-deck:model-selection", JSON.stringify(sel));
		} catch {
			/* ignore — localStorage quota or sandbox */
		}
		set({ modelSelection: sel });
		},

	markMcpHealthStale() {
		set({ mcpHealth: { response: null, lastReceivedAtMs: null } });
	},
	})),
);

function handleFrame(
	frame: ServerFrame,
	set: (partial: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)) => void,
	get: () => StoreState,
): void {
	switch (frame.type) {
		case "hello":
			set({ connectionId: frame.connectionId });
			// Re-subscribe to any previously-active sessions.
			for (const id of get().subscribed) {
				get().ws?.send({ type: "subscribe", sessionId: id });
			}
			return;

		case "subscribed":
			set((s) => ({
				sessionsById: {
					...s.sessionsById,
					[frame.sessionId]: initSession(frame.snapshot),
				},
			}));
			return;

		case "unsubscribed":
			get().subscribed.delete(frame.sessionId);
			return;

		case "session_event": {
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const next = applyEvent(prev, frame.event);
				return { sessionsById: { ...s.sessionsById, [frame.sessionId]: next } };
			});
			return;
		}

		case "tasks_changed":
			set((s) => ({ tasksChangeCounter: s.tasksChangeCounter + 1 }));
			return;

		case "skills_changed":
			set((s) => ({ skillsChangeCounter: s.skillsChangeCounter + 1 }));
			return;

		case "kb_changed":
			set((s) => ({ kbChangeCounter: s.kbChangeCounter + 1 }));
			return;

		case "ext_ui_dialog_open":
			set((s) => ({
				pendingDialogs: { ...s.pendingDialogs, [frame.sessionId]: frame },
			}));
			return;

		case "ext_ui_dialog_cancel":
			set((s) => {
				const current = s.pendingDialogs[frame.sessionId];
				if (!current || current.dialogId !== frame.dialogId) return {};
				const next = { ...s.pendingDialogs };
				delete next[frame.sessionId];
				return { pendingDialogs: next };
			});
			return;

		case "plan_mode_changed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const planMode: PlanModeContextWire | undefined = frame.enabled
					? { enabled: true, planFilePath: frame.planFilePath ?? "local://PLAN.md" }
					: undefined;
				// On exit, also drop any unresolved approval card — the bridge
				// has already rejected its standing handler, so leaving the
				// card visible would let the user click into a 409.
				const pendingPlanApproval = frame.enabled ? prev.pendingPlanApproval : undefined;
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, planMode, pendingPlanApproval },
					},
				};
			});
			return;

		case "plan_proposed":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev) return {};
				const pending: PendingPlanApprovalWire = {
					proposalId: frame.proposalId,
					planFilePath: frame.planFilePath,
					planContent: frame.planContent,
					suggestedTitle: frame.suggestedTitle,
					suggestedFinalPath: frame.suggestedFinalPath,
				};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: pending },
					},
				};
			});
			return;

		case "plan_proposal_resolved":
			set((s) => {
				const prev = s.sessionsById[frame.sessionId];
				if (!prev?.pendingPlanApproval) return {};
				if (prev.pendingPlanApproval.proposalId !== frame.proposalId) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[frame.sessionId]: { ...prev, pendingPlanApproval: undefined },
					},
				};
			});
			return;

		case "session_disposed":
			set((s) => {
				const nextSessions = { ...s.sessionsById };
				delete nextSessions[frame.sessionId];
				const nextDialogs = { ...s.pendingDialogs };
				delete nextDialogs[frame.sessionId];
				return {
					sessionsById: nextSessions,
					pendingDialogs: nextDialogs,
					activeId: s.activeId === frame.sessionId ? undefined : s.activeId,
				};
			});
			return;

		case "error":
			set((s) => {
				const id = frame.sessionId;
				if (!id) return {};
				const prev = s.sessionsById[id];
				if (!prev) return {};
				return {
					sessionsById: {
						...s.sessionsById,
						[id]: { ...prev, lastError: frame.error },
					},
				};
			});
			return;

		case "heartbeat":
			set(() => ({
				heartbeat: {
					lastReceivedAtMs: Date.now(),
					serverStartedAt: frame.serverStartedAt,
					pid: frame.pid,
					uptimeSecs: frame.uptimeSecs,
					buildSha: frame.buildSha,
					version: frame.version,
				},
			}));
			return;

		case "notification":
			set((s) => {
				// Dedupe by id: server may re-send on reconnect.
				if (s.notifications.some((n) => n.id === frame.id)) return {};
				const item: NotificationItem = {
					id: frame.id,
					level: frame.level,
					title: frame.title,
					timestamp: frame.timestamp,
					receivedAtMs: Date.now(),
					deliveredOs: false,
					dismissed: false,
				};
				if (frame.body !== undefined) item.body = frame.body;
				if (frame.sound !== undefined) item.sound = frame.sound;
				if (frame.source !== undefined) item.source = frame.source;
				if (frame.actionUrl !== undefined) item.actionUrl = frame.actionUrl;
				const next = [...s.notifications, item];
				// Cap retention; oldest fall off.
				if (next.length > MAX_NOTIFICATIONS) next.splice(0, next.length - MAX_NOTIFICATIONS);
				return { notifications: next };
			});
			return;

		case "pong":
		default:
			return;

	case "deploy_state":
		set((s) => {
			if (s.deployState && s.deployState.updatedAt === frame.state.updatedAt) return {};
			return { deployState: frame.state };
		});
			return;

	case "reload_available":
		// Server has a new bundle. Soft-reload by navigating with a cache
		// buster; the WS will auto-reconnect within the backoff window
		// so the user's session and composer drafts survive.
		if (typeof window !== "undefined") {
			const url = new URL(window.location.href);
			if (url.searchParams.get("v") !== frame.bundleHash) {
				url.searchParams.set("v", frame.bundleHash);
				window.location.assign(url.toString());
	}
	}
			return;

	case "gholam_chat_state":
		set((s) => {
			const existing = s.gholamChats[frame.chatId];
			const nextUsage = frame.usage ?? existing?.usage ?? { tokensIn: 0, tokensOut: 0, costMicrocents: 0 };
			const updated: GholamChatRecord = existing
				? { ...existing, state: frame.state, updatedAt: new Date().toISOString(), usage: nextUsage }
				: {
						id: frame.chatId,
						title: "(loading)",
						kind: "user",
						cwd: "",
						state: frame.state,
						usage: nextUsage,
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					};
			return {
				gholamChats: { ...s.gholamChats, [frame.chatId]: updated },
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
			return;

	case "gholam_chat_message": {
		set((s) => {
			const list = s.gholamChatMessages[frame.chatId] ?? [];
			if (list.some((m) => m.id === frame.message.id)) return {};
			const nextList = [...list, frame.message].sort((a, b) => a.seq - b.seq);
			return {
				gholamChatMessages: { ...s.gholamChatMessages, [frame.chatId]: nextList },
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
			return;
	}

	case "gholam_chat_usage":
		set((s) => {
			const existing = s.gholamChats[frame.chatId];
			if (!existing) return {};
			return {
				gholamChats: {
					...s.gholamChats,
					[frame.chatId]: { ...existing, usage: frame.usage },
				},
				gholamChatChangeCounter: s.gholamChatChangeCounter + 1,
			};
		});
			return;

case "store_item_added":
	set((s) => ({
		storefrontPulse: {
			byId: { ...s.storefrontPulse.byId, [frame.item.id]: Date.now() },
			counter: s.storefrontPulse.counter + 1,
				},
	}));
			return;

case "store_item_updated":
	set((s) => ({
		storefrontPulse: {
			byId: s.storefrontPulse.byId,
			counter: s.storefrontPulse.counter + 1,
				},
	}));
			return;

case "store_item_removed":
		set((s) => {
		const { [frame.id]: _gone, ...rest } = s.storefrontPulse.byId;
		return { storefrontPulse: { byId: rest, counter: s.storefrontPulse.counter + 1 } };
		});
			return;

case "discovery_added":
	set((s) => ({ storefrontPulse: { byId: s.storefrontPulse.byId, counter: s.storefrontPulse.counter + 1 } }));
			return;

case "mcp_health":
		set((s) => {
	// Server pushes a single snapshot per probe cycle containing all probed
	// servers; union each entry by `id` into the cached response so the
	// strip re-renders without polling. `probedAt` is the max across the
	// batch so the relative-time tooltip stays coherent under partial loss.
		const prev = s.mcpHealth.response;
		const byId = new Map<string, McpHealthStatus>();
		for (const row of prev?.status ?? []) byId.set(row.id, row);
	let latestProbe = prev?.probedAt ?? "";
	for (const row of frame.status) {
		byId.set(row.id, row);
		if (row.probedAt > latestProbe) latestProbe = row.probedAt;
	}
		const next: McpHealthResponse = {
			status: Array.from(byId.values()),
		probedAt: latestProbe,
			};
		return { mcpHealth: { response: next, lastReceivedAtMs: Date.now() } };
		});
			return;
}
}

// Selectors ────────────────────────────────────────────────────────────────
export const selectActiveSession = (s: StoreState): SessionUi | undefined =>
	s.activeId ? s.sessionsById[s.activeId] : undefined;
function readModelSelection(): { provider: string; id: string } | undefined {
	if (typeof localStorage === "undefined") return undefined;
	const raw = localStorage.getItem("omp-deck:model-selection");
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as { provider?: string; id?: string };
		if (typeof parsed.provider === "string" && typeof parsed.id === "string") {
			return { provider: parsed.provider, id: parsed.id };
		}
	} catch {
		/* ignore corrupt entry */
	}
	return undefined;
}
