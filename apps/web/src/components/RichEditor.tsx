import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	type ClipboardEvent,
	type KeyboardEvent,
	type SyntheticEvent,
} from "react";

import { EditorContent, useEditor } from "@tiptap/react";
import { Mark } from "@tiptap/core";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";

import { cn } from "@/lib/utils";

/** Pending Gholam suggestion. Mirrors the optional `suggestions` prop on
 *  RichEditorProps; the first entry is consumed on Tab. */
export interface PendingSuggestion {
	id: string;
	replacement: string;
	range?: [number, number];
}

export interface RichEditorProps {
	value: string;
	onChange: (markdown: string) => void;
	onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
	onSelect?: (e: SyntheticEvent<HTMLTextAreaElement>) => void;
	onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
	placeholder?: string;
	rows?: number;
	readOnly?: boolean;
	disableRichText?: boolean;
	className?: string;
	"data-queued-edit"?: string;
	/** Pending suggestions (Gholam sidecar). When `suggestions[0]` is set,
	 *  Tab consumes it via `onTabApply` and the decoration follows its range. */
	suggestions?: PendingSuggestion[];
	onTabApply?: (s: { id: string; replacement: string }) => void;
}

/* ─── Wavy underline mark for Gholam suggestions ─────────────────────────────
   Decoration-only — no payload, no behaviour. Survives markdown round-trip
   because the serializer omits marks it doesn't know about (we strip this
   mark in `serializeDoc`). The CSS class is provided by RichEditor.css. */
const SuggestionMark = Mark.create({
	name: "ompSuggestion",
	parseHTML() {
		return [{ tag: "span.omp-suggestion" }];
	},
	renderHTML() {
		return ["span", { class: "omp-suggestion" }, 0];
	},
	addOptions() {
		return { HTMLAttributes: { class: "omp-suggestion" } };
	},
});

/* ─── Markdown → HTML ────────────────────────────────────────────────────────
   Tiny converter covering the StarterKit surface — headings, bold, italic,
   code (inline + fenced), bullets, ordered lists, links. Anything else
   passes through as paragraph text. Uses a state machine rather than a
   regex so the output stays sane on nested lists and multi-line code. */
type MdBlock =
	| { kind: "code"; lang?: string; lines: string[] }
	| { kind: "p"; text: string }
	| { kind: "ul" | "ol"; items: string[] }
	| { kind: "h"; level: 1 | 2 | 3; text: string }
	| { kind: "hr" }
	| { kind: "quote"; lines: string[] };

function parseMarkdown(md: string): MdBlock[] {
	const out: MdBlock[] = [];
	let i = 0;
	const lines = md.replace(/\r\n?/g, "\n").split("\n");

	while (i < lines.length) {
		const raw = lines[i] ?? "";
		if (raw.startsWith("```")) {
			const lang = raw.slice(3).trim() || undefined;
			const buf: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
				buf.push(lines[i] ?? "");
				i++;
			}
			if (i < lines.length) i++; // closing fence
			out.push({ kind: "code", lang, lines: buf });
			continue;
		}
		const h = /^(#{1,3})\s+(.+)$/.exec(raw);
		if (h) {
			out.push({ kind: "h", level: h[1].length as 1 | 2 | 3, text: h[2] });
			i++;
			continue;
		}
		if (/^---+$/.test(raw.trim())) {
			out.push({ kind: "hr" });
			i++;
			continue;
		}
		if (/^\s*[-*]\s+/.test(raw)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*]\s+/.test(lines[i] ?? "")) {
				items.push((lines[i] ?? "").replace(/^\s*[-*]\s+/, ""));
				i++;
			}
			out.push({ kind: "ul", items });
			continue;
		}
		if (/^\s*\d+\.\s+/.test(raw)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i] ?? "")) {
				items.push((lines[i] ?? "").replace(/^\s*\d+\.\s+/, ""));
				i++;
			}
			out.push({ kind: "ol", items });
			continue;
		}
		if (/^>\s?/.test(raw)) {
			const buf: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i] ?? "")) {
				buf.push((lines[i] ?? "").replace(/^>\s?/, ""));
				i++;
			}
			out.push({ kind: "quote", lines: buf });
			continue;
		}
		if (raw.trim() === "") {
			i++;
			continue;
		}
		// Paragraph — coalesce until blank line or block delimiter.
		const buf: string[] = [raw];
		i++;
		while (
			i < lines.length &&
			(lines[i] ?? "").trim() !== "" &&
			!/^(#{1,3}\s|```|---+\s*$|\s*[-*]\s+|\s*\d+\.\s+|>\s?)/.test(lines[i] ?? "")
		) {
			buf.push(lines[i] ?? "");
			i++;
		}
		out.push({ kind: "p", text: buf.join("\n") });
	}
	return out;
}

const escapeHtml = (s: string) =>
	s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/** Apply inline markdown rules: `code`, **bold**, *italic*, [text](url).
 *  Order matters — inline code first so we don't accidentally bold inside
 *  a code span. Returns HTML, leaves unknown markup literal. */
function inlineToHtml(text: string): string {
	let s = escapeHtml(text);
	// inline code
	s = s.replace(/`([^`]+)`/g, (_, inner: string) => `<code>${inner}</code>`);
	// links [text](url) — keep url sanitised by escaping earlier
	s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
		// Drop javascript: and data: hrefs.
		if (/^(javascript|data|vbscript):/i.test(url)) return label;
		return `<a href="${url}">${label}</a>`;
	});
	// bold then italic — bold first so `*foo*` survives italic parse.
	s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	s = s.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
	return s;
}

function blocksToHtml(blocks: MdBlock[]): string {
	const out: string[] = [];
	for (const b of blocks) {
		switch (b.kind) {
			case "p":
				out.push(`<p>${inlineToHtml(b.text)}</p>`);
				break;
			case "h":
				out.push(`<h${b.level}>${inlineToHtml(b.text)}</h${b.level}>`);
				break;
			case "ul":
				out.push(`<ul>${b.items.map((t) => `<li>${inlineToHtml(t)}</li>`).join("")}</ul>`);
				break;
			case "ol":
				out.push(`<ol>${b.items.map((t) => `<li>${inlineToHtml(t)}</li>`).join("")}</ol>`);
				break;
			case "code":
				out.push(
					`<pre><code${b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ""}>${escapeHtml(
						b.lines.join("\n"),
					)}</code></pre>`,
				);
				break;
			case "hr":
				out.push(`<hr>`);
				break;
			case "quote":
				out.push(`<blockquote>${inlineToHtml(b.lines.join("\n"))}</blockquote>`);
				break;
		}
	}
	return out.join("");
}

/* ─── Tiptap doc → markdown ──────────────────────────────────────────────────
   Walks the PM tree directly so we don't lose information round-tripping
   through HTML. Strips the suggestion mark (decoration only). */
function serializeDoc(doc: PMNode): string {
	const out: string[] = [];

	const renderMarks = (text: string, marks: readonly PMMark[]) => {
		const filtered = marks.filter((m) => m.type.name !== "ompSuggestion");
		let s = text;
		for (const m of filtered) {
			switch (m.type.name) {
				case "code":
					s = `\`${s}\``;
					break;
				case "bold":
					s = `**${s}**`;
					break;
				case "italic":
					s = `*${s}*`;
					break;
				case "strike":
					s = `~~${s}~~`;
					break;
				case "link": {
					const href = (m.attrs?.href as string | undefined) ?? "";
					if (!/^(javascript|data|vbscript):/i.test(href)) s = `[${s}](${href})`;
					break;
				}
			}
		}
		return s;
	};

	const renderInline = (node: PMNode): string => {
		if (node.isText) {
			const text = node.text ?? "";
			return renderMarks(text, node.marks);
		}
		if (node.type.name === "hardBreak") return "\n";
		if (node.type.name === "image") {
			const src = (node.attrs?.src as string | undefined) ?? "";
			const alt = (node.attrs?.alt as string | undefined) ?? "";
			return `![${alt}](${src})`;
		}
		let inner = "";
		node.content.forEach((c) => {
			inner += renderInline(c);
		});
		if (node.type.name === "codeBlock") {
			const lang = (node.attrs?.language as string | undefined) ?? "";
			return `\`\`\`${lang}\n${node.textContent}\n\`\`\`\n`;
		}
		return inner;
	};

	doc.content.forEach((node) => {
		switch (node.type.name) {
			case "heading": {
				const level = (node.attrs?.level as number | undefined) ?? 1;
				const lvl = Math.max(1, Math.min(3, level));
				out.push(`${"#".repeat(lvl)} ${node.textContent}`);
				break;
			}
			case "paragraph": {
				let buf = "";
				node.content.forEach((c) => {
					buf += renderInline(c);
				});
				out.push(buf);
				break;
			}
			case "bulletList": {
				node.content.forEach((li) => {
					out.push(`- ${li.textContent}`);
				});
				break;
			}
			case "orderedList": {
				let n = 1;
				node.content.forEach((li) => {
					out.push(`${n}. ${li.textContent}`);
					n++;
				});
				break;
			}
			case "listItem": {
				let buf = "";
				node.content.forEach((c) => {
					buf += renderInline(c);
				});
				out.push(`- ${buf}`);
				break;
			}
			case "codeBlock": {
				const lang = (node.attrs?.language as string | undefined) ?? "";
				out.push(`\`\`\`${lang}\n${node.textContent}\n\`\`\``);
				break;
			}
			case "blockquote": {
				node.textContent.split("\n").forEach((ln) => out.push(`> ${ln}`));
				break;
			}
			case "horizontalRule":
				out.push("---");
				break;
			default: {
				out.push(`- ${node.textContent}`);
			}
		}
		out.push("");
	});
	// Trim the trailing blank lines; preserve exactly one between blocks.
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n\n");
}

/** Map a codepoint text-offset into a ProseMirror document position. The
 *  suggestion range is expressed against the buffer's plain-text view, so
 *  we walk PM nodes tracking text length until the offset lands inside one. */
function textOffsetToPos(doc: PMNode, offset: number): number {
	let pos = 0;
	let target = doc.content.size;
	const walk = (node: PMNode, p: number): number => {
		if (!node.isText) {
			let cur = p;
			node.content.forEach((c) => {
				cur = walk(c, cur);
			});
			return cur;
		}
		const len = (node.text ?? "").length;
		if (offset >= pos && offset <= pos + len) {
			target = p + (offset - pos);
			return p + len;
		}
		pos += len;
		return p + len;
	};
	doc.content.forEach((n) => walk(n, 0));
	return target;
}

/* ─── Component ────────────────────────────────────────────────────────────── */
export const RichEditor = forwardRef<HTMLTextAreaElement | HTMLDivElement, RichEditorProps>(
	function RichEditor(
		{
			value,
			onChange,
			onKeyDown,
			onSelect,
			onPaste,
			placeholder,
			rows = 1,
			readOnly,
			disableRichText,
			className,
			"data-queued-edit": dataQueuedEdit,
			suggestions,
			onTabApply,
		},
		ref,
	) {
		const monoRef = useRef<HTMLTextAreaElement | null>(null);

		/* ── Monospace fallback ─────────────────────────────────────────── */
		const setMonoRef = useCallback(
			(node: HTMLTextAreaElement | null) => {
				monoRef.current = node;
				if (typeof ref === "function") ref(node);
				else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
			},
			[ref],
		);

		// ── Rich mode (Tiptap) ─────────────────────────────────────────────
		const initialHtml = useMemo(() => blocksToHtml(parseMarkdown(value)), []); // eslint-disable-line react-hooks/exhaustive-deps

		const editor = useEditor(
			{
				extensions: [StarterKit, SuggestionMark],
				content: initialHtml,
				editable: !readOnly,
				editorProps: {
					attributes: {
					class: "ProseMirror",
						"data-placeholder": placeholder ?? "",
				},
			},
				onUpdate({ editor }) {
					onChange(serializeDoc(editor.state.doc));
			},
					},
			[],
		);

		// Forward ref to the Tiptap root DOM node so existing callers can
		// .focus() / .select() just like a textarea.
		useImperativeHandle(
			ref,
			() =>
				((editor?.view.dom as HTMLDivElement | null) ??
					(null as unknown as HTMLDivElement)) as HTMLDivElement,
			[editor],
		);

		// External value change → rehydrate the editor (only when value diverges
		// from what the editor currently has, to avoid clobbering onChange).
		const lastSerialized = useRef<string>(value);
		useEffect(() => {
			if (!editor) return;
			const current = serializeDoc(editor.state.doc);
			if (current === value) {
				lastSerialized.current = current;
				return;
			}
			if (current === lastSerialized.current && value !== current) {
				// Caller pushed a new value; rehydrate.
				editor.commands.setContent(blocksToHtml(parseMarkdown(value)), false);
				lastSerialized.current = value;
			}
		}, [value, editor]);

		// Wavy-underline decoration for the active suggestion. Strip any prior
		// range mark, then apply the new range (if any) — same colour, same
		// CSS class, so existing rules in RichEditor.css carry the styling.
		const currentRange = suggestions?.[0]?.range;
		const currentId = suggestions?.[0]?.id;
		useEffect(() => {
			if (!editor) return;
			const { state } = editor;
			let tr = state.tr;
			const markType = state.schema.marks.ompSuggestion;
			if (!markType) return;
			// Remove every existing instance of the mark.
			tr.removeMark(0, tr.doc.content.size, markType);
			if (currentRange) {
				const [start, end] = currentRange;
				const from = Math.max(1, textOffsetToPos(tr.doc, start));
				const to = Math.min(tr.doc.content.size, textOffsetToPos(tr.doc, end));
				if (to > from) {
					tr = tr.addMark(from, to, markType.create());
				}
			}
			if (tr.docChanged || tr.steps.length > 0) editor.view.dispatch(tr);
		}, [editor, currentId, currentRange]);

		// Tab handler — consume the first suggestion if any, else insert \t.
		useEffect(() => {
			if (!editor) return;
			const handler = (e: KeyboardEvent) => {
				if (e.key !== "Tab") return;
				const first = suggestions?.[0];
				if (first && onTabApply) {
					e.preventDefault();
					onTabApply({ id: first.id, replacement: first.replacement });
				}
			};
			const el = editor.view.dom as HTMLElement;
			el.addEventListener("keydown", handler as unknown as EventListener);
			return () => el.removeEventListener("keydown", handler as unknown as EventListener);
		}, [editor, suggestions, onTabApply]);

		if (disableRichText) {
			return (
				<textarea
					ref={setMonoRef}
					value={value}
					rows={rows}
					placeholder={placeholder}
					readOnly={readOnly}
					disabled={readOnly}
					onChange={(e) => onChange(e.target.value)}
					onKeyDown={onKeyDown}
					onSelect={onSelect}
					onPaste={onPaste}
					data-queued-edit={dataQueuedEdit}
					className={cn(
						"min-h-[34px] flex-1 resize-none border-0 bg-transparent px-1 py-1.5",
						"text-[14px] text-ink placeholder:text-ink-4 focus:outline-none",
						"font-mono",
						className,
					)}
				/>
			);
		}

		const minHeight = Math.max(1, rows) * 1.5; // em; rough rows * 1.5em line-height hint
		return (
			<div
				className={cn("omp-richeditor", className)}
				data-queued-edit={dataQueuedEdit}
				style={{ minHeight: `${minHeight}em` }}
			>
			<div className="omp-richeditor__surface">
				{editor ? <EditorContent editor={editor} /> : null}
			</div>
			</div>
		);
	},
);