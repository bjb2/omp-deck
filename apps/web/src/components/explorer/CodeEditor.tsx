/**
 * A CodeMirror 6 text editor, themed to the active omp-deck palette rather
 * than shipping its own. CodeMirror's `EditorView.theme` accepts a plain
 * style object, so the deck's CSS custom properties are read at mount and
 * handed straight in — the editor re-themes for free whenever the user
 * switches themes, because the values it read are the same `rgb(var(--…))`
 * strings every other component uses.
 */
import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type ViewUpdate, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { indentOnInput, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";

const LANG_BY_EXT: Record<string, () => Extension> = {
	ts: () => javascript({ typescript: true }),
	tsx: () => javascript({ typescript: true, jsx: true }),
	js: () => javascript(),
	jsx: () => javascript({ jsx: true }),
	mjs: () => javascript(),
	cjs: () => javascript(),
	py: () => python(),
	json: () => json(),
	md: () => markdown(),
	mdx: () => markdown(),
	yml: () => yaml(),
	yaml: () => yaml(),
	html: () => html(),
	htm: () => html(),
	css: () => css(),
};

function languageExtension(filename: string): Extension[] {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	const factory = LANG_BY_EXT[ext];
	return factory ? [factory()] : [];
}

/** Read a token's current RGB channel string from the document root. */
function readToken(name: string): string {
	const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
	return value ? `rgb(${value})` : "transparent";
}

function deckTheme(): Extension {
	const paper2 = readToken("paper-2");
	const paperCode = readToken("paper-code");
	const ink = readToken("ink");
	const ink3 = readToken("ink-3");
	const line = readToken("line");
	const accent = readToken("accent");
	const accentSoft = readToken("accent-soft");

	return EditorView.theme(
		{
			"&": { color: ink, backgroundColor: paperCode, height: "100%", fontSize: "13px" },
			".cm-content": { fontFamily: "var(--font-mono)", caretColor: accent, padding: "12px 0" },
			".cm-cursor, .cm-dropCursor": { borderLeftColor: accent },
			"&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
				backgroundColor: `${accentSoft}`,
			},
			".cm-gutters": { backgroundColor: paper2, color: ink3, border: "none", borderRight: `1px solid ${line}` },
			".cm-activeLine": { backgroundColor: "rgba(128,128,128,0.06)" },
			".cm-activeLineGutter": { backgroundColor: "rgba(128,128,128,0.08)" },
			".cm-scroller": { fontFamily: "var(--font-mono)" },
			"&.cm-focused": { outline: "none" },
		},
		{ dark: true },
	);
}

interface Props {
	path: string;
	value: string;
	readOnly?: boolean;
	onChange?: (value: string) => void;
	/** Ctrl/Cmd+S inside the editor. */
	onSave?: () => void;
}

export function CodeEditor({ path, value, readOnly = false, onChange, onSave }: Props): JSX.Element {
	const containerRef = useRef<HTMLDivElement>(null);
	const viewRef = useRef<EditorView | null>(null);
	// Latest callbacks in refs so the extensions array (built once per file)
	// always calls the current handler without needing the effect to rebuild
	// the whole editor state on every render.
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;

	useEffect(() => {
		if (!containerRef.current) return;

		const extensions: Extension[] = [
			lineNumbers(),
			history(),
			indentOnInput(),
			syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
			keymap.of([
				...defaultKeymap,
				...historyKeymap,
				...searchKeymap,
				indentWithTab,
				{
					key: "Mod-s",
					run: () => {
						onSaveRef.current?.();
						return true;
					},
				},
			]),
			EditorView.lineWrapping,
			EditorView.editable.of(!readOnly),
			deckTheme(),
			...languageExtension(path),
			EditorView.updateListener.of((update: ViewUpdate) => {
				if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
			}),
		];

		const state = EditorState.create({ doc: value, extensions });
		const view = new EditorView({ state, parent: containerRef.current });
		viewRef.current = view;

		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// Rebuild only when switching files or read-only state — content updates
		// flow through the update listener above, not a full remount, so the
		// cursor position and undo history survive a save.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [path, readOnly]);

	// External value change (e.g. reverting, or loading a different revision
	// of the same path) without remounting: only apply if it actually differs
	// from the live document, so this doesn't fight the user's own typing.
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		if (current === value) return;
		view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value]);

	return <div ref={containerRef} className="h-full min-h-0 overflow-hidden" />;
}
