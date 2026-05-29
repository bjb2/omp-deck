/**
 * Onboarding routes — drive the first-run wizard's state machine.
 *
 * GET  /api/onboarding/state          → OnboardingState (composite)
 * POST /api/onboarding/complete       → mark done (skipped flag distinguishes
 *                                       walked-through vs X-ed out)
 * POST /api/onboarding/seed-kb-system → write the four `system/*.md` stubs
 *                                       that the default `/start` body
 *                                       references; idempotent (won't
 *                                       overwrite existing files)
 *
 * Provider auth, kb init, start.md write, and env updates all reuse their
 * existing routes (`/api/auth/oauth/*`, `/api/kb/init`,
 * `/api/orientation/*`, `/api/env/*`). The wizard just sequences them.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { Hono } from "hono";

import type {
	CompleteOnboardingRequest,
	OnboardingState,
	SeedKbSystemRequest,
	SeedKbSystemResponse,
} from "@omp-deck/protocol";

import { resolveKbRoot } from "./kb-service.ts";
import { logger } from "./log.ts";
import { getOnboardingState, markOnboardingComplete } from "./onboarding-state.ts";

const log = logger("routes:onboarding");

/**
 * The four `kb://system/*.md` files the default `/start` body fetches.
 * Shipped as blank-ish stubs so the agent's read-on-orient flow returns
 * something rather than a stream of 404s. Users can edit / replace at
 * will — we never overwrite a file the user has touched.
 */
/**
 * Top-level README written at the kb root by `seed-kb-system`. Same
 * intent as the one rendered by `kb-service.initialize()` — drop a
 * starter file so the first-time visitor sees what a kb article looks
 * like (frontmatter shape + wikilink convention) and where to point new
 * content. Inlined here so the wizard can scaffold at any path the user
 * chooses, not just the server's resolved `OMP_DECK_KB_ROOT`.
 */
const KB_README_BODY = [
	"---",
	"type: knowledge",
	"tags: [meta, readme]",
	"---",
	"",
	"# Welcome to your KB",
	"",
	"This is a fresh knowledge base scaffolded by omp-deck onboarding. The deck",
	"reads this folder as a Karpathy-style llm-wiki — hand-tended markdown with",
	"YAML frontmatter and `[[wikilinks]]` between articles.",
	"",
	"## How it works",
	"",
	"- Each file is markdown with YAML frontmatter (`type`, `created`,",
	"  `updated`, `tags` are parsed automatically).",
	"- `[[some-file]]` resolves by filename stem. `[[dir/path]]` for explicit",
	"  paths. `[[target|label]]` to rename the rendered text.",
	"- The `/start` slash command reads `system/*.md` at session boot — drop",
	"  notes about your voice, projects, and org system there.",
	"",
	"## What this is NOT",
	"",
	"omp's session memory (rolling summaries, vector store) is separate. This kb",
	"is your long-term, hand-tended layer. They complement each other.",
	"",
	"Happy authoring.",
	"",
].join("\n");

const KB_SYSTEM_STUBS: ReadonlyArray<{ name: string; body: string }> = [
	{
		name: "working-voice.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, voice]",
			"---",
			"",
			"# Working voice",
			"",
			"How you prefer the agent to communicate with you. Drop short notes here as",
			"you notice things you want the agent to do or stop doing. Read at session",
			"start by the default `/start` command.",
			"",
			"## Examples",
			"",
			"- Be direct. Skip pleasantries.",
			"- Cite tasks by `T-N` ids.",
			"- Don't ask for confirmation on reversible actions.",
			"",
		].join("\n"),
	},
	{
		name: "deck-orientation.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, deck]",
			"---",
			"",
			"# Deck orientation",
			"",
			"Quick reference for what omp-deck is and the local API surface.",
			"",
			"## Capabilities",
			"",
			"- **Chat** — multi-session conversations with the omp agent.",
			"- **Tasks** — `T-N` kanban. `GET /api/tasks` for state.",
			"- **Routines** — cron / webhook / manual pipelines. `GET /api/routines`.",
			"- **Inbox** — quick-capture surface. `GET /api/inbox`.",
			"- **KB** — this folder. Read via `kb://` URIs or `GET /api/kb/file?path=…`.",
			"- **Skills** — installed under `~/.omp/agent/skills/`.",
			"",
			"## Local API base",
			"",
			"`http://127.0.0.1:8787/api` — reachable from any session via `bash` + `curl`.",
			"",
		].join("\n"),
	},
	{
		name: "projects-hub.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, projects]",
			"---",
			"",
			"# Active projects",
			"",
			"One-stop list of projects you're actively working on. Cross-reference",
			"with the kanban for in-flight tasks.",
			"",
			"## Example structure",
			"",
			"### project-name",
			"",
			"- **What:** one line",
			"- **Status:** active / paused / done",
			"- **Related tasks:** T-N, T-M",
			"",
		].join("\n"),
	},
	{
		name: "org-system-hub.md",
		body: [
			"---",
			"type: knowledge",
			"tags: [system, org]",
			"---",
			"",
			"# Org system hub",
			"",
			"How your work is organized. The agent reads this at session start to",
			"orient. Drop notes here about: where things live, how you triage, what",
			"counts as 'done', anything cross-cutting the agent should default to.",
			"",
		].join("\n"),
	},
];

export function buildOnboardingRouter(): Hono {
	const app = new Hono();

	app.get("/state", async (c) => {
		const state: OnboardingState = await getOnboardingState();
		return c.json(state);
	});

	app.post("/complete", async (c) => {
		let body: CompleteOnboardingRequest = { skipped: false };
		try {
			body = (await c.req.json()) as CompleteOnboardingRequest;
		} catch {
			// Empty body is fine — assume non-skipped completion.
		}
		markOnboardingComplete(Boolean(body.skipped));
		const state = await getOnboardingState();
		return c.json(state);
	});

	app.post("/seed-kb-system", async (c) => {
		let body: SeedKbSystemRequest = {};
		try {
			body = (await c.req.json()) as SeedKbSystemRequest;
		} catch {
			/* empty body uses defaults */
		}
		const kbRoot = body.kbRoot?.trim() || resolveKbRoot();
		const systemDir = path.join(kbRoot, "system");
		try {
			mkdirSync(systemDir, { recursive: true });
		} catch (err) {
			log.error(`mkdir failed at ${systemDir}`, err);
			return c.json({ error: String(err) }, 500);
		}
		const result: SeedKbSystemResponse = { created: [], skipped: [] };
		// Top-level README — same intent as kb-service.initialize() but writes
		// to whatever path the caller passes, not the server's resolved root.
		// (Lets the wizard scaffold at a user-chosen location without first
		// restarting the server to repoint OMP_DECK_KB_ROOT.)
		const readmePath = path.join(kbRoot, "README.md");
		if (!existsSync(readmePath)) {
			try {
				writeFileSync(readmePath, KB_README_BODY, "utf8");
				result.created.push("README.md");
			} catch (err) {
				log.warn(`failed to write ${readmePath}`, err);
				result.skipped.push("README.md");
			}
		} else {
			result.skipped.push("README.md");
		}
		for (const stub of KB_SYSTEM_STUBS) {
			const dest = path.join(systemDir, stub.name);
			if (existsSync(dest)) {
				result.skipped.push(`system/${stub.name}`);
				continue;
			}
			try {
				writeFileSync(dest, stub.body, "utf8");
				result.created.push(`system/${stub.name}`);
			} catch (err) {
				log.warn(`failed to write ${dest}`, err);
				result.skipped.push(`system/${stub.name}`);
			}
		}
		return c.json(result);
	});

	return app;
}
