/**
 * `POST /api/transcribe` — shell out to a configured whisper-cpp binary and
 * return its JSON transcription. Contract:
 *
 *   multipart/form-data
 *     - `audio`    (File)   raw audio bytes (wav/webm/ogg/m4a — whisper-cpp decides)
 *     - `language` (string) "fa" | "en" | "auto"
 *
 *   → 200 { text, language, durationMs }
 *   → 400 missing field / bad multipart
 *   → 413 audio larger than MAX_BYTES
 *   → 501 process.env.WHISPER_BIN is unset (transcription backend not configured)
 *   → 500 whisper exited non-zero or produced malformed JSON
 *
 * The binary is invoked once per request with the audio written to a temp file
 * (whisper-cpp needs a path it can mmap). Stdout is parsed as JSON. We never
 * let the temp file leak — `defer rm -f` is the cleaning hook.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Hono } from "hono";

import { logger } from "./log.ts";

const log = logger("routes:transcribe");

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a 5-min mobile clip
const ALLOWED_LANG: Record<string, true> = { fa: true, en: true, auto: true };
const SUPPORTED_AUDIO: Record<string, true> = {
	"audio/wav": true,
	"audio/x-wav": true,
	"audio/wave": true,
	"audio/webm": true,
	"audio/ogg": true,
	"audio/mpeg": true,
	"audio/mp4": true,
	"audio/x-m4a": true,
	"audio/m4a": true,
	"application/octet-stream": true, // some browsers send this for mediaRecorder blobs
};

export interface TranscribeConfig {
	/** Absolute path to the whisper-cpp binary; falls back to `process.env.WHISPER_BIN`. */
	whisperBin?: string;
	/** Whisper `--model` flag value (path or name whisper-cpp resolves). */
	model?: string;
}

export function buildTranscribeRouter(config: TranscribeConfig = {}): Hono {
	const app = new Hono();

	app.post("/transcribe", async (c) => {
		const bin = (config.whisperBin ?? process.env.WHISPER_BIN ?? "").trim();
		if (!bin) {
			return c.json({ error: "transcription backend not configured" }, 501);
		}

		let bytes: Uint8Array;
		let mimeType: string;
		let displayName: string | undefined;
		let language: string = "";
		try {
			const contentType = (c.req.header("content-type") ?? "").toLowerCase();
			if (!contentType.startsWith("multipart/form-data")) {
				return c.json(
					{
						error:
							"send multipart/form-data with an 'audio' file field and a 'language' text field",
					},
					400,
				);
			}
			const form = await c.req.formData();
			const audio = form.get("audio");
			if (!(audio instanceof File)) {
				return c.json({ error: "multipart upload requires 'audio' field" }, 400);
			}
			const languageRaw = form.get("language");
			language = typeof languageRaw === "string" ? languageRaw.trim().toLowerCase() : "";
			if (!ALLOWED_LANG[language]) {
				return c.json({ error: "language must be one of: fa, en, auto" }, 400);
			}
			bytes = new Uint8Array(await audio.arrayBuffer());
			mimeType = (audio.type || "").toLowerCase();
			displayName = audio.name;
		} catch (err) {
			log.error(`transcribe: multipart parse failed`, err);
			return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
		}

		if (bytes.byteLength === 0) {
			return c.json({ error: "empty audio" }, 400);
		}
		if (bytes.byteLength > MAX_BYTES) {
			return c.json(
				{ error: `audio exceeds ${MAX_BYTES} bytes (got ${bytes.byteLength})` },
				413,
			);
		}
		if (mimeType && !SUPPORTED_AUDIO[mimeType]) {
			return c.json({ error: `unsupported audio type: ${mimeType}` }, 415);
		}

		const ext = mimeTypeToExt(mimeType, displayName);
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-transcribe-"));
		const inputPath = path.join(tmpDir, `clip.${ext}`);
		await fs.writeFile(inputPath, bytes);

		const args = [
			"--language",
			languageArgFor(language),
			"--output-json",
			"-",
			"-f",
			inputPath,
		];
		if (config.model) args.push("--model", config.model);

		try {
			const proc = Bun.spawn({
				cmd: [bin, ...args],
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			if (exitCode !== 0) {
				log.error(`whisper exited ${exitCode}`, { stderr: stderr.slice(0, 2000) });
				return c.json(
					{ error: `whisper exited ${exitCode}: ${stderr.slice(0, 500)}` },
					500,
				);
			}
			const parsed = parseWhisperJson(stdout);
			if (!parsed) {
				return c.json({ error: "whisper produced unparseable output" }, 500);
			}
			return c.json({
				text: parsed.text ?? "",
				language: parsed.language ?? language,
				durationMs: Math.round(Number(parsed.duration ?? 0) * 1000),
			});
		} catch (err) {
			log.error(`whisper spawn failed`, err);
			return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
		} finally {
			fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	return app;
}

function mimeTypeToExt(mime: string, displayName: string | undefined): string {
	if (displayName) {
		const dot = displayName.lastIndexOf(".");
		if (dot > 0 && dot < displayName.length - 1) {
			const ext = displayName.slice(dot + 1).toLowerCase();
			if (/^[a-z0-9]{1,5}$/.test(ext)) return ext;
		}
	}
	switch (mime) {
		case "audio/wav":
		case "audio/x-wav":
		case "audio/wave":
			return "wav";
		case "audio/webm":
			return "webm";
		case "audio/ogg":
			return "ogg";
		case "audio/mpeg":
			return "mp3";
		case "audio/mp4":
		case "audio/x-m4a":
		case "audio/m4a":
			return "m4a";
		default:
			return "wav"; // whisper-cpp sniffs the header; default to a known-good container
	}
}

function languageArgFor(language: string): string {
	// whisper-cpp: "auto" = let it detect; otherwise 2-letter ISO code.
	return language === "auto" ? "auto" : language;
}

/**
 * whisper-cpp's `--output-json -` writes a single JSON object to stdout.
 * Defensive: trim BOM/whitespace, accept the first JSON-looking substring.
 */
function parseWhisperJson(raw: string): { text?: string; language?: string; duration?: number } | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(trimmed.slice(start, end + 1)) as {
			text?: string;
			language?: string;
			duration?: number;
		};
	} catch {
		return null;
	}
}