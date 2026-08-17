import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mic, MicOff } from "lucide-react";

import { cn } from "@/lib/utils";

export interface VoiceRecorderProps {
	className?: string;
	disabled?: boolean;
	/** Fired when the server returns a transcript. */
	onTranscribe?: (text: string, language: string) => void;
	/** Fired on every media error (mic permission denied, blob post failed). */
	onError?: (message: string) => void;
}

type State = "idle" | "recording" | "transcribing" | "denied";

/** Module-level singleton: only one recording at a time across the app.
 *  When a second component starts, the previous one stops first. */
let currentRecorder: MediaRecorder | null = null;
let currentStream: MediaStream | null = null;

/** Try a list of MIME types in order and pick the first the browser accepts.
 *  Returns empty string when nothing matched so MediaRecorder picks its own
 *  default (Safari fallback). */
function pickMimeType(): string {
	const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg"];
	if (typeof MediaRecorder === "undefined") return "";
	for (const c of candidates) {
		if (MediaRecorder.isTypeSupported(c)) return c;
	}
	return "";
}

/* ─── Component ────────────────────────────────────────────────────────────── */
export function VoiceRecorder({ className, disabled, onTranscribe, onError }: VoiceRecorderProps) {
	const [state, setState] = useState<State>("idle");
	const stateRef = useRef<State>(state);
	stateRef.current = state;
	const mountRef = useRef(true);

	useEffect(() => {
		mountRef.current = true;
		return () => {
			mountRef.current = false;
		};
	}, []);

	const stopExisting = useCallback(() => {
		if (currentRecorder && currentRecorder.state !== "inactive") {
			try {
				currentRecorder.stop();
			} catch {
				/* recorder may already be stopping */
			}
		}
		if (currentStream) {
			currentStream.getTracks().forEach((t) => t.stop());
			currentStream = null;
		}
	}, []);

	const start = useCallback(async () => {
		if (disabled || stateRef.current !== "idle") return;
		stopExisting();

		if (
			typeof navigator === "undefined" ||
			!navigator.mediaDevices?.getUserMedia ||
			typeof MediaRecorder === "undefined"
		) {
			onError?.("voice recording unsupported in this browser");
			return;
		}

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			if (!mountRef.current) return;
			if (err instanceof DOMException && err.name === "NotAllowedError") {
				setState("denied");
				window.setTimeout(() => {
					if (mountRef.current) setState("idle");
				}, 1500);
			} else {
				onError?.(err instanceof Error ? err.message : String(err));
			}
			return;
		}
		if (!mountRef.current) {
			stream.getTracks().forEach((t) => t.stop());
			return;
		}

		const mimeType = pickMimeType();
		const recorder = mimeType
			? new MediaRecorder(stream, { mimeType })
			: new MediaRecorder(stream);

		currentRecorder = recorder;
		currentStream = stream;

		const chunks: Blob[] = [];
		recorder.addEventListener("dataavailable", (ev) => {
			if (ev.data && ev.data.size > 0) chunks.push(ev.data);
		});
		recorder.addEventListener("stop", async () => {
			currentRecorder = null;
			if (currentStream) {
				currentStream.getTracks().forEach((t) => t.stop());
				currentStream = null;
			}
			if (!mountRef.current) return;
			if (chunks.length === 0) {
				setState("idle");
				return;
			}
			const blob = new Blob(chunks, { type: mimeType || recorder.mimeType || "audio/webm" });
			setState("transcribing");
			try {
				const fd = new FormData();
				fd.append("audio", blob, `clip.${extForMime(blob.type)}`);
				fd.append("language", "auto");
				const res = await fetch("/api/transcribe", { method: "POST", body: fd });
				if (!res.ok) {
					onError?.(`transcribe failed: ${res.status}`);
					if (mountRef.current) setState("idle");
					return;
				}
				const body = (await res.json()) as { text?: string; language?: string };
				if (typeof body.text === "string") {
					onTranscribe?.(body.text, body.language ?? "auto");
				}
			} catch (err) {
				onError?.(err instanceof Error ? err.message : String(err));
			} finally {
				if (mountRef.current) setState("idle");
			}
		});

		recorder.start();
		setState("recording");
	}, [disabled, onError, onTranscribe, stopExisting]);

	const stop = useCallback(() => {
		if (currentRecorder && currentRecorder.state !== "inactive") {
			try {
				currentRecorder.stop();
			} catch {
				/* ignore */
			}
		}
	}, []);

	// Tear down on unmount mid-recording.
	useEffect(() => {
		return () => {
			stopExisting();
		};
	}, [stopExisting]);

	const onClick = () => {
		if (disabled) return;
		if (stateRef.current === "idle") void start();
		else if (stateRef.current === "recording") stop();
	};

	const Icon =
		state === "transcribing" ? Loader2 : state === "denied" || state === "recording" ? MicOff : Mic;
	const label =
		state === "recording"
			? "Stop recording"
			: state === "transcribing"
				? "Transcribing…"
				: state === "denied"
					? "Microphone permission denied"
					: "Record voice";

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled || state === "transcribing"}
			aria-label={label}
			title={label}
			className={cn(
				"btn-ghost h-7 w-7 shrink-0 self-end p-0",
				state === "recording" && "animate-pulse text-danger",
				state === "denied" && "animate-[shake_0.4s_ease-in-out] text-danger",
				className,
			)}
		>
			<Icon className={cn("h-4 w-4", state === "transcribing" && "animate-spin")} />
		</button>
	);
}

function extForMime(mime: string): string {
	if (mime.includes("webm")) return "webm";
	if (mime.includes("ogg")) return "ogg";
	if (mime.includes("wav")) return "wav";
	if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
	return "bin";
}