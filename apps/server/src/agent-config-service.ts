/**
 * Agent-config manager: browse and edit `OMP_AGENT_DIR` (subagents, skills,
 * extensions, rules, MCP config, model routing), and safely import a whole
 * replacement directory — e.g. the `~/.omp/agent` from another machine.
 *
 * The import flow is the interesting part. The instinct "turn omp off, wipe
 * the folder, drop the new files in, turn it back on" is correct — but doing
 * those steps by hand around a *live* server is exactly how you corrupt the
 * SQLite files the SDK has open (`agent.db`, `models.db`, the maintenance-gate
 * state) or end up with half a directory if something fails midway. This
 * module gets the same outcome mechanically, safely:
 *
 *   1. stageImport — extract the uploaded archive into a *sibling* directory
 *      (`<agentDir>.staged-<id>`), never touching the live directory. Compute
 *      a plan (added / changed / removed paths) so the operator can see
 *      exactly what's about to happen before committing to it.
 *   2. applyStagedImport — an atomic two-`rename` swap: the live directory
 *      moves aside to `<agentDir>.backup-<timestamp>` (never deleted — that
 *      IS the backup) and the staged directory moves into its place. Renames
 *      within the same filesystem are atomic, so a crash between the two
 *      renames is impossible to land in — either both happened or neither did.
 *   3. The caller restarts the server process afterward. That's the "turn omp
 *      off" the user asked for, except ordered correctly: swap the files
 *      first (fast, atomic, the process doesn't need to be down for it),
 *      *then* restart so the SDK opens the new `agent.db`/`models.db` fresh
 *      rather than continuing to hold the old ones' file handles.
 *
 * `discardStagedImport` cleans up a staged directory the operator decided not
 * to apply, and old backups are listed (never auto-deleted — that decision is
 * the operator's, not this module's).
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadConfig } from "./config.ts";
import { guardAgentDirPath } from "./path-guard.ts";
import { logger } from "./log.ts";

const log = logger("agent-config-service");

export class GuardError extends Error {}
export class NoAgentDirError extends Error {}
export class ImportError extends Error {}

function agentDir(): string {
	const dir = loadConfig().agentDir;
	if (!dir) throw new NoAgentDirError("OMP_AGENT_DIR is not configured on this server");
	return path.resolve(dir);
}

/** Files never opened for text editing — live SQLite state, not config. */
const BINARY_SKIP = new Set([".db", ".sqlite", ".sqlite3"]);

// ─── Browse / edit ──────────────────────────────────────────────────────────

export interface AgentFileEntry {
	name: string;
	path: string;
	kind: "file" | "dir";
	sizeBytes: number | null;
	modifiedAt: string | null;
	/** True for recognized live-state files the editor should treat as read-only/download-only. */
	isDatabase: boolean;
}

/**
 * List a directory under the agent dir. `target` is an absolute path — same
 * contract as `files-service.listDir` — or empty/omitted for the agent dir
 * root itself. Matching that contract (rather than a "relative sub-path"
 * one) is what lets the web client's `FileTree` component be reused verbatim
 * for both the workspace explorer and this browser: it always passes back
 * the absolute `path` values a previous listing returned.
 */
export async function listAgentDir(target: string): Promise<{ path: string; entries: AgentFileEntry[] }> {
	const guard = guardAgentDirPath(target || agentDir(), { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	const dirents = await fs.readdir(guard.resolved, { withFileTypes: true });
	const entries = await Promise.all(
		dirents.map(async (d) => {
			const full = path.join(guard.resolved!, d.name);
			const st = await fs.stat(full).catch(() => null);
			return {
				name: d.name,
				path: full,
				kind: d.isDirectory() ? ("dir" as const) : ("file" as const),
				sizeBytes: st && !st.isDirectory() ? st.size : null,
				modifiedAt: st ? st.mtime.toISOString() : null,
				isDatabase: BINARY_SKIP.has(path.extname(d.name)),
			};
		}),
	);
	entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
	return { path: guard.resolved, entries };
}

const MAX_EDIT_BYTES = 2 * 1024 * 1024;

export async function readAgentFile(target: string): Promise<{ path: string; content: string }> {
	const guard = guardAgentDirPath(target, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	if (BINARY_SKIP.has(path.extname(guard.resolved))) {
		throw new GuardError("this is a live database file — use export to download it, not the text editor");
	}
	const st = await fs.stat(guard.resolved);
	if (st.size > MAX_EDIT_BYTES) throw new GuardError(`file is ${st.size}B, over the ${MAX_EDIT_BYTES}B edit limit`);
	const content = await fs.readFile(guard.resolved, "utf8");
	return { path: guard.resolved, content };
}

export async function writeAgentFile(target: string, content: string): Promise<{ path: string }> {
	const guard = guardAgentDirPath(target, { mustExist: false });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	if (BINARY_SKIP.has(path.extname(guard.resolved))) {
		throw new GuardError("refusing to overwrite a live database file through the text editor");
	}
	await fs.mkdir(path.dirname(guard.resolved), { recursive: true });
	await fs.writeFile(guard.resolved, content, "utf8");
	log.info(`wrote agent-config file ${guard.resolved}`);
	return { path: guard.resolved };
}

export async function deleteAgentPath(target: string): Promise<void> {
	const guard = guardAgentDirPath(target, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	if (guard.resolved === agentDir()) throw new GuardError("refusing to delete the agent directory itself");
	await fs.rm(guard.resolved, { recursive: true, force: false });
	log.info(`deleted agent-config path ${guard.resolved}`);
}

// ─── Export ─────────────────────────────────────────────────────────────────

/** Zip the whole agent directory to a temp file and return its path for the route to stream. */
export async function exportAgentDirZip(): Promise<{ zipPath: string; cleanup: () => Promise<void> }> {
	const dir = agentDir();
	const zipPath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "omp-deck-export-")), "agent-export.zip");
	const proc = Bun.spawn(["zip", "-r", "-q", zipPath, "."], { cwd: dir, stdout: "pipe", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (exitCode !== 0) throw new ImportError(`export failed: ${stderr.trim()}`);
	return {
		zipPath,
		cleanup: async () => {
			await fs.rm(path.dirname(zipPath), { recursive: true, force: true }).catch(() => undefined);
		},
	};
}

// ─── Import ─────────────────────────────────────────────────────────────────

export interface ImportPlanEntry {
	path: string;
	change: "add" | "modify" | "remove";
	isDatabase: boolean;
}

export interface ImportPlan {
	stagingId: string;
	entries: ImportPlanEntry[];
	addedCount: number;
	modifiedCount: number;
	removedCount: number;
	/** True when the plan touches a live database file — surfaced so the UI can warn loudly. */
	touchesDatabase: boolean;
}

interface StagingRecord {
	stagingPath: string;
	mode: "merge" | "full-reset";
	createdAt: number;
}

const stagingRegistry = new Map<string, StagingRecord>();
const STAGING_TTL_MS = 30 * 60_000;

function stagingRoot(): string {
	return `${agentDir()}.staged`;
}

function pruneExpiredStaging(): void {
	const now = Date.now();
	for (const [id, rec] of stagingRegistry) {
		if (now - rec.createdAt > STAGING_TTL_MS) {
			stagingRegistry.delete(id);
			void fs.rm(rec.stagingPath, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

async function walkFiles(root: string): Promise<Set<string>> {
	const out = new Set<string>();
	async function walk(dir: string): Promise<void> {
		const dirents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
		for (const d of dirents) {
			const full = path.join(dir, d.name);
			if (d.isDirectory()) await walk(full);
			else out.add(path.relative(root, full));
		}
	}
	await walk(root);
	return out;
}

/**
 * Extract an uploaded zip into a staging directory next to the live one and
 * compute what would change. Nothing about the live agent directory is
 * touched by this step.
 *
 * `mode: "merge"` layers the archive's files on top of the current directory
 * (everything not in the archive survives). `mode: "full-reset"` treats the
 * archive as the complete replacement — anything not in it is planned for
 * removal, matching "wipe and replace" exactly, but computed and shown before
 * anything is deleted.
 */
export async function stageImport(zipBuffer: Buffer, mode: "merge" | "full-reset"): Promise<ImportPlan> {
	pruneExpiredStaging();
	const dir = agentDir();
	const stagingId = crypto.randomUUID();
	const stagingPath = path.join(stagingRoot(), stagingId);
	await fs.mkdir(stagingPath, { recursive: true });

	const zipTmp = path.join(stagingPath, "_upload.zip");
	await fs.writeFile(zipTmp, zipBuffer);
	const extractDir = path.join(stagingPath, "extracted");
	await fs.mkdir(extractDir, { recursive: true });

	// Validate every entry resolves inside `extractDir` BEFORE extracting.
	// `unzip -Z1` prints one archive member per line (no quoting, no
	// headers) — feed it through `path.resolve` against the extract root
	// and reject the import if any entry escapes. Closes zip-slip.
	const listProc = Bun.spawn(["unzip", "-Z1", zipTmp], { stdout: "pipe", stderr: "pipe" });
	const listText = await new Response(listProc.stdout).text();
	const listStderr = await new Response(listProc.stderr).text();
	const listExit = await listProc.exited;
	if (listExit !== 0) {
		await fs.rm(zipTmp, { force: true });
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
		throw new ImportError(`could not list archive: ${listStderr.trim() || "not a valid zip"}`);
	}
	const extractAbs = path.resolve(extractDir);
	for (const rawEntry of listText.split(/\r?\n/)) {
		const entry = rawEntry.replace(/\/$/, "");
		if (!entry) continue;
		const target = path.resolve(extractAbs, entry);
		if (target !== extractAbs && !target.startsWith(extractAbs + path.sep)) {
			await fs.rm(zipTmp, { force: true });
			await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
			throw new ImportError(`archive entry escapes staging dir: ${entry}`);
		}
	}

	const proc = Bun.spawn(["unzip", "-q", "-o", zipTmp, "-d", extractDir], { stdout: "pipe", stderr: "pipe" });
	const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	await fs.rm(zipTmp, { force: true });
	if (exitCode !== 0) {
		await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => undefined);
		throw new ImportError(`could not extract archive: ${stderr.trim() || "not a valid zip"}`);
	}

	// A zip whose entries all share one top-level folder (a common "download
	// as zip" shape) is unwrapped one level so the import lands the folder's
	// *contents* in the agent dir, not the folder itself.
	const topEntries = await fs.readdir(extractDir, { withFileTypes: true });
	const effectiveRoot =
		topEntries.length === 1 && topEntries[0]!.isDirectory() ? path.join(extractDir, topEntries[0]!.name) : extractDir;

	const [incoming, current] = await Promise.all([walkFiles(effectiveRoot), walkFiles(dir)]);

	const entries: ImportPlanEntry[] = [];
	for (const rel of incoming) {
		entries.push({
			path: rel,
			change: current.has(rel) ? "modify" : "add",
			isDatabase: BINARY_SKIP.has(path.extname(rel)),
		});
	}
	if (mode === "full-reset") {
		for (const rel of current) {
			if (!incoming.has(rel)) entries.push({ path: rel, change: "remove", isDatabase: BINARY_SKIP.has(path.extname(rel)) });
		}
	}
	entries.sort((a, b) => a.path.localeCompare(b.path));

	stagingRegistry.set(stagingId, { stagingPath: effectiveRoot, mode, createdAt: Date.now() });

	return {
		stagingId,
		entries,
		addedCount: entries.filter((e) => e.change === "add").length,
		modifiedCount: entries.filter((e) => e.change === "modify").length,
		removedCount: entries.filter((e) => e.change === "remove").length,
		touchesDatabase: entries.some((e) => e.isDatabase),
	};
}

export interface ApplyResult {
	backupPath: string;
	appliedPath: string;
}

/**
 * Commit a staged import. Builds the final tree in one more sibling
 * directory (so a "merge" mode import — the common case — doesn't require
 * mutating the live directory to compute), then does the atomic two-rename
 * swap described in the module docblock.
 */
export async function applyStagedImport(stagingId: string): Promise<ApplyResult> {
	const rec = stagingRegistry.get(stagingId);
	if (!rec) throw new ImportError("staged import not found or expired — re-upload");
	const dir = agentDir();

	const finalPath = path.join(stagingRoot(), `${stagingId}-final`);
	if (rec.mode === "full-reset") {
		// The archive already IS the complete replacement.
		await fs.rename(rec.stagingPath, finalPath);
	} else {
		// Merge: start from a copy of the live directory, then overlay the
		// staged files on top. `cp -a` preserves the SQLite files byte-for-byte
		// where the archive doesn't touch them.
		await fs.mkdir(finalPath, { recursive: true });
		const copyProc = Bun.spawn(["cp", "-a", `${dir}/.`, finalPath], { stdout: "pipe", stderr: "pipe" });
		const [copyErr, copyExit] = await Promise.all([new Response(copyProc.stderr).text(), copyProc.exited]);
		if (copyExit !== 0) throw new ImportError(`could not prepare merge: ${copyErr.trim()}`);
		const overlayProc = Bun.spawn(["cp", "-a", `${rec.stagingPath}/.`, finalPath], { stdout: "pipe", stderr: "pipe" });
		const [overlayErr, overlayExit] = await Promise.all([new Response(overlayProc.stderr).text(), overlayProc.exited]);
		if (overlayExit !== 0) throw new ImportError(`could not apply overlay: ${overlayErr.trim()}`);
	}

	const backupPath = `${dir}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	// Rename within the same parent directory — same filesystem, atomic.
	await fs.rename(dir, backupPath);
	try {
		await fs.rename(finalPath, dir);
	} catch (err) {
		// Best-effort recovery: put the original back so the server isn't left
		// pointed at a missing directory.
		await fs.rename(backupPath, dir).catch(() => undefined);
		throw new ImportError(`swap failed, original directory restored: ${String(err)}`);
	}

	stagingRegistry.delete(stagingId);
	await fs.rm(path.join(stagingRoot(), stagingId), { recursive: true, force: true }).catch(() => undefined);
	log.info(`applied agent-config import ${stagingId}; previous directory backed up at ${backupPath}`);
	return { backupPath, appliedPath: dir };
}

export async function discardStagedImport(stagingId: string): Promise<void> {
	const rec = stagingRegistry.get(stagingId);
	stagingRegistry.delete(stagingId);
	const dirToRemove = rec ? path.join(stagingRoot(), stagingId) : undefined;
	if (dirToRemove) await fs.rm(dirToRemove, { recursive: true, force: true }).catch(() => undefined);
}

export interface BackupInfo {
	name: string;
	path: string;
	createdAt: string;
}

/** Prior import backups, newest first. Never auto-deleted. */
export async function listBackups(): Promise<BackupInfo[]> {
	const parent = path.dirname(agentDir());
	const base = path.basename(agentDir());
	const dirents = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
	const backups = await Promise.all(
		dirents
			.filter((d) => d.isDirectory() && d.name.startsWith(`${base}.backup-`))
			.map(async (d) => {
				const full = path.join(parent, d.name);
				const st = await fs.stat(full);
				return { name: d.name, path: full, createdAt: st.birthtime.toISOString() };
			}),
	);
	return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Restore a prior backup over the live directory — the undo for a bad import. Same atomic-swap discipline. */
export async function restoreBackup(backupPath: string): Promise<ApplyResult> {
	const dir = agentDir();
	const parent = path.dirname(dir);
	const base = path.basename(dir);
	const resolved = path.resolve(backupPath);
	if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(`${base}.backup-`)) {
		throw new GuardError("not a recognized backup path");
	}
	if (!(await fs.stat(resolved).catch(() => null))?.isDirectory()) {
		throw new GuardError("backup directory not found");
	}
	const displaced = `${dir}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
	await fs.rename(dir, displaced);
	await fs.rename(resolved, dir);
	log.info(`restored agent-config backup ${resolved}; previous state moved to ${displaced}`);
	return { backupPath: displaced, appliedPath: dir };
}
