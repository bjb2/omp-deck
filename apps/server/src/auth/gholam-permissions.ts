/**
 * Server-side gate for gholam-mediated `gholam_command` frames.
 *
 * - Loads the user's grant file (`OMP_DECK_DATA_DIR/gholam-permissions.json`)
 *   on first call. Seeds with all read permissions; writes default `false`.
 * - `checkGholamFramePermissions(required)` is the gate used by the WS
 *   message handler in `apps/server/src/index.ts` (after `resolvePrincipal`,
 *   before dispatch). On failure, the caller sends an error frame back.
 * - `grantPermission` / `revokePermission` are the user-facing toggles
 *   invoked by the Settings → Gholam view (future UI).
 *
 * Source of truth for the permission list is the sidecar's
 * `apps/gholam/src/permissions.ts` — re-exported here so server and sidecar
 * stay in sync without duplicating the table.
 */
import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GholamPermissionKey } from "@omp-deck/protocol";

export { GHOLAM_PERMISSIONS } from "@omp-deck/protocol";
export type { GholamPermissionKey } from "@omp-deck/protocol";

const GRANT_PATH = path.join(
	process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck"),
	"gholam-permissions.json",
);

interface GholamPermissionGrant {
	permissions: GholamPermissionKey[];
	updatedAt: string;
}

/** Default seed: all reads auto-granted. Writes default `false` until the
 *  user toggles them in Settings → Gholam. */
const DEFAULT_GRANT: GholamPermissionKey[] = [
	"library.prompts.read",
	"library.history.read",
	"library.sessions.read",
	"kb.read",
	"marketplace.search",
	"mcp.invoke",
	"discovery.search",
	"prompts.recommend",
];

async function readGrant(): Promise<GholamPermissionGrant | null> {
	try {
		const raw = await fs.readFile(GRANT_PATH, "utf-8");
		const parsed = JSON.parse(raw) as GholamPermissionGrant;
		if (Array.isArray(parsed.permissions)) return parsed;
		return null;
	} catch {
		return null;
	}
}

async function writeGrant(grant: GholamPermissionGrant): Promise<void> {
	const dir = path.dirname(GRANT_PATH);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${GRANT_PATH}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(grant, null, 2), "utf-8");
	await fs.rename(tmp, GRANT_PATH);
}

/** Returns the user's current grant set. Seeds the file on first call. */
export async function loadGholamPermissionGrant(): Promise<Set<GholamPermissionKey>> {
	const existing = await readGrant();
	if (!existing) {
		const seeded: GholamPermissionGrant = { permissions: DEFAULT_GRANT, updatedAt: new Date().toISOString() };
		await writeGrant(seeded);
		return new Set(seeded.permissions);
	}
	return new Set(existing.permissions);
}

/** Gate. Empty/missing required set is always OK. */
export async function checkGholamFramePermissions(
	required: readonly GholamPermissionKey[],
): Promise<{ ok: true } | { ok: false; missing: GholamPermissionKey[] }> {
	if (required.length === 0) return { ok: true };
	const grant = await loadGholamPermissionGrant();
	const missing = required.filter((k) => !grant.has(k));
	if (missing.length === 0) return { ok: true };
	return { ok: false, missing };
}

/** User-facing toggle: add a permission if missing. */
export async function grantPermission(key: GholamPermissionKey): Promise<void> {
	const grant = await loadGholamPermissionGrant();
	if (grant.has(key)) return;
	grant.add(key);
	await writeGrant({ permissions: Array.from(grant), updatedAt: new Date().toISOString() });
}

/** User-facing toggle: remove a permission if present. */
export async function revokePermission(key: GholamPermissionKey): Promise<void> {
	const grant = await loadGholamPermissionGrant();
	if (!grant.has(key)) return;
	grant.delete(key);
	await writeGrant({ permissions: Array.from(grant), updatedAt: new Date().toISOString() });
}

export function grantFileExists(): boolean {
	return existsSync(GRANT_PATH);
}
