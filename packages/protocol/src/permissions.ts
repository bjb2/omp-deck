/**
 * Gholam's permission registry — canonical source.
 *
 * Every gholam → server frame declares its required permissions in
 * `requiredPermissions`. The server-side gate in
 * `apps/server/src/auth/gholam-permissions.ts` consults the user's grant
 * file and rejects frames whose permissions are not granted.
 *
 * Permission values:
 *   - "read"      auto-granted on first boot
 *   - "write"     requires explicit user toggle in Settings → Gholam
 *   - "execute"   requires explicit user toggle (most sensitive)
 *
 * The grants live outside the source tree so the user can audit them
 * without editing this file.
 */
export const GHOLAM_PERMISSIONS = {
	"library.prompts.read": "read",
	"library.prompts.write": "write",
	"library.history.read": "read",
	"library.sessions.read": "read",
	"kb.read": "read",
	"kb.write": "write", // append only; full update deferred
	"marketplace.search": "read",
	"marketplace.install": "execute", // requires user approval
	"mcp.invoke": "execute",
	"github.write": "write",
	"openship.deploy": "write",
	"discovery.search": "read",
	"prompts.recommend": "read",
} as const;

export type GholamPermission = keyof typeof GHOLAM_PERMISSIONS;
