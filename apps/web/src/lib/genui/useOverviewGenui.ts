/**
 * `useOverviewGenui` — Overview page consumer for the GenUI SSE pipeline.
 *
 * Opens `GET /api/genui/stream?route=/&window=<w>` on mount, parses the
 * NDJSON `GenFrame` events into an accumulated `GenNode[]` tree, and
 * surfaces a non-fatal error so the page can keep its hand-written fallback
 * sections visible.
 *
 * Connection lifecycle mirrors `useChatThread.ts`: AbortController-owned
 * `fetch`, teardown via `signal`, exponential reconnect backoff capped at
 * 8s. Errors are surfaced as a string — the page renders the legacy
 * sections below the slot so the route never goes blank.
 *
 * `range` is part of the SSE query so the 24h/7d/30d window toggle
 * refetches; the hook intentionally refetches on every `range` change.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GenFrame, GenNode } from "./components";
import type { OverviewWindow } from "@/lib/overview-api";

export interface UseOverviewGenuiResult {
	nodes: GenNode[];
	error: string | null;
	isStreaming: boolean;
	retry: () => void;
}

const MAX_BACKOFF_MS = 8_000;
const INITIAL_BACKOFF_MS = 500;

export function useOverviewGenui(range: OverviewWindow): UseOverviewGenuiResult {
	const [nodes, setNodes] = useState<GenNode[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [isStreaming, setIsStreaming] = useState(false);
	const [retryNonce, setRetryNonce] = useState(0);

	// Keep the live range in a ref so the connection effect can close over
	// the latest value without re-subscribing on every keystroke.
	const rangeRef = useRef(range);
	rangeRef.current = range;

	const retry = useCallback(() => {
		setError(null);
		setNodes([]);
		setRetryNonce((n) => n + 1);
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		let cancelled = false;
		let backoffMs = INITIAL_BACKOFF_MS;
		let timer: ReturnType<typeof setTimeout> | null = null;

		// Reset per-mount so a window toggle restarts the stream cleanly.
		setNodes([]);
		setError(null);
		setIsStreaming(true);

		const open = async () => {
			if (cancelled) return;
			const url = `/api/genui/stream?route=${encodeURIComponent("/")}&window=${encodeURIComponent(rangeRef.current)}`;
			let res: Response;
			try {
				res = await fetch(url, { signal: controller.signal, headers: { Accept: "text/event-stream" } });
			} catch (err) {
				if (cancelled || controller.signal.aborted) return;
				const msg = err instanceof Error ? err.message : String(err);
				setError(`GenUI unavailable: ${msg}`);
				setIsStreaming(false);
				scheduleReconnect();
				return;
			}

			if (!res.ok || !res.body) {
				if (cancelled) return;
				setError(`GenUI unavailable: HTTP ${res.status}`);
				setIsStreaming(false);
				scheduleReconnect();
				return;
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			try {
				while (!cancelled) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });

					// SSE messages are `event: <e>\ndata: <json>\n\n`. We split on
					// the blank-line delimiter, then peel off the `data:` line.
					const events = buffer.split("\n\n");
					buffer = events.pop() ?? "";

					const collected: GenNode[] = [];
					let streamError: string | null = null;
					let sawDone = false;

					for (const chunk of events) {
						if (!chunk) continue;
						const dataLine = chunk
							.split("\n")
							.find((l) => l.startsWith("data:"));
						if (!dataLine) continue;
						const payload = dataLine.slice(5).trim();
						if (!payload) continue;
						let frame: GenFrame;
						try {
							frame = JSON.parse(payload) as GenFrame;
						} catch {
							continue;
						}
						if (frame.type === "frame") {
							collected.push(frame.node);
						} else if (frame.type === "done") {
							sawDone = true;
						}
					}

					if (collected.length > 0 || sawDone) {
						setNodes((prev) => [...prev, ...collected]);
					}
					if (sawDone) {
						setIsStreaming(false);
						break;
					}
					if (streamError) {
						setError(streamError);
						setIsStreaming(false);
						break;
					}
				}
			} catch (err) {
				if (cancelled || controller.signal.aborted) return;
				const msg = err instanceof Error ? err.message : String(err);
				setError(`GenUI unavailable: ${msg}`);
				setIsStreaming(false);
				scheduleReconnect();
				return;
			}

			if (cancelled) return;
			setIsStreaming(false);
		};

		const scheduleReconnect = () => {
			if (cancelled) return;
			const wait = backoffMs;
			backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
			timer = setTimeout(() => {
				timer = null;
				void open();
			}, wait);
		};

		void open();

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			controller.abort();
		};
	}, [range, retryNonce]);

	return { nodes, error, isStreaming, retry };
}