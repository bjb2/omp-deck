/**
 * workflowz / orchestrate — multi-agent parallel dispatcher.
 *
 * Accepts a list of {prompt, model, cwd} tasks and runs them in parallel
 * against the live `AgentBridge`. Each task gets its own ephemeral session
 * so its transcript doesn't pollute the user's chat history. The dispatcher
 * returns a workflowId the UI can poll for status updates.
 *
 * Magic-word trigger surface (so the chat composer can intercept the special
 * keywords the user typed):
 *
 *   • `ultrathink <prompt>`  → enqueue with reasoning-effort = "high" + an
 *                              explicit "think deeply" preamble.
 *   • `workflowz <prompt>`   → fan out a 3-way parallel workflow: (a) the
 *                              original prompt, (b) a critique, (c) an
 *                              alternate approach. Synthesize on return.
 *   • `orchestrate <prompt>` → run as a workflow of 1 task but with a
 *                              dedicated orchestrator role (sets the session
 *                              title and the prelude).
 *
 * The chat composer is responsible for tokenizing the prefix off before
 * calling `dispatch`.
 */
import { randomUUID } from "node:crypto";

import type { AgentBridge } from "./bridge/types.ts";
import { logger } from "./log.ts";

const log = logger("workflowz");

export interface WorkflowzTask {
	prompt: string;
	model?: string;
	cwd?: string;
	role?: "primary" | "critique" | "alternate" | "synthesizer";
}

export interface WorkflowzDispatchResult {
	workflowId: string;
	tasks: Array<{ taskId: string; status: "queued" }>;
}

export interface WorkflowzStatus {
	workflowId: string;
	mode: string;
	startedAt: string;
	finishedAt?: string;
	results: Array<{
		taskId: string;
		role: string;
		status: "running" | "ok" | "error";
		output?: string;
		error?: string;
	}>;
}

function extractText(msg: { content?: string | Array<{ type?: string; text?: string }> }): string {
	const c = msg.content;
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map((p) => p.text ?? "").join("\n");
	return "";
}

function parseModelRef(s: string | undefined): { provider: string; id: string } | undefined {
	if (!s) return undefined;
	const [provider, ...rest] = s.split("/");
	if (!provider || rest.length === 0) return undefined;
	return { provider, id: rest.join("/") };
}
const inflight = new Map<string, WorkflowzStatus>();

export const workflowz = {
	async dispatch(bridge: AgentBridge, mode: string, tasks: WorkflowzTask[]): Promise<WorkflowzDispatchResult> {
		const workflowId = randomUUID();
		const expanded = expandTasks(mode, tasks);
		const status: WorkflowzStatus = {
			workflowId,
			mode,
			startedAt: new Date().toISOString(),
			results: expanded.map((t) => ({ taskId: randomUUID(), role: t.role ?? "primary", status: "running" })),
		};
		inflight.set(workflowId, status);
		void run(bridge, expanded, status);
		return {
			workflowId,
			tasks: status.results.map(({ taskId }) => ({ taskId, status: "queued" as const })),
		};
	},

	status(id: string): WorkflowzStatus | undefined {
		return inflight.get(id);
	},

	list(): WorkflowzStatus[] {
		return [...inflight.values()];
	},
};

function expandTasks(mode: string, tasks: WorkflowzTask[]): WorkflowzTask[] {
	if (mode === "parallel") return tasks;
	if (mode === "ultrathink") {
		return tasks.map((t) => ({
			...t,
			prompt: `Think deeply and step-by-step. Consider edge cases, alternatives, and tradeoffs.\n\n${t.prompt}`,
		}));
	}
	if (mode === "workflowz") {
		const out: WorkflowzTask[] = [];
		for (const t of tasks) {
			out.push(t);
			out.push({
				...t,
				role: "critique",
				prompt: `Critique the following request and find the flaws before answering:\n\n${t.prompt}`,
			});
			out.push({
				...t,
				role: "alternate",
				prompt: `Approach the same problem from a totally different angle:\n\n${t.prompt}`,
			});
			out.push({
				...t,
				role: "synthesizer",
				prompt: `Synthesize the previous three answers into one final response. Keep what is correct, drop what isn't, and explain why.\n\n${t.prompt}`,
			});
		}
		return out;
	}
	if (mode === "orchestrate") {
		return tasks.map((t) => ({
			...t,
			prompt: `You are the orchestrator. Plan, delegate, and synthesize — do not execute code yourself.\n\n${t.prompt}`,
		}));
	}
	return tasks;
}

async function run(bridge: AgentBridge, tasks: WorkflowzTask[], status: WorkflowzStatus): Promise<void> {
	await Promise.all(tasks.map(async (t, idx) => {
		const slot = status.results[idx]!;
		try {
			const cwd = t.cwd ?? process.cwd();
			const modelRef = parseModelRef(t.model);
			const session = await bridge.createSession({ cwd, ...(modelRef ? { model: modelRef } : {}) });
			const handle = bridge.getSession(session.sessionId);
			if (!handle) throw new Error("workflowz: session vanished");
			await handle.prompt(t.prompt);
			const snap = handle.snapshot();
			const msgs = Array.isArray(snap.messages) ? (snap.messages as unknown[]) : [];
			const lastAssistant = [...msgs].reverse().find((m) => {
				const r = (m as { role?: unknown }).role;
				return typeof r === "string" && r === "assistant";
			});
			slot.status = "ok";
			slot.output = lastAssistant
				? extractText(lastAssistant as { content?: string | Array<{ type?: string; text?: string }> })
				: "(no response)";
		} catch (err) {
			slot.status = "error";
			slot.error = String((err as Error).message ?? err);
			log.warn(`workflowz task failed`, err);
		}
	}));
	status.finishedAt = new Date().toISOString();
}
