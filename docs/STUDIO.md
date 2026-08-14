# Studio, Tooltip, and Context-Menu Design

A user-facing studio surface layered on top of the existing deck. Hover anywhere → tooltip. Right-click anywhere → menu. One new `/studio` route composes the deck's existing views side-by-side. No new back-end.

---

## 1. Studio surface — what `/studio` actually is

`/studio` is **one page that lays out code, sessions, KB, tasks, deployments, gholam state, and agent config side-by-side with the user's active session in the center**. It is *not* a parallel product — every pane embeds an existing view's renderable. The studio is the deck, opened wide.

### Layout

Three-column CSS Grid, full-bleed inside `AppRouter`:

```
┌─────────────────────────────────────────────────────────────────┐
│  Header — /studio · workspace · heartbeat · theme · reset       │  h=10
├──────────────────┬──────────────────────────┬───────────────────┤
│  Pane A (1/3)    │  Pane B (2/3, primary)   │  Pane C (1/3)     │
│  KB tree +       │  Live session composer   │  Tasks kanban     │
│  commit graph    │  + active tool cards     │  + Gholam state   │
│                  │                          │                   │
├──────────────────┴──────────────────────────┴───────────────────┤
│  Status bar — bridges · deployments · inbox count · shortcuts   │  h=7
└─────────────────────────────────────────────────────────────────┘
```

Default pane assignment (preset `wide`):

| Col | Default pane (id)            | Source component                        |
| --- | ---------------------------- | --------------------------------------- |
| A   | `kb`                         | `<KbView />` (read-only embed, no top bar) |
| B   | `composer`                   | `<ChatView />` minus `<NavRail>`        |
| C   | `tasks`                      | `<TasksView />`                          |

Two presets: `compact` (1 col, stack), `sidebar-left` (KB left, composer right 1/2 + tasks below composer). Drag-to-rearrange is v2.

### Pin / anchor model

- **Pinned** across navigation: `composer`, `kb` (read mode), `gholam`. These panes survive the user visiting `/chat`, `/tasks`, etc. — the studio mounts its own chrome overlay and the user's previous view stays visible *under* it. Concretely: the studio wraps the router outlet, not the other way around. (Defer: in v1 the studio is a full route; panes reset on navigation. Persistent overlay is v1.1 — the StudioProvider already lays the wiring.)
- **Per-view**: nothing yet — v1 is single-route.

### Reduced motion & keyboard

- `prefers-reduced-motion: reduce` → tooltip fade-in skipped (instant show); context menu opens without scale.
- Tooltip: hover **or** focus (Tab). Esc dismisses. Blur dismisses. `Alt` (configurable) opens expanded variant.
- Context menu: right-click **or** `Shift+F10` **or** `ContextMenu` key. Arrow keys navigate. Enter activates. Esc dismisses. Type-ahead filters by label substring.

### Data wiring

- Same `useStore` zustand store (`apps/web/src/lib/store.ts`) the rest of the deck uses.
- Same `WsClient` (`apps/web/src/lib/ws.ts`) — the studio mounts its own `subscribe()` listener; frames the deck doesn't process (none today) are ignored.
- No new server routes. No protocol changes. `ServerFrame` / `ClientFrame` are untouched.
- Heartbeat, tasks-change, skills-change, kb-change counters feed the studio panes the same way the standalone views do.

### StudioProvider

A small React context (`apps/web/src/lib/studio/StudioProvider.tsx`):

```ts
type PaneDescriptor = {
  id: string;          // "kb" | "composer" | "tasks" | "gholam" | ...
  title: string;
  render: () => ReactNode;   // function form, not component, so we can lazy-mount
  capabilities: ("edit" | "execute" | "danger")[];
  defaultPreset: "wide" | "compact" | "sidebar-left";
}

type StudioContextValue = {
  panes: Record<string, PaneDescriptor>;
  register: (p: PaneDescriptor) => () => void;   // returns unregister
  layout: PresetLayout;                          // mutable via header control
  focusPane: (id: string) => void;               // for ?pane= deep-link
}
```

Six hard-coded panes ship in v1 (listed in §5). Module-federation is **not** introduced. New panes later just call `register({...})` in the new view file.

---

## 2. Tooltip system — hover anything, get details

The hard part is "anything." Without a content model the tooltip is either empty or always the same generic blurb. Resolution order is explicit:

### Resolution order (a → e, first non-empty wins)

a. **Explicit** — `data-tooltip="..."` attribute on the element. Inline cases (button labels, hard-coded copy in views the executor shouldn't invasively edit).
b. **Keyed** — `data-tooltip-key="kb.commit-graph"` resolves to a JSON catalog entry. The catalog lives in `apps/web/src/lib/studio/tooltip-catalog.ts` (see §4).
c. **Heuristic** — for buttons/inputs without explicit content, derive deterministically from:
   - `aria-label` (highest weight)
   - `title` attribute (HTML default)
   - `data-testid` (last-resort identifier)
   - the visible textContent (trimmed)
   - the bound `onClick` function's `.name` if minified-friendly
   Heuristic must NEVER return empty. Final fallback is the literal string `"No description available yet — [edit this tooltip]"` with the key shown so a maintainer can find it.
d. **Async detail** — pressing the hotkey (default `Alt`, configurable per user in Settings) while the tooltip is open swaps it for the EXPANDED variant: doc URL, related frames, "Copy as markdown" button. For a session key, the expanded variant pulls `{model, context usage %, recent 5 messages summary}` on-demand from the store.
e. **Dismiss** — `Esc`, blur, click-elsewhere, scroll, navigation. Long-press 500ms on touch opens the tooltip in pinned mode (stays until tapped again).

### Behavior

- Hover delay: **300ms** before fade-in starts.
- Fade-in: **80ms**.
- Position: clamped to viewport, prefers-above then below then left then right (the existing deck's `GholamOverlay` panel is a good reference for how the studio should anchor floating surfaces — `position: fixed`, `rgb(var(--paper-2) / 0.95)` background, 12px radius, 24px 48px shadow, `1px solid rgb(var(--line))`).
- Render target: `document.body` via a single portal in the singleton. Constrain to a `position: fixed` rect clamped to viewport — NEVER allow the tooltip to escape `overflow: hidden` clipping on its parent.

### Singleton API

```ts
// apps/web/src/lib/studio/tooltip.ts
export const Tooltip = {
  show(target: HTMLElement | { rect: DOMRect; key?: string }, opts?: { expanded?: boolean; pinned?: boolean }): void;
  dismiss(reason?: "esc" | "blur" | "nav" | "click"): void;
  subscribe(fn: (state: { open: boolean; rect?: DOMRect; content?: TooltipContent }) => void): () => void;
  current(): TooltipState | null;
};
```

### React wrapper

```tsx
<Tooltipify
  key="composer.attach"
  inline                            // wrap inline (default) or block
  expanded={<ExpandedVariant />}   // optional override of the Alt-expanded body
>
  <Button>attach</Button>
</Tooltipify>
```

Behavior: `<Tooltipify>` is a thin wrapper — it copies `key` / `data-tooltip-key` onto the child, attaches hover/focus listeners, and lets the singleton decide what to render. It does **not** render the tooltip itself.

---

## 3. Context-menu system — right-click anything

Same hard problem: every element needs an action list. Without a content model the menu is empty.

### Registry shapes

```ts
// apps/web/src/lib/studio/context-menu.ts
export type MenuAction = {
  id: string;
  label: string;
  hint?: string;              // 1-line description, shown in tooltip on hover
  accelerator?: string;       // "Ctrl+E", "Enter", etc.
  icon?: "edit" | "trash" | "copy" | "external-link" | "play" | "stop" | "refresh" | "plus";
  danger?: boolean;
  capability: "edit" | "change" | "execute" | "open" | "danger" | "gholam.action" | "kb.action" | "task.action";
  handler: (ctx: unknown) => void | Promise<void>;
};

export type MenuDescriptor = {
  actions: MenuAction[];
  filter?: string;            // substring match against typed prefix
  priority?: number;          // higher wins when multiple match
};

export const ContextMenu = {
  register(key: string, build: (ctx: any) => MenuDescriptor | MenuAction[]): () => void;
  show(target: HTMLElement, event: { clientX: number; clientY: number }): void;
  close(reason?: "esc" | "click" | "nav"): void;
  subscribe(fn: (s: { open: boolean; actions: MenuAction[]; rect?: DOMRect }) => void): () => void;
};
```

### Registration examples

```ts
ContextMenu.register("kb.commit-graph.vertex", ({ node }) => [
  { id: "open", label: "Open file", accelerator: "Enter", capability: "open", icon: "external-link", handler: () => navigate(node.path) },
  { id: "copy-path", label: "Copy path", accelerator: "Ctrl+Shift+C", capability: "edit", icon: "copy", handler: () => navigator.clipboard.writeText(node.path) },
  { id: "delete", label: "Delete from graph", danger: true, capability: "danger", icon: "trash", handler: () => confirmThen("Delete?", () => api.kb.delete(node.id)) },
]);

ContextMenu.register("composer.attachment", ({ attachment }) => [
  { id: "preview", label: "Preview", accelerator: "Enter", capability: "open", handler: () => setPreview(attachment) },
  { id: "remove", label: "Remove", danger: true, capability: "danger", icon: "trash", handler: () => removeAttachment(attachment.id) },
  { id: "copy-data-url", label: "Copy data URL", capability: "edit", icon: "copy", handler: () => navigator.clipboard.writeText(attachment.data) },
]);

ContextMenu.register("gholam.priority", ({ priority }) => [
  { id: "edit", label: "Edit priority", capability: "edit", icon: "edit", handler: () => openEdit(priority) },
  { id: "remove", label: "Remove priority", danger: true, capability: "danger", icon: "trash", handler: () => removePriority(priority.id) },
  { id: "trigger", label: "Trigger heartbeat now", capability: "gholam.action", icon: "play", handler: () => api.gholam.beatNow() },
]);
```

### Resolution order

Specificity (most specific wins):

1. **Item-scoped** — exact key with element identity: `kb.commit-graph.vertex:cursor`
2. **Type-scoped** — `kb.commit-graph.vertex`
3. **Family-scoped** — `kb.commit-graph`
4. **Namespace fallback** — `kb`
5. **Global fallback** (ALWAYS non-empty):
   - Inspect element (open DevTools)
   - Copy element reference (CSS selector)
   - Copy as markdown (entire element rendered to MD)
   - Open dev console
   - Reload app
   - Toggle tooltips on/off

### Behavior

- `onContextMenu` listener on `<body>` (delegated) reads `data-context-key` (closest ancestor). If none, global fallback runs.
- `Shift+F10` or `ContextMenu` keyboard key opens the menu on the focused element.
- Each action renders a `<Tip>` with the action's `hint` and `accelerator` so menu items are themselves tooltip-able.
- Long-press 500ms on touch surfaces opens the menu with `navigator.vibrate?.(15)` (only when available; never throws).
- Destructive actions (`danger: true`) require a confirm step before `handler()` runs. The confirm is a `<ConfirmChip>` inline within the menu (don't open a second modal).

---

## 4. Catalog — the heart of the system

The catalog is the only persistent knowledge layer. Both systems read it.

### Structure

```ts
// apps/web/src/lib/studio/tooltip-catalog.ts

export const TOOLTIP_CATALOG_VERSION = 7;   // bump on every add/remove/rewrite

export type TooltipEntry = {
  title: string;
  body: string;                  // 1-3 sentences, plain prose
  docUrl?: string;               // expanded-variant deep link
  related?: string[];            // other catalog keys (cross-references)
  capabilities?: string[];       // for filtering by capability
  since: string;                 // semver of deck release, e.g. "0.18.0"
};

export const TOOLTIPS: Record<string, TooltipEntry> = { ... };

export type MenuEntry = {
  scope: string;                 // dotted key
  actions: (ctx: any) => MenuAction[];
  since: string;
};

export const MENUS: Record<string, MenuEntry> = { ... };
```

### Versioning

Catalog ships with `TOOLTIP_CATALOG_VERSION`. At boot, the singleton compares against `lastSeenTooltipCatalogVersion` in localStorage. If different, it logs a one-line console message (`tooltip catalog version drift: local=N server=M — refresh to view new copy`) and **keeps the old keys rendering** (graceful). Never block render on mismatch. This protects an old client from a new server's stale strings.

### v1 seed targets

For v1 we aim for **~80 tooltip entries + ~30 menu descriptors** with a hard floor of **zero "unknown" tooltips when hovering any element in `/studio`**.

Seeded from:

- **Every view in `router.tsx:64-99`** (16 paths: `/`, `/explorer`, `/agent-config`, `/tasks`, `/routines`, `/workflows`, `/gholam`, `/inbox`, `/marketplace`, `/skills`, `/kb`, `/integrations`, `/settings`, `/onboarding`, `/routines/:id/runs/:runId`, `/chat` if present) → `view.tasks`, `view.kb`, etc.
- **Every public route from `apps/server/src/routes.ts`** — already inventoried: `/health`, `/version`, `/workspaces`, `/sessions`, `/sessions` (POST), `/sessions/:id/abort`, `/sessions/:id/compact`, `/sessions/:id` (PATCH), `/models`, `/sessions/:id` (DELETE) → `route.sessions.abort`, `route.sessions.compact`, etc.
- **Every `KNOWN_TOOLS` entry** (`packages/protocol/src/index.ts:1099-1116`): `read`, `write`, `edit`, `bash`, `search`, `find`, `lsp`, `task`, `web_search`, `eval`, `generate_image`, `todo_write`, `browser`, `ast_edit`, `ast_grep`, `ask` → `tool.read`, `tool.write`, etc.
- **`BridgeName`** values from protocol (currently `telegram`) → `bridge.telegram`.
- **All four `NotificationLevel`** values → `notify.info`, `notify.warn`, `notify.error`, `notify.critical`.
- **Sidebar entries in `GholamView.tsx`** (Sidecar panel: pid, ws port, last beat, heartbeat interval select) → reuse the existing top-of-file docblock.
- **Top-of-file docblocks** from each view file. These are already beautifully written — copy prose, attribute in `related`.
- **`Layout.tsx` chrome controls** (NavRail icons, ConnectionIndicator, GholamOverlay) → `chrome.connection`, `chrome.nav-rail`, etc.
- **Composer controls** (attach, send, stop, model select, plan toggle) → `composer.send`, `composer.attach`, etc.

### Hard floor: zero unknowns in `/studio`

If the heuristic floor is not 100% after seeding, the executor MUST add a `[STUDIO-SEED]` marker list to the catalog file's header comment listing every remaining target. Those entries use the heuristic + an explicit stub entry until v1.1 fills them in.

---

## 5. Studio panes (the `/studio` page itself)

Six panes ship in v1. Each pane is a thin wrapper around an existing view's renderable — **no logic is duplicated**.

| Pane id        | Wraps                  | Capability tags                       |
| -------------- | ---------------------- | ------------------------------------- |
| `composer`     | `<ChatView>` minus nav rail, top bar replaced by studio header | `edit`, `execute`                     |
| `kb`           | `<KbView>` read-mode (no command palette in pane; sidebar yes) | `kb.action`, `open`                   |
| `tasks`        | `<TasksView>`          | `task.action`, `edit`                 |
| `gholam`       | `<GholamView>` sidebar+main (no inspector) | `gholam.action`, `danger`             |
| `workflows`    | `<WorkflowsView>` collapsed sidebar | `edit`, `execute`                     |
| `bridge-pills` | custom — small pills row reading `bridges-api.ts` | `open`                                 |

Header (10h): `[/studio · ${workspace}] · heartbeat · theme · preset selector · reset layout`. Status bar (7h): bridges row (one pill per `BridgeName`), deployments badge (clicks open latest `logTail`), inbox count badge, shortcuts hint.

### Embedding rule

Each pane receives a `readOnly?: boolean` prop. When `readOnly` is true the pane hides edit affordances and disables mutations — pure observer mode for the studio. This matters because multiple panes may share the same view's store slice; we don't want simultaneous edits racing.

`StudioProvider` mounts panes in `IntersectionObserver`-guarded wrappers so off-screen panes don't burn CPU on `kb_change_counter` increments.

---

## 6. Behavior & a11y

- **WCAG 1.4.13 (Content on Hover or Focus)**: tooltip announces on focus AS WELL AS hover; dismissable via Esc without moving focus; hoverable (mouse can move onto the tooltip without it disappearing).
- **Keyboard nav in tooltip**: focusable, Tab cycles through any action buttons in the expanded variant, Esc dismisses.
- **Keyboard nav in context menu**: ArrowDown focuses first action (or last-focused if re-opened), ArrowUp/Down navigate, Enter activates, Esc dismisses, printable keys filter by `label` substring.
- **Reduced motion** (`prefers-reduced-motion: reduce`): no fade animations. Tooltip appears immediately on hover. Context menu opens without scale-in.
- **Mobile**: long-press 500ms opens context menu (with `navigator.vibrate?.(15)` if available); tap-and-hold 500ms opens tooltip pinned.
- **Portal placement**: tooltip and menu both render to `document.body` via a single portal per surface. Position: `fixed`. Rect clamped to viewport with 8px margin.
- **Theme**: tooltip background `rgb(var(--paper-2) / 0.95)`, border `1px solid rgb(var(--line))`, shadow `0 24px 48px -16px rgb(var(--ink) / 0.35)`, font sizes match deck's `font-mono text-2xs` for hint and `font-sans text-xs` for body. Same for menu (border-radius 12px).

### Defer

- Full keyboard shortcut overlay (`?` opens a `command+k`-style palette listing every shortcut + tool + view): its own design — not in v1.

---

## 7. Routing + persistence

### Route

Add to `apps/web/src/router.tsx:64-99`:

```tsx
{ path: "/studio", element: <StudioView /> },
```

`StudioView` is a new file at `apps/web/src/views/StudioView.tsx`. It mounts `<StudioProvider>`, registers the 6 panes, and renders the 3-column grid + header + status bar.

### Persistence

- Layout preset (`wide` / `compact` / `sidebar-left`) → localStorage `omp-deck:studio:layout-preset`
- Per-pane chrome overrides (e.g. "KB pane collapsed sidebar") → localStorage `omp-deck:studio:<paneId>:chrome` (JSON)
- Tooltip expanded preference → localStorage `omp-deck:studio:tooltip:expanded-hotkey`
- Catalog version drift marker → localStorage `omp-deck:studio:catalog-version-seen`

### Deep links

URL query params:

- `?pane=kb` — focus the KB pane (highlight border, scroll into view)
- `?pane=kb&focus=nodeId` — focus a specific node within the KB pane (the studio's `focusPane` callback reads this and dispatches)
- `?preset=compact` — override preset for this load only

The URL IS the studio's state — copy/paste a deep link and the recipient opens the same view.

---

## 8. Risks & non-goals (v1)

**Non-goals** (deferred to v1.1+):

- Plugin API for tooltips / menus — hard-coded catalog only.
- Drag-to-rearrange panes — preset layouts only.
- AI-suggested context menu items (e.g. "Refactor this with the active agent").
- Cross-pane drag (drop a KB file onto the composer to attach).
- Persistent-overlay mode (where studio panes survive navigation).
- Full command-palette shortcut overlay.

**Risks**:

- **Catalog staleness**: a new tool or route added without catalog entry. Mitigation: every catalog key is grep-able; CI lint scans `KNOWN_TOOLS`, route prefixes, `BridgeName`, `NotificationLevel` against the catalog and fails the build if drift exists.
- **Action safety**: every destructive action requires confirm. No undo path in v1 — confirm is the safety net.
- **Performance**: 6 panes × listeners × WS frames. Mitigation: panes are lazy-mounted behind `IntersectionObserver`; only visible panes subscribe. KB + tasks each have their own change counter — already cheap.
- **a11y regression**: the deck today uses native `title=` attributes (`ConnectionIndicator.tsx:86`). Keep them — `<Tooltipify>` should not strip `title`, it should layer on top of it.
- **Style drift**: the studio reuses existing Tailwind tokens (`bg-paper-2`, `text-ink-2`, `border-line`, `font-mono`). No new design tokens added.
- **Portal escape**: a naive `position: absolute` tooltip can clip inside overflow-hidden containers. Always `position: fixed` from `document.body`.

---

## 9. Implementation sequence for the executor

Twelve steps. Group: **A** = additive/safe, **B** = behavior. The catalog seed is one big step (don't scatter).

### A — additive (steps 1–7)

1. **Create the catalog file with ALL seed entries in one shot.**
   - New file: `apps/web/src/lib/studio/tooltip-catalog.ts`.
   - Export `TOOLTIP_CATALOG_VERSION = 1`, `TOOLTIPS` (~80 entries), `MENUS` (~30 entries).
   - Reuse prose from view-file docblocks (`GholamView.tsx:1-13`, `KbView.tsx:36-43`, `TasksView.tsx`'s top docblock when present).
   - Cover every `KNOWN_TOOLS` entry, every router path, every `BridgeName`, every `NotificationLevel`, every server route prefix inventoried from `apps/server/src/routes.ts`.
   - Hard floor: zero unknown tooltips in `/studio`. If you can't reach it, add a `[STUDIO-SEED]` comment block at the top of the file listing every unseeded target with its CSS selector and the heuristic that covers it.
   - This step is the keystone — every later step imports from here.

2. **Create the tooltip singleton.**
   - New file: `apps/web/src/lib/studio/tooltip.ts`.
   - Exports the `Tooltip` singleton (API in §2) plus a `TooltipSurface` React component that mounts the portal.
   - Resolution order (a→e) lives here. Heuristic lives here. No DOM mutation outside `document.body`.

3. **Create the React wrapper.**
   - New file: `apps/web/src/lib/studio/Tooltipify.tsx`.
   - One component, ~30 lines. Clones the child, attaches hover/focus/keydown listeners, calls `Tooltip.show({ rect })` with the resolved key.
   - Default: pass-through. Opt-out via `disabled`.

4. **Create the context-menu registry + singleton.**
   - New file: `apps/web/src/lib/studio/context-menu.ts`.
   - Exports the `ContextMenu` singleton (API in §3) plus `ContextMenuSurface` portal component.
   - Resolution order (item → type → family → namespace → global fallback).
   - Global fallback lives in the same file, always non-empty.

5. **Create the StudioProvider.**
   - New file: `apps/web/src/lib/studio/StudioProvider.tsx`.
   - Exposes the `register` API and the layout context.
   - Reads preset from localStorage at mount; persists on change.

6. **Add `/studio` route.**
   - Edit: `apps/web/src/router.tsx`.
   - Add `import { StudioView } from "./views/StudioView";`
   - Add `{ path: "/studio", element: <StudioView /> }` to the routes array (alongside `/chat`/`/tasks`/etc.).

7. **Wire StudioProvider at the app root.**
   - Edit: `apps/web/src/App.tsx`.
   - Wrap `<AppRouter />` with `<StudioProvider>` (or mount inside `<AuthedApp>` after the existing effects).
   - Mount `<TooltipSurface />` and `<ContextMenuSurface />` once, near the toast surface.

### B — behavior (steps 8–12)

8. **Create `StudioView` with the 3-column grid.**
   - New file: `apps/web/src/views/StudioView.tsx`.
   - Uses `StudioProvider`'s `panes` map. Six hard-coded pane registrations inline (the executor may extract these to `apps/web/src/lib/studio/panes.ts`).
   - Header + status bar render at top/bottom.

9. **Embed existing views as panes.**
   - In each pane's `render` function: import the view component, render with `readOnly` prop where applicable.
   - For `composer`: import `ChatView`'s body but skip its `<Layout>` chrome (extract to a `<ChatBody>` subcomponent if needed — keep this surgical).

10. **Hook up deep links.**
    - In `StudioView`: read `useSearchParams`, call `focusPane(id)` on mount and on param change.
    - In `StudioProvider`: expose `focusPane` that scrolls into view and applies an accent border pulse for 1.2s.

11. **Seed menu descriptors for the highest-value targets.**
    - `kb.commit-graph.vertex`, `kb.file`, `composer.attachment`, `gholam.priority`, `tasks.card`, `tasks.column`, `bridge.telegram`, `studio.statusbar.badge`.
    - Each in the catalog. Each calls existing APIs (`api.kb.*`, `api.gholam.*`, `api.tasks.*`, etc.) — no new server routes.

12. **a11y + reduced-motion pass + lint.**
    - Run axe-core against `/studio`; fix any contrast/keyboard violations.
    - Add a CI lint script (`apps/web/scripts/lint-studio-catalog.ts`) that asserts every router path, `KNOWN_TOOLS` entry, `BridgeName`, and `NotificationLevel` has a matching catalog entry. Wire to `pnpm lint` or equivalent.
    - Smoke-test: hover every interactive element in `/studio`, confirm tooltip appears; right-click, confirm menu appears; reduced-motion ON, confirm fade is skipped; keyboard-only, confirm Tab focuses a button and its tooltip announces; mobile viewport, long-press opens the menu.

---

verified:

**READ in full:**
- `apps/web/src/App.tsx` (94 lines)
- `apps/web/src/router.tsx` (103 lines, including routes table at 64-99 and OnboardingGate at 43-62)
- `apps/web/src/views/GholamView.tsx` (lines 1-163 + Layout props region 101-160)
- `apps/web/src/views/KbView.tsx` (structural summary of 1226 lines — declarations + imports; full prose of header docblock 1-43)
- `apps/web/src/views/TasksView.tsx` (full file head + structural summary of 499 lines)
- `apps/web/src/lib/store.ts` (lines 1-300 of 669 — full type/header; elided tail is action bodies only, not relevant)
- `apps/web/src/lib/ws.ts` (full file 121 lines)
- `apps/web/src/components/Layout.tsx` (full file 162 lines)
- `apps/web/src/styles.css` (lines 1-65, 410-720 — theme tokens + GholamOverlay panel anchoring pattern)
- `packages/protocol/src/index.ts` (lines 1098-1118 for `KNOWN_TOOLS`; 882-1078 for `ServerFrame`; 813-878 for `ClientFrame`; 1067-1093 for notification types; 200-230 for `BridgeName`/`BridgeStatus`)

**Used summaries for:**
- `apps/web/src/views/KbView.tsx` body components (TreeBranch, TreeDir, KbFilePane, KbInspector) — only needed as confirmation that KB has rich right-clickable surface area; not modified in this design.
- `apps/web/src/views/TasksView.tsx` body (Column, TaskCardBody, TaskModal) — same reason.
- `apps/web/src/lib/store.ts` tail (lines 301-669) — action implementations; only the chrome state slice (sidebarOpen, inspectorOpen) was needed and that's in the head.
- `apps/server/src/routes.ts` — listed by grep only (route prefixes); not read line-by-line. Inventory captured: `/health`, `/version`, `/workspaces`, `/sessions`, `POST /sessions`, `/sessions/:id/abort`, `/sessions/:id/compact`, `PATCH /sessions/:id`, `/models`, `DELETE /sessions/:id`.

**No external search needed** — no Radix vs HTML5 `<menu>` question arose; the design rolls a custom portal (consistent with the deck's existing `GholamOverlay` pattern in `styles.css:594-660`).
