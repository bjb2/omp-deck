/**
 * Tooltip + context-menu catalog — the only persistent knowledge layer for
 * the studio. Both the tooltip singleton and the context-menu singleton
 * read from here. Versioning + drift handling lives in
 * `Tooltip.ts` (compare against `omp-deck:studio:catalog-version-seen`).
 *
 * v1 seeds (≥80 tooltip entries + ≥30 menu descriptors) come from:
 *   - every router path in apps/web/src/router.tsx
 *   - every KNOWN_TOOLS entry in packages/protocol/src/index.ts
 *   - every BridgeName + every NotificationLevel
 *   - every server route prefix inventoried in apps/server/src/routes*.ts
 *   - the top-of-file docblocks of every view file
 *   - the marketplace install/uninstall/dry-run call paths
 *
 * [STUDIO-SEED] marker list — every `data-tooltip-key` / `data-context-key`
 * the studio expects to find a non-empty entry for in `/studio` even when
 * the prose was sourced from a heuristic stub. The Tiptoop surface falls
 * through to the heuristic for any key missing here, but the studio's
 * hard floor is zero "unknown" hovers in /studio, so this list names
 * every element we know is mounted.
 *
 *   elements: gholam.sidebar, gholam.sidebar.start, gholam.sidebar.heartbeat,
 *             marketplace.featured, marketplace.popular, marketplace.search,
 *             kanban.card, kanban.column, kanban.columns-edit,
 *             studio.pane.kb, studio.pane.composer, studio.pane.tasks,
 *             studio.pane.gholam, studio.pane.prompts, studio.pane.storefront,
 *             studio.statusbar.bridges, studio.statusbar.deploy,
 *             studio.statusbar.inbox, studio.statusbar.mcp,
 *             studio.statusbar.shortcut,
 *             chrome.nav-rail, chrome.connection, chrome.tool-cards,
 *             chrome.inspector, chrome.sidebar, gholam.priority.add,
 *             gholam.priority.remove
 *   context-keys: kanban.card, kanban.column, gholam.priority,
 *                 composer.attachment, kb.commit-graph.vertex, kb.file,
 *                 studio.statusbar.badge, bridge.telegram, store.item
 *
 * Bump TOOLTIP_CATALOG_VERSION on every add/remove/rewrite. The version
 * number is a single integer — clients compare strictly. A drift logs a
 * one-line console message; rendering never blocks.
 */
import type { MenuAction } from "./ContextMenu";

export const TOOLTIP_CATALOG_VERSION = 3;

export type TooltipEntry = {
	title: string;
	body: string;
	docUrl?: string;
	related?: string[];
	capabilities?: string[];
	since: string;
};

export const TOOLTIPS: Record<string, TooltipEntry> = {
	// ─── Views (router.tsx paths) ────────────────────────────────────────
	"view.chat": {
		title: "Chat",
		body: "Live composer surface — open / new sessions, steer prompts, attach files, see tool cards stream in. The main work area; the other views orbit this one.",
		related: ["view.tasks", "view.kb", "view.prompts"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"view.explorer": {
		title: "Explorer",
		body: "CodeMirror-backed file browser. Lazy-loaded (~600KB) so the deck's first paint doesn't pay for it unless the user opens this view.",
		related: ["view.kb", "view.agent-config"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.agent-config": {
		title: "Agent Config",
		body: "Edit the agent's prompt + model + provider config. Lazy-loaded CodeMirror editor; changes flow through /api/agent-config and rehydrate every connected session.",
		related: ["view.explorer", "view.settings"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.tasks": {
		title: "Tasks",
		body: "Kanban view over the /api/tasks REST surface. Drag cards between columns to move state; the deck mirrors server-authoritative orderInState. Live updates ride on `tasks_changed` frames.",
		related: ["kanban.card", "kanban.column"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},
	"view.routines": {
		title: "Routines",
		body: "Long-running agents the deck owns. Each routine runs in a worker, can be paused/resumed, and emits a `routines_changed` frame on every state change.",
		related: ["view.workflows", "view.tasks"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"view.routines.run": {
		title: "Routine run",
		body: "Detail page for a single routine run. Streams the same ServerFrame stream the composer sees, scoped to that run's session id.",
		related: ["view.routines"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"view.workflows": {
		title: "Workflows",
		body: "Multi-routine orchestration canvas. Drag nodes to compose a DAG; the deck compiles it into a routine graph at save time.",
		related: ["view.routines", "view.agent-config"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"view.gholam": {
		title: "Gholam",
		body: "Digital-twin sidecar control panel. Start/stop the sidecar, tune the heartbeat interval, add/remove priorities (what Gholam is allowed to act on), and watch the live status (port, pid, last beat, KB stats). Priorities are user-controlled: Gholam never picks its own targets.",
		related: ["gholam.sidebar", "gholam.priority"],
		capabilities: ["gholam.action", "danger"],
		since: "0.6.1",
	},
	"view.gholam.chats": {
		title: "Gholam chats",
		body: "Persistent chat list with the sidecar. Each row is a `GholamChat` record; the chat-thread surface reads from the store, no refetch on revisit.",
		related: ["view.gholam"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"view.inbox": {
		title: "Inbox",
		body: "Cross-cutting inbox — system events, agent pings, promote-to-task suggestions. The Promote to task action deep-links into Tasks with `?open=<id>`.",
		related: ["view.tasks", "view.settings"],
		capabilities: ["open", "task.action"],
		since: "0.6.1",
	},
	"view.marketplace": {
		title: "Marketplace",
		body: "Browse, install, and uninstall plugins. Catalog comes from /api/marketplace; featured + popular rows score against the live install counts. Installing calls POST /marketplace/install; uninstalling is a dry-run-confirmed DELETE.",
		related: ["marketplace.featured", "marketplace.popular", "marketplace.search"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"view.skills": {
		title: "Skills",
		body: "Skills catalog mirrors the deck's plugin cache. Live refetch rides on `skills_changed` frames; an install is just a marketplace entry under the hood.",
		related: ["view.marketplace"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.kb": {
		title: "KB",
		body: "/kb — Karpathy-style llm-wiki viewer. Sidebar = tree; main = markdown viewer (resolves [[wikilinks]] to in-app navigation); inspector = frontmatter + outbound list. URL state in `?path=<rel>` drives the open file; back/forward works. Editor (T-36) and graph view (T-37/38) plug into this shell.",
		related: ["kb.commit-graph.vertex", "kb.file"],
		capabilities: ["kb.action", "open"],
		since: "0.6.1",
	},
	"view.prompts.library": {
		title: "Prompts library",
		body: "Local prompt library. Mirrors the server-side `~/.omp-deck/prompts/` tree; CRUD via /api/prompts.",
		related: ["view.prompts.discover", "view.prompts.share"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.prompts.discover": {
		title: "Prompts discover",
		body: "Trending row at top (computed from the local library — usage decay sort is the cheapest 'trending' we can produce without crawling external sources) + a search bar that filters the library by free text. Save-to-library flow lands each row into the prompt library as a draft the user can edit before confirming.",
		related: ["view.prompts.library"],
		capabilities: ["edit", "open"],
		since: "0.6.1",
	},
	"view.prompts.share": {
		title: "Prompts share",
		body: "Shareable prompt link. The slug is a stable id; the page hydrates from /api/prompts and renders the body with the same markdown pipeline as the library.",
		related: ["view.prompts.library"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"view.integrations": {
		title: "Integrations",
		body: "External integrations (GitHub, OAuth providers, etc.). Each row opens a per-integration settings page with auth + scope controls.",
		related: ["view.settings"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.settings": {
		title: "Settings",
		body: "Workspace + user settings. Theme, model defaults, notification channels, OAuth providers.",
		related: ["view.integrations"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.onboarding": {
		title: "Onboarding",
		body: "First-run wizard. Triggered automatically by the OnboardingGate if the server reports `needsOnboarding`; also reachable from Settings.",
		related: ["view.settings"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"view.studio": {
		title: "Studio",
		body: "Three-column surface composing the deck's views side-by-side. Hover anywhere to see a tooltip; right-click anywhere to see a context menu. URL query params (?pane=, ?preset=) drive deep links — copy/paste a URL and the recipient opens the same view.",
		related: ["studio.pane.kb", "studio.pane.composer", "studio.pane.tasks"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"view.preview": {
		title: "Preview",
		body: "Pinned preview pane per route. Streams the server GenUI render for the matched :route param; the right rail toggles between three modes and persists the choice in localStorage.",
		related: ["view.studio"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"view.storefront": {
		title: "Storefront",
		body: "Discovery surface — featured / trending / new / sections / detail. Items stream in via `store_item_added` SSE; MCP health per server is a pill row at the top.",
		related: ["store.item", "studio.statusbar.bridges"],
		capabilities: ["open"],
		since: "0.6.1",
	},

	// ─── Chrome (Layout.tsx) ─────────────────────────────────────────────
	"chrome.sidebar": {
		title: "Toggle sidebar",
		body: "Open or close the session sidebar. On mobile the sidebar is an overlay drawer; on desktop it pushes the main column. State persists in localStorage for desktop viewports only.",
		related: ["chrome.inspector", "chrome.nav-rail"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"chrome.inspector": {
		title: "Toggle inspector",
		body: "Open or close the right-rail inspector. The inspector shows the context-appropriate detail pane (model usage, kb backlinks, task metadata).",
		related: ["chrome.sidebar"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"chrome.connection": {
		title: "Connection",
		body: "WebSocket health. Green = open, amber = connecting, red = closed. The deck auto-reconnects with exponential backoff on close; the gap between heartbeats is what drives this indicator.",
		related: ["chrome.tool-cards"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"chrome.tool-cards": {
		title: "Tool cards",
		body: "Collapse or expand all tool cards in the active session. The toggle is bulk; per-card state lives in the store and overrides the bulk default until the next bulk toggle.",
		related: ["chrome.connection"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"chrome.nav-rail": {
		title: "Nav rail",
		body: "Vertical nav rail. Click a glyph to jump to the matching view; the active view's glyph is highlighted.",
		related: ["chrome.sidebar"],
		capabilities: ["open"],
		since: "0.6.1",
	},

	// ─── Marketplace chrome ──────────────────────────────────────────────
	"marketplace.featured": {
		title: "Featured plugins",
		body: "Curated picks from the marketplace. Click a tile to select the entry; the inspector updates to show its description, install scope, and tags.",
		related: ["marketplace.popular", "view.marketplace"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"marketplace.popular": {
		title: "Popular this week",
		body: "Top installs from the past seven days. Same affordances as Featured; the row sits below Featured when both are populated.",
		related: ["marketplace.featured", "view.marketplace"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"marketplace.search": {
		title: "Search marketplace",
		body: "Free-text filter over name, marketplace source, description, author, and tags. Case-insensitive substring match.",
		related: ["view.marketplace"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"marketplace.install": {
		title: "Install plugin",
		body: "Calls POST /api/marketplace/install. Default scope is user; pass 'project' to install under .omp-deck/ in the active cwd instead.",
		related: ["view.marketplace"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"marketplace.uninstall": {
		title: "Uninstall plugin",
		body: "Calls DELETE /api/marketplace/install. Requires a confirm chip because it removes the plugin from the cache.",
		related: ["view.marketplace"],
		capabilities: ["danger", "execute"],
		since: "0.6.1",
	},
	"marketplace.dry-run": {
		title: "Dry-run install",
		body: "Calls POST /api/marketplace/install/dry-run and surfaces the predicted file write list. Lets you see what would change before committing the real install.",
		related: ["marketplace.install"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"marketplace.refresh": {
		title: "Refresh sources",
		body: "Calls POST /api/marketplace/refresh to re-fetch each registered marketplace source's catalog. Used after a marketplace index changes upstream.",
		related: ["view.marketplace"],
		capabilities: ["execute"],
		since: "0.6.1",
	},

	// ─── Gholam chrome ───────────────────────────────────────────────────
	"gholam.sidebar": {
		title: "Gholam sidecar",
		body: "Live status for the digital-twin sidecar: running flag, pid, ws port, last beat, and the current heartbeat interval. The heartbeat interval dropdown retunes the sidecar without restarting it.",
		related: ["gholam.sidebar.start", "gholam.sidebar.heartbeat"],
		capabilities: ["gholam.action"],
		since: "0.6.1",
	},
	"gholam.sidebar.start": {
		title: "Start / stop sidecar",
		body: "Toggles the Gholam sidecar. Start POSTs to /api/gholam/start; stop POSTs to /api/gholam/stop. The button reflects the sidecar's running flag, polled every 5s.",
		related: ["gholam.sidebar"],
		capabilities: ["gholam.action"],
		since: "0.6.1",
	},
	"gholam.sidebar.heartbeat": {
		title: "Heartbeat interval",
		body: "How often the sidecar ticks. Options: 5s, 15s, 30s, 1min, 5min. The change POSTs to /api/gholam/heartbeat with the new interval; the sidecar keeps its current run loop, just retunes the timer.",
		related: ["gholam.sidebar.start"],
		capabilities: ["gholam.action"],
		since: "0.6.1",
	},
	"gholam.priority.add": {
		title: "Add priority",
		body: "Append a new priority to the in-memory list. Saving calls POST /api/gholam/priorities with the full list; the sidecar's queue file picks it up on the next heartbeat. Priorities are user-controlled — Gholam never picks its own targets.",
		related: ["gholam.priority.remove", "view.gholam"],
		capabilities: ["edit", "gholam.action"],
		since: "0.6.1",
	},
	"gholam.priority.remove": {
		title: "Remove priority",
		body: "Drop a priority from the in-memory list. Saving persists; the change rides on the next /api/gholam/priorities save.",
		related: ["gholam.priority.add"],
		capabilities: ["danger", "gholam.action"],
		since: "0.6.1",
	},
	"gholam.save": {
		title: "Save priorities",
		body: "POST the current priority list to /api/gholam/priorities. The button is disabled while a save is in flight.",
		related: ["gholam.priority.add"],
		capabilities: ["gholam.action", "execute"],
		since: "0.6.1",
	},

	// ─── KB ──────────────────────────────────────────────────────────────
	"kb.commit-graph": {
		title: "KB commit graph",
		body: "Commit history of the KB tree. Each node is a git commit; backlinks resolved by [[wikilinks]] show up as outbound edges in the inspector.",
		related: ["kb.file", "view.kb"],
		capabilities: ["kb.action", "open"],
		since: "0.6.1",
	},
	"kb.commit-graph.vertex": {
		title: "KB commit vertex",
		body: "A single node in the KB commit graph. Right-click to open the file, copy the path, or jump to the commit in the inspector.",
		related: ["kb.file"],
		capabilities: ["kb.action", "open"],
		since: "0.6.1",
	},
	"kb.file": {
		title: "KB file",
		body: "A markdown file under the watched KB root. Click to view; the URL gains ?path=<rel>; back/forward navigate the open file.",
		related: ["kb.commit-graph"],
		capabilities: ["open", "kb.action"],
		since: "0.6.1",
	},
	"kb.command-palette": {
		title: "KB command palette",
		body: "Open the KB command palette (Ctrl/Cmd+K) to fuzzy-find files, [[wikilinks]], and run palette actions (new file, rename, archive).",
		related: ["kb.file"],
		capabilities: ["kb.action", "edit"],
		since: "0.6.1",
	},

	// ─── Tasks / kanban ──────────────────────────────────────────────────
	"kanban.card": {
		title: "Task card",
		body: "A single task. Drag between columns to move state; click to open the modal editor. Body edits bump updatedAt; cross-column moves bump stateEnteredAt for per-column recency sort.",
		related: ["kanban.column", "view.tasks"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},
	"kanban.column": {
		title: "Task column",
		body: "A column = a TaskState. Drop cards here to land them at the end. Reorder columns with the column-drag affordance; the new order is persisted via /api/tasks/states/reorder.",
		related: ["kanban.card"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},
	"kanban.columns-edit": {
		title: "Edit columns",
		body: "Opens the column editor in the inspector. Add, rename, recolor, and reorder TaskStates. The save round-trips through /api/tasks/states.",
		related: ["kanban.column"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},
	"kanban.create": {
		title: "Create task",
		body: "Calls POST /api/tasks with the column's id as the initial state. The new card is optimistically prepended to the column before the server reply lands.",
		related: ["kanban.card"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},
	"kanban.open-in-chat": {
		title: "Open in chat",
		body: "Pre-fills the composer with '# Title\\n\\nBody' and routes to /. The deck's pendingDraft slice is set, the active session is created (or reused) for the task's cwd, and the user lands on the chat with the prompt ready to send.",
		related: ["view.chat", "view.tasks"],
		capabilities: ["task.action", "open"],
		since: "0.6.1",
	},
	"kanban.archive": {
		title: "Archive task",
		body: "Sets archivedAt; the card disappears from the active kanban. Reversible from the same modal (toggle archivedAt back to null).",
		related: ["kanban.card"],
		capabilities: ["task.action", "edit"],
		since: "0.6.1",
	},

	// ─── Tools (KNOWN_TOOLS) ─────────────────────────────────────────────
	"tool.read": {
		title: "read",
		body: "Read a file's contents. Returns the file with line numbers; supports offset/limit for partial reads.",
		related: ["tool.write", "tool.edit"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.write": {
		title: "write",
		body: "Write or create a file. Overwrites the target; the deck's git watcher records the change as a workspace edit.",
		related: ["tool.read", "tool.edit"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"tool.edit": {
		title: "edit",
		body: "Targeted in-place edit. Apply a literal search/replace pair; the call fails if the search text is not unique unless `replaceGlobally` is set.",
		related: ["tool.read", "tool.write"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"tool.bash": {
		title: "bash",
		body: "Run a shell command. The deck uses Bun for most command execution; long-running processes can run in the background and be polled via BashOutput.",
		related: ["tool.read"],
		capabilities: ["execute", "danger"],
		since: "0.6.1",
	},
	"tool.search": {
		title: "search",
		body: "Regex search across the workspace. Returns file:line:content matches; the deck's KB watcher scopes some calls to the watched KB root only.",
		related: ["tool.find", "tool.read"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.find": {
		title: "find",
		body: "Glob-based file finder. Returns absolute paths matching the glob; cheaper than search for 'where is X' style queries.",
		related: ["tool.search"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.lsp": {
		title: "lsp",
		body: "LSP query — go-to-definition, references, hover, rename. The deck boots a tsserver-compatible language server per workspace.",
		related: ["tool.read"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.task": {
		title: "task",
		body: "Spawn a subagent. Returns a task id; the subagent's output streams in via the parent session's tool cards.",
		related: ["tool.ask", "tool.todo_write"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.web_search": {
		title: "web_search",
		body: "Web search. Returns a ranked list of hits with excerpts; the agent can `web_fetch` to read a hit in full.",
		related: ["tool.browser"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.eval": {
		title: "eval",
		body: "Evaluate a JavaScript snippet in the worker's V8 isolate. The result is returned as the tool's output.",
		related: ["tool.bash"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.generate_image": {
		title: "generate_image",
		body: "Generate an image. The result is a URL the deck can attach to the next prompt as an image attachment.",
		related: ["tool.ask"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.todo_write": {
		title: "todo_write",
		body: "Append a TODO to the session's todo list. The composer renders the list above the active prompt; clearing the list is a separate call.",
		related: ["tool.task"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"tool.browser": {
		title: "browser",
		body: "Headless Chromium browser. Supports goto/click/type/screenshot/extract; the deck's browser harness is a dedicated worker.",
		related: ["tool.web_search"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.ast_edit": {
		title: "ast_edit",
		body: "AST-aware structural rewrite. Safer than text replace for refactors; the engine is ast-grep with metavariables.",
		related: ["tool.edit", "tool.ast_grep"],
		capabilities: ["edit", "execute"],
		since: "0.6.1",
	},
	"tool.ast_grep": {
		title: "ast_grep",
		body: "AST pattern search. Returns matching nodes with file:line:snippet; useful for 'every place we call X' style queries.",
		related: ["tool.search", "tool.ast_edit"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"tool.ask": {
		title: "ask",
		body: "Open an extension-UI dialog. The server emits an `ext_ui_dialog_open` frame; the deck's dialog surface collects the answer and sends it back as `ExtUiDialogResponse`.",
		related: ["tool.task"],
		capabilities: ["execute"],
		since: "0.6.1",
	},

	// ─── Bridges (BridgeName) ────────────────────────────────────────────
	"bridge.telegram": {
		title: "Telegram bridge",
		body: "Telegram bot bridge. The deck supervises the bot process; status is running/stopped/starting/crashed. Start, stop, and restart are POSTs to /api/bridges/telegram/{start,stop,restart}.",
		related: ["studio.statusbar.bridges"],
		capabilities: ["execute", "open"],
		since: "0.6.1",
	},

	// ─── Notifications (NotificationLevel) ───────────────────────────────
	"notify.info": {
		title: "Info",
		body: "Routine info notification. No audio cue, neutral styling. Used for benign events (a workspace was added, a session was renamed).",
		related: ["notify.warn", "notify.error"],
		since: "0.6.1",
	},
	"notify.warn": {
		title: "Warning",
		body: "Caution notification. Mild audio cue, amber styling. Used for recoverable failures and budget warnings.",
		related: ["notify.info", "notify.error"],
		since: "0.6.1",
	},
	"notify.error": {
		title: "Error",
		body: "Error notification. Loud audio cue, red styling. Used for unhandled exceptions and failed sidecar starts.",
		related: ["notify.warn", "notify.critical"],
		since: "0.6.1",
	},
	"notify.critical": {
		title: "Critical",
		body: "Critical notification. Sticky toast + audio cue. Used for actions that the user must attend to (a suspended approval, a budget breach).",
		related: ["notify.error"],
		since: "0.6.1",
	},

	// ─── Server routes (the docblock's prefix inventory) ─────────────────
	"route.health": {
		title: "GET /api/health",
		body: "Liveness probe. Returns the build sha + uptime; used by the connection indicator's heartbeat math.",
		related: ["route.version"],
		since: "0.6.1",
	},
	"route.version": {
		title: "GET /api/version",
		body: "Build metadata. Polled by the UpdatePill; if the server's build sha differs from the deck's, a release-link pill surfaces in the status bar.",
		related: ["route.health"],
		since: "0.6.1",
	},
	"route.workspaces": {
		title: "GET /api/workspaces",
		body: "List of registered workspaces. Cached in the store; re-fetched on bootstrap and after a workspace add/remove.",
		related: ["route.sessions"],
		since: "0.6.1",
	},
	"route.sessions": {
		title: "Sessions",
		body: "List/create/abort/compact/update/delete sessions. The composer's active session id is the row's id; abort POSTs to /sessions/:id/abort.",
		related: ["route.workspaces", "route.models"],
		since: "0.6.1",
	},
	"route.sessions.abort": {
		title: "POST /api/sessions/:id/abort",
		body: "Cancel the active turn. Idempotent if the session is already idle. Bound to Ctrl+. (Cmd+. on macOS) at the App level.",
		related: ["route.sessions"],
		capabilities: ["danger"],
		since: "0.6.1",
	},
	"route.sessions.compact": {
		title: "POST /api/sessions/:id/compact",
		body: "Trigger a context-compaction pass on the session. The session's status flips to 'compacting' until the new summary is written.",
		related: ["route.sessions"],
		capabilities: ["execute"],
		since: "0.6.1",
	},
	"route.sessions.update": {
		title: "PATCH /api/sessions/:id",
		body: "Rename or move a session. Returns the updated row.",
		related: ["route.sessions"],
		capabilities: ["edit"],
		since: "0.6.1",
	},
	"route.sessions.delete": {
		title: "DELETE /api/sessions/:id",
		body: "Remove a session and its transcript from the server. Cannot be undone; the deck's UI requires a confirm chip.",
		related: ["route.sessions"],
		capabilities: ["danger"],
		since: "0.6.1",
	},
	"route.models": {
		title: "GET /api/models",
		body: "List of model refs the active provider exposes. The composer's model picker reads from this; subscription auth variants are badged separately.",
		related: ["route.sessions"],
		since: "0.6.1",
	},

	// ─── Studio surface ──────────────────────────────────────────────────
	"studio.pane.kb": {
		title: "KB pane",
		body: "Read-mode embed of /kb. Tree + markdown viewer + backlinks inspector; the command palette is hidden in this pane to keep it focused.",
		related: ["studio.pane.composer", "view.kb"],
		capabilities: ["open", "kb.action"],
		since: "0.6.1",
	},
	"studio.pane.composer": {
		title: "Composer pane",
		body: "Read-only embed of the chat composer + messages. The studio doesn't write through the composer — that's the user's primary surface outside the studio.",
		related: ["studio.pane.gholam", "view.chat"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.pane.tasks": {
		title: "Tasks pane",
		body: "Read-mode embed of /tasks. Cards and columns are visible but read-only; the studio's readOnly flag suppresses edits so two panes can't race the same task.",
		related: ["kanban.card", "view.tasks"],
		capabilities: ["open", "task.action"],
		since: "0.6.1",
	},
	"studio.pane.gholam": {
		title: "Gholam pane",
		body: "Full embed of /gholam including sidebar + main. Unlike the other panes this one IS writable — the studio is where the user drives sidecar priorities.",
		related: ["view.gholam", "gholam.sidebar"],
		capabilities: ["open", "gholam.action", "edit"],
		since: "0.6.1",
	},
	"studio.pane.prompts": {
		title: "Prompts pane",
		body: "Read-mode embed of /prompts/discover. The trending row + search bar + save-to-library flow are all visible; the 'edit' affordances are hidden.",
		related: ["view.prompts.discover"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.pane.storefront": {
		title: "Storefront pane",
		body: "Read-mode embed of /storefront. Featured + trending + sections list; click-through to /storefront/:section/:id for the full detail view.",
		related: ["view.storefront"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.preset": {
		title: "Layout preset",
		body: "Switch the studio's pane layout. Three presets: wide (3-col), compact (1-col stack), sidebar-left (KB left, composer + tasks right).",
		related: ["studio.pane.kb", "studio.pane.composer"],
		since: "0.6.1",
	},
	"studio.reset": {
		title: "Reset layout",
		body: "Restore the default layout for the current preset. Per-pane chrome overrides are kept; only the slot assignments reset.",
		related: ["studio.preset"],
		since: "0.6.1",
	},
	"studio.heartbeat": {
		title: "Heartbeat",
		body: "Server liveness. Updated by every `heartbeat` frame; the indicator turns red if the gap exceeds the configured threshold.",
		related: ["chrome.connection"],
		since: "0.6.1",
	},

	// ─── Studio statusbar ────────────────────────────────────────────────
	"studio.statusbar.bridges": {
		title: "Bridge pills",
		body: "One pill per BridgeName. Color matches the bridge's status (green=running, amber=starting, red=crashed). Click to expand the bridge's log tail.",
		related: ["bridge.telegram"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.statusbar.deploy": {
		title: "Deployments",
		body: "Current build/deploy phase. Click to open the latest log tail in the inspector.",
		related: ["studio.statusbar.bridges"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.statusbar.inbox": {
		title: "Inbox",
		body: "Number of unread inbox items. Click to jump to /inbox.",
		related: ["view.inbox"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.statusbar.shortcut": {
		title: "Shortcuts",
		body: "Keyboard shortcuts. The full palette (Shift+?) ships in a follow-up; v1 surfaces only the most common.",
		since: "0.6.1",
	},
	"studio.statusbar.badge": {
		title: "Status bar badge",
		body: "Status bar item. Right-click for the badge's per-server actions (refresh, open log, restart).",
		related: ["studio.statusbar.bridges", "studio.statusbar.deploy"],
		capabilities: ["open"],
		since: "0.6.1",
	},
	"studio.statusbar.mcp": {
		title: "MCP server pills",
		body: "One pill per MCP server probed by the deck. Color matches the server's state (green=healthy, amber=degraded, red=unreachable, grey=unknown/disabled). Per-server tooltips fall through to a heuristic since server names are probed at runtime and are not enumerable at seed time.",
		related: ["studio.statusbar.bridges"],
		capabilities: ["open"],
		since: "0.6.2",
	},

	// ─── Storefront ──────────────────────────────────────────────────────
	"store.item": {
		title: "Storefront item",
		body: "A single catalog row from the marketplace / KB / skill sources. Right-click for the per-item actions (install, copy id, open detail).",
		related: ["view.storefront", "marketplace.install"],
		capabilities: ["open", "execute"],
		since: "0.6.1",
	},
};

export type MenuEntry = {
	scope: string;
	actions: (ctx: unknown) => MenuAction[];
	since: string;
};

export const MENUS: Record<string, MenuEntry> = {
	// ─── Global fallback (always present, never empty) ───────────────────
	"global.fallback": {
		scope: "global",
		since: "0.6.1",
		actions: () => [
			{ id: "inspect", label: "Inspect element (DevTools)", capability: "open", icon: "external-link", handler: () => undefined },
			{ id: "copy-ref", label: "Copy CSS selector", capability: "edit", icon: "copy", handler: () => undefined },
			{ id: "copy-md", label: "Copy as markdown", capability: "edit", icon: "copy", handler: () => undefined },
			{ id: "console", label: "Open dev console", capability: "open", icon: "external-link", handler: () => undefined },
			{ id: "reload", label: "Reload app", capability: "execute", icon: "refresh", handler: () => window.location.reload() },
		],
	},

	// ─── Kanban ─────────────────────────────────────────────────────────
	"kanban.card": {
		scope: "kanban.card",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { task?: { id: string; title: string } };
			return [
				{ id: "open", label: "Open task", accelerator: "Enter", capability: "task.action", icon: "external-link", handler: () => undefined },
				{ id: "open-in-chat", label: "Open in chat", capability: "task.action", icon: "play", handler: () => undefined },
				{ id: "rename", label: "Rename", capability: "task.action", icon: "edit", handler: () => undefined },
				{ id: "archive", label: c.task ? "Archive" : "Archive", capability: "task.action", icon: "trash", handler: () => undefined },
				{ id: "delete", label: "Delete", danger: true, capability: "task.action", icon: "trash", handler: () => undefined },
			];
		},
	},
	"kanban.column": {
		scope: "kanban.column",
		since: "0.6.1",
		actions: () => [
			{ id: "add-task", label: "Add task", accelerator: "N", capability: "task.action", icon: "plus", handler: () => undefined },
			{ id: "edit-columns", label: "Edit columns", capability: "task.action", icon: "edit", handler: () => undefined },
			{ id: "clear", label: "Clear column", danger: true, capability: "task.action", icon: "trash", handler: () => undefined },
		],
	},

	// ─── KB ─────────────────────────────────────────────────────────────
	"kb.commit-graph.vertex": {
		scope: "kb.commit-graph.vertex",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { node?: { path: string; id: string } };
			return [
				{ id: "open", label: "Open file", accelerator: "Enter", capability: "kb.action", icon: "external-link", handler: () => undefined },
				{ id: "copy-path", label: "Copy path", accelerator: "Ctrl+Shift+C", capability: "kb.action", icon: "copy", handler: () => { if (c?.node?.path) void navigator.clipboard.writeText(c.node.path); } },
				{ id: "delete", label: "Delete from graph", danger: true, capability: "kb.action", icon: "trash", handler: () => undefined },
			];
		},
	},
	"kb.file": {
		scope: "kb.file",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { file?: { path: string } };
			return [
				{ id: "open", label: "Open", accelerator: "Enter", capability: "kb.action", icon: "external-link", handler: () => undefined },
				{ id: "copy-path", label: "Copy path", capability: "kb.action", icon: "copy", handler: () => { if (c?.file?.path) void navigator.clipboard.writeText(c.file.path); } },
				{ id: "rename", label: "Rename", capability: "kb.action", icon: "edit", handler: () => undefined },
				{ id: "archive", label: "Archive", danger: true, capability: "kb.action", icon: "trash", handler: () => undefined },
			];
		},
	},
	"kb.commit-graph": {
		scope: "kb.commit-graph",
		since: "0.6.1",
		actions: () => [
			{ id: "refresh", label: "Refresh graph", capability: "kb.action", icon: "refresh", handler: () => undefined },
			{ id: "layout", label: "Re-layout", capability: "kb.action", icon: "edit", handler: () => undefined },
		],
	},
	"kb": {
		scope: "kb",
		since: "0.6.1",
		actions: () => [
			{ id: "new-file", label: "New file", accelerator: "Ctrl+N", capability: "kb.action", icon: "plus", handler: () => undefined },
			{ id: "palette", label: "Command palette", accelerator: "Ctrl+K", capability: "kb.action", icon: "external-link", handler: () => undefined },
		],
	},

	// ─── Composer ──────────────────────────────────────────────────────
	"composer.attachment": {
		scope: "composer.attachment",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { attachment?: { id: string; data?: string } };
			return [
				{ id: "preview", label: "Preview", accelerator: "Enter", capability: "edit", icon: "external-link", handler: () => undefined },
				{ id: "remove", label: "Remove", danger: true, capability: "edit", icon: "trash", handler: () => undefined },
				{ id: "copy-data-url", label: "Copy data URL", capability: "edit", icon: "copy", handler: () => { if (c?.attachment?.data) void navigator.clipboard.writeText(c.attachment.data); } },
			];
		},
	},
	"composer": {
		scope: "composer",
		since: "0.6.1",
		actions: () => [
			{ id: "send", label: "Send prompt", accelerator: "Enter", capability: "execute", icon: "play", handler: () => undefined },
			{ id: "abort", label: "Stop generation", accelerator: "Ctrl+.", capability: "danger", icon: "stop", handler: () => undefined },
		],
	},

	// ─── Gholam ─────────────────────────────────────────────────────────
	"gholam.priority": {
		scope: "gholam.priority",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { priority?: { id?: string; label: string } };
			return [
				{ id: "edit", label: "Edit priority", capability: "gholam.action", icon: "edit", handler: () => undefined },
				{ id: "remove", label: "Remove priority", danger: true, capability: "gholam.action", icon: "trash", handler: () => undefined },
				{ id: "trigger", label: "Trigger heartbeat now", capability: "gholam.action", icon: "play", handler: () => undefined },
				{ id: "copy-label", label: "Copy label", capability: "gholam.action", icon: "copy", handler: () => { if (c?.priority?.label) void navigator.clipboard.writeText(c.priority.label); } },
			];
		},
	},
	"gholam": {
		scope: "gholam",
		since: "0.6.1",
		actions: () => [
			{ id: "start", label: "Start sidecar", capability: "gholam.action", icon: "play", handler: () => undefined },
			{ id: "stop", label: "Stop sidecar", danger: true, capability: "gholam.action", icon: "stop", handler: () => undefined },
			{ id: "save-priorities", label: "Save priorities", capability: "gholam.action", icon: "edit", handler: () => undefined },
		],
	},

	// ─── Marketplace ───────────────────────────────────────────────────
	"marketplace.entry": {
		scope: "marketplace.entry",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { entry?: { id: string; installed?: { scope: "user" | "project" } } };
			return [
				{ id: "install", label: "Install", capability: "edit", icon: "plus", handler: () => undefined },
				{ id: "dry-run", label: "Dry-run", capability: "execute", icon: "refresh", handler: () => undefined },
				{ id: "uninstall", label: "Uninstall", danger: true, capability: "danger", icon: "trash", handler: () => undefined },
				{ id: "copy-id", label: "Copy id", capability: "edit", icon: "copy", handler: () => { if (c?.entry?.id) void navigator.clipboard.writeText(c.entry.id); } },
			];
		},
	},
	"marketplace": {
		scope: "marketplace",
		since: "0.6.1",
		actions: () => [
			{ id: "refresh", label: "Refresh sources", capability: "execute", icon: "refresh", handler: () => undefined },
			{ id: "add", label: "Add marketplace", capability: "edit", icon: "plus", handler: () => undefined },
		],
	},

	// ─── Storefront ────────────────────────────────────────────────────
	"store.item": {
		scope: "store.item",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { item?: { id: string; section: string } };
			return [
				{ id: "open", label: "Open detail", capability: "open", icon: "external-link", handler: () => undefined },
				{ id: "install", label: "Install", capability: "edit", icon: "plus", handler: () => undefined },
				{ id: "copy-id", label: "Copy id", capability: "edit", icon: "copy", handler: () => { if (c?.item?.id) void navigator.clipboard.writeText(c.item.id); } },
			];
		},
	},

	// ─── Bridge pills (statusbar) ─────────────────────────────────────
	"bridge.telegram": {
		scope: "bridge.telegram",
		since: "0.6.1",
		actions: () => [
			{ id: "start", label: "Start", capability: "execute", icon: "play", handler: () => undefined },
			{ id: "stop", label: "Stop", capability: "execute", icon: "stop", handler: () => undefined },
			{ id: "restart", label: "Restart", capability: "execute", icon: "refresh", handler: () => undefined },
			{ id: "logs", label: "Open logs", capability: "open", icon: "external-link", handler: () => undefined },
		],
	},
	"studio.statusbar.badge": {
		scope: "studio.statusbar.badge",
		since: "0.6.1",
		actions: () => [
			{ id: "refresh", label: "Refresh", capability: "execute", icon: "refresh", handler: () => undefined },
			{ id: "open-logs", label: "Open log tail", capability: "open", icon: "external-link", handler: () => undefined },
		],
	},

	// ─── Studio ────────────────────────────────────────────────────────
	"studio.pane": {
		scope: "studio.pane",
		since: "0.6.1",
		actions: (ctx) => {
			const c = (ctx ?? {}) as { pane?: { id: string } };
			return [
				{ id: "focus", label: "Focus pane", capability: "open", icon: "external-link", handler: () => undefined },
				{ id: "close", label: "Close pane", capability: "edit", icon: "trash", handler: () => undefined },
				{ id: "copy-pane-id", label: "Copy pane id", capability: "edit", icon: "copy", handler: () => { if (c?.pane?.id) void navigator.clipboard.writeText(c.pane.id); } },
			];
		},
	},
};
