/**
 * GholamOverlay — playful AI-companion overlay that floats over every page of
 * the deck. The overlay connects to the Gholam sidecar over WS, surfaces
 * heartbeat + priority queue status, and lets the user dictate tasks ("Gholam,
 * add https://github.com/foo/bar to the knowledgebase and study its docs
 * folder") that the sidecar will execute against the live `AgentBridge`.
 *
 * The component is intentionally low-noise when idle: a tiny pill in the
 * bottom-right corner with a heartbeat dot. Click to expand into a full
 * chat surface. The "voice" is sharp, terse, and a little irreverent — the
 * overlay exists because the user asked for a playful twin.
 */
import { useEffect, useRef, useState } from "react";

interface HeartbeatFrame {
	type: "heartbeat";
	at: string;
	priorities: number;
	kb: { pathCount: number; byteSize: number };
}

interface PrioritiesFrame {
	type: "priorities";
	priorities: GholamPriority[];
}

interface HelloFrame {
	type: "hello";
	id: string;
	port: number;
	kb: string;
}

interface GholamPriority {
	id: string;
	label: string;
	cwd: string;
	scope: string;
	addedAt: string;
}

type Frame = HeartbeatFrame | PrioritiesFrame | HelloFrame | { type: string; [k: string]: unknown };

const PILL_WS_BASE = (): string => {
	const loc = window.location;
	const proto = loc.protocol === "https:" ? "wss" : "ws";
	const port = loc.port || (loc.protocol === "https:" ? "443" : "80");
	// Sidecar runs on a known port the deck server picks at spawn; the
	// API exposes /api/gholam/status.wsPort. Fallback to 47900.
	return `${proto}://${loc.hostname}:${(window as unknown as { __GHOLAM_WS_PORT__?: number }).__GHOLAM_WS_PORT__ ?? 47900}/ws`;
};

export function GholamOverlay(): JSX.Element {
	const [open, setOpen] = useState(false);
	const [online, setOnline] = useState(false);
	const [lastBeat, setLastBeat] = useState<string | undefined>();
	const [priorities, setPriorities] = useState<GholamPriority[]>([]);
	const [kb, setKb] = useState<{ pathCount: number; byteSize: number }>({ pathCount: 0, byteSize: 0 });
	const [input, setInput] = useState("");
	const [log, setLog] = useState<Array<{ at: string; text: string }>>([]);
	const wsRef = useRef<WebSocket | undefined>();

	useEffect(() => {
		let cancelled = false;
		const connect = () => {
			try {
				const ws = new WebSocket(PILL_WS_BASE());
				wsRef.current = ws;
				ws.addEventListener("open", () => {
					if (cancelled) return;
					setOnline(true);
				});
				ws.addEventListener("close", () => {
					if (cancelled) return;
					setOnline(false);
					setTimeout(connect, 2_000);
				});
				ws.addEventListener("message", (ev) => {
					try {
						const frame = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()) as Frame;
						if (frame.type === "heartbeat") {
							const f = frame as HeartbeatFrame;
							setLastBeat(f.at);
							setKb(f.kb);
							setPriorities((prev) => prev.length === f.priorities ? prev : prev);
						}
						if (frame.type === "priorities") {
							setPriorities((frame as PrioritiesFrame).priorities);
						}
					} catch {
						// ignore malformed frame
					}
				});
			} catch {
				setOnline(false);
				setTimeout(connect, 3_000);
			}
		};
		connect();
		return () => {
			cancelled = true;
			wsRef.current?.close();
		};
	}, []);

	async function submit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (!trimmed) return;
		const at = new Date().toLocaleTimeString();
		setLog((prev) => [...prev, { at, text: trimmed }]);
		setInput("");
		try {
			await fetch("/api/gholam/priorities", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ priorities: [{ label: trimmed, cwd: process.cwd(), scope: "session" }] }),
			});
			setLog((prev) => [...prev, { at: new Date().toLocaleTimeString(), text: "→ queued for Gholam" }]);
		} catch (err) {
			setLog((prev) => [...prev, { at: new Date().toLocaleTimeString(), text: `× failed: ${String(err)}` }]);
		}
	}

	return (
		<div className="gholam-root">
			<button
				type="button"
				className={`gholam-pill ${online ? "online" : "offline"}`}
				onClick={() => setOpen((v) => !v)}
				aria-label={open ? "Close Gholam" : "Open Gholam"}
			>
				<span className={`gholam-dot ${online ? "live" : "dead"}`} />
				<span className="gholam-label">Gholam</span>
			</button>
			{open && (
				<div className="gholam-panel">
					<header className="gholam-header">
						<strong>Gholam</strong>
						<small>
							{online ? "online" : "offline"}
							{lastBeat ? ` · last beat ${lastBeat}` : ""}
						</small>
					</header>
					<section className="gholam-stats">
						<div><b>{priorities.length}</b> priorities</div>
						<div><b>{kb.pathCount}</b> KB files · <b>{Math.round(kb.byteSize / 1024)} KB</b></div>
					</section>
					<section className="gholam-log" aria-live="polite">
						{log.length === 0 && <em>Talk to me. I'm your twin.</em>}
						{log.map((l, i) => (
							<div key={i} className="gholam-log-line">
								<small>{l.at}</small>
								<span>{l.text}</span>
							</div>
						))}
					</section>
					<form
						className="gholam-input"
						onSubmit={(e) => {
							e.preventDefault();
							void submit(input);
						}}
					>
						<input
							type="text"
							placeholder="Gholam, please ..."
							value={input}
							onChange={(e) => setInput(e.target.value)}
						/>
						<button type="submit">→</button>
					</form>
				</div>
			)}
		</div>
	);
}
