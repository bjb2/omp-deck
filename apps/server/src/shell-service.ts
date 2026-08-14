/**
 * Shell service — long-running captured-output processes for the in-deck
 * terminal pane (`/shell`). Each `Bun.spawn` runs `/bin/sh -c "<command>"`
 * (or `cmd.exe /d /s /c` on Windows); stdout+stderr are merged into a
 * bounded tail buffer and streamed to subscribers over SSE.
 *
 * Scope: log-tail. Not a real PTY. Programs that detect TTY (color,
 * progress bars, raw-mode input, prompt-toolkit / inquirer / jest-watch
 * style TUIs) will not render correctly. Use the local terminal for
 * those — this surface is for `bun run build`, `bun test`, `tsc`,
 * `git push`, grep, log tail, etc.
 *
 * Scope: single-tenant (one user per deck). Shells live for the server
 * lifetime. On `beforeExit` / `SIGTERM` we send SIGTERM to everything.
 *
 * Security: cwd is guarded by `path-guard.guardWorkspacePath` /
 * `guardAgentDirPath`. The server runs only on loopback by convention;
 * the harness's transport-level auth gate covers non-loopback hosts.
 */
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import { logger } from "./log.js";
import { guardAgentDirPath, guardWorkspacePath, isWorkspaceDir } from "./path-guard.js";

const log = logger("shell");

const TAIL_LIMIT = 64 * 1024;
const MAX_PROCESSES = 32;
const SUBSCRIBER_GRACE_MS = 5_000;

export interface ShellSummary {
	id: string;
	command: string;
	cwd: string;
	status: "running" | "exited";
	exitCode?: number;
	startedAt: string;
	exitedAt?: string;
}

interface Subscriber {
	id: string;
	push: (chunk: string) => void;
}

interface Shell {
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	exitedAt?: string;
	exitCode?: number;
	proc: ReturnType<typeof Bun.spawn>;
	stdin: Bun.FileSink;
	tail: Buffer;
	subscribers: Map<string, Subscriber>;
}

const shells = new Map<string, Shell>();

function shellForSummary(s: Shell): ShellSummary {
	const out: ShellSummary = {
		id: s.id,
		command: s.command,
		cwd: s.cwd,
		status: s.exitCode !== undefined ? "exited" : "running",
		startedAt: s.startedAt,
	};
	if (s.exitCode !== undefined) out.exitCode = s.exitCode;
	if (s.exitedAt) out.exitedAt = s.exitedAt;
	return out;
}

function resolveCwd(rawCwd: string | undefined): { ok: true; cwd: string } | { ok: false; error: string } {
	const fallback = process.env.OMP_DECK_DEFAULT_CWD || process.cwd();
	const raw = rawCwd?.trim() || fallback;
	const abs = resolvePath(raw);
	const ws = guardWorkspacePath(abs, { mustExist: true });
	if (ws.ok) return { ok: true, cwd: abs };
	const agent = guardAgentDirPath(abs, { mustExist: true });
	if (agent.ok) return { ok: true, cwd: abs };
	// Allow declared workspaces even if they don't exist yet — dev work
	// frequently starts in a not-yet-created directory.
	if (isWorkspaceDir(abs)) return { ok: true, cwd: abs };
	return { ok: false, error: `cwd not under a workspace root: ${abs}` };
}

function broadcastChunk(s: Shell, chunk: string): void {
	for (const sub of s.subscribers.values()) sub.push(chunk);
}

function purgeIfDone(s: Shell): void {
	if (s.exitCode === undefined) return;
	if (s.subscribers.size > 0) return;
	shells.delete(s.id);
	log.info(`shell: purged ${s.id} (exit=${s.exitCode})`);
}

function drainStream(
	stream: ReadableStream<Uint8Array> | undefined,
	s: Shell,
	prefix: "" | "\u001b[33m",
): Promise<void> {
	if (!stream) return Promise.resolve();
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	const queue: string[] = [];

	const onChunk = (chunk: string): void => {
		const tagged = prefix ? `${prefix}${chunk}\u001b[0m` : chunk;
		for (const sub of s.subscribers.values()) sub.push(tagged);
	};

	return reader.read().then(function loop(r): Promise<void> | void {
		if (r.done) return;
		if (r.value !== undefined) {
			const text = decoder.decode(r.value, { stream: true });
			queue.push(text);
			const merged = Buffer.concat(
				[s.tail, Buffer.from(text, "utf-8")],
			);
			s.tail = merged.length > TAIL_LIMIT ? merged.subarray(merged.length - TAIL_LIMIT) : merged;
			onChunk(text);
		}
		return reader.read().then(loop);
	}).catch((err: unknown) => {
		log.warn(`shell: ${s.id} stream reader error`, err);
	});
}

function buildCommandLine(command: string): string[] {
	return process.platform === "win32"
		? ["cmd.exe", "/d", "/s", "/c", command]
		: ["/bin/sh", "-c", command];
}

export const shell = {
	list(): ShellSummary[] {
		return [...shells.values()].map(shellForSummary);
	},

	get(id: string): ShellSummary | undefined {
		const s = shells.get(id);
		return s ? shellForSummary(s) : undefined;
	},

	tail(id: string): Buffer | undefined {
		return shells.get(id)?.tail;
	},

	create(command: string, rawCwd?: string): { ok: true; process: ShellSummary } | { ok: false; error: string } {
		if (!command.trim()) return { ok: false, error: "command is required" };
		if (shells.size >= MAX_PROCESSES) {
			return { ok: false, error: `max concurrent shells (${MAX_PROCESSES}) reached` };
		}
		const cwd = resolveCwd(rawCwd);
		if (!cwd.ok) return { ok: false, error: cwd.error };

		const proc = Bun.spawn({
			cmd: buildCommandLine(command),
			cwd: cwd.cwd,
			env: process.env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});

		const id = randomUUID();
		const startedAt = new Date().toISOString();
		const internal: Shell = {
			id,
			command,
			cwd: cwd.cwd,
			startedAt,
			proc,
			stdin: proc.stdin as Bun.FileSink,
			tail: Buffer.alloc(0),
			subscribers: new Map(),
		};
		shells.set(id, internal);
		log.info(`shell: spawned ${id} cmd=${JSON.stringify(command)} cwd=${cwd.cwd}`);

		void drainStream(proc.stdout as ReadableStream<Uint8Array> | undefined, internal, "");
		void drainStream(proc.stderr as ReadableStream<Uint8Array> | undefined, internal, "\u001b[33m");

		proc.exited.then((code) => {
			internal.exitCode = code ?? 0;
			internal.exitedAt = new Date().toISOString();
			log.info(`shell: ${id} exited code=${code}`);
			broadcastChunk(internal, `\r\n[exit ${code}]\r\n`);
			setTimeout(() => purgeIfDone(internal), SUBSCRIBER_GRACE_MS);
		});

		return { ok: true, process: shellForSummary(internal) };
	},

	write(id: string, input: string): { ok: boolean; error?: string } {
		const s = shells.get(id);
		if (!s) return { ok: false, error: "shell not found" };
		if (s.exitCode !== undefined) return { ok: false, error: "shell has exited" };
		try {
			s.stdin.write(input);
			return { ok: true };
		} catch (err) {
			return { ok: false, error: `stdin write failed: ${String((err as Error).message ?? err)}` };
		}
	},

	kill(id: string): { ok: boolean; error?: string } {
		const s = shells.get(id);
		if (!s) return { ok: false, error: "shell not found" };
		if (s.exitCode !== undefined) return { ok: true };
		try {
			try { s.stdin.end?.(); } catch { /* already closed */ }
			s.proc.kill("SIGTERM");
			return { ok: true };
		} catch (err) {
			return { ok: false, error: `kill failed: ${String((err as Error).message ?? err)}` };
		}
	},

	subscribe(id: string, push: (chunk: string) => void): () => void {
		const s = shells.get(id);
		if (!s) return () => {};
		const subId = randomUUID();
		s.subscribers.set(subId, { id: subId, push });
		return () => {
			s.subscribers.delete(subId);
			purgeIfDone(s);
		};
	},

	purge(id: string): boolean {
		const s = shells.get(id);
		if (!s || s.exitCode === undefined) return false;
		shells.delete(id);
		return true;
	},
};

process.on("beforeExit", () => {
	for (const s of shells.values()) {
		try { s.proc.kill("SIGTERM"); } catch (err) { log.warn(`shell: shutdown kill ${s.id}`, err); }
	}
});
process.on("SIGTERM", () => {
	for (const s of shells.values()) {
		try { s.proc.kill("SIGTERM"); } catch (err) { log.warn(`shell: shutdown kill ${s.id}`, err); }
	}
});
