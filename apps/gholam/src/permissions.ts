/**
 * Gholam-side permission registry.
 *
 * Canonical source lives in `packages/protocol/src/permissions.ts`. Both
 * sides (sidecar + server) import from there so the registry stays in
 * sync without hand-mirrored tables. The server-side gate in
 * `apps/server/src/auth/gholam-permissions.ts` consumes the same export.
 */
export { GHOLAM_PERMISSIONS } from "@omp-deck/protocol";
export type { GholamPermission } from "@omp-deck/protocol";
