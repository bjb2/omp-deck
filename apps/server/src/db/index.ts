/**
 * omp-deck local data store.
 *
 * Backed by Bun's built-in sqlite (`bun:sqlite`). Single-process write model —
 * we don't expect concurrent writers because the server is one Bun process.
 *
 * Migration model: numbered .sql files in `./migrations/`. The runner records
 * applied filenames in a `schema_migrations` table and skips anything already
 * applied. Each file is executed atomically inside a transaction.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../log.ts";

const log = logger("db");

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, "migrations");

let instance: Database | null = null;
let walCheckpointTimer: ReturnType<typeof setInterval> | null = null;
const WAL_CHECKPOINT_INTERVAL_MS = 60_000;

export interface DbOpenOpts {
	/** Absolute path to the sqlite file. Created if missing. */
	path: string;
}

export function openDb(opts: DbOpenOpts): Database {
	if (instance) return instance;
	const dbPath = path.resolve(opts.path);
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });

	const db = new Database(dbPath, { create: true, strict: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	// FULL = durable — fsync the WAL on every commit. Trades a small
	// throughput cost on disk-bound workloads for a hard guarantee that
	// any committed row survives a power loss. Acceptable for the deck's
	// local store where writes are scarce but correctness is non-negotiable.
	db.exec("PRAGMA synchronous = FULL");

	applyMigrations(db);
	seedWelcomeTaskIfEmpty(db);

	instance = db;
	// Periodic WAL checkpoint keeps the -wal file from growing unbounded
	// during long uptimes. TRUNCATE fully reclaims space back into the
	// main DB file. Fire-and-forget; failure here is logged but does not
	// block the boot path.
	// Idempotent: the test suite opens/closes the DB many times; only one
	// interval and one set of exit hooks are needed across the process
	// lifetime.
	if (!walCheckpointTimer) {
		walCheckpointTimer = setInterval(() => {
			if (!instance) return;
			try {
				instance.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			} catch (err) {
				log.warn(`wal_checkpoint failed: ${(err as Error).message}`);
			}
		}, WAL_CHECKPOINT_INTERVAL_MS);
		const stopCheckpoint = (): void => {
			if (walCheckpointTimer) {
				clearInterval(walCheckpointTimer);
				walCheckpointTimer = null;
			}
		};
		// Best-effort cleanup on process exit — the interval keeps the
		// event loop alive, and we want it gone when the server shuts
		// down. process.once is fine across reopens because we only
		// register once per process.
		process.once("exit", stopCheckpoint);
		process.once("SIGINT", stopCheckpoint);
		process.once("SIGTERM", stopCheckpoint);
	}

	log.info(`db ready at ${dbPath}`);
	return db;
}

export function getDb(): Database {
	if (!instance) throw new Error("db not opened — call openDb() at boot");
	return instance;
}

export function closeDb(): void {
	if (instance) {
		if (walCheckpointTimer) {
			clearInterval(walCheckpointTimer);
			walCheckpointTimer = null;
		}
		instance.close();
		instance = null;
	}
}

// ─── Migrations ────────────────────────────────────────────────────────────

function applyMigrations(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			name        TEXT PRIMARY KEY,
			applied_at  TEXT NOT NULL
		)
	`);

	const applied = new Set<string>(
		(db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all() as { name: string }[])
			.map((r) => r.name),
	);

	const files = fs
		.readdirSync(MIGRATIONS_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();

	const recordStmt = db.prepare<unknown, [string, string]>(
		"INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)",
	);

	for (const file of files) {
		if (applied.has(file)) continue;
		const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
		log.info(`applying migration ${file}`);
		db.transaction(() => {
			db.exec(sql);
			recordStmt.run(file, new Date().toISOString());
		})();
	}
}

// ─── First-boot seed ───────────────────────────────────────────────────────

/**
 * When the deck boots against an empty `tasks` table — fresh install, no
 * archived rows either — insert a single backlog task that orients the user.
 * Idempotent: any existing row (archived or not) makes this a no-op so we
 * never spam a returning user.
 */
function seedWelcomeTaskIfEmpty(db: Database): void {
	const count = (db
		.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks")
		.get() as { n: number } | null)?.n ?? 0;
	if (count > 0) return;

	const taskId = `t_${id().toLowerCase().slice(0, 18)}`;
	const now = nowIso();
	const title = "Welcome to omp-deck";
	const body = WELCOME_BODY;

	db.transaction(() => {
		const seqRow = db
			.query<{ value: number }, []>(
				"UPDATE sequences SET value = value + 1 WHERE name = 'tasks' RETURNING value",
			)
			.get() as { value: number } | null;
		const displayId = seqRow?.value ?? 1;
		db.prepare<unknown, [string, number, string, string, string, number, string | null, string, string]>(
			`INSERT INTO tasks (id, display_id, title, body, state_id, order_in_state, cwd, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(taskId, displayId, title, body, "s_backlog", 1000, null, now, now);
	})();
	log.info(`seeded welcome task (T-1) on empty kanban`);
}

const WELCOME_BODY = `Welcome to omp-deck. A few orientation pointers; mark this task done when you've finished.

### Nav rail (left edge)
- **Chat** — multi-session conversations with the omp agent.
- **Tasks** — this kanban. \`T-N\` ids stay stable; columns are user-configurable.
- **Routines** — cron-scheduled bash / prompt / script jobs.
- **Inbox** — quick-capture surface. Promote items to tasks with one click.
- **Marketplace** — browse and install plugins/skills from registered catalogs. The empty-state suggests \`anthropics/claude-plugins-official\`.
- **Settings** — env vars, themes, messaging bridges, appearance.

### Define an auto-start prompt (optional)

Want the agent to greet you with a workspace summary every time you open a fresh chat? Write \`~/.omp/agent/commands/start.md\` (the SDK's user-global slash-command location), e.g.:

\`\`\`md
---
description: Summarize the active workspace and surface anything in-flight
---
Summarize the current workspace's state. Mention any active tasks (from the kanban),
recent git activity, and anything that looks blocked.
\`\`\`

Then in **Settings → Env**, set \`OMP_DECK_AUTO_START\` to \`/start\`. The deck fires it once per new session, after you subscribe.

### Themes

**Settings → Appearance** ships two presets — Paper (warm cream, rust accent) and Slate (deep slate, brighter rust). System preference picks one on first visit; the choice persists per browser.

### Deck slash commands

In any composer:
- \`/task add <title>\` — file a new backlog task in this workspace.
- \`/task list [state]\` — list active + backlog (or any state).
- \`/task done <T-id>\` — mark done.
- \`/task move <T-id> <state>\` — move between columns.

The picker shows all four under the \`DECK\` scope alongside SDK builtins (\`/context\`, \`/compact\`, \`/usage\`, ...).

### Docs

More in \`docs/\`:
- \`docs/install.md\` — fresh vs existing-omp install paths.
- \`docs/configuration.md\` — full env reference.
- \`docs/deployment.md\` — Tailscale, Docker, SSH-tunnel hardening.
- \`docs/marketplaces.md\` — catalog seeding and install semantics.
- \`docs/telegram.md\` — bridge setup if you want to chat with the agent from your phone.
`;

// ─── Small id helper ───────────────────────────────────────────────────────

/**
 * App-side id generator. ULID-ish: 26 chars, time-sortable prefix, base32
 * crockford alphabet. Good enough for primary keys, no monotonic guarantee
 * within the same millisecond (we accept rare collisions; PRIMARY KEY catches
 * them).
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function id(): string {
	const ts = Date.now();
	let out = "";
	let n = ts;
	for (let i = 0; i < 10; i++) {
		out = ALPHABET[n % 32]! + out;
		n = Math.floor(n / 32);
	}
	for (let i = 0; i < 16; i++) {
		out += ALPHABET[Math.floor(Math.random() * 32)]!;
	}
	return out;
}

export function nowIso(): string {
	return new Date().toISOString();
}
