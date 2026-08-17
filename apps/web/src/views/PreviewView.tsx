/**
 * Pinned preview pane per route (§4 of docs/GENERATIVE.md). Renders the
 * server stream from `POST /api/preview/render` into the GenUI renderer.
 *
 * The view is intentionally a thin shell: the actual preview logic lives
 * in `PreviewPane.tsx` (right-rail toggle, three modes, per-route
 * localStorage). This view mounts `PreviewPane` for the matched route
 * from the URL `:route` param.
 */

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

import { Layout } from "@/components/Layout";
import { PreviewPane } from "@/components/PreviewPane";
import type { GenNode } from "@/lib/genui/components";

export function PreviewView() {
	const params = useParams();
	const route = typeof params.route === "string" && params.route.length > 0 ? params.route : "/";
	const [frames, setFrames] = useState<GenNode[]>([]);
	const [error, setError] = useState<string | undefined>();

	useEffect(() => {
		const ctrl = new AbortController();
		setFrames([]);
		setError(undefined);
		void (async (): Promise<void> => {
			try {
				const res = await fetch("/api/preview/render", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						path: `preview/${route}`,
						content: "",
						route,
					}),
					signal: ctrl.signal,
				});
				if (!res.ok || !res.body) {
					setError(`preview fetch failed: HTTP ${res.status}`);
					return;
				}
				const reader = res.body.getReader();
				const dec = new TextDecoder();
				let buf = "";
				const collected: GenNode[] = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += dec.decode(value, { stream: true });
					const lines = buf.split("\n");
					buf = lines.pop() ?? "";
					for (const raw of lines) {
						const line = raw.startsWith("data: ") ? raw.slice(6) : raw;
						if (!line) continue;
						try {
							const parsed = JSON.parse(line) as { type?: string; node?: GenNode };
							if (parsed.type === "frame" && parsed.node) {
								collected.push(parsed.node);
							}
						} catch {
							/* ignore malformed lines */
						}
					}
				}
				setFrames(collected);
			} catch (err) {
				if ((err as { name?: string }).name === "AbortError") return;
				setError(String(err));
			}
		})();
		return () => ctrl.abort();
	}, [route]);

	return (
		<Layout
			sidebar={null}
			main={
				<div className="flex h-full min-h-0 flex-col">
					<div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-paper px-3">
						<div className="meta">Preview</div>
						<div className="font-mono text-xs text-ink-3">{route}</div>
						{error ? <div className="ml-auto font-mono text-2xs text-danger">{error}</div> : null}
					</div>
					<div className="min-h-0 flex-1">
						<PreviewPane route={route} frames={frames} label={`Preview · ${route}`} />
					</div>
				</div>
			}
			inspector={null}
		/>
	);
}