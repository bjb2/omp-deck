/**
 * Shared path confinement for anything that lets a client name a filesystem
 * path: the file explorer, the git cockpit, the `@filepath` composer
 * autocomplete this module was extracted from, and the agent-config manager.
 *
 * The deck's transport-level protection (loopback bind, or the auth gate on a
 * public one) answers "who can talk to this process at all" — it says nothing
 * about which paths a request may name once it's in. A client that can reach
 * the API and asks to read `/etc/shadow` or write into `~/.ssh` should be
 * refused regardless of how it authenticated. That's what this module is for.
 *
 * Two kinds of root are recognized:
 *
 *   - The user's home directory and its configured extra workspace roots
 *     (`OMP_DECK_WORKSPACES`) — the "your projects" surface.
 *   - The omp agent directory (`OMP_AGENT_DIR`) — a separate root, deliberately
 *     kept apart from workspaces so a workspace-scoped file browser can never
 *     be pointed at the agent's own auth database by a crafted path.
 *
 * Callers pick which root set applies to their route; nothing here defaults to
 * "allow everything."
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import * as path from "node:path";

import { loadConfig } from "./config.ts";

export interface GuardResult {
	ok: boolean;
	/** Resolved, symlink-free absolute path. Only set when ok. */
	resolved?: string;
	reason?: string;
}

function workspaceRoots(): string[] {
	const config = loadConfig();
	const home = process.env.HOME ?? process.env.USERPROFILE;
	const roots = [home, config.defaultCwd, ...config.extraWorkspaces].filter(
		(r): r is string => typeof r === "string" && r.trim().length > 0,
	);
	return [...new Set(roots.map((r) => path.resolve(r)))];
}

function agentDirRoot(): string | undefined {
	const config = loadConfig();
	return config.agentDir ? path.resolve(config.agentDir) : undefined;
}

/**
 * Resolve `candidate` and confirm it sits under one of `roots` (or is a root
 * itself). Symlinks are resolved via `realpath` before the containment check,
 * so a symlink planted inside an allowed root cannot walk the check outside it
 * — `path.relative` string comparison alone is not enough once symlinks exist.
 *
 * `mustExist: false` allows a path that doesn't exist yet (needed for
 * "create this new file"), but the checked path is still resolved against its
 * nearest existing ancestor so a not-yet-created path can't smuggle a `..`
 * segment past the containment check either.
 */
function checkAgainst(candidate: string, roots: string[], opts: { mustExist: boolean }): GuardResult {
	if (roots.length === 0) return { ok: false, reason: "no allowed roots configured" };
	if (!path.isAbsolute(candidate)) return { ok: false, reason: "path must be absolute" };

	let target = path.resolve(candidate);

	// Resolve the longest existing ancestor to defeat symlink escapes, then
	// re-append the not-yet-existing tail.
	let existingAncestor = target;
	const tail: string[] = [];
	while (!existsSync(existingAncestor)) {
		const parent = path.dirname(existingAncestor);
		if (parent === existingAncestor) break; // reached filesystem root
		tail.unshift(path.basename(existingAncestor));
		existingAncestor = parent;
	}

	if (existingAncestor === target && !existsSync(target)) {
		// Nothing on disk at all (e.g. root itself missing) — fail closed.
		return { ok: false, reason: "path does not exist" };
	}

	let realAncestor: string;
	try {
		realAncestor = realpathSync(existingAncestor);
	} catch {
		return { ok: false, reason: "could not resolve path" };
	}
	target = tail.length > 0 ? path.join(realAncestor, ...tail) : realAncestor;

	const contained = roots.some((root) => {
		const rel = path.relative(root, target);
		return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
	});
	if (!contained) return { ok: false, reason: "path is outside every allowed root" };

	if (opts.mustExist && !existsSync(target)) return { ok: false, reason: "path does not exist" };

	return { ok: true, resolved: target };
}

/** Confine to the user's home directory and configured workspace roots. */
export function guardWorkspacePath(candidate: string, opts: { mustExist?: boolean } = {}): GuardResult {
	return checkAgainst(candidate, workspaceRoots(), { mustExist: opts.mustExist ?? false });
}

/** Confine to `OMP_AGENT_DIR`. Distinct from workspace paths on purpose — see module docblock. */
export function guardAgentDirPath(candidate: string, opts: { mustExist?: boolean } = {}): GuardResult {
	const root = agentDirRoot();
	if (!root) return { ok: false, reason: "OMP_AGENT_DIR is not configured" };
	return checkAgainst(candidate, [root], { mustExist: opts.mustExist ?? false });
}

/** True when `candidate` is an existing directory under an allowed workspace root. */
export function isWorkspaceDir(candidate: string): boolean {
	const result = guardWorkspacePath(candidate, { mustExist: true });
	if (!result.ok || !result.resolved) return false;
	try {
		return statSync(result.resolved).isDirectory();
	} catch {
		return false;
	}
}

export { workspaceRoots };
