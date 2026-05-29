/**
 * Shared transport types between omp-deck server and web.
 *
 * The server embeds @oh-my-pi/pi-coding-agent SDK and re-emits its
 * AgentSessionEvent stream into ServerFrames. To avoid type drift,
 * we keep payloads structurally typed via `unknown`-ish records on the
 * web side and import the real SDK types on the server side.
 *
 * This package is dep-free on purpose — it's the contract. Note: V1 added
 * `ajv` + `ajv-formats` as runtime deps so the validator (re-exported below)
 * can compile the JSON schemas. The schemas under `src/schemas/` remain the
 * single source of truth for both runtime validation and the visual builder.
 */

// Re-export the V1 routine spec validator. JSON Schemas live in src/schemas/.
export { validateRoutineSpec } from "./validate";
export type { ValidationError, ValidationResult } from "./validate";

// ─────────────────────────────────────────────────────────────────────────────
// REST shapes
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelRef {
	provider: string;
	id: string;
}

export interface SessionSummary {
	id: string;
	path: string;
	cwd: string;
	title?: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
}

export interface WorkspaceEntry {
	cwd: string;
	label: string;
	sessionCount: number;
}

export interface CreateSessionRequest {
	cwd: string;
	resumeFromPath?: string;
	model?: ModelRef;
	/** Do not fire the configured auto-start prompt when this creates a fresh session. */
	suppressAutoStart?: boolean;
}

export interface CreateSessionResponse {
	sessionId: string;
	sessionFile?: string;
	cwd: string;
}

export interface ListSessionsQuery {
	cwd?: string;
}

export interface ListSessionsResponse {
	sessions: SessionSummary[];
}

export interface ListWorkspacesResponse {
	workspaces: WorkspaceEntry[];
	defaultCwd: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings / managed environment
// ─────────────────────────────────────────────────────────────────────────────

export type EnvValueType = "string" | "int" | "path" | "enum" | "boolean";
export type EnvValueSource = "process-env" | "env-file" | "default" | "unset";
export type EnvRestartTarget = "server" | "telegram-bridge";

export interface EnvEntry {
	key: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
	defaultValue?: string;
	valueType: EnvValueType;
	sensitive: boolean;
	restartRequired: boolean;
	hotApply: boolean;
	description: string;
	options?: string[];
	restartTarget?: EnvRestartTarget;
}

export interface ListEnvSettingsResponse {
	entries: EnvEntry[];
	envFilePath: string;
	dataDir: string;
	restartRequired: boolean;
}

export interface PatchEnvSettingsRequest {
	updates: Record<string, string | null>;
}

export interface PatchEnvSettingsResponse extends ListEnvSettingsResponse {
	appliedHot: string[];
}

export interface RevealEnvValueResponse {
	key: string;
	value: string;
	masked: string;
	isSet: boolean;
	source: EnvValueSource;
}

export interface RestartServerResponse {
	ok: boolean;
	pid?: number;
	message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orientation (deck-managed session-shaping artifacts)
// ─────────────────────────────────────────────────────────────────────────────

/** Source-of-truth for the system-prompt prelude prepended to every session. */
export interface PreludeResponse {
	/** Absolute path of the deck-managed override file. */
	path: string;
	/** Bundled default text the deck falls back to when no override is set. */
	default: string;
	/** Current override text, or null when no override exists. */
	override: string | null;
	/** What the bridge actually injects on the next `createAgentSession`. */
	effective: string;
}

export interface UpdatePreludeRequest {
	/** `null` clears the override so future sessions fall back to `default`. */
	value: string | null;
}

/** The `~/.omp/agent/commands/start.md` orchestrator fired on session boot. */
export interface StartCommand {
	path: string;
	exists: boolean;
	/** `description:` frontmatter value, empty string when absent. */
	description: string;
	/** Markdown body sans frontmatter. */
	body: string;
}

export interface UpdateStartCommandRequest {
	description: string;
	body: string;
}

export type GateValueSource = "process-env" | "env-file" | "default" | "unset";

/** One tunable knob for the maintenance-gate extension. */
export interface GateKnob {
	/** Effective integer value the extension would observe right now. */
	value: number;
	/** Bundled default when no override is set. */
	default: number;
	/** Raw string from env-file / process-env, or null when unset. */
	rawValue: string | null;
	source: GateValueSource;
}

/** Live state of the maintenance-gate extension as the deck sees it. */
export interface MaintenanceGateState {
	/** Inverse of `OMP_DECK_MAINTENANCE_GATE_DISABLED`. */
	enabled: boolean;
	disabledRaw: string | null;
	disabledSource: GateValueSource;
	knobs: {
		minOpMsgs: GateKnob;
		minReleaseAgeMs: GateKnob;
		fireFloorMs: GateKnob;
	};
	orgRoot: string | null;
	orgRootSource: GateValueSource;
	installedExtensionPresent: boolean;
	installedExtensionPath: string;
	preview: { deckMode: string; flatFileMode: string };
}

export interface UpdateMaintenanceGateRequest {
	enabled?: boolean;
	minOpMsgs?: number | null;
	minReleaseAgeMs?: number | null;
	fireFloorMs?: number | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bridge supervisor (long-running auxiliary processes the deck owns)
// ─────────────────────────────────────────────────────────────────────────────

export type BridgeName = "telegram";
export type BridgeStatus = "running" | "stopped" | "starting" | "crashed";

export interface BridgeInfo {
	name: BridgeName;
	label: string;
	status: BridgeStatus;
	pid?: number;
	startedAt?: string;
	stoppedAt?: string;
	exitCode?: number;
	exitSignal?: string;
	crashCount: number;
	missingEnv: string[];
	requiredEnv: string[];
	lastError?: string;
}

export interface ListBridgesResponse {
	bridges: BridgeInfo[];
}

export interface BridgeLogLine {
	stream: "stdout" | "stderr";
	text: string;
	timestamp: string;
}

export interface BridgeLogsResponse {
	name: BridgeName;
	lines: BridgeLogLine[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	label: string;
	role?: string;
	contextWindow?: number;
	/** Provider has resolvable auth (api key set, oauth credentials present, or keyless). */
	isAvailable: boolean;
	/**
	 * True when the provider exposes a browser-OAuth flow (subscription auth)
	 * — e.g. `openai-codex` for ChatGPT Plus/Pro, `anthropic` w/ Claude Pro.
	 * The picker badges these so users can tell subscription variants apart
	 * from API-key variants of the same model name.
	 */
	isSubscription?: boolean;
	/** True for the model active in the requesting session. */
	isCurrent?: boolean;
	/** Optional UX hint: input modalities the provider supports for this model. */
	inputModes?: Array<"text" | "image">;
}

export interface ListModelsResponse {
	models: ModelInfo[];
	active?: ModelRef;
}

export interface SetSessionModelRequest {
	model: ModelRef;
}


// ─────────────────────────────────────────────────────────────────────────────
// Marketplace (SDK plugin catalog browsing + install/uninstall)
// ─────────────────────────────────────────────────────────────────────────────

export interface MarketplaceSource {
	name: string;
	sourceType: "github" | "git" | "url" | "local";
	sourceUri: string;
	updatedAt: string;
}

export interface MarketplacePluginCapabilities {
	commands?: boolean;
	agents?: boolean;
	hooks?: boolean;
	mcpServers?: boolean;
	lspServers?: boolean;
}

export interface MarketplaceCatalogEntry {
	id: string; // "name@marketplace"
	name: string;
	marketplace: string;
	description?: string;
	version?: string;
	author?: string;
	homepage?: string;
	keywords?: string[];
	category?: string;
	tags?: string[];
	capabilities: MarketplacePluginCapabilities;
	installed?: {
		scope: "user" | "project";
		version: string;
		installedAt: string;
		enabled?: boolean;
	};
}

export interface InstalledPluginInfo {
	id: string;
	name: string;
	marketplace: string;
	scope: "user" | "project";
	version: string;
	installedAt: string;
	installPath: string;
	enabled?: boolean;
	shadowedBy?: "project";
}

export interface ListMarketplaceResponse {
	sources: MarketplaceSource[];
	catalog: MarketplaceCatalogEntry[];
	installed: InstalledPluginInfo[];
}

export interface InstallPluginRequest {
	name: string;
	marketplace: string;
	scope?: "user" | "project";
	force?: boolean;
}

export interface InstallPluginResponse {
	ok: boolean;
	installed: InstalledPluginInfo;
}

export interface UninstallPluginRequest {
	id: string; // "name@marketplace"
	scope?: "user" | "project";
}

export interface AddMarketplaceRequest {
	source: string; // url, github "owner/repo", git+url, or absolute local path
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills (enumeration across every omp skill provider)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed SKILL.md frontmatter. `name` falls back to the directory name when
 * the file omits an explicit `name:` field, matching the omp SDK's loader.
 */
export interface SkillFrontmatter {
	name: string;
	description?: string;
	model?: string;
	triggers?: string[];
	tags?: string[];
}

/**
 * Provider identifier from the omp SDK's capability system. Open-ended so
 * the deck doesn't break when omp adds a new discovery provider, but the
 * known set is what the UI styles/labels/sorts by today.
 */
export type SkillProvider =
	| "native"           // omp's own — ~/.omp/agent/skills + <cwd>/.omp/skills
	| "claude-plugins"   // marketplace-installed plugins
	| "claude"           // shared ~/.claude/skills + .claude/skills
	| "codex"            // shared ~/.codex/skills + .codex/skills
	| "opencode"
	| "cursor"
	| "windsurf"
	| "cline"
	| "gemini"
	| "agents"           // skills nested under subagent dirs
	| "custom"           // custom directories from runtime config
	| (string & {});     // forward-compat

/**
 * A skill enumerated from any omp provider. `provider` + `level` say where
 * it came from; plugin attribution is set only when the source was a
 * marketplace-installed Claude plugin.
 */
export interface SkillSummary {
	/**
	 * Server-issued opaque identifier (base64url of the absolute SKILL.md
	 * path). Stable across reads, URL-safe, used as `/api/skills/:id`.
	 */
	id: string;
	/** Frontmatter `name` (falls back to dirName). */
	name: string;
	/** Directory under the provider's `skills/` root. */
	dirName: string;
	/** Provider that contributed this skill. */
	provider: SkillProvider;
	/** Human display label (e.g. "OMP", "Claude Plugins", "Claude Code"). */
	providerLabel: string;
	/** User vs project scope, from the SDK's source metadata. */
	level: "user" | "project";
	/** Absolute path to SKILL.md on disk. UI keeps this opaque. */
	skillPath: string;
	/** Parsed frontmatter (name, description, model, triggers, tags). */
	frontmatter: SkillFrontmatter;
	/** False only when the owning provider's enable-flag is off, or hide=true. */
	enabled: boolean;
	/** Plugin attribution — set only when `provider === "claude-plugins"`. */
	pluginId?: string;
	pluginName?: string;
	marketplace?: string;
}

export interface ListSkillsResponse {
	skills: SkillSummary[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge Base (Karpathy-style llm-wiki viewer over ~/kb)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry in a KB tree listing. `path` is always forward-slash separated
 * and rooted at the KB root (e.g. "tools/tauri-knowledge-hub.md"). For dirs
 * `mdCount` includes recursive markdown count after exclude rules.
 */
export interface KbTreeEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
	/** Bytes; omitted for directories. */
	size?: number;
	/** ISO timestamp; omitted for directories. */
	mtime?: string;
	/** Recursive markdown count, dirs only. */
	mdCount?: number;
	/** True when this entry is a symlink/junction (e.g. cryptocracy). */
	symlink?: boolean;
}

export interface KbTreeResponse {
	/** The requested directory's relative path; empty for root. */
	path: string;
	dirs: KbTreeEntry[];
	files: KbTreeEntry[];
}

/**
 * One parsed wikilink from a SKILL/article body. `resolved` is the relative
 * path of the matching file (forward-slash), or null when no file matches
 * the target's stem or subpath. `anchor` carries any `#section` portion.
 */
export interface KbWikilink {
	/** Verbatim text inside `[[…]]`, including label and anchor parts. */
	raw: string;
	/** The target without label/anchor — what was used to resolve. */
	target: string;
	/** Render label (`[[target|label]]` — defaults to `target`). */
	label: string;
	/** Anchor portion (`[[target#anchor]]`) — null if absent. */
	anchor: string | null;
	/** Resolved kb-relative path with forward slashes, or null. */
	resolved: string | null;
	/** Reason resolution failed when `resolved === null`. */
	unresolvedReason?: "no-match" | "ambiguous-stem" | "outside-kb";
}

export interface KbFileResponse {
	/** Forward-slash relative path from kb root. */
	path: string;
	/** Absolute disk path; opaque to clients but useful for inspector. */
	absolutePath: string;
	/** Parsed YAML frontmatter (empty when absent or invalid). */
	frontmatter: Record<string, unknown>;
	/** Frontmatter parser warning when `---` block was malformed YAML. */
	frontmatterError?: string;
	/** SKILL.md / article body with frontmatter stripped. */
	body: string;
	/** Verbatim file content on disk (frontmatter + body) — used by the editor. */
	rawContent: string;
	/**
	 * Body with wikilinks already substituted to in-app markdown links so the
	 * web client can render directly through react-markdown without
	 * understanding `[[…]]` syntax. Resolved links become
	 * `[label](kb-link:<resolved>?anchor=<a>)`; unresolved links become
	 * `[label](kb-unresolved:<target>)`. Wikilinks inside fenced code or
	 * inline backticks are left alone.
	 */
	bodyForRender: string;
	/** Outgoing wikilinks, in order of appearance. */
	outgoingLinks: KbWikilink[];
	/** File size in bytes. */
	size: number;
	/** ISO timestamp. */
	mtime: string;
}

/**
 * One node in the KB graph. `dir` is the top-level kb directory (used by the
 * graph view to color-code: domains / tools / system / writing / cryptocracy).
 * `inbound` / `outbound` are degrees for sizing + isolation toggles.
 */
export interface KbGraphNode {
	/** Stable id — same as `path`. */
	id: string;
	path: string;
	title: string;
	/** Top-level directory ("" for files at kb root). */
	dir: string;
	inbound: number;
	outbound: number;
	/** Frontmatter tags, if any — used for tag filtering. */
	tags: string[];
}

export interface KbGraphEdge {
	source: string;
	target: string;
}

export interface KbGraphResponse {
	nodes: KbGraphNode[];
	edges: KbGraphEdge[];
	/** Number of wikilink occurrences that didn't resolve to a node. */
	unresolvedCount: number;
	/** Total nodes that exist in the index (>= nodes.length when truncated). */
	totalNodes: number;
	/**
	 * True when the response was truncated at the v1 cap (10_000 nodes). UI
	 * should surface a warning so the user knows the graph isn't whole.
	 */
	truncated: boolean;
}

export interface KbBacklink {
	/** Source file whose body links to the queried path. */
	source: string;
	/** Short snippet of body around the link (best-effort, line-bounded). */
	snippet: string;
	/** Render label that was used in the source's wikilink. */
	label: string;
}

export interface KbBacklinksResponse {
	path: string;
	backlinks: KbBacklink[];
}

/**
 * Where a search query matched a file. Used by the UI to render
 * differently — filename hits sort to the top, body hits get a snippet.
 */
export type KbSearchMatchKind = "stem" | "title" | "tag" | "body";

export interface KbSearchResult {
	/** Forward-slash kb-relative path. */
	path: string;
	/** Display title — frontmatter `name` if set, else filename stem. */
	title: string;
	/** Top-level directory ("" for root files). Used for color coding. */
	dir: string;
	/** Score (higher = better). Order is deterministic by score desc + path asc. */
	score: number;
	/** Best match kind for this file (a file may match many ways). */
	matchKind: KbSearchMatchKind;
	/** Body-context snippet centered on the first body match; empty otherwise. */
	snippet: string;
}

export interface KbSearchResponse {
	query: string;
	results: KbSearchResult[];
	/** Total candidate matches before the limit was applied. */
	totalMatches: number;
	/** True when the response was truncated to the requested limit. */
	truncated: boolean;
}

/**
 * Co-located file under a skill's directory. Listed recursively (depth-first)
 * with `relPath` carrying the path from the skill dir; the UI groups by
 * parent. Symlinks and excluded dirs (`node_modules`, `__pycache__`, `.git`)
 * are filtered server-side.
 */
export interface SkillFile {
	/** Path relative to the skill directory, forward-slash separated. */
	relPath: string;
	name: string;
	kind: "file" | "dir";
	/** Bytes; omitted for directories. */
	size?: number;
	/** ISO timestamp; omitted for directories. */
	mtime?: string;
}

/**
 * Single-skill detail. `body` is the SKILL.md content with the frontmatter
 * block stripped; consumers re-render with the chat markdown pipeline.
 */
export interface SkillDetailResponse extends SkillSummary {
	body: string;
	files: SkillFile[];
}
// ─────────────────────────────────────────────────────────────────────────────
// WebSocket frames
// ─────────────────────────────────────────────────────────────────────────────

/** Sanitized SDK message — passthrough of @oh-my-pi/pi-coding-agent AgentMessage. */
export type AgentMessageJson = Record<string, unknown> & {
	role: "user" | "assistant" | "tool" | "system" | "custom" | string;
	content: unknown;
};

/** Sanitized SDK event — passthrough of AgentSessionEvent. */
export type AgentSessionEventJson = Record<string, unknown> & {
	type: string;
};

/**
 * Context-window utilization for an in-process agent session. Mirrors the
 * SDK's `ContextUsage` shape but is defined here so the protocol package owns
 * the canonical type the deck UI consumes.
 *
 * `tokens` and `percent` are nullable because the SDK can't reliably report
 * fresh numbers immediately after compaction — the next assistant response
 * is what supplies the post-compaction usage. While in that hole the deck
 * UI should render a "—%" / "calculating" affordance, not a 0%.
 */
export interface ContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * Live plan-mode state for a session. Mirrors the SDK's `PlanModeState` shape
 * minus internal flags the deck UI never consumes (workflow / reentry).
 * Absent on a snapshot means plan mode is off.
 */
export interface PlanModeContextWire {
	enabled: boolean;
	/** Always `local://PLAN.md` for the deck MVP — surfaced so future per-session overrides land here. */
	planFilePath: string;
}

/**
 * A plan the agent has proposed for approval. The deck UI renders this as an
 * inline `PlanApproval` card. Replayed on `subscribed` so a page-reload during
 * pending approval re-shows the card without waiting for the next event.
 */
export interface PendingPlanApprovalWire {
	/** Stable id used to disambiguate concurrent approval responses (two tabs). */
	proposalId: string;
	/** Original `local://` path the agent wrote the plan to (always `local://PLAN.md` for MVP). */
	planFilePath: string;
	/** Verbatim contents of `planFilePath` as the agent submitted it. */
	planContent: string;
	/** Title derived via SDK `resolvePlanTitle` — pre-fills the title input. */
	suggestedTitle: string;
	/** Final `local://` path the plan will move to on approve (title-stem.md). */
	suggestedFinalPath: string;
}

/** Snapshot delivered when a client subscribes to an existing session. */
export interface SessionSnapshot {
	sessionId: string;
	sessionFile?: string;
	sessionName?: string;
	cwd: string;
	model?: ModelRef;
	thinkingLevel?: string;
	isStreaming: boolean;
	messages: AgentMessageJson[];
	todoPhases: Array<Record<string, unknown>>;
	/**
	 * Current context-window utilization, mirroring the SDK's
	 * `session.getContextUsage()`. Absent when the model has no declared
	 * context window. `tokens` is `null` immediately after compaction (before
	 * the next assistant response provides fresh usage data); `percent` is
	 * `null` in the same case.
	 */
	contextUsage?: ContextUsage;
	/**
	 * Plan-mode state, present iff the session is in plan mode at snapshot
	 * time. The web client uses this to render the "Plan" pill and gate the
	 * Shift+Tab toggle's visual on/off without a separate state fetch.
	 */
	planMode?: PlanModeContextWire;
	/**
	 * Unresolved plan-approval card, if the agent proposed a plan that the
	 * user hasn't approved/rejected yet. Replayed verbatim on subscribe so a
	 * page reload re-renders the PlanApproval inline component.
	 */
	pendingPlanApproval?: PendingPlanApprovalWire;
	/**
	 * Prompts the SDK currently has queued for execution after the active
	 * turn finishes. Empty when no turn is in flight or no queued prompts
	 * exist. Included in the snapshot so a page-reload subscriber sees the
	 * queue immediately instead of waiting for the next `queue_state` event.
	 */
	queuedPrompts?: QueuedPromptWire[];
}

/**
 * Wire shape of a queued prompt. Mirrors what the deck UI renders for the
 * "queued" bubble. `id` is the bridge-assigned `queuedId` echoed back in
 * `prompt_queued` and `queue_state` events so the client can target a
 * specific entry for cancel/edit.
 */
export interface QueuedPromptWire {
	id: string;
	text: string;
	images?: ImageAttachment[];
	behavior: "steer" | "followUp";
	queuedAt: number;
}

/**
 * Image attachment for prompt frames — matches the SDK's ImageContent shape.
 * `data` is the raw base64-encoded image payload (no data: URL prefix).
 */
export interface ImageAttachment {
	type: "image";
	data: string;
	mimeType: string;
}

/**
 * Possible extension-UI dialog response shapes returned by the client when an
 * agent (typically the `ask` tool, but any extension can use the same surface)
 * has asked for a selection / confirmation / free-form input.
 */
export interface ExtUiDialogResponse {
	/** Single selected option (for `select` / `input` / `editor`). */
	value?: string;
	/** Multi-select result. Reserved for future native multi-select; the
	 *  current `ask` tool implementation issues a sequence of single selects. */
	values?: string[];
	/** `confirm` dialog answer. */
	confirmed?: boolean;
	/** True iff the user cancelled (Esc, modal close, tab close). */
	cancelled?: true;
	/** True iff the dialog timed out before the user responded. */
	timedOut?: true;
}

/** Client → Server. */
export type ClientFrame =
	| { type: "ping" }
	| { type: "subscribe"; sessionId: string }
	| { type: "unsubscribe"; sessionId: string }
	| {
			type: "prompt";
			sessionId: string;
			text: string;
			images?: ImageAttachment[];
			streamingBehavior?: "steer" | "followUp";
	  }
	| { type: "abort"; sessionId: string }
	/**
	 * Clear the session's pending-prompt queue (steering + follow-up).
	 * The server replies with a synthetic `queue_cleared` session event
	 * carrying the count of dropped entries so subscribed clients can
	 * reconcile their `queuedPrompts` UI state.
	 */
	| { type: "clear_queue"; sessionId: string }
	/**
	 * Cancel a single queued prompt by its `queuedId`. The server replies
	 * with a synthetic `queue_state` session event carrying the new ordered
	 * queue so subscribed clients can reconcile. No-op if the id is unknown
	 * (already drained, never queued, or wrong session).
	 */
	| { type: "cancel_queued"; sessionId: string; queuedId: string }
	/**
	 * Edit a queued prompt's text (and optionally images). Server pops every
	 * SDK queue entry and re-enqueues survivors with the edited entry's
	 * content substituted in-place — order preserved. Same `queue_state`
	 * echo as cancel.
	 */
	| {
			type: "edit_queued";
			sessionId: string;
			queuedId: string;
			text: string;
			images?: ImageAttachment[];
	  }
	/** Response to an `ext_ui_dialog_open` frame. */
	| ({
			type: "ext_ui_dialog_response";
			sessionId: string;
			dialogId: string;
	  } & ExtUiDialogResponse)
	/**
	 * Enter or exit plan mode for `sessionId`. Idempotent: re-sending the
	 * same `enabled` value is a no-op. Server snapshots active tools on
	 * enter and restores them on exit, registers/clears the standing
	 * resolve handler, and broadcasts a `plan_mode_changed` frame.
	 */
	| { type: "set_plan_mode"; sessionId: string; enabled: boolean }
	/**
	 * Reply to a `plan_proposed` frame. `approved=true` triggers rename +
	 * synthetic `planModeApprovedPrompt` injection; `approved=false`
	 * silently exits plan mode. `editedContent` overwrites `local://PLAN.md`
	 * before the rename; `finalPath` overrides the title-derived destination
	 * (must be `local://*.md`).
	 */
	| {
			type: "plan_response";
			sessionId: string;
			proposalId: string;
			approved: boolean;
			finalPath?: string;
			editedContent?: string;
	  };

/** Server → Client. */
export type ServerFrame =
	| { type: "hello"; connectionId: string }
	| { type: "pong" }
	| { type: "subscribed"; sessionId: string; snapshot: SessionSnapshot }
	| { type: "unsubscribed"; sessionId: string }
	| { type: "session_event"; sessionId: string; event: AgentSessionEventJson }
	| { type: "session_disposed"; sessionId: string }
	/** Broadcast frame: any kanban-task mutation occurred. Clients refetch. */
	| { type: "tasks_changed" }
	/** Broadcast frame: skill catalog or enabled-state changed. Clients refetch. */
	| { type: "skills_changed" }
	/** Broadcast frame: any KB file under the watched root mutated. Clients refetch. */
	| { type: "kb_changed" }
	/** OAuth: SDK has produced the consent URL; client opens it in a new tab. */
	| {
			type: "oauth_consent";
			flowId: string;
			provider: string;
			url: string;
			instructions?: string;
		}
	/** OAuth: SDK status update (e.g. "Waiting for browser authentication…"). */
	| { type: "oauth_progress"; flowId: string; provider: string; message: string }
	/** OAuth: SDK is asking the user a free-form question (enterprise URL, etc). */
	| {
			type: "oauth_prompt";
			flowId: string;
			provider: string;
			promptId: string;
			message: string;
			placeholder?: string;
		}
	/** OAuth: login resolved successfully; client should refetch providers + models. */
	| { type: "oauth_complete"; flowId: string; provider: string }
	/** OAuth: login rejected (timeout, port collision, state mismatch, user cancel). */
	| { type: "oauth_failed"; flowId: string; provider: string; message: string }
	/** Broadcast: model registry availability changed (post-login / post-revoke). */
	| { type: "models_changed" }
	/** V1 routine: a new multi-step run has started. */
	| {
			type: "routine_run_started";
			routineId: string;
			runId: string;
			triggerKind: "cron" | "manual" | "webhook" | "event";
			startedAt: string;
		}
	/** V1 routine: a single step transitioned (running -> success/failed/skipped/aborted). */
	| {
			type: "routine_step_event";
			runId: string;
			stepId: string;
			stepIndex: number;
			status: RoutineStepStatus;
			startedAt?: string;
			endedAt?: string;
			durationMs?: number;
			excerpt?: { stdout?: string; stderr?: string };
			outputJson?: unknown;
			error?: string;
			model?: string;
			tokens?: { in: number; out: number };
		}
	/** V1 routine: the run finished (or was aborted). Total cost is in USD micro-cents. */
	| {
			type: "routine_run_finished";
			runId: string;
			status: "success" | "failed" | "aborted";
			abortReason?: string;
			endedAt: string;
			durationMs: number;
			totalCostMicros: number;
		}
	/**
	 * An extension UI dialog has opened in the named session. The web client
	 * renders a modal of the matching shape and replies with
	 * `ext_ui_dialog_response`. Used by the SDK `ask` tool today and by any
	 * extension calling `ctx.ui.select/editor/confirm/input`.
	 *
	 * `kind` selects the rendered shape; not every field applies to every kind.
	 * Strict superset of what `ask` needs so the same channel covers
	 * extension-driven dialogs without protocol churn.
	 */
	| {
			type: "ext_ui_dialog_open";
			sessionId: string;
			dialogId: string;
			kind: "select" | "editor" | "confirm" | "input";
			/** Title / prompt line shown above the controls. */
			prompt: string;
			/** select: option labels in display order. */
			options?: string[];
			/** select: hint that the dialog allows multiple selections. */
			multi?: boolean;
			/** select: index of the option pre-focused on open. */
			initialIndex?: number;
			/** select: index of the "recommended" option (visually marked). */
			recommended?: number;
			/** select: ancillary help text below the options. */
			helpText?: string;
			/** confirm: secondary message body. */
			message?: string;
			/** input: placeholder text. */
			placeholder?: string;
			/** editor: initial textarea contents. */
			prefill?: string;
			/** editor: render with the prompt styled like the chat composer. */
			promptStyle?: boolean;
			/** Server-side timeout in ms; UI may render a countdown. 0 / absent = none. */
			timeoutMs?: number;
	  }
	/**
	 * The server-side promise behind a previously-opened dialog has been
	 * cancelled (signal aborted, session disposed, server-side timeout fired).
	 * The web client should close the matching modal without sending a
	 * response — the SDK call is already settled.
	 */
	| {
			type: "ext_ui_dialog_cancel";
			sessionId: string;
			dialogId: string;
			reason: "session_disposed" | "timeout" | "aborted";
	  }
	/**
	 * Plan mode toggled for `sessionId`. Broadcast on every enter/exit
	 * (whether user-initiated via `set_plan_mode` or server-initiated as
	 * part of approving / rejecting a proposal). Clients reconcile their
	 * composer-pill + status-pill state by mirroring this onto the session.
	 */
	| {
			type: "plan_mode_changed";
			sessionId: string;
			enabled: boolean;
			/** Always present when `enabled` — absent on exit. */
			planFilePath?: string;
	  }
	/**
	 * Agent has finalized a plan and called `resolve apply`. The web client
	 * renders an inline `PlanApproval` card with Approve / Reject / Edit &
	 * approve buttons and replies with `plan_response`. Replayed verbatim
	 * on `subscribed` via `pendingPlanApproval` so a late tab sees the card.
	 */
	| {
			type: "plan_proposed";
			sessionId: string;
			proposalId: string;
			planFilePath: string;
			planContent: string;
			suggestedTitle: string;
			suggestedFinalPath: string;
	  }
	/**
	 * A previously-broadcast `plan_proposed` has been resolved. Second-tab
	 * Approve clicks observe `outcome="resolved_elsewhere"` on the same id
	 * and can roll back their optimistic UI. `expired` is reserved for a
	 * future server-side timeout; v1 emits only `approved`/`rejected`.
	 */
	| {
			type: "plan_proposal_resolved";
			sessionId: string;
			proposalId: string;
			outcome: "approved" | "rejected" | "resolved_elsewhere" | "expired";
	  }
	/**
	 * Server liveness heartbeat. Broadcast on a fixed interval (default 5s).
	 * Clients use the gap between consecutive heartbeats to drive a connection
	 * indicator. `serverStartedAt` lets clients detect a restart even when the
	 * WebSocket auto-reconnects: a fresh value means the server bounced.
	 */
	| {
			type: "heartbeat";
			serverStartedAt: string;
			pid: number;
			uptimeSecs: number;
			buildSha: string | null;
			version: string;
			timestamp: string;
	  }
	/**
	 * User-facing notification. Emitted by the deck's `NotificationService` for
	 * routine failures, budget breaches, suspended approval prompts, and any
	 * other surface that opts in. Browser-channel deliver()s push these frames
	 * to every connected client; the web layer renders an OS-level
	 * `Notification` (when permission granted) plus an audio cue.
	 */
	| {
			type: "notification";
			id: string;
			level: NotificationLevel;
			title: string;
			body?: string;
			sound?: boolean;
			source?: string;
			actionUrl?: string;
			timestamp: string;
	  }
	| { type: "error"; sessionId?: string; error: string };

/** Severity for a deck notification. Drives the audio tone + visual styling. */
export type NotificationLevel = "info" | "warn" | "error" | "critical";

/** Payload accepted by `NotificationService.notify` on the server. */
export interface NotificationPayload {
	level: NotificationLevel;
	title: string;
	body?: string;
	/** Default true for `warn` and above; explicit false suppresses the tone. */
	sound?: boolean;
	/** Free-form origin tag, e.g. `routine:<routineId>/run:<runId>`. */
	source?: string;
	/** Optional deep-link the user can click to jump to the relevant view. */
	actionUrl?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool-call rendering hints (used by the web app to pick a renderer)
// ─────────────────────────────────────────────────────────────────────────────

export const KNOWN_TOOLS = [
	"read",
	"write",
	"edit",
	"bash",
	"search",
	"find",
	"lsp",
	"task",
	"web_search",
	"eval",
	"generate_image",
	"todo_write",
	"browser",
	"ast_edit",
	"ast_grep",
	"ask",
] as const;

export type KnownTool = (typeof KNOWN_TOOLS)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Tasks (kanban)
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskState {
	id: string;
	name: string;
	color: string;
	position: number;
	isDefault: boolean;
}

export interface Task {
	id: string;
	/** Monotonic deck-wide display number. Render as `T-${displayId}`. */
	displayId: number;
	title: string;
	body: string;
	stateId: string;
	orderInState: number;
	cwd?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * ISO timestamp of when this task last entered its current `stateId`.
	 * Bumps on cross-column moves; left untouched by body edits, title edits,
	 * or same-column drag reorders. Drives the per-column recency sort.
	 *
	 * Backfilled to `updated_at` for pre-004 rows on migration; values may not
	 * be perfectly accurate before the first post-deploy move.
	 */
	stateEnteredAt: string;
	archivedAt?: string;
}

export interface CreateTaskRequest {
	title: string;
	body?: string;
	stateId?: string;
	cwd?: string;
}

export interface UpdateTaskRequest {
	title?: string;
	body?: string;
	stateId?: string;
	orderInState?: number;
	cwd?: string;
	archived?: boolean;
}

export interface ListTasksResponse {
	tasks: Task[];
	states: TaskState[];
}

export interface CreateTaskStateRequest {
	name: string;
	color?: string;
	position?: number;
}

export interface UpdateTaskStateRequest {
	name?: string;
	color?: string;
	position?: number;
}

/** Body for the "reorder task states" endpoint (kanban column drag). */
export interface ReorderTaskStatesRequest {
	/** Permutation of every existing `TaskState.id`, top-of-board first. */
	orderedIds: string[];
}

export interface ReorderTaskStatesResponse {
	states: TaskState[];
}

/** Body for the "move task" convenience endpoint (kanban drop). */
export interface MoveTaskRequest {
	stateId: string;
	/** New 0-based index inside the destination column. */
	index: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inbox
// ─────────────────────────────────────────────────────────────────────────────

export type InboxKind =
	| "email"
	| "ticket"
	| "idea"
	| "decision"
	| "investigation"
	| "capture";

export interface InboxItem {
	id: string;
	kind: InboxKind;
	title: string;
	body: string;
	source?: string;
	createdAt: string;
	processedAt?: string;
}

export interface CreateInboxItemRequest {
	kind: InboxKind;
	title: string;
	body?: string;
	source?: string;
}

export interface UpdateInboxItemRequest {
	title?: string;
	body?: string;
	kind?: InboxKind;
	source?: string;
	processed?: boolean;
}

export interface ListInboxResponse {
	items: InboxItem[];
}

/**
 * Promote an inbox item into a task.
 *
 * The server copies the item's `title` and `body` onto a new task in the
 * destination state (or the user's default state when omitted) and, unless
 * `markProcessed: false`, marks the source item processed so it stops
 * cluttering the unprocessed list.
 */
export interface PromoteInboxItemRequest {
	stateId?: string;
	markProcessed?: boolean;
}

export interface PromoteInboxItemResponse {
	task: Task;
	inbox: InboxItem;
}

// ─────────────────────────────────────────────────────────────────────────────
// Routines (cron)
// ─────────────────────────────────────────────────────────────────────────────

export type RoutineActionKind = "bash" | "prompt" | "script";

export interface Routine {
	id: string;
	name: string;
	description: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled: boolean;
	createdAt: string;
	updatedAt: string;
	lastRunAt?: string;
	nextRunAt?: string;
	// V1 additions — see "V1 routine spec" section below for the parsed-spec types.
	/** 0 = V0 single-action routine (cron+actionKind+actionBody); 1 = V1 multi-step (specYaml). */
	specVersion: 0 | 1;
	/** Concurrency policy. V0 routines default to 'skip'; V1 routines set it explicitly in their spec. */
	concurrency: RoutineConcurrency;
	/** Full V1 spec source-of-truth. NULL/undefined for V0 routines. */
	specYaml?: string;
	/** Optional runtime budget caps. */
	budget?: RoutineBudget;
	/** IANA timezone for cron evaluation. NULL = system default. */
	timezone?: string;
	/** User-authored tags for the filter UI. */
	tags?: string[];
}

export interface CreateRoutineRequest {
	name: string;
	description?: string;
	cron: string;
	actionKind: RoutineActionKind;
	actionBody: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface UpdateRoutineRequest {
	name?: string;
	description?: string;
	cron?: string;
	actionKind?: RoutineActionKind;
	actionBody?: string;
	actionCwd?: string;
	enabled?: boolean;
}

export interface RoutineRun {
	id: string;
	routineId: string;
	startedAt: string;
	endedAt?: string;
	exitCode?: number;
	stdoutExcerpt: string;
	stderrExcerpt: string;
	error?: string;
	/**
	 * Trigger kind. V0 routines only ever see 'cron' or 'manual'; V1 routines
	 * can additionally be triggered by 'webhook' (HMAC-verified POST to /hooks/*)
	 * or 'event' (telegram, deck_inbox, deck_task, future MCP notifications).
	 */
	trigger: "cron" | "manual" | "webhook" | "event";
	// V1 additions — populated by the V1 runner; 0/undefined for V0 rows.
	/** JSON-serialized trigger payload (webhook body, manual params, event payload). */
	triggerPayload?: string;
	/** Sum of input+output LLM tokens across all agent steps in this run. */
	totalLlmTokens: number;
	/** Estimated cost in USD micro-cents (token counts × model price table). */
	totalLlmCostMicros: number;
	/** When the runner aborted, distinct from endedAt (which is the last-step finish). */
	abortedAt?: string;
	/** 'budget' | 'timeout' | 'cancelled' | 'failure' | 'signature_invalid' | 'concurrency_skipped'. */
	abortReason?: string;
	/** Count of routine_step_runs rows for this run. */
	stepCountTotal: number;
	/** Count of step runs ending in status='failed' or 'aborted'. */
	stepCountFailed: number;
}


// ─── V1 routine spec (multi-step pipelines, spec_version=1) ──────────────

export type RoutineConcurrency =
	| "skip"
	| "queue"
	| "cancel-previous"
	| "parallel";

export interface RoutineBudget {
	/** Wall-clock cap across the whole run. */
	max_duration_secs?: number;
	/** Hard cap on estimated LLM spend per run. Estimated from token counts × model price table. */
	max_llm_cost_usd?: number;
	max_llm_tokens_input?: number;
	max_llm_tokens_output?: number;
	/** Guards against infinite-branch bugs in routine specs. */
	max_steps_executed?: number;
}

export type RoutineOnFailure = "abort" | "continue" | "retry";

export interface RoutineRetryPolicy {
	times: number;
	backoff: "linear" | "exponential";
	max_delay_secs?: number;
	/** What to do if all retries fail. Defaults to 'abort'. */
	after_retry?: "abort" | "continue";
}

export type RoutineDeckAction =
	| "create_inbox_item"
	| "create_task"
	| "move_task"
	| "promote_inbox_item_to_task"
	| "list_tasks"
	| "list_inbox"
	| "get_task"
	| "get_inbox_item";


/** Common fields every step type accepts. */
export interface RoutineStepCommon {
	id: string;
	/** Boolean JS expression over the context. If false, step is skipped. */
	when?: string;
	on_failure?: RoutineOnFailure;
	retry?: RoutineRetryPolicy;
	timeout_secs?: number;
}

/** Discriminated union by `type`. Add a new step type here AND author its JSON schema. */
export type RoutineStep =
	| (RoutineStepCommon & {
			type: "run";
			command: string;
			cwd?: string;
		})
	| (RoutineStepCommon & {
			type: "agent";
			prompt: string;
			model?: string;
			structured_output?: { schema: unknown; strict?: boolean };
			skills_allowed?: string[];
			mcp_servers_allowed?: string[];
		})
	| (RoutineStepCommon & {
			type: "write";
			path: string;
			content: string;
			append?: boolean;
		})
	| (RoutineStepCommon & {
			type: "http";
			method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
			url: string;
			headers?: Record<string, string>;
			query?: Record<string, string | number | boolean>;
			body?: unknown;
			expect_json?: boolean;
		})
	| (RoutineStepCommon &
			(
				| {
						type: "deck";
						action: "create_inbox_item";
						kind: InboxKind;
						title: string;
						body?: string;
						source?: string;
				  }
				| {
						type: "deck";
						action: "create_task";
						title: string;
						body?: string;
						/** Task state id or case-insensitive state-name substring. Defaults to the default state. */
						state_ref?: string;
						cwd?: string;
				  }
				| {
						type: "deck";
						action: "move_task";
						/** Accepts `T-58` or `t_01...`. */
						task_ref: string;
						/** Required destination state id or case-insensitive state-name substring. */
						state_ref: string;
						/** 0-based destination index. Defaults to 0 (top of column). */
						index?: number;
				  }
				| {
						type: "deck";
						action: "promote_inbox_item_to_task";
						/** Inbox item id, usually from a prior fetch step. */
						inbox_ref: string;
						/** Destination state id or case-insensitive state-name substring. Defaults to the default state. */
						state_ref?: string;
						/** Defaults to true — promoted inbox items are marked processed. */
						mark_processed?: boolean;
				  }
				| {
						type: "deck";
						action: "list_tasks";
						/** Optional state filter — accepts a state id or a case-insensitive state-name substring (e.g. `"active"`). */
						state_ref?: string;
						/** Optional recency filter — only tasks whose `updatedAt` is within the last N hours. */
						since_hours?: number;
						/** Defaults to false; when true, archived tasks are included. */
						include_archived?: boolean;
						/** Cap on the number of tasks returned. Defaults to unlimited. */
						limit?: number;
				  }
				| {
						type: "deck";
						action: "list_inbox";
						/** Optional kind filter. */
						kind?: InboxKind;
						/** Optional recency filter — only items whose `createdAt` is within the last N hours. */
						since_hours?: number;
						/** Defaults to false; when true, already-processed inbox items are included. */
						include_processed?: boolean;
						/** Cap on the number of items returned. Defaults to unlimited. */
						limit?: number;
				  }
				| {
						type: "deck";
						action: "get_task";
						/** Accepts `T-58` or `t_01...`. */
						task_ref: string;
				  }
				| {
						type: "deck";
						action: "get_inbox_item";
						/** Inbox item id. */
						inbox_ref: string;
				  }
			))
	| (RoutineStepCommon & {
			type: "mcp";
			server: string;
			tool: string;
			args?: Record<string, unknown>;
		})
	| (RoutineStepCommon & {
			type: "transform";
			/** JS expression source. Evaluated in a quickjs sandbox; no network, no fs. */
			body: string;
		})
	| (RoutineStepCommon & {
			type: "wait";
			duration_secs: number;
		})
	| (RoutineStepCommon & {
			type: "set_state";
			/** Key/value pairs to upsert into routine_state. Values may use template substitution. */
			state: Record<string, unknown>;
		});

/** Discriminated union over the four trigger kinds. A routine may have multiple. */
export type RoutineTrigger =
	| { cron: string }
	| { webhook: { path: string; secret_env: string } }
	| { manual: { params_schema?: unknown } }
	| { event: { source: string; type?: string; filter?: string } };

/** The parsed V1 routine spec. Source-of-truth lives in routines.spec_yaml. */
export interface RoutineSpec {
	name: string;
	description?: string;
	trigger: RoutineTrigger[];
	concurrency?: RoutineConcurrency;
	timezone?: string;
	budget?: RoutineBudget;
	/** Declared cross-run state keys (informational; runtime can write any key via set_state). */
	state?: { declared_keys?: string[] };
	tags?: string[];
	steps: RoutineStep[];
	/**
	 * OPTIONAL canvas-mode metadata: per-step node positions plus the edge graph
	 * between them. Carried inline in spec_yaml so canvas mode is fully
	 * round-trippable without a separate persistence layer. The V1 runtime engine
	 * ignores `layout` entirely; the visual builder uses it to restore the graph.
	 */
	layout?: RoutineLayout;
}

/** Single node entry in a {@link RoutineLayout}. Keyed by the corresponding step id. */
export interface RoutineLayoutNode {
	x: number;
	y: number;
	/** If true, the canvas renders the node in compact form (id + type only). */
	collapsed?: boolean;
}

/**
 * Edge semantics:
 * - `success` (default): sequential edge, no compilation effect.
 * - `error`: reserved; future on_failure routing.
 * - `true` / `false`: branches leaving an `if`-flavored node — compile to `when:` gates on the target.
 * - `manual`: hand-drawn dependency edge that does not auto-compile.
 */
export type RoutineLayoutEdgeKind = "success" | "error" | "true" | "false" | "manual";

/** Directed edge between two step nodes on the canvas. */
export interface RoutineLayoutEdge {
	from: string;
	to: string;
	kind?: RoutineLayoutEdgeKind;
	label?: string;
}

/**
 * Canvas-mode metadata for a routine. Optional everywhere; routines authored
 * in form/spec mode never need a `layout` block. When present, `version` must
 * be `1` (bumped only on breaking layout-format changes).
 */
export interface RoutineLayout {
	version: 1;
	nodes?: Record<string, RoutineLayoutNode>;
	edges?: RoutineLayoutEdge[];
}

export type RoutineStepStatus =
	| "pending"
	| "running"
	| "success"
	| "skipped"
	| "failed"
	| "aborted";

/** Per-step execution record. One row in routine_step_runs per step per run attempt. */
export interface RoutineStepRun {
	id: string;
	runId: string;
	stepId: string;
	stepIndex: number;
	stepType: RoutineStep["type"];
	startedAt: string;
	endedAt?: string;
	status: RoutineStepStatus;
	stdoutExcerpt: string;
	stderrExcerpt: string;
	/** JSON-serialized structured output captured to the context for downstream steps. */
	outputJson?: string;
	error?: string;
	model?: string;
	llmTokensIn?: number;
	llmTokensOut?: number;
	llmCostMicros?: number;
	durationMs?: number;
	/** Retry attempt number; 1 for first attempt. */
	attempt: number;
}

export interface ListRoutineStepRunsResponse {
	steps: RoutineStepRun[];
}
export interface ListRoutinesResponse {
	routines: Routine[];
}

export interface ListRoutineRunsResponse {
	runs: RoutineRun[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands (discovered from ~/.omp/agent/commands/ + project overrides)
// ─────────────────────────────────────────────────────────────────────────────

export type SlashCommandScope = "user" | "project" | "builtin" | "deck";

export interface SlashSubcommand {
	name: string;
	description: string;
	usage?: string;
}

export interface SlashCommand {
	name: string; // basename without .md, or "<builtin>" / "<builtin> <subcommand>"
	scope: SlashCommandScope;
	description?: string;
	argumentHint?: string;
	/** Builtin parents carry their full subcommand inventory for richer pickers. */
	subcommands?: SlashSubcommand[];
}

export interface ListSlashCommandsResponse {
	commands: SlashCommand[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Filesystem path completion (composer `@filepath` mentions)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single match entry from the path-completion endpoint. Server returns paths
 * *relative to the queried `cwd`* so the composer can insert them verbatim
 * without re-resolving against the workspace root.
 */
export interface FilePathMatch {
	/** Path relative to the queried cwd, using forward slashes. */
	path: string;
	/** Basename, surfaced for emphasis rendering in the picker. */
	name: string;
	/** True if the entry is a directory — picker can render a trailing slash. */
	isDir: boolean;
}

export interface ListFilePathsResponse {
	matches: FilePathMatch[];
	/** `true` when the underlying file list was served from a cached snapshot. */
	cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth providers / OAuth login flow (driven from Settings → Providers)
// ─────────────────────────────────────────────────────────────────────────────

export type ProviderAuthState = "oauth" | "api-key" | "unconfigured";

export interface ProviderInfo {
	id: string;
	name: string;
	state: ProviderAuthState;
	/** Number of credentials stored for the provider (1 typical; >1 for round-robin). */
	count: number;
}

export interface ListProvidersResponse {
	providers: ProviderInfo[];
}

/**
 * `POST /api/auth/oauth/:provider/start` response. The deck blocks the
 * response until the SDK fires `onAuth`, so by the time the client sees
 * this it has a real consent URL to open. WS frames keyed by `flowId`
 * deliver subsequent state transitions.
 */
export interface StartOAuthResponse {
	flowId: string;
	url: string;
	instructions?: string;
}

/** Client → deck: paste the redirect URL or raw `code` from the browser. */
export interface OAuthManualCodeRequest {
	code: string;
}

/** Client → deck: reply to a mid-flow `onPrompt` request from the SDK. */
export interface OAuthPromptReplyRequest {
	promptId: string;
	answer: string;
}
