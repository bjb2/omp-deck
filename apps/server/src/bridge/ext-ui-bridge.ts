/**
 * Per-session bridge from the omp SDK's `ExtensionUIContext` surface to the
 * deck's WebSocket protocol.
 *
 * The SDK's `ask` tool (and any extension calling `ctx.ui.select / editor /
 * confirm / input`) ends up here. Each call:
 *
 *   1. Generates a `dialogId` and publishes an `ext_ui_dialog_open` frame to
 *      every WS client currently subscribed to this session.
 *   2. Returns a Promise that the bridge resolves when the matching
 *      `ext_ui_dialog_response` arrives, when `signal` aborts, when the
 *      server-side timeout fires, or when the session is disposed.
 *
 * The dialog frames are buffered: a client that subscribes mid-dialog (page
 * reload, second tab opened) receives the current pending dialogs immediately
 * so the modal renders without waiting for another agent emit.
 *
 * Reference impls in the SDK:
 *   - `@oh-my-pi/pi-coding-agent/src/modes/rpc/rpc-mode.ts` (RPC bridge)
 *   - `@oh-my-pi/pi-coding-agent/src/modes/acp/acp-agent.ts` (ACP bridge)
 */
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionUiComponentFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	TerminalInputHandler,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import type { ExtUiDialogResponse, ServerFrame } from "@omp-deck/protocol";

import { logger } from "../log.ts";

const log = logger("bridge:ext-ui");

type DialogOpenFrame = Extract<ServerFrame, { type: "ext_ui_dialog_open" }>;
type DialogCancelFrame = Extract<ServerFrame, { type: "ext_ui_dialog_cancel" }>;

interface PendingDialog {
	/** The frame originally broadcast — re-sent verbatim on late subscribe. */
	frame: DialogOpenFrame;
	/** Resolve the SDK-facing promise with the user's answer. */
	settle: (response: ExtUiDialogResponse) => void;
	/** Triggered by signal abort / session dispose / server timeout. */
	cancel: (reason: DialogCancelFrame["reason"]) => void;
}

/** Listener over server-bound UI frames for one session. */
type FrameListener = (frame: DialogOpenFrame | DialogCancelFrame) => void;

/**
 * Per-session implementation of `ExtensionUIContext`. Only the dialog-shaped
 * methods (`select`, `editor`, `confirm`, `input`) round-trip to the client;
 * the rest are no-ops (or minimal best-effort) because the deck UI doesn't
 * expose a TUI-style component surface.
 */
export class ExtensionUIBridge implements ExtensionUIContext {
	private readonly sessionId: string;
	private readonly pending = new Map<string, PendingDialog>();
	private readonly listeners = new Set<FrameListener>();
	private nextDialogId = 1;
	private disposed = false;

	/**
	 * v17 added `addAutocompleteProvider` to ExtensionUIContext. The deck
	 * doesn't render a TUI autocomplete, so this is a no-op stub.
	 */
	addAutocompleteProvider(_provider: unknown): void {
		// No-op: the web UI doesn't host a slash-command autocomplete that
		// extension tools would inject into. Left here so the structural
		// `implements` check stays satisfied.
	}

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	// ─── Public bridge surface (consumed by InProcessAgentBridge / WsHub) ─

	/** Snapshot of currently-open dialog frames — re-sent to late subscribers. */
	getPendingFrames(): DialogOpenFrame[] {
		const out: DialogOpenFrame[] = [];
		for (const p of this.pending.values()) out.push(p.frame);
		return out;
	}

	/** Subscribe to dialog open/cancel frames. */
	subscribeFrames(listener: FrameListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Handle a client-side `ext_ui_dialog_response` frame. */
	handleResponse(dialogId: string, response: ExtUiDialogResponse): void {
		const entry = this.pending.get(dialogId);
		if (!entry) {
			log.debug(`response for unknown dialog ${dialogId} (already settled)`);
			return;
		}
		entry.settle(response);
	}

	/** Cancel every open dialog. Caller chooses why. */
	cancelAllPending(reason: DialogCancelFrame["reason"]): void {
		const ids = Array.from(this.pending.keys());
		for (const id of ids) {
			const entry = this.pending.get(id);
			if (entry) entry.cancel(reason);
		}
	}

	/** Drop all state and disable future calls. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelAllPending("session_disposed");
		this.listeners.clear();
	}

	// ─── ExtensionUIContext: dialog methods (real implementations) ────────

	select(
		prompt: string,
		options: string[],
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		const fields: Pick<DialogOpenFrame, "options"> = { options };
		return this.openDialog<string | undefined>(
			{ kind: "select", prompt, ...fields },
			dialogOptions,
			undefined,
			(resp) => {
				if (resp.cancelled) return undefined;
				if (typeof resp.value === "string") return resp.value;
				return undefined;
			},
		);
	}

	confirm(
		prompt: string,
		message: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		return this.openDialog<boolean>(
			{ kind: "confirm", prompt, message },
			dialogOptions,
			false,
			(resp) => {
				if (resp.cancelled) return false;
				if (typeof resp.confirmed === "boolean") return resp.confirmed;
				return false;
			},
		);
	}

	input(
		prompt: string,
		placeholder?: string,
		dialogOptions?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return this.openDialog<string | undefined>(
			{ kind: "input", prompt, ...(placeholder !== undefined ? { placeholder } : {}) },
			dialogOptions,
			undefined,
			(resp) => {
				if (resp.cancelled) return undefined;
				if (typeof resp.value === "string") return resp.value;
				return undefined;
			},
		);
	}

	editor(
		title: string,
		prefill?: string,
		dialogOptions?: ExtensionUIDialogOptions,
		editorOptions?: { promptStyle?: boolean },
	): Promise<string | undefined> {
		const extra: Partial<DialogOpenFrame> = {};
		if (prefill !== undefined) extra.prefill = prefill;
		if (editorOptions?.promptStyle) extra.promptStyle = true;
		return this.openDialog<string | undefined>(
			{ kind: "editor", prompt: title, ...extra },
			dialogOptions,
			undefined,
			(resp) => {
				if (resp.cancelled) return undefined;
				if (typeof resp.value === "string") return resp.value;
				return undefined;
			},
		);
	}

	// ─── ExtensionUIContext: out-of-scope surface (no-ops) ────────────────
	//
	// The deck doesn't expose a TUI component surface, custom editor / footer /
	// header / widget API, or raw terminal input listeners. The interface
	// still requires these methods; we provide harmless no-ops so any
	// extension that calls them keeps running rather than throwing.

	notify(message: string, type?: "info" | "warning" | "error"): void {
		log.info(`ui.notify [${type ?? "info"}]: ${message}`);
	}

	onTerminalInput(_handler: TerminalInputHandler): () => void {
		return () => {};
	}

	setStatus(_key: string, _text: string | undefined): void {}

	setWorkingMessage(_message?: string): void {}

	setWidget(_key: string, _content: ExtensionWidgetContent, _options?: ExtensionWidgetOptions): void {}

	setFooter(_factory: ExtensionUiComponentFactory | undefined): void {}

	setHeader(_factory: ExtensionUiComponentFactory | undefined): void {}

	setTitle(_title: string): void {}

	async custom<T>(): Promise<T> {
		// Custom TUI components aren't representable in the deck UI.
		return undefined as T;
	}

	setEditorText(_text: string): void {}

	pasteToEditor(_text: string): void {}

	getEditorText(): string {
		return "";
	}

	setEditorComponent(_factory: unknown): void {}

	get theme(): never {
		// Extensions that read `ctx.ui.theme` in the deck context need to be
		// updated; rather than ship a fake Theme that lies about color codes,
		// throw so the caller knows it's unsupported here.
		throw new Error("ExtensionUIBridge.theme is not available in deck mode");
	}

	getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
		return Promise.resolve([]);
	}

	getTheme(_name: string): Promise<undefined> {
		return Promise.resolve(undefined);
	}

	setTheme(_theme: unknown): Promise<{ success: boolean; error?: string }> {
		return Promise.resolve({ success: false, error: "Theme switching is not supported in deck mode" });
	}

	getToolsExpanded(): boolean {
		return false;
	}

	setToolsExpanded(_expanded: boolean): void {}

	// ─── Internal dialog wiring ───────────────────────────────────────────

	/**
	 * Common path for every dialog-shaped method. Generates the frame,
	 * publishes it, registers a pending entry keyed by `dialogId`, and wires
	 * `signal` / `timeout` / `dispose` into the matching cancellation paths.
	 *
	 * `parseResponse` maps the raw client response into the SDK-shaped return
	 * value for the calling method.
	 */
	private openDialog<T>(
		partial: Pick<DialogOpenFrame, "kind" | "prompt"> & Partial<DialogOpenFrame>,
		dialogOptions: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		parseResponse: (resp: ExtUiDialogResponse) => T,
	): Promise<T> {
		if (this.disposed) return Promise.resolve(defaultValue);
		if (dialogOptions?.signal?.aborted) return Promise.resolve(defaultValue);

		const dialogId = this.allocateDialogId();
		const timeoutMs = typeof dialogOptions?.timeout === "number" ? dialogOptions.timeout : undefined;

		const frame: DialogOpenFrame = {
			type: "ext_ui_dialog_open",
			sessionId: this.sessionId,
			dialogId,
			kind: partial.kind,
			prompt: partial.prompt,
			...(partial.options !== undefined ? { options: partial.options } : {}),
			...(partial.multi !== undefined ? { multi: partial.multi } : {}),
			...(partial.initialIndex !== undefined ? { initialIndex: partial.initialIndex } : {}),
			...(partial.recommended !== undefined ? { recommended: partial.recommended } : {}),
			...(partial.helpText !== undefined ? { helpText: partial.helpText } : {}),
			...(partial.message !== undefined ? { message: partial.message } : {}),
			...(partial.placeholder !== undefined ? { placeholder: partial.placeholder } : {}),
			...(partial.prefill !== undefined ? { prefill: partial.prefill } : {}),
			...(partial.promptStyle !== undefined ? { promptStyle: partial.promptStyle } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		};

		return new Promise<T>((resolve) => {
			let settled = false;
			let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

			const cleanup = (): void => {
				if (timeoutTimer) clearTimeout(timeoutTimer);
				dialogOptions?.signal?.removeEventListener("abort", onAbort);
				this.pending.delete(dialogId);
			};

			const finish = (value: T): void => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			};

			const settle = (resp: ExtUiDialogResponse): void => {
				if (settled) return;
				if (resp.timedOut) dialogOptions?.onTimeout?.();
				try {
					finish(parseResponse(resp));
				} catch (err) {
					log.warn(`dialog ${dialogId} parseResponse threw`, err);
					finish(defaultValue);
				}
			};

			const cancel = (reason: DialogCancelFrame["reason"]): void => {
				if (settled) return;
				this.emit({
					type: "ext_ui_dialog_cancel",
					sessionId: this.sessionId,
					dialogId,
					reason,
				});
				if (reason === "timeout") dialogOptions?.onTimeout?.();
				finish(defaultValue);
			};

			const onAbort = (): void => cancel("aborted");
			dialogOptions?.signal?.addEventListener("abort", onAbort, { once: true });

			if (timeoutMs !== undefined && timeoutMs > 0) {
				timeoutTimer = setTimeout(() => cancel("timeout"), timeoutMs);
			}

			this.pending.set(dialogId, { frame, settle, cancel });
			this.emit(frame);
		});
	}

	private emit(frame: DialogOpenFrame | DialogCancelFrame): void {
		for (const listener of this.listeners) {
			try {
				listener(frame);
			} catch (err) {
				log.warn(`UI frame listener threw`, err);
			}
		}
	}

	private allocateDialogId(): string {
		// Locally-monotonic ids scoped to the session keep wire frames short
		// and debuggable. The session id makes them globally unique across
		// the deck.
		const id = `d_${this.sessionId}_${this.nextDialogId}`;
		this.nextDialogId += 1;
		return id;
	}
}
