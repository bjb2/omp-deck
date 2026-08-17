/**
 * Auto-kanban: deterministic splitter that turns a Composer prompt into one
 * Task per separable cue, plus the persistence wrapper. Runs server-side on
 * every prompt send (WS hook) and on the client-belt-and-braces REST
 * endpoint at `/api/tasks/from-message`.
 *
 * Heuristics are intentionally regex-only — no LLM, no embeddings, no
 * network. The parser must be cheap, total, and predictable so the
 * "Auto-created N tasks" toast never surprises a user.
 *
 * Cue sources, in priority order:
 *   1. Bullet lines (`- `, `* `, `•`) — each line = one cue.
 *   2. Numbered lines (`1. `, `2) `, etc.) — each line = one cue.
 *   3. Sentences separated by `.`, `!`, `?`, or `;` that contain an
 *      imperative verb (`fix`, `add`, `refactor`, `implement`, `remove`,
 *      `write`, `build`, `ship`, `investigate`, `check`, `update`,
 *      `document`, `design`, `plan`, `test`, `review`, `wire`,
 *      `rename`, `migrate`, `enable`, `disable`, `extract`, `replace`,
 *      `simplify`, `optimize`, `debug`, `track`, `note`, `schedule`,
 *      `convert`) followed by a noun-ish token.
 *
 * Cap: 25 cues per message. Excess cues are dropped — only the most
 * structured ones (bullets/numbers) earn their slot.
 */

import type { Task } from "@omp-deck/protocol";

import { logger } from "./log.ts";
import { broadcastBus } from "./broadcast-bus.ts";
import { createTask } from "./db/tasks.ts";

const log = logger("auto-kanban");

const MAX_CUES = 25;

export interface ParsedCue {
	/** Short title for the kanban card (first ~80 chars, trimmed). */
	title: string;
	/** Full cue text for the task body. */
	body?: string;
}

/**
 * Imperative verbs we recognize as "this is an action the user wants
 * tracked". Order matters: longer / more-specific verbs must come before
 * shorter matches so `implement` doesn't shadow `implementer` (the regex
 * uses word boundaries, so this is mostly belt-and-braces for the future).
 */
const IMPERATIVE_VERBS = [
	"investigate",
	"implement",
	"refactor",
	"migrate",
	"optimize",
	"document",
	"simplify",
	"remember",
	"schedule",
	"convert",
	"replace",
	"extract",
	"disable",
	"enable",
	"rename",
	"design",
	"review",
	"remove",
	"build",
	"write",
	"debug",
	"check",
	"track",
	"note",
	"ship",
	"plan",
	"test",
	"wire",
	"fix",
	"add",
	"upd",
] as const;

const VERB_REGEX = new RegExp(
	`\\b(?:${IMPERATIVE_VERBS.join("|")})\\b\\s+(?:the\\s+|a\\s+|an\\s+)?(\\S+(?:\\s+\\S+){0,4})`,
	"i",
);

/** Bullet marker at the start of a line: `-`, `*`, `•`. */
const BULLET_REGEX = /^\s*([-*•])\s+(.+?)\s*$/;
const NUMBERED_REGEX = /^\s*(\d+)[.)]\s+(.+?)\s*$/;

export function parseTaskCues(text: string): ParsedCue[] {
	if (!text || typeof text !== "string") return [];
	const lines = text.split(/\r?\n/);
	const cues: ParsedCue[] = [];

	// Pass 1: bullets & numbered lines dominate when present. One cue per
	// line; skip blank lines.
	for (const line of lines) {
		if (cues.length >= MAX_CUES) break;
		const trimmed = line.trim();
		if (!trimmed) continue;
		const bulleted = BULLET_REGEX.exec(trimmed);
		if (bulleted) {
			cues.push(titleAndBody(bulleted[2] ?? ""));
			continue;
		}
		const numbered = NUMBERED_REGEX.exec(trimmed);
		if (numbered) {
			cues.push(titleAndBody(numbered[2] ?? ""));
		}
	}

	if (cues.length >= MAX_CUES) return cues;

	// Pass 2: sentence-level imperative detection. Only engages when we
	// haven't already parsed ≥2 structured cues — otherwise dense bullet
	// lists would trigger duplicate sentence splits of the same work.
	if (cues.length < 2) {
		const sentenceCues = extractSentenceCues(text);
		for (const cue of sentenceCues) {
			if (cues.length >= MAX_CUES) break;
			cues.push(cue);
		}
	}

	return cues;
}

function titleAndBody(raw: string): ParsedCue {
	const clean = raw.replace(/\s+/g, " ").trim();
	const title = clean.length > 80 ? `${clean.slice(0, 77)}…` : clean;
	return { title, body: clean };
}

/** Split freeform prose into imperative sentences. */
function extractSentenceCues(text: string): ParsedCue[] {
	const segments = text
		.split(/(?<=[.!?;])\s+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const out: ParsedCue[] = [];
	for (const seg of segments) {
		if (out.length >= MAX_CUES) break;
		// Strip trailing punctuation for matching; keep body verbatim.
		const match = VERB_REGEX.exec(seg);
		if (!match) continue;
		out.push(titleAndBody(seg));
	}
	return out;
}

/** Compose the canonical task body: tags header + full cue text. */
function buildBody(cue: ParsedCue, project: string, cwd: string): string {
	const tags = `auto,project-${project}`;
	const header = `tags: ${tags} · cwd: ${cwd}`;
	const clean = cue.body ?? cue.title;
	return `${header}\n\n${clean}`;
}

/**
 * Persist parsed cues as Tasks tagged `auto,project-<project>` and
 * broadcast `tasks_changed` once. Returns the freshly-created rows in
 * declaration order. Caller can ignore the return; failures are logged
 * but never thrown — auto-kanban is fire-and-forget from the prompt
 * send's perspective.
 */
export async function createAutoTasks(
	cues: ParsedCue[],
	cwd: string,
	project: string,
): Promise<Task[]> {
	if (cues.length === 0) return [];
	const created: Task[] = [];
	for (const cue of cues) {
		try {
			const task = createTask({
				title: cue.title,
				body: buildBody(cue, project, cwd),
				cwd: cwd || undefined,
			});
			created.push(task);
		} catch (err) {
			log.warn(`auto-kanban: failed to create task "${cue.title}"`, err);
		}
	}
	if (created.length > 0) {
		broadcastBus.broadcast({ type: "tasks_changed" });
	}
	return created;
}
