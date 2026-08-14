import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ClipboardEvent,
	type DragEvent,
	type KeyboardEvent,
} from "react";
import type { FilePathMatch, SlashCommand } from "@omp-deck/protocol";

import { api } from "@/lib/api";
import { FilePathPicker } from "@/components/composer/FilePathPicker";
import { Paperclip, ArrowUp, Square, X } from "lucide-react";
import type { ImageAttachment, PromptRecommendation } from "@omp-deck/protocol";

import { SlashCommandPicker } from "@/components/composer/SlashCommandPicker";
import { PromptSuggestions } from "@/components/PromptSuggestions";

import { selectActiveSession, useStore } from "@/lib/store";
import { useComposerHistory } from "@/lib/use-composer-history";
import { cn } from "@/lib/utils";

interface PendingImage extends ImageAttachment {
	id: string;
	preview: string;
}

const MAX_PENDING_IMAGES = 8;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Per-cwd cache of discovered slash commands so re-mounting the composer
 * (route change between Chat / Tasks / etc., HMR) doesn't re-fetch. The
 * server response is cheap, but in dev the network panel filling up with
 * `/api/slash-commands` calls on every Vite reload is noise.
 */
const slashCommandsCache = new Map<string, SlashCommand[]>();

export function Composer() {
	const session = useStore(selectActiveSession);
	const sendPrompt = useStore((s) => s.sendPrompt);
	const abort = useStore((s) => s.abort);
	const clearQueue = useStore((s) => s.clearQueue);
	const setPlanMode = useStore((s) => s.setPlanMode);
	const planModeEnabled = session?.planMode?.enabled ?? false;
	const pendingDraft = useStore((s) => s.pendingDraft);
	const setPendingDraft = useStore((s) => s.setPendingDraft);
	const queuedCount = session?.queuedPrompts.length ?? 0;
	const [draft, setDraft] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [dragOver, setDragOver] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const imagesRef = useRef<PendingImage[]>([]);
	imagesRef.current = images;

	// ─── Slash commands ─────────────────────────────────────────────────────
	//
	// Picker fetches commands on session-cwd change, deduped via a module-local
	// cache so re-mounting the composer (route change, hot reload) doesn't
	// re-hit the server. Selection index is owned here so the textarea's
	// keydown handler can drive Arrow / Enter / Tab / Esc without the picker
	// having to wire its own listeners onto window.
	const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);
	const [slashSelected, setSlashSelected] = useState(0);
	const sessionCwd = session?.cwd;

	// ─── Prompt history (T-10) ──────────────────────────────────────────────
	//
	// Mirrors the omp TUI's ArrowUp recall. Keyed by sessionCwd so two windows
	// pointed at different repos do not share history. The hook itself is
	// stable across renders; we only need to know when the recall replaces the
	// draft to update caret + autoresize.
	const history = useComposerHistory(sessionCwd);

	useEffect(() => {
		if (!sessionCwd) {
			setSlashCommands([]);
			return;
		}
		const cached = slashCommandsCache.get(sessionCwd);
		if (cached) {
			setSlashCommands(cached);
			return;
		}
		let cancelled = false;
		void api
			.listSlashCommands(sessionCwd)
			.then((res) => {
				if (cancelled) return;
				slashCommandsCache.set(sessionCwd, res.commands);
				setSlashCommands(res.commands);
			})
			.catch((err) => {
				if (!cancelled) console.warn("listSlashCommands failed", err);
			});
		return () => {
			cancelled = true;
		};
	}, [sessionCwd]);

	// Derived state — the textarea draft tells us whether the picker is active.
	// Active means the draft starts with "/" and the user hasn't yet typed a
	// space (which would mean they're typing arguments to an already-chosen
	// command, not searching for a command name).
	const slashQuery = useMemo<string | null>(() => {
		if (!draft.startsWith("/")) return null;
		const afterSlash = draft.slice(1);
		// Once whitespace appears, the user is past the command name. Hide.
		if (/\s/.test(afterSlash)) return null;
		return afterSlash;
	}, [draft]);

	// Client-side virtual slash commands. Routed back to store actions
	// instead of being sent over the WS as text. The bridge can't see
	// them, which is fine — they're UI shortcuts, not agent prompts.
	const virtualSlashCommands = useMemo<SlashCommand[]>(
		() => [
			{
				name: "plan",
				scope: "deck",
				description: planModeEnabled
					? "Exit plan mode (or Shift+Tab)"
					: "Enter plan mode — agent reads + proposes only (or Shift+Tab)",
				argumentHint: "[on|off]",
			},
			{
				name: "ultrathink",
				scope: "deck",
				description: "Deep-reason the prompt — fires the active session with reasoning-effort = high.",
				argumentHint: "<prompt>",
			},
			{
				name: "workflowz",
				scope: "deck",
				description: "Fan out a 3-way parallel workflow (primary + critique + alternate + synthesize).",
				argumentHint: "<prompt>",
			},
			{
				name: "orchestrate",
				scope: "deck",
				description: "Run as an orchestrator agent — plan, delegate, synthesize.",
				argumentHint: "<prompt>",
			},
			{
				name: "login",
				scope: "deck",
				description: "Sign in to a provider (omni / anthropic / openai / openrouter / custom).",
				argumentHint: "<provider> <subscription-key>",
			},
			{
				name: "restart",
				scope: "deck",
				description: "Restart the omp-deck server.",
				argumentHint: "",
			},
		],
		[planModeEnabled],
	);

	const allSlashCommands = useMemo(
		() => [...virtualSlashCommands, ...slashCommands],
		[virtualSlashCommands, slashCommands],
	);

	const filteredSlash = useMemo(() => {
		if (slashQuery === null) return [];
		if (allSlashCommands.length === 0) return [];
		const q = slashQuery.toLowerCase();
		if (q === "") return allSlashCommands;
		// Prefix match wins over substring match so typing the start of a name
		// surfaces the obvious candidate at the top.
		const prefix: SlashCommand[] = [];
		const substr: SlashCommand[] = [];
		for (const c of allSlashCommands) {
			const n = c.name.toLowerCase();
			if (n.startsWith(q)) prefix.push(c);
			else if (n.includes(q)) substr.push(c);
		}
		return [...prefix, ...substr];
	}, [slashQuery, allSlashCommands]);

	// Reset highlighted row whenever the candidate list changes so we don't
	// point at an index that's been filtered out.
	useEffect(() => {
		setSlashSelected(0);
	}, [filteredSlash]);

	const slashOpen = slashQuery !== null && filteredSlash.length > 0;
	const disabled = !session;
	const isBusy = session?.status === "streaming" || session?.status === "retrying";

	const autoresize = useCallback((): void => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(280, ta.scrollHeight)}px`;
	}, []);

	// ─── @filepath mention picker ──────────────────────────────────────────
	//
	// The composer activates a path-autocomplete dropdown whenever the caret
	// sits inside an `@<token>` mention. Unlike the slash picker (anchored at
	// draft start), `@` mentions can appear anywhere in the message and any
	// number of times. Trigger range = the latest unterminated `@...` ending
	// at `caretPos`; closing the mention requires whitespace or a second `@`.
	const [pathMatches, setPathMatches] = useState<FilePathMatch[]>([]);
	const [pathSelected, setPathSelected] = useState(0);
	const [caretPos, setCaretPos] = useState(0);
	const lastFetchRef = useRef(0);

	// ─── Prompt suggestions + {{ autocomplete ────────────────────────────────
	//
	// `<PromptSuggestions />` mounts when the composer is focused, the draft
	// is empty, and 5s have passed since the last keystroke. The 5s idle
	// timer is reset on every draft change; cleared on send/dismiss.
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const lastEditRef = useRef(Date.now());
	const [variableCandidates, setVariableCandidates] = useState<string[]>([]);
	const [variableSelected, setVariableSelected] = useState(0);

	useEffect(() => {
		// Tick once per second; flip the suggestions panel on when the
		// composer has been idle for ≥ 5s and is empty. Once the user
		// types, lastEditRef resets and the panel hides again.
		const t = window.setInterval(() => {
			if (!taRef.current) return;
			const empty = draft.trim().length === 0 && images.length === 0;
			const idle = Date.now() - lastEditRef.current >= 5000;
			setSuggestionsOpen(empty && idle);
		}, 1000);
		return () => window.clearInterval(t);
	}, [draft, images]);

	// `{{<token>` mention — same shape as the file-path picker but sourced
	// from the cached prompt library's union of `variables[]`. The chip
	// shows when the caret sits inside an unterminated `{{ ... `.
	const variableRange = useMemo<{ start: number; end: number; token: string } | null>(() => {
		const before = draft.slice(0, caretPos);
		const m = before.match(/\{\{\s*([a-zA-Z_][\w.-]*)$/);
		if (!m) return null;
		const token = m[1] ?? "";
		const start = caretPos - token.length - 2; // index of the opening `{{`
		return { start, end: caretPos, token };
	}, [draft, caretPos]);

	const promptsLibraryLocal = useStore((s) => s.promptsLibrary);
	const variableRangeToken = variableRange?.token;

	useEffect(() => {
		if (!variableRange) {
			setVariableCandidates([]);
			return;
		}
		const set = new Set<string>();
		for (const p of promptsLibraryLocal) {
			for (const v of p.variables ?? []) set.add(v);
		}
		const all = [...set].sort();
		const q = variableRange.token.toLowerCase();
		const filtered = q ? all.filter((v) => v.toLowerCase().includes(q)) : all;
		setVariableCandidates(filtered.slice(0, 12));
		setVariableSelected(0);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [variableRangeToken, promptsLibraryLocal]);

	const pickVariable = useCallback(
		(name: string): void => {
			if (!variableRange) return;
			setDraft((prev) => {
				const before = prev.slice(0, variableRange.start);
				const after = prev.slice(variableRange.end);
				return `${before}{{${name}}}${after}`;
			});
			queueMicrotask(() => {
				const ta = taRef.current;
				if (!ta) return;
				const pos = variableRange.start + name.length + 4; // `{{name}}` len
				ta.setSelectionRange(pos, pos);
				setCaretPos(pos);
				ta.focus();
				autoresize();
			});
		},
		[autoresize, variableRange],
	);

	const onSuggestionPick = useCallback(
		(rec: PromptRecommendation): void => {
			// Insert the prompt body at the caret (overwriting any partial draft).
			setDraft(rec.prompt.body);
			useStore.getState().promptUsageBump(rec.prompt.id);
			setSuggestionsOpen(false);
			queueMicrotask(() => {
				const ta = taRef.current;
				if (!ta) return;
				const end = rec.prompt.body.length;
				ta.setSelectionRange(end, end);
				setCaretPos(end);
				ta.focus();
				autoresize();
			});
		},
		[autoresize],
	);



	interface MentionRange {
		token: string;
		rangeStart: number; // index of the `@`
		rangeEnd: number; // caret position
	}
	const mentionRange = useMemo<MentionRange | null>(() => {
		// Only the *last* `@token` before the caret matters; later text past
		// caret is preserved as suffix on pick.
		const before = draft.slice(0, caretPos);
		const m = before.match(/(^|[^\\])@([^\s@]*)$/);
		if (!m) return null;
		const token = m[2] ?? "";
		const rangeStart = caretPos - token.length - 1; // index of the `@`
		return { token, rangeStart, rangeEnd: caretPos };
	}, [draft, caretPos]);

	useEffect(() => {
		if (!sessionCwd || !mentionRange) {
			setPathMatches([]);
			return;
		}
		// Debounce so fast typing doesn't fire one fetch per keystroke; the
		// server's inventory is cached but the network round-trip still costs.
		const fetchAt = Date.now();
		lastFetchRef.current = fetchAt;
		const handle = window.setTimeout(() => {
			void api
				.completeFilePath(sessionCwd, mentionRange.token, 20)
				.then((res) => {
					// Discard if a newer keystroke superseded this fetch.
					if (lastFetchRef.current !== fetchAt) return;
					setPathMatches(res.matches);
				})
				.catch((err) => {
					if (lastFetchRef.current === fetchAt) console.warn("completeFilePath failed", err);
				});
		}, 80);
		return () => window.clearTimeout(handle);
	}, [sessionCwd, mentionRange?.token]); // eslint-disable-line react-hooks/exhaustive-deps

	useEffect(() => {
		setPathSelected(0);
	}, [pathMatches]);

	const pathOpen = mentionRange !== null && pathMatches.length > 0;

	const pickFilePath = useCallback(
		(match: FilePathMatch): void => {
			if (!mentionRange) return;
			// Replace `@<token>` with `@<chosen> ` (trailing space mirrors slash
			// picker so the user can keep typing without a manual gap). For
			// directories include a trailing slash so subsequent typing
			// continues the path naturally — `@apps/web/src/co<Tab>` lands at
			// `@apps/web/src/components/` and you can keep narrowing.
			const suffix = match.isDir ? "" : " ";
			const insertion = `@${match.path}${match.isDir ? "/" : ""}${suffix}`;
			setDraft((prev) => {
				const before = prev.slice(0, mentionRange.rangeStart);
				const after = prev.slice(mentionRange.rangeEnd);
				return `${before}${insertion}${after}`;
			});
			queueMicrotask(() => {
				const ta = taRef.current;
				if (!ta) return;
				const pos = mentionRange.rangeStart + insertion.length;
				ta.setSelectionRange(pos, pos);
				setCaretPos(pos);
				ta.focus();
				autoresize();
			});
		},
		[autoresize, mentionRange],
	);

	/**
	 * Intercept client-side virtual slash commands (`/plan`, future ones).
	 * Returns true when the command was handled and the caller should NOT
	 * fall through to either drafting the command into the textarea or
	 * sending it as a prompt over the WS.
	 *
	 * Accepts `args` separately so the same routing works both for
	 * picker-clicks (no args yet) and for `send()` (caller parses
	 * `/plan on` etc. and passes `"on"`).
	 */
	const dispatchVirtualCommand = useCallback(
		(name: string, args: string): boolean => {
			if (name === "plan") {
				if (!session) return true; // swallow with no-op when no session
				const arg = args.trim().toLowerCase();
				if (arg === "on") setPlanMode(true);
				else if (arg === "off") setPlanMode(false);
				else setPlanMode(!planModeEnabled);
				return true;
			}
			if (name === "ultrathink") {
				const prompt = args.trim();
				if (!prompt || !session) return true;
				// v0.7+: dispatch via /api/workflows with mode=ultrathink and the active session id.
				void fetch("/api/workflows", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode: "ultrathink", tasks: [{ prompt, cwd: session.cwd }] }),
				}).catch(() => {});
				return true;
			}
			if (name === "workflowz" || name === "orchestrate") {
				const prompt = args.trim();
				if (!prompt || !session) return true;
				void fetch("/api/workflows", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode: name, tasks: [{ prompt, cwd: session.cwd }] }),
				}).catch(() => {});
				return true;
			}
			if (name === "restart") {
				void fetch("/api/system/lifecycle", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "restart" }),
				}).catch(() => {});
				return true;
			}
			if (name === "login") {
				// /login <provider> <key> — forward to /api/auth/login.
				const parts = args.trim().split(/\s+/);
				const provider = parts[0];
				const key = parts.slice(1).join(" ");
				if (!provider || !key) return true;
				void fetch("/api/auth/login", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ provider, subscriptionKey: key }),
				}).catch(() => {});
				return true;
			}
			return false;
		},
		[session, planModeEnabled, setPlanMode],
	);

	const pickSlashCommand = useCallback(
		(cmd: SlashCommand): void => {
			// Virtual commands fire on pick and clear the draft — they take no
			// args today, and the user has already telegraphed intent by
			// clicking. Falling through to the draft-fill path would force
			// them to also press Enter for no reason.
			if (dispatchVirtualCommand(cmd.name, "")) {
				setDraft("");
				const ta = taRef.current;
				if (ta) ta.style.height = "auto";
				queueMicrotask(() => taRef.current?.focus());
				return;
			}
			// Replace the entire leading slash token with the chosen command name
			// and a trailing space. Preserve any whitespace-bounded remainder
			// (rare — slashQuery !== null guarantees no internal space, but the
			// draft could still have a newline if we relax the rule later).
			setDraft((prev) => {
				const rest = prev.startsWith("/") ? prev.slice(1).match(/\s.*$/s)?.[0] ?? "" : "";
				return `/${cmd.name} ${rest.trimStart()}`;
			});
			queueMicrotask(() => {
				const ta = taRef.current;
				if (!ta) return;
				const pos = cmd.name.length + 2; // `/name ` length
				ta.setSelectionRange(pos, pos);
				ta.focus();
				autoresize();
			});
		},
		[autoresize, dispatchVirtualCommand],
	);

	// Pull a pending draft (set by Tasks "Open in chat") into the composer
	// exactly once. Defer to allow autoresize to settle.
	useEffect(() => {
		if (!pendingDraft) return;
		setDraft(pendingDraft.text);
		setPendingDraft(undefined);
		queueMicrotask(() => {
			autoresize();
			taRef.current?.focus();
		});
	}, [pendingDraft, setPendingDraft, autoresize]);

	const insertAtCursor = useCallback(
		(insert: string): void => {
			const ta = taRef.current;
			if (!ta) {
				setDraft((prev) => prev + insert);
				return;
			}
			const start = ta.selectionStart ?? ta.value.length;
			const end = ta.selectionEnd ?? ta.value.length;
			setDraft((prev) => {
				const before = prev.slice(0, start);
				const after = prev.slice(end);
				const next = `${before}${insert}${after}`;
				queueMicrotask(() => {
					const pos = start + insert.length;
					ta.setSelectionRange(pos, pos);
					ta.focus();
					autoresize();
				});
				return next;
			});
		},
		[autoresize],
	);

	const addImageFile = useCallback(
		async (file: File): Promise<void> => {
			if (!file || !file.type.startsWith("image/")) return;
			if (file.size > MAX_IMAGE_BYTES) {
				console.warn(`image too large: ${file.size} bytes`);
				return;
			}
			if (imagesRef.current.length >= MAX_PENDING_IMAGES) return;

			const data = await fileToBase64(file);
			const mimeType = file.type || "image/png";
			const preview = `data:${mimeType};base64,${data}`;

			const newImage: PendingImage = {
				id: crypto.randomUUID(),
				type: "image",
				data,
				mimeType,
				preview,
			};
			const placeholderIndex = imagesRef.current.length + 1;
			imagesRef.current = [...imagesRef.current, newImage];
			setImages(imagesRef.current);
			insertAtCursor(`[Image #${placeholderIndex}] `);
		},
		[insertAtCursor],
	);

	const ingestFiles = useCallback(
		async (files: FileList | File[]): Promise<void> => {
			for (const f of Array.from(files)) {
				if (f.type.startsWith("image/")) await addImageFile(f);
			}
		},
		[addImageFile],
	);

	function send(): void {
		const text = draft;
		const hasContent = text.trim().length > 0 || images.length > 0;
		if (!hasContent || disabled) return;

		// Intercept client-side virtual slash commands before the WS send.
		// Shape: `/<name>[ <args>]`. Anything else falls through to sendPrompt.
		if (text.startsWith("/") && images.length === 0) {
			const trimmed = text.trim();
			const spaceAt = trimmed.indexOf(" ");
			const name = (spaceAt < 0 ? trimmed.slice(1) : trimmed.slice(1, spaceAt)).toLowerCase();
			const args = spaceAt < 0 ? "" : trimmed.slice(spaceAt + 1);
			if (dispatchVirtualCommand(name, args)) {
				setDraft("");
				const ta = taRef.current;
				if (ta) ta.style.height = "auto";
				return;
			}
		}
		const payload: ImageAttachment[] = images.map(({ id: _id, preview: _p, ...rest }) => rest);
		sendPrompt(text, payload.length > 0 ? payload : undefined);
		// Record the prompt for ArrowUp recall. The hook collapses consecutive
		// duplicates and ignores recall-then-send-unmodified, so we don't have
		// to track that here.
		if (text.length > 0) history.push(text);
		setDraft("");
		setImages([]);
		imagesRef.current = [];
		const ta = taRef.current;
		if (ta) ta.style.height = "auto";
	}

	function handleKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
		// Plan-mode toggle (Shift+Tab). Mirrors the TUI's `app.plan.toggle`
		// keybinding. Highest priority — fires regardless of picker state,
		// composer content, or streaming state. Idempotent on the wire; server
		// echoes `plan_mode_changed` which the reducer mirrors back.
		if (e.key === "Tab" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
			if (!session) return;
			e.preventDefault();
			setPlanMode(!planModeEnabled);
			return;
		}

		// File-path mention picker has the highest priority — if the caret sits
		// inside an `@token`, it owns Arrow / Enter / Tab / Esc the same way the
		// slash picker does. Slash and file-path pickers are mutually exclusive
		// (slash anchors at draft start; file-path triggers on `@` anywhere) so
		// the if-else cascade is safe.
		const variableOpen = variableCandidates.length > 0 && variableRange !== null;
		if (variableOpen) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			setVariableSelected((i) => Math.min(i + 1, variableCandidates.length - 1));
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			setVariableSelected((i) => Math.max(i - 1, 0));
			return;
		}
		if (e.key === "Enter" || e.key === "Tab") {
			e.preventDefault();
			const choice = variableCandidates[variableSelected] ?? variableCandidates[0];
			if (choice) pickVariable(choice);
			return;
		}
		if (e.key === "Escape") {
			e.preventDefault();
			setVariableCandidates([]);
			return;
		}
		}
		if (pathOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setPathSelected((i) => Math.min(i + 1, pathMatches.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setPathSelected((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const choice = pathMatches[pathSelected] ?? pathMatches[0];
				if (choice) pickFilePath(choice);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				// Dismiss without dropping the `@` token — user might just want
				// the literal `@` and we shouldn't erase their typing. Clear
				// matches so the picker hides until the next keystroke retriggers.
				setPathMatches([]);
				return;
			}
		}
		// When the slash picker is open, it owns Arrow / Enter / Tab / Esc so the
		// textarea's send-on-Enter doesn't fire a half-typed `/maint` as a chat
		// message and the user can dismiss with Esc without abandoning the draft.
		if (slashOpen) {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSlashSelected((i) => Math.min(i + 1, filteredSlash.length - 1));
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				setSlashSelected((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const choice = filteredSlash[slashSelected] ?? filteredSlash[0];
				if (choice) pickSlashCommand(choice);
				return;
			}
			if (e.key === "Escape") {
				e.preventDefault();
				// Dismiss by clearing the leading slash token. Other keys (typing
				// to refine the query) just fall through to the default editor.
				setDraft((prev) => prev.replace(/^\/\S*/, ""));
				return;
			}
		}
		// History recall (ArrowUp / ArrowDown). Only fires once the slash and
		// path pickers have already passed, so their navigation always wins
		// while open. Caret rule mirrors a shell: ArrowUp recalls only when the
		// caret is on the first visual line of the textarea (no newline before
		// it); ArrowDown only on the last line. That keeps multi-line composition
		// usable — pressing ArrowUp inside paragraph 2 still moves the caret.
		if (
			e.key === "ArrowUp" &&
			!e.shiftKey &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey
		) {
			const ta = e.currentTarget;
			const pos = ta.selectionStart ?? 0;
			if (!draft.slice(0, pos).includes("\n")) {
				const recalled = history.up(draft);
				if (recalled !== null) {
					e.preventDefault();
					setDraft(recalled);
					queueMicrotask(() => {
						const end = recalled.length;
						ta.setSelectionRange(end, end);
						setCaretPos(end);
						autoresize();
					});
					return;
				}
			}
		}
		if (
			e.key === "ArrowDown" &&
			!e.shiftKey &&
			!e.metaKey &&
			!e.ctrlKey &&
			!e.altKey
		) {
			const ta = e.currentTarget;
			const pos = ta.selectionStart ?? 0;
			if (!draft.slice(pos).includes("\n") && history.isWalking()) {
				const recalled = history.down();
				if (recalled !== null) {
					e.preventDefault();
					setDraft(recalled);
					queueMicrotask(() => {
						const end = recalled.length;
						ta.setSelectionRange(end, end);
						setCaretPos(end);
						autoresize();
					});
					return;
				}
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
			e.preventDefault();
			send();
		}
	}

	async function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>): Promise<void> {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		for (const it of items) {
			if (it.kind === "file") {
				const f = it.getAsFile();
				if (f && f.type.startsWith("image/")) files.push(f);
			}
		}
		if (files.length === 0) return; // let the textarea handle plain text paste
		e.preventDefault();
		await ingestFiles(files);
	}

	async function handleDrop(e: DragEvent<HTMLDivElement>): Promise<void> {
		e.preventDefault();
		setDragOver(false);
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) await ingestFiles(files);
	}

	function removeImage(id: string): void {
		setImages((prev) => prev.filter((img) => img.id !== id));
	}

	return (
		<div
			className={cn(
				"shrink-0 border-t border-line bg-paper px-3 pb-3 pt-2 transition-colors",
				dragOver && "bg-accent-soft/40",
			)}
			onDragOver={(e) => {
				if (e.dataTransfer?.types?.includes("Files")) {
					e.preventDefault();
					setDragOver(true);
				}
			}}
			onDragLeave={() => setDragOver(false)}
			onDrop={(e) => void handleDrop(e)}
		>
			<div className="mx-auto max-w-[760px]">
				{images.length > 0 ? (
					<div className="mb-2 flex flex-wrap items-end gap-1.5">
						{images.map((img, i) => (
							<ImageThumb
								key={img.id}
								index={i + 1}
								preview={img.preview}
								bytes={estimateBytes(img.data)}
								onRemove={() => removeImage(img.id)}
							/>
						))}
					</div>
				) : null}

				<div
					className={cn(
						"relative flex items-end gap-2 rounded-lg border bg-paper-2 px-2 py-1.5",
						planModeEnabled
							? "border-thinking/60 focus-within:border-thinking"
							: "border-line focus-within:border-ink/30",
					)}
				>
					<SlashCommandPicker
						commands={filteredSlash}
						selectedIndex={slashSelected}
						onPick={pickSlashCommand}
						onSelectionChange={setSlashSelected}
					/>
					<VariablePicker
					candidates={variableCandidates}
					selectedIndex={variableSelected}
					onPick={pickVariable}
					onSelectionChange={setVariableSelected}
					/>
					<FilePathPicker
						matches={pathMatches}
						selectedIndex={pathSelected}
						onPick={pickFilePath}
						onSelectionChange={setPathSelected}
					/>
					<PromptSuggestions
					cwd={sessionCwd}
					visible={suggestionsOpen}
					query={draft}
					onPick={onSuggestionPick}
					onDismiss={() => setSuggestionsOpen(false)}
					/>
					<input
						ref={fileRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(e) => {
							const files = e.target.files;
							if (files) void ingestFiles(files);
							if (fileRef.current) fileRef.current.value = "";
						}}
					/>
					<button
						type="button"
						className="btn-ghost h-7 w-7 shrink-0 self-end p-0"
						onClick={() => fileRef.current?.click()}
						disabled={disabled}
						aria-label="Attach image"
						title="Attach image"
					>
						<Paperclip className="h-4 w-4" />
					</button>

					<textarea
						ref={taRef}
						value={draft}
						rows={1}
						placeholder={
							disabled
								? "Pick a session first"
								: planModeEnabled
									? "Plan mode — agent reads + proposes only"
									: isBusy
										? "Streaming… enter to queue"
										: dragOver
											? "Drop images here"
											: "Message omp…"
						}
						onChange={(e) => {
							setDraft(e.target.value);
							setCaretPos(e.currentTarget.selectionStart ?? e.currentTarget.value.length);
							lastEditRef.current = Date.now();
							setSuggestionsOpen(false);
							autoresize();
						}}
						onSelect={(e) => {
							setCaretPos(e.currentTarget.selectionStart ?? 0);
						}}
						onKeyDown={handleKey}
						onPaste={(e) => void handlePaste(e)}
						className={cn(
							"min-h-[34px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5",
							"text-[14px] text-ink placeholder:text-ink-4 focus:outline-none",
						)}
						disabled={disabled}
					/>
					{isBusy ? (
						<button
							type="button"
							className="btn-danger h-7 gap-1 self-end px-2 text-xs"
							onClick={() => abort()}
							aria-label="Stop streaming (Ctrl+.)"
							title="Stop streaming (Ctrl+.)"
						>
							<Square className="h-3 w-3" fill="currentColor" />
							<span className="font-mono uppercase tracking-meta text-2xs">stop</span>
						</button>
					) : (
						<button
							type="button"
							className="btn-primary h-7 w-7 p-0 self-end disabled:bg-line-strong"
							onClick={send}
							disabled={disabled || (draft.trim().length === 0 && images.length === 0)}
							aria-label="Send"
							title="Send"
						>
							<ArrowUp className="h-3.5 w-3.5" />
						</button>
					)}
				</div>

				<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 font-mono text-2xs text-ink-3">
					{queuedCount > 0 ? (
						<button
							type="button"
							onClick={() => clearQueue()}
							className="rounded border border-line bg-paper px-1.5 py-0.5 uppercase tracking-meta text-ink-2 hover:text-danger hover:border-danger/40"
							title="Drop every queued prompt for this session"
						>
							{queuedCount} queued · cancel
						</button>
					) : null}
					<span>
						{images.length > 0
							? `${images.length} image${images.length === 1 ? "" : "s"} · `
							: ""}
						enter send · shift+enter newline · paste/drop image
					</span>
				</div>
			</div>
		</div>
	);
}

function ImageThumb({
	index,
	preview,
	bytes,
	onRemove,
}: {
	index: number;
	preview: string;
	bytes: number;
	onRemove: () => void;
}) {
	return (
		<div className="group relative">
			<img
				src={preview}
				alt={`pasted ${index}`}
				className="h-14 w-14 rounded border border-line object-cover bg-paper-3"
			/>
			<div className="pointer-events-none absolute bottom-0 left-0 right-0 rounded-b bg-ink/75 px-1 py-0.5 text-center font-mono text-2xs text-paper-2">
				#{index}·{formatKb(bytes)}
			</div>
			<button
				type="button"
				onClick={onRemove}
				className="absolute -right-1.5 -top-1.5 rounded-full bg-ink p-0.5 text-paper opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100"
				aria-label="Remove image"
			>
				<X className="h-3 w-3" />
			</button>
		</div>
	);
}

async function fileToBase64(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error ?? new Error("read failed"));
		reader.onload = () => {
			const result = reader.result as string;
			const comma = result.indexOf(",");
			resolve(comma >= 0 ? result.slice(comma + 1) : result);
		};
		reader.readAsDataURL(file);
	});
}

function estimateBytes(base64: string): number {
	if (!base64) return 0;
	const padding = (base64.match(/=+$/)?.[0] ?? "").length;
	return Math.floor((base64.length * 3) / 4) - padding;
}

function formatKb(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * `{{variable` autocomplete picker. Mirrors the file-path picker's
 * controlled-from-outside contract so the composer's `handleKey` keeps the
 * single source of keyboard truth. Renders nothing when there are no
 * candidates so the composer can mount it unconditionally.
 */
function VariablePicker({
	candidates,
	selectedIndex,
	onPick,
	onSelectionChange,
}: {
	candidates: string[];
	selectedIndex: number;
	onPick: (name: string) => void;
	onSelectionChange: (i: number) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
		el?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	if (candidates.length === 0) return null;

	return (
		<div
			role="listbox"
			aria-label="Variables"
			className={cn(
				"absolute bottom-full left-0 right-0 mb-1 max-h-[200px] overflow-y-auto",
				"rounded-md border border-line bg-paper-2 shadow-[0_8px_24px_-8px_rgba(26,24,20,0.25)]",
				"font-mono text-[13px]",
			)}
		>
			<div ref={listRef}>
				{candidates.map((name, i) => {
					const active = i === selectedIndex;
					return (
						<button
							key={name}
							type="button"
							role="option"
							aria-selected={active}
							onClick={() => onPick(name)}
							onMouseEnter={() => onSelectionChange(i)}
							onMouseDown={(e) => e.preventDefault()}
							className={cn(
								"block w-full px-3 py-1.5 text-left",
								active ? "bg-accent-soft/60" : "hover:bg-paper-3/60",
							)}
						>
							<span className={cn("font-medium", active ? "text-accent" : "text-ink")}>
								{name}
							</span>
						</button>
					);
				})}
			</div>
			<div className="border-t border-line bg-paper px-3 py-1 font-mono text-2xs text-ink-3">
				↑↓ navigate · enter/tab pick · esc dismiss
			</div>
		</div>
	);
}
