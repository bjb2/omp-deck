/**
 * `run` step: shell command. cmd /c on Windows, bash -lc on POSIX. Template-
 * substitutes `command` and `cwd` before exec.
 */

import type { RoutineStep } from "@omp-deck/protocol";
import { renderString } from "../template.ts";
import type { RunContext, StepResult } from "../types.ts";
import { routineRunSpawnEnv } from "../../spawn-env.ts";

const MAX_EXCERPT = 8 * 1024;

export async function executeRunStep(
	step: Extract<RoutineStep, { type: "run" }>,
	context: RunContext,
	signal: AbortSignal,
	defaultCwd: string,
): Promise<StepResult> {
	const startedMs = Date.now();
	const command = renderString(step.command, context as unknown as Record<string, unknown>);
	const cwd = step.cwd
		? renderString(step.cwd, context as unknown as Record<string, unknown>)
		: defaultCwd;
	const isWin = process.platform === "win32";
	const cmd = isWin ? ["cmd", "/c", command] : ["bash", "-lc", command];

	try {
		const proc = Bun.spawn(cmd, {
			cwd,
			// SECURITY-027: routine bodies are less-trusted than interactive
			// user shells — imported or sync'd routines can be hostile. Strip
			// provider secrets; only path/home/tmp/locale + internal-runner
			// tokens survive. See apps/server/src/spawn-env.ts.
			env: routineRunSpawnEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const onAbort = () => {
			try {
				proc.kill();
			} catch {
				/* already gone */
			}
		};
		signal.addEventListener("abort", onAbort);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				readClipped(proc.stdout),
				readClipped(proc.stderr),
				proc.exited,
			]);
			const durationMs = Date.now() - startedMs;
			if (signal.aborted) {
				return {
					status: "aborted",
					stdoutExcerpt: stdout,
					stderrExcerpt: stderr,
					error: "aborted",
					durationMs,
				};
			}
			const status: StepResult["status"] = exitCode === 0 ? "success" : "failed";
			return {
				status,
				stdoutExcerpt: stdout,
				stderrExcerpt: stderr,
				error: status === "failed" ? `exit code ${exitCode}` : undefined,
				durationMs,
			};
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	} catch (err) {
		return {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: String(err),
			durationMs: Date.now() - startedMs,
		};
	}
}

async function readClipped(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8");
	let acc = "";
	let capped = false;
	// Drain-and-discard once capped. We MUST NOT cancel the reader: doing so
	// closes the consumer end of the OS pipe, and the child's next write
	// raises EPIPE (Windows: OSError errno 22) which propagates through
	// Python's `print(flush=True)` and crashes long-output processes like
	// run_daily.py mid-fetch. Quietly consume the remainder, keep the first
	// MAX_EXCERPT bytes plus a truncation marker.
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!capped) {
			acc += decoder.decode(value, { stream: true });
			if (acc.length > MAX_EXCERPT) {
				acc = acc.slice(0, MAX_EXCERPT) + "\n…(truncated)";
				capped = true;
			}
		}
	}
	if (!capped) acc += decoder.decode();
	return acc;
}
