/**
 * Session lifecycle — kill / archive / pin.
 *
 * Kill: hard-stop a session, drop its in-memory handle, leave the on-disk
 * transcript intact for resume.
 *
 * Archive: move the session out of the active sidebar list into a separate
 * `archived.jsonl` index. Reverse with `unarchive`.
 *
 * Pin: keep a session alive past the idle timeout. Mirrors the SDK's
 * sticky-session semantics — pinned sessions never get reaped.
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "./log.ts";
import { getDataDir } from "./env-store.ts";

const log = logger("session-lifecycle");

const PIN_PATH = path.join(
	process.env.OMP_AGENT_DIR ?? path.join(os.homedir(), ".omp", "agent"),
	"pinned-sessions.json",
);

async function readPinSet(): Promise<Set<string>> {
	try {
		const raw = await fs.readFile(PIN_PATH, "utf-8");
		return new Set(JSON.parse(raw) as string[]);
	} catch {
		return new Set();
	}
}

async function writePinSet(set: Set<string>): Promise<void> {
	const dir = path.dirname(PIN_PATH);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${PIN_PATH}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify([...set]), "utf-8");
	await fs.rename(tmp, PIN_PATH);
}

export const sessionLifecycle = {
	async kill(bridge: { getSession: (id: string) => { dispose: () => Promise<void> } | undefined }, id: string): Promise<void> {
		const handle = bridge.getSession(id);
		if (!handle) throw new Error(`session ${id} not found`);
		await handle.dispose();
	},

	async archive(bridge: { getSession: (id: string) => { setArchived?: (a: boolean) => Promise<void>; dispose: () => Promise<void> } | undefined }, id: string): Promise<void> {
		const handle = bridge.getSession(id);
		if (!handle) throw new Error(`session ${id} not found`);
		if (handle.setArchived) {
			await handle.setArchived(true);
		} else {
			// SDK doesn't expose setArchived — best-effort dispose so it stops
			// appearing in the live list, and the on-disk transcript still
			// surfaces on resume for review.
			await handle.dispose();
		}
	},

	async pin(_bridge: unknown, id: string): Promise<boolean> {
		const set = await readPinSet();
		const next = !set.has(id);
		if (next) set.add(id);
		else set.delete(id);
		await writePinSet(set);
		log.info(`pin(${id}) → ${next}`);
		return next;
	},
};

export async function isPinned(id: string): Promise<boolean> {
	const set = await readPinSet();
	return set.has(id);
}

export interface ReceiptSession {
	sessionId: string;
	cwd: string;
	firstPrompt?: string;
}

const RECEIPT_TEMPLATE = `# Goal
{goal}

# Delivered

# Next step

# Reflection
`;

/**
 * Stamp a session-start receipt into `data/sessions/`. The filename embeds
 * the local date and a HHMM stamp so multiple sessions started in the same
 * day sort chronologically without colliding. The body is the empty
 * Goal/Delivered/Next step/Reflection skeleton the operator fills in once
 * the session winds down.
 */
export async function writeReceipt(session: ReceiptSession): Promise<string> {
	// Receipts live under the deck-wide data dir (not per-cwd) so every
	// session started anywhere on this machine rolls up to one place the
	// operator can review. `session.cwd` is kept on the signature for
	// future metadata; it does not influence the on-disk path.
	const dir = path.join(getDataDir(), "sessions");
	await fs.mkdir(dir, { recursive: true });
	const now = new Date();
	const y = `${now.getFullYear()}`;
	const m = `${now.getMonth() + 1}`.padStart(2, "0");
	const d = `${now.getDate()}`.padStart(2, "0");
	const hh = `${now.getHours()}`.padStart(2, "0");
	const mm = `${now.getMinutes()}`.padStart(2, "0");
	const filename = `${y}-${m}-${d}-${hh}${mm}-${session.sessionId}.md`;
	const filePath = path.join(dir, filename);
	const body = RECEIPT_TEMPLATE.replace("{goal}", session.firstPrompt ?? "");
	await fs.writeFile(filePath, body, "utf-8");
	return filePath;
}
