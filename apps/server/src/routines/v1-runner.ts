/**
 * V1 multi-step routine pipeline executor. Stateless module-level function
 * called by routines-runner.ts's `fire()` method when `routine.specVersion === 1`.
 *
 * Per-step responsibilities:
 *   1. Evaluate `when:` in the sandbox; insert a 'skipped' step_run and skip
 *      if falsy.
 *   2. Insert a 'running' step_run; broadcast routine_step_event.
 *   3. Dispatch to the step's executor with an AbortSignal + the routine's
 *      cwd hint + the runId (for the http step's internal-auth header).
 *   4. Honor `on_failure: abort|continue|retry`. Retry semantics: bounded by
 *      `retry.times`; exponential or linear backoff; falls through to
 *      `after_retry` (default 'abort') if all retries fail.
 *   5. Accumulate the step's tokens/cost into the run-level budget; check
 *      caps; abort the run with `abort_reason='budget'` if any cap exceeded.
 *   6. Update the in-memory RunContext so downstream steps see the prior
 *      step's outputs via `steps.<id>.<field>`.
 *
 * Failure modes are first-class — exceptions from executors become
 * StepResult{status='failed'}; the runner itself only throws on
 * unrecoverable infrastructure errors (db unreachable, etc.).
 */

import { parse as parseYaml } from "yaml";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import type {
	Routine,
	RoutineSpec,
	RoutineStep,
} from "@omp-deck/protocol";

import { broadcastBus } from "../broadcast-bus.ts";
import { notificationService } from "../notifications/index.ts";
import { finalizeRun, finishStepRun, insertSkippedStepRun, startStepRun } from "../db/routine-step-runs.ts";
import { sendToAll } from "../push-service.ts";
import type { WsHub } from "../ws.ts";
import { logger } from "../log.ts";
import { accumulate, checkBudget, newBudgetState } from "./budget.ts";
import { evaluate } from "./sandbox.ts";
import { executeAgentStep } from "./steps/agent.ts";
import { executeDeckStep } from "./steps/deck.ts";
import { executeHttpStep } from "./steps/http.ts";
import { executeMcpStep } from "./steps/mcp.ts";
import { executeRunStep } from "./steps/run.ts";
import { executeSetStateStep } from "./steps/set_state.ts";
import { executeTransformStep } from "./steps/transform.ts";
import { executeWaitStep } from "./steps/wait.ts";
import { executeWriteStep } from "./steps/write.ts";
import { loadState } from "./state.ts";
import type { AbortReason, RunContext, StepContextEntry, StepResult } from "./types.ts";

const log = logger("routines-v1");

export interface V1RunHandle {
	runId: string;
	abort: AbortController;
	finished: Promise<{ status: "success" | "failed" | "aborted"; abortReason?: AbortReason }>;
}

/**
 * Parse a routine's `specYaml` into a typed RoutineSpec. Returns null if
 * the routine isn't V1 or the YAML is malformed (caller logs + aborts run).
 */
export function parseSpec(routine: Routine): RoutineSpec | null {
	if (routine.specVersion !== 1 || !routine.specYaml) return null;
	try {
		return parseYaml(routine.specYaml) as RoutineSpec;
	} catch (err) {
		log.warn(`failed to parse spec_yaml for routine ${routine.id}`, err);
		return null;
	}
}

export async function runV1Pipeline(input: {
	routine: Routine;
	spec: RoutineSpec;
	runId: string;
	triggerKind: "cron" | "manual" | "webhook" | "event";
	triggerPayload: Record<string, unknown>;
	abortSignal: AbortSignal;
	defaultCwd: string;
	/**
	 * Per-run sandbox root for `agent` steps. The runner creates
	 * `<agentSandboxRoot>/<runId>/` lazily on the first `agent` step and uses
	 * it as the cwd for that step's `omp -p` child process. Keeps agent steps
	 * away from the user's home (where unrelated files may be inferred by
	 * the coding agent as 'briefing material').
	 */
	agentSandboxRoot: string;
	wsHub?: WsHub;
}): Promise<{ status: "success" | "failed" | "aborted"; abortReason?: AbortReason }> {
	const { routine, spec, runId, triggerKind, triggerPayload, abortSignal, defaultCwd, agentSandboxRoot, wsHub } = input;
	const startedAt = new Date();
	const startedAtIso = startedAt.toISOString();
	const startedMs = Date.now();

	// Initialize context.
	const context: RunContext = {
		run: {
			id: runId,
			started: startedAtIso,
			iso_started: startedAtIso,
			date: startedAtIso.slice(0, 10),
			trigger_kind: triggerKind,
		},
		trigger: triggerPayload,
		steps: {},
		env: filterEnv(process.env),
		secrets: {}, // V1: tenant `.env` secrets not yet plumbed through; placeholder
		state: loadState(routine.id),
	};

	const budget = newBudgetState(() => Date.now());
	const broadcast = (frame: Parameters<typeof broadcastBus.broadcast>[0]) => broadcastBus.broadcast(frame);

	broadcast({
		type: "routine_run_started",
		routineId: routine.id,
		runId,
		triggerKind,
		startedAt: startedAtIso,
	});

	let stepCountTotal = 0;
	let stepCountFailed = 0;
	let abortReason: AbortReason | undefined;
	let aggregateStdout = "";

	const stepCwd = (routine.actionCwd && routine.actionCwd.trim()) || defaultCwd;

	// Lazy mkdir for the per-run agent sandbox. Created the first time an
	// `agent` step runs; left in place after the run finishes so the user can
	// inspect whatever scratch files the coding agent dropped. Pure-deck-step
	// runs (no `agent` step) never touch the filesystem.
	const runSandboxDir = path.join(agentSandboxRoot, runId);
	let runSandboxEnsured = false;
	const ensureAgentSandbox = async (): Promise<string> => {
		if (!runSandboxEnsured) {
			await mkdir(runSandboxDir, { recursive: true });
			runSandboxEnsured = true;
		}
		return runSandboxDir;
	};

	for (let i = 0; i < spec.steps.length; i++) {
		if (abortSignal.aborted) {
			abortReason = "cancelled";
			break;
		}
		const step = spec.steps[i];
		if (!step) continue;

		// `when:` gating
		if (step.when) {
			let truthy: unknown;
			try {
				truthy = await evaluate(step.when, context as unknown as Record<string, unknown>);
			} catch (err) {
				log.warn(`when-eval failed for step ${step.id}`, err);
				truthy = false;
			}
			if (!truthy) {
				insertSkippedStepRun({
					runId,
					stepId: step.id,
					stepIndex: i,
					stepType: step.type,
				});
				context.steps[step.id] = {
					status: "skipped",
					stdout: "",
					stderr: "",
					duration_ms: 0,
				};
				broadcast({
					type: "routine_step_event",
					runId,
					stepId: step.id,
					stepIndex: i,
					status: "skipped",
				});
				continue;
			}
		}

		// Execute with retry policy.
		const attemptCap = step.retry?.times ?? 1;
		const backoff = step.retry?.backoff ?? "exponential";
		const maxDelaySecs = step.retry?.max_delay_secs ?? 60;
		let lastResult: StepResult | undefined;
		let attempt = 0;
		while (attempt < Math.max(1, attemptCap)) {
			attempt += 1;
			const stepRunId = startStepRun({
				runId,
				stepId: step.id,
				stepIndex: i,
				stepType: step.type,
				attempt,
			});
			broadcast({
				type: "routine_step_event",
				runId,
				stepId: step.id,
				stepIndex: i,
				status: "running",
				startedAt: new Date().toISOString(),
			});

			const result = await dispatchStep(step, context, abortSignal, defaultCwd, stepCwd, runId, routine.id, ensureAgentSandbox);
			lastResult = result;
			finishStepRun(stepRunId, {
				status: result.status,
				stdoutExcerpt: result.stdoutExcerpt,
				stderrExcerpt: result.stderrExcerpt,
				outputJson: result.json !== undefined ? safeJson(result.json) : null,
				error: result.error ?? null,
				model: result.model ?? null,
				llmTokensIn: result.llmTokensIn ?? null,
				llmTokensOut: result.llmTokensOut ?? null,
				llmCostMicros: result.llmCostMicros ?? null,
				durationMs: result.durationMs,
			});
			broadcast({
				type: "routine_step_event",
				runId,
				stepId: step.id,
				stepIndex: i,
				status: result.status,
				endedAt: new Date().toISOString(),
				durationMs: result.durationMs,
				excerpt: {
					stdout: result.stdoutExcerpt,
					stderr: result.stderrExcerpt,
				},
				outputJson: result.json,
				error: result.error,
				model: result.model,
				tokens:
					result.llmTokensIn != null
						? { in: result.llmTokensIn, out: result.llmTokensOut ?? 0 }
						: undefined,
			});

			if (result.status === "success" || result.status === "aborted") break;

			// failed — maybe retry
			if (attempt < attemptCap) {
				const delaySecs = Math.min(
					backoff === "exponential" ? Math.pow(2, attempt - 1) : attempt,
					maxDelaySecs,
				);
				await sleep(delaySecs * 1000, abortSignal);
			}
		}

		const finalResult: StepResult = lastResult ?? {
			status: "failed",
			stdoutExcerpt: "",
			stderrExcerpt: "",
			error: "no result produced",
			durationMs: 0,
		};

		// Update context.steps for downstream steps.
		const ctxEntry: StepContextEntry = {
			status: finalResult.status,
			stdout: finalResult.stdoutExcerpt,
			stderr: finalResult.stderrExcerpt,
			duration_ms: finalResult.durationMs,
		};
		if (finalResult.json !== undefined) ctxEntry.json = finalResult.json;
		if (finalResult.error !== undefined) ctxEntry.error = finalResult.error;
		if (finalResult.model !== undefined) ctxEntry.model = finalResult.model;
		if (finalResult.llmTokensIn != null) {
			ctxEntry.tokens = { in: finalResult.llmTokensIn, out: finalResult.llmTokensOut ?? 0 };
		}
		context.steps[step.id] = ctxEntry;

		stepCountTotal += 1;
		accumulate(budget, finalResult);
		aggregateStdout = appendClipped(aggregateStdout, finalResult.stdoutExcerpt);

		if (finalResult.status === "failed" || finalResult.status === "aborted") {
			stepCountFailed += 1;
			const onFailure = step.on_failure ?? "abort";
			const afterRetry = step.retry?.after_retry ?? "abort";
			const effective = onFailure === "retry" ? afterRetry : onFailure;
			if (effective === "abort" || finalResult.status === "aborted") {
				abortReason = finalResult.status === "aborted" ? "cancelled" : "failure";
				break;
			}
			// continue: fall through to next step
		}

		// Budget check between steps.
		const exceeded = checkBudget(budget, spec.budget, () => Date.now());
		if (exceeded) {
			log.info(`run ${runId} hit budget limit ${exceeded.limit} (${exceeded.value} > ${exceeded.cap})`);
			abortReason = "budget";
			break;
		}
	}

	const endedAtIso = new Date().toISOString();
	const finalStatus: "success" | "failed" | "aborted" =
		abortReason === undefined ? "success" : abortReason === "cancelled" ? "aborted" : "failed";

	const finalizePatch: Parameters<typeof finalizeRun>[1] = {
		endedAt: endedAtIso,
		stdoutExcerpt: aggregateStdout,
		stderrExcerpt: "",
		totalLlmTokens: budget.totalTokensIn + budget.totalTokensOut,
		totalLlmCostMicros: budget.totalCostMicros,
		stepCountTotal,
		stepCountFailed,
	};
	if (finalStatus === "success") {
		finalizePatch.exitCode = 0;
	} else {
		finalizePatch.exitCode = null;
		finalizePatch.abortedAt = endedAtIso;
		finalizePatch.abortReason = abortReason ?? null;
		finalizePatch.error = abortReason ? `aborted: ${abortReason}` : null;
	}
	finalizeRun(runId, finalizePatch);

	// Push a notification when the run ended badly. Success is silent on
	// purpose — successful unattended routines should not buzz the user.
	if (finalStatus !== "success") {
		const level: "warn" | "error" = abortReason === "budget" ? "warn" : "error";
		const reasonLabel = abortReason === "budget"
			? "budget cap"
			: abortReason === "cancelled"
			? "cancelled"
			: abortReason === "timeout"
			? "timed out"
			: abortReason ?? "failed";
		void notificationService.notify({
			level,
			title: `routine "${routine.name}" ${reasonLabel}`,
			body: stepCountFailed > 0
				? `${stepCountFailed} step(s) failed out of ${stepCountTotal}`
				: undefined,
			source: `routine:${routine.id}/run:${runId}`,
			actionUrl: `/routines/${routine.id}/runs/${runId}`,
		});
	}

	// Send Web Push notification if the user is not actively at their desk
	// (no WS activity in the last 30s).
	if (!wsHub || !wsHub.hasRecentActivity(30_000)) {
		const suffix = finalStatus === "success" ? "completed" : finalStatus === "failed" ? "failed" : "aborted";
		const summary = stepCountFailed > 0
			? `${stepCountFailed}/${stepCountTotal} step(s) failed`
			: `${stepCountTotal} step(s) ${suffix}`;
		void sendToAll({
			title: `${routine.name} ${suffix}`,
			body: summary,
			actionUrl: `/routines/${routine.id}/runs/${runId}`,
			tag: `routine-${routine.id}`,
		}).catch((err) => {
			log.debug(`routine completion push failed: ${String(err)}`);
		});
	}

	broadcast({
		type: "routine_run_finished",
		runId,
		status: finalStatus,
		...(abortReason ? { abortReason } : {}),
		endedAt: endedAtIso,
		durationMs: Date.now() - startedMs,
		totalCostMicros: budget.totalCostMicros,
	});

	return abortReason ? { status: finalStatus, abortReason } : { status: finalStatus };
}

/**
 * Fire a Web Push notification when a session proposes a plan, guarded by
 * WS activity check (suppressed if user active within 30s).
 */
export function notifyPlanProposed(sessionId: string, proposalId: string, wsHub?: WsHub): void {
	if (wsHub?.hasRecentActivity(30_000)) return;
	void sendToAll({
		title: "Plan proposed",
		body: "A new plan requires your approval",
		actionUrl: `/chat?session=${encodeURIComponent(sessionId)}`,
		tag: `plan-${proposalId}`,
	}).catch((err) => {
		log.debug(`plan_proposed push failed: ${String(err)}`);
	});
}


async function dispatchStep(
	step: RoutineStep,
	context: RunContext,
	signal: AbortSignal,
	defaultCwd: string,
	routineCwd: string,
	runId: string,
	routineId: string,
	ensureAgentSandbox: () => Promise<string>,
): Promise<StepResult> {
	switch (step.type) {
		case "run":
			return executeRunStep(step, context, signal, routineCwd);
		case "agent": {
			// Agent steps shell out to `omp -p`, which is a full coding agent
			// with read / bash / search / etc. Run it in a deck-owned per-run
			// scratch dir so it can't latch onto unrelated files in the user's
			// home and use them as 'input data' (daily-briefing drift case).
			const sandbox = await ensureAgentSandbox();
			return executeAgentStep(step, context, signal, sandbox);
		}
		case "write":
			return executeWriteStep(step, context, signal, routineCwd);
		case "http":
			return executeHttpStep(step, context, signal, runId);
		case "deck":
			return executeDeckStep(step, context, signal);
		case "mcp":
			return executeMcpStep(step, context, signal);
		case "transform":
			return executeTransformStep(step, context, signal);
		case "wait":
			return executeWaitStep(step, context, signal);
		case "set_state":
			return executeSetStateStep(step, context, signal, routineId);
		default: {
			void defaultCwd;
			return {
				status: "failed",
				stdoutExcerpt: "",
				stderrExcerpt: "",
				error: `unknown step type: ${(step as { type: string }).type}`,
				durationMs: 0,
			};
		}
	}
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

function safeJson(value: unknown): string | null {
	try {
		return JSON.stringify(value);
	} catch {
		return null;
	}
}

function appendClipped(acc: string, more: string): string {
	const MAX = 8 * 1024;
	if (acc.length >= MAX) return acc;
	const room = MAX - acc.length;
	return acc + (more.length > room ? more.slice(0, room) + "\n…(truncated)" : more);
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
	await new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	});
}

