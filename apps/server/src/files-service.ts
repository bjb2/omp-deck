/**
 * File explorer backend: list directories, read/write files, create
 * directories, rename, and delete — confined to workspace roots via
 * `path-guard.ts`.
 *
 * This is a general-purpose filesystem surface reachable over HTTP, so every
 * write path re-validates its target through the guard rather than trusting a
 * path that was merely *listed* earlier in the same request lifecycle.
 */
import { promises as fs, type Dirent } from "node:fs";
import * as path from "node:path";

import { guardWorkspacePath, workspaceRoots } from "./path-guard.ts";
import { logger } from "./log.ts";

const log = logger("files-service");

/** Directories never worth descending into for a project browser. */
const SKIP_DIR_NAMES = new Set([
	"node_modules",
	".git",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".nuxt",
	"dist",
	"build",
	".turbo",
	".cache",
]);

export interface FileEntry {
	name: string;
	path: string;
	kind: "file" | "dir" | "symlink";
	sizeBytes: number | null;
	modifiedAt: string | null;
}

export interface ListDirResult {
	path: string;
	entries: FileEntry[];
}

async function statEntry(dirent: Dirent, fullPath: string): Promise<FileEntry> {
	const kind = dirent.isSymbolicLink() ? "symlink" : dirent.isDirectory() ? "dir" : "file";
	try {
		const st = await fs.stat(fullPath);
		return {
			name: dirent.name,
			path: fullPath,
			kind: st.isDirectory() ? "dir" : kind,
			sizeBytes: st.isDirectory() ? null : st.size,
			modifiedAt: st.mtime.toISOString(),
		};
	} catch {
		// Broken symlink or a race with a concurrent delete — still list it,
		// just without stat data, rather than dropping the whole directory read.
		return { name: dirent.name, path: fullPath, kind, sizeBytes: null, modifiedAt: null };
	}
}

export async function listDir(target: string): Promise<ListDirResult> {
	const guard = guardWorkspacePath(target, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	const dirents = await fs.readdir(guard.resolved, { withFileTypes: true });
	const entries = await Promise.all(
		dirents
			.filter((d) => !(d.isDirectory() && SKIP_DIR_NAMES.has(d.name)))
			.map((d) => statEntry(d, path.join(guard.resolved!, d.name))),
	);
	entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
	return { path: guard.resolved, entries };
}

/** Byte ceiling for a file read/write over the API — protects the WS/HTTP layer from huge binaries. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export class GuardError extends Error {}
export class TooLargeError extends Error {}
export class NotUtf8Error extends Error {}

export async function readFile(target: string): Promise<{ path: string; content: string; sizeBytes: number }> {
	const guard = guardWorkspacePath(target, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	const st = await fs.stat(guard.resolved);
	if (st.isDirectory()) throw new GuardError("path is a directory");
	if (st.size > MAX_FILE_BYTES) throw new TooLargeError(`file is ${st.size} bytes; limit is ${MAX_FILE_BYTES}`);
	const buf = await fs.readFile(guard.resolved);
	// Reject binary content rather than mangling it through a lossy UTF-8
	// decode — a null byte in the first chunk is the standard cheap binary
	// sniff and avoids scanning the whole buffer for large files.
	if (buf.subarray(0, Math.min(buf.length, 8192)).includes(0)) {
		throw new NotUtf8Error("file does not look like text");
	}
	return { path: guard.resolved, content: buf.toString("utf8"), sizeBytes: st.size };
}

export async function writeFile(target: string, content: string): Promise<{ path: string; sizeBytes: number }> {
	if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
		throw new TooLargeError(`content is over the ${MAX_FILE_BYTES}-byte limit`);
	}
	// mustExist:false — writing a new file is a normal case; the guard still
	// confines the resolved path to an allowed root either way.
	const guard = guardWorkspacePath(target, { mustExist: false });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	await fs.mkdir(path.dirname(guard.resolved), { recursive: true });
	await fs.writeFile(guard.resolved, content, "utf8");
	const st = await fs.stat(guard.resolved);
	log.info(`wrote ${guard.resolved} (${st.size}B)`);
	return { path: guard.resolved, sizeBytes: st.size };
}

export async function makeDir(target: string): Promise<{ path: string }> {
	const guard = guardWorkspacePath(target, { mustExist: false });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	await fs.mkdir(guard.resolved, { recursive: true });
	return { path: guard.resolved };
}

export async function renamePath(from: string, to: string): Promise<{ path: string }> {
	const src = guardWorkspacePath(from, { mustExist: true });
	if (!src.ok || !src.resolved) throw new GuardError(src.reason ?? "source path not allowed");
	const dst = guardWorkspacePath(to, { mustExist: false });
	if (!dst.ok || !dst.resolved) throw new GuardError(dst.reason ?? "destination path not allowed");
	await fs.mkdir(path.dirname(dst.resolved), { recursive: true });
	await fs.rename(src.resolved, dst.resolved);
	log.info(`renamed ${src.resolved} -> ${dst.resolved}`);
	return { path: dst.resolved };
}

export async function deletePath(target: string, opts: { recursive?: boolean } = {}): Promise<void> {
	const guard = guardWorkspacePath(target, { mustExist: true });
	if (!guard.ok || !guard.resolved) throw new GuardError(guard.reason ?? "path not allowed");
	// A workspace root itself is a valid guard target — never let a delete
	// remove one wholesale.
	if (workspaceRoots().includes(guard.resolved)) throw new GuardError("refusing to delete a workspace root");
	await fs.rm(guard.resolved, { recursive: Boolean(opts.recursive), force: false });
	log.info(`deleted ${guard.resolved}`);
}
