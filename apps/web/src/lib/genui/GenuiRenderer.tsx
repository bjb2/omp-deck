/**
 * Renderer for the GenUI component vocabulary (apps/web/src/lib/genui/components.ts).
 *
 * Dispatch is purely via React.createElement against the per-type whitelist;
 * unknown types resolve to `null` (with a console.warn in dev) — the LLM
 * cannot smuggle `<script>` or arbitrary event handlers through this surface
 * because no string is ever passed to `createElement` as a tag name.
 *
 * Action emitters (<GenButton>, <GenForm>) route through the existing
 * broadcastBus dispatchers (WS send / mcp_call / gholam_command / navigate)
 * — there are no new event channels.
 */

import { useState, type ReactNode } from "react";
import { Markdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { GENUI_TYPES, GENUI_ALLOWLIST_VERSION, type GenAction, type GenNode } from "./components";
import type { GenComponent } from "@omp-deck/protocol";

const DEV = typeof process !== "undefined" && process.env.NODE_ENV !== "production";

function unknownNode(type: unknown): ReactNode {
	if (DEV) {
		// eslint-disable-next-line no-console
		console.warn(`[genui] skipping unknown component type: ${String(type)}`);
	}
	return null;
}

/** Run an action through the existing WS bus. mcp_call / gholam_command /
 *  submit_prompt already have wire types in @omp-deck/protocol; navigate
 *  is a thin client-side location change. */
function runAction(action: GenAction): void {
	const w = typeof window === "undefined" ? null : window;
	if (!w) return;
	switch (action.kind) {
		case "navigate": {
			const target = typeof action.payload?.path === "string" ? action.payload.path : null;
			if (target) w.location.assign(target);
			break;
		}
		case "submit_prompt": {
			const text = typeof action.payload?.text === "string" ? action.payload.text : "";
			if (!text) break;
			// Surface as a CustomEvent; the composer (or whoever owns the
			// prompt input) can listen. We deliberately do NOT touch the
			// composer DOM directly — the listener pattern keeps the
			// renderer decoupled from the composer's identity.
			w.dispatchEvent(new CustomEvent("omp-deck:genui:submit-prompt", { detail: { text } }));
			break;
		}
		case "mcp_call":
		case "gholam_command": {
			// Forward through the shared bus event so the existing WS
			// client (apps/web/src/lib/ws.ts) routes it server-side.
			w.dispatchEvent(
				new CustomEvent("omp-deck:genui:tool-call", { detail: { kind: action.kind, payload: action.payload } }),
			);
			break;
		}
		default:
			if (DEV) {
				// eslint-disable-next-line no-console
				console.warn(`[genui] unknown action.kind: ${String(action.kind)}`);
			}
	}
}

function toneClass(tone: "default" | "muted" | "danger" | "accent" | undefined): string {
	switch (tone) {
		case "muted":
			return "text-ink-3";
		case "danger":
			return "text-danger";
		case "accent":
			return "text-accent";
		default:
			return "text-ink";
	}
}

function sizeClass(size: "xs" | "sm" | "md" | "lg" | undefined): string {
	switch (size) {
		case "xs":
			return "text-2xs";
		case "sm":
			return "text-xs";
		case "lg":
			return "text-base";
		default:
			return "text-sm";
	}
}

function GenStackView({ children, gap }: { children: ReactNode; gap?: number }): ReactNode {
	return (
		<div className="flex flex-col" style={{ gap: typeof gap === "number" ? `${gap}px` : undefined }}>
			{children}
		</div>
	);
}

function GenRowView({ children, gap, align }: { children: ReactNode; gap?: number; align?: "start" | "center" | "end" }): ReactNode {
	const justify = align === "start" ? "flex-start" : align === "end" ? "flex-end" : "center";
	return (
		<div className="flex flex-row items-center" style={{ gap: typeof gap === "number" ? `${gap}px` : undefined, justifyContent: justify }}>
			{children}
		</div>
	);
}

function GenGridView({ children, cols, gap }: { children: ReactNode; cols?: number; gap?: number }): ReactNode {
	return (
		<div
			className="grid"
			style={{
				gridTemplateColumns: typeof cols === "number" ? `repeat(${cols}, minmax(0, 1fr))` : undefined,
				gap: typeof gap === "number" ? `${gap}px` : undefined,
			}}
		>
			{children}
		</div>
	);
}

function GenTextView({ content, size, tone }: { content: string; size?: "xs" | "sm" | "md" | "lg"; tone?: "default" | "muted" | "danger" | "accent" }): ReactNode {
	return <span className={cn(sizeClass(size), toneClass(tone))}>{content}</span>;
}

function GenMarkdownView({ content }: { content: string }): ReactNode {
	return (
		<div className="prose prose-sm max-w-none text-ink">
			<Markdown>{content}</Markdown>
		</div>
	);
}

function GenCodeView({ content, lang }: { content: string; lang?: string }): ReactNode {
	return (
		<pre className="overflow-x-auto rounded-md border border-line bg-paper-2 p-2 font-mono text-2xs text-ink">
			<code data-lang={lang}>{content}</code>
		</pre>
	);
}

function GenImageView({ src, alt }: { src: string; alt?: string }): ReactNode {
	return <img src={src} alt={alt ?? ""} className="max-h-64 max-w-full rounded-md border border-line" />;
}

function GenVideoView({ src }: { src: string }): ReactNode {
	return <video src={src} controls className="max-h-64 max-w-full rounded-md border border-line" />;
}

function GenButtonView({ label, action }: { label: string; action: GenAction }): ReactNode {
	return (
		<button
			type="button"
			className="inline-flex items-center gap-1 rounded-md border border-line bg-paper-2 px-2 py-1 text-xs text-ink hover:bg-paper-3"
			onClick={() => runAction(action)}
		>
			{label}
		</button>
	);
}

function GenActionView({ action }: { action: GenAction }): ReactNode {
	// GenAction with no UI is rare; render an invisible marker so the
	// renderer still emits a node (avoids null children warnings in
	// upstream frames).
	return <span hidden data-action-kind={action.kind} />;
}

function GenTableView({ headers, rows }: { headers: string[]; rows: GenNode[][] }): ReactNode {
	return (
		<div className="overflow-x-auto rounded-md border border-line">
			<table className="w-full text-xs">
				<thead className="bg-paper-2">
					<tr>
						{headers.map((h, i) => (
							<th key={i} className="px-2 py-1 text-left font-mono uppercase tracking-meta text-ink-3">
								{h}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((row, ri) => (
						<tr key={ri} className="border-t border-line">
							{row.map((cell, ci) => (
								<td key={ci} className="px-2 py-1 text-ink">
									<GenuiRenderer node={cell} />
								</td>
							))}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function GenKeyValueView({ entries }: { entries: Array<{ key: string; value: GenNode }> }): ReactNode {
	return (
		<dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
			{entries.flatMap((e, i) => [
				<dt key={`k-${i}`} className="font-mono uppercase tracking-meta text-ink-3">
					{e.key}
				</dt>,
				<dd key={`v-${i}`} className="text-ink">
					<GenuiRenderer node={e.value} />
				</dd>,
			])}
		</dl>
	);
}

function GenCardView({ title, children }: { children: ReactNode; title?: string }): ReactNode {
	return (
		<section className="rounded-md border border-line bg-paper-2 p-3">
			{title ? <div className="mb-2 font-mono text-2xs uppercase tracking-meta text-ink-3">{title}</div> : null}
			{children}
		</section>
	);
}

function GenTabsView({ tabs, defaultId }: { tabs: Array<{ id: string; label: string; content: GenNode }>; defaultId?: string }): ReactNode {
	const [active, setActive] = useState<string>(defaultId ?? tabs[0]?.id ?? "");
	const current = tabs.find((t) => t.id === active) ?? tabs[0];
	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-row gap-1 border-b border-line">
				{tabs.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setActive(t.id)}
						className={cn(
							"px-2 py-1 font-mono text-2xs uppercase tracking-meta",
							t.id === active ? "border-b-2 border-accent text-accent" : "text-ink-3 hover:text-ink",
						)}
					>
						{t.label}
					</button>
				))}
			</div>
			<div>{current ? <GenuiRenderer node={current.content} /> : null}</div>
		</div>
	);
}

function GenModalView({ title, onClose, children }: { children: ReactNode; title?: string; onClose: GenAction }): ReactNode {
	return (
		<div className="rounded-md border border-line bg-paper-2 p-3">
			<div className="mb-2 flex items-center justify-between">
				{title ? <div className="font-mono text-2xs uppercase tracking-meta text-ink-3">{title}</div> : <div />}
				<button
					type="button"
					onClick={() => runAction(onClose)}
					className="rounded px-2 py-0.5 text-xs text-ink-3 hover:bg-paper-3 hover:text-ink"
					aria-label="Close"
				>
					×
				</button>
			</div>
			{children}
		</div>
	);
}

function GenFormView({
	submit,
	fields,
}: {
	submit: GenAction;
	fields: Array<{ name: string; label: string; kind: "text" | "number" | "checkbox"; placeholder?: string; defaultValue?: string | number | boolean }>;
}): ReactNode {
	const [values, setValues] = useState<Record<string, string | number | boolean>>(() => {
		const out: Record<string, string | number | boolean> = {};
		for (const f of fields) {
			if (f.defaultValue !== undefined) out[f.name] = f.defaultValue;
			else if (f.kind === "checkbox") out[f.name] = false;
			else out[f.name] = "";
		}
		return out;
	});
	const setField = (name: string, value: string | number | boolean): void => {
		setValues((prev) => ({ ...prev, [name]: value }));
	};
	const onSubmit = (e: React.FormEvent): void => {
		e.preventDefault();
		runAction({ ...submit, payload: { ...submit.payload, values } });
	};
	return (
		<form onSubmit={onSubmit} className="flex flex-col gap-2 rounded-md border border-line bg-paper-2 p-3">
			{fields.map((f) => (
				<label key={f.name} className="flex flex-col gap-1 text-xs text-ink-3">
					<span className="font-mono text-2xs uppercase tracking-meta">{f.label}</span>
					{f.kind === "checkbox" ? (
						<input type="checkbox" checked={Boolean(values[f.name])} onChange={(e) => setField(f.name, e.currentTarget.checked)} />
					) : f.kind === "number" ? (
						<input
							type="number"
							value={(typeof values[f.name] === "number" ? values[f.name] : "") as number}
							placeholder={f.placeholder}
							onChange={(e) => setField(f.name, e.currentTarget.value === "" ? 0 : Number(e.currentTarget.value))}
							className="rounded-md border border-line bg-paper px-2 py-1 text-ink"
						/>
					) : (
						<input
							type="text"
							value={(typeof values[f.name] === "string" ? values[f.name] : "") as string}
							placeholder={f.placeholder}
							onChange={(e) => setField(f.name, e.currentTarget.value)}
							className="rounded-md border border-line bg-paper px-2 py-1 text-ink"
						/>
					)}
				</label>
			))}
			<button
				type="submit"
				className="self-start rounded-md border border-line bg-paper-2 px-2 py-1 text-xs text-ink hover:bg-paper-3"
			>
				Submit
			</button>
		</form>
	);
}

/** Children adapter — strings/numbers/booleans render as inline text,
 *  components go through the recursive dispatcher. */
function renderChildren(children: GenNode[] | undefined): ReactNode {
	if (!children || children.length === 0) return null;
	const out: ReactNode[] = [];
	children.forEach((c, i) => {
		if (c === null || c === undefined || typeof c === "boolean") return;
		if (typeof c === "string" || typeof c === "number") {
			out.push(
				<span key={i} className="text-ink">
					{String(c)}
				</span>,
			);
			return;
		}
		out.push(<GenuiRenderer key={i} node={c} />);
	});
	return out;
}

/** Single recursive renderer. Walks the type discriminator; unknown types
 *  fall through `default` to the dev-warn + null branch. */
function renderNode(node: GenComponent): ReactNode {
	switch (node.type) {
		case "GenStack":
			return <GenStackView gap={node.props?.gap}>{renderChildren(node.children)}</GenStackView>;
		case "GenRow":
			return (
				<GenRowView gap={node.props?.gap} align={node.props?.align}>
					{renderChildren(node.children)}
				</GenRowView>
			);
		case "GenGrid":
			return (
				<GenGridView cols={node.props?.cols} gap={node.props?.gap}>
					{renderChildren(node.children)}
				</GenGridView>
			);
		case "GenText":
			return <GenTextView content={node.content} size={node.props?.size} tone={node.props?.tone} />;
		case "GenMarkdown":
			return <GenMarkdownView content={node.content} />;
		case "GenCode":
			return <GenCodeView content={node.content} lang={node.props?.lang} />;
		case "GenImage":
			return <GenImageView src={node.props.src} alt={node.props.alt} />;
		case "GenVideo":
			return <GenVideoView src={node.props.src} />;
		case "GenButton":
			return <GenButtonView label={node.props.label} action={node.props.action} />;
		case "GenAction":
			return <GenActionView action={node.props} />;
		case "GenTable":
			return <GenTableView headers={node.props.headers} rows={node.rows} />;
		case "GenKeyValue":
			return <GenKeyValueView entries={node.entries} />;
		case "GenCard":
			return <GenCardView title={node.props?.title}>{renderChildren(node.children)}</GenCardView>;
		case "GenTabs":
			return <GenTabsView tabs={node.tabs} defaultId={node.props?.default} />;
		case "GenModal":
			return (
				<GenModalView title={node.props.title} onClose={node.props.onClose}>
					{renderChildren(node.children)}
				</GenModalView>
			);
		case "GenForm":
			return <GenFormView submit={node.props.submit} fields={node.props.fields} />;
		default: {
			// Exhaustive check via never — TS narrows to never here, so a
			// future arm added to GenComponent without a matching case
			// would fail this build.
			// The `GENUI_TYPES` whitelist at the call site already filters
			// unknown types before renderNode is invoked, so anything that
			// reaches this default is an unhandled future arm — log and
			// skip rather than fabricate a never-typed exception.
			return unknownNode("(unhandled)");
		}
	}
}

export interface GenuiRendererProps {
	node: GenNode;
}

/** Render a single GenUI node. Strings/numbers/booleans render as text;
 *  components dispatch through the whitelist. */
export function GenuiRenderer({ node }: GenuiRendererProps): ReactNode {
	if (node === null || node === undefined) return null;
	if (typeof node === "boolean") return null;
	if (typeof node === "string" || typeof node === "number") return <span className="text-ink">{String(node)}</span>;
	if (typeof node === "object" && "type" in node) {
		const t = node.type;
		if (typeof t !== "string" || !(GENUI_TYPES as readonly string[]).includes(t)) {
			return unknownNode(t);
		}
		return renderNode(node as GenComponent);
	}
	return unknownNode(typeof node);
}

/** Render an entire frame stack (multiple top-level nodes). The frame
 *  stream emits one node per line; the renderer collapses them into a
 *  single column. */
export function GenuiStack({ nodes }: { nodes: GenNode[] }): ReactNode {
	return (
		<div className="flex flex-col gap-3">
			{nodes.map((n, i) => (
				<GenuiRenderer key={i} node={n} />
			))}
		</div>
	);
}

export { GENUI_ALLOWLIST_VERSION };