/**
 * Deck-side mints the per-process bearer token the gholam sidecar's WS
 * expects in `Sec-WebSocket-Protocol`. Persisted to `OMP_DECK_DATA_DIR/
 * gholam-token.json` so an external restart of the sidecar can hand the
 * same token back, and the WS handshake in the sidecar can validate it.
 *
 * NOT a user-facing API token, NOT an `api-token` principal kind, NOT a
 * row in the auth DB. Only the deck ↔ gholam handshake uses it.
 */
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const TOKEN_PATH = path.join(
	process.env.OMP_DECK_DATA_DIR ?? path.join(os.homedir(), ".omp-deck"),
	"gholam-token.json",
);

interface TokenRecord {
	token: string;
	mintedAt: string;
}

async function readExisting(): Promise<TokenRecord | null> {
	try {
		const raw = await fs.readFile(TOKEN_PATH, "utf-8");
		const parsed = JSON.parse(raw) as TokenRecord;
		if (typeof parsed.token === "string" && parsed.token.length > 0) return parsed;
		return null;
	} catch {
		return null;
	}
}

function mintRaw(): string {
	// 32 random bytes, base64url. Not a JWT, not signed — the sidecar
	// compares token equality on every WS upgrade, so strength lives in
	// entropy not in signature.
	return randomBytes(32).toString("base64url");
}

/** Read the existing token, or mint-and-persist a new one. */
export async function currentGholamToken(): Promise<string> {
	const existing = await readExisting();
	if (existing) return existing.token;
	return await mintGholamToken();
}

/** Mint a fresh token, persist it, return the new value. */
export async function mintGholamToken(): Promise<string> {
	const token = mintRaw();
	const dir = path.dirname(TOKEN_PATH);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${TOKEN_PATH}.${process.pid}.tmp`;
	const record: TokenRecord = { token, mintedAt: new Date().toISOString() };
	await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
	await fs.rename(tmp, TOKEN_PATH);
	return token;
}

/** Delete the persisted token. Next gholam.start() will mint a fresh one. */
export async function revokeGholamToken(): Promise<void> {
	try {
		await fs.unlink(TOKEN_PATH);
	} catch (err) {
		// Missing file is the success case — don't warn on it.
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			throw err;
		}
	}
}

