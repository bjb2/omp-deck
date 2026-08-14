-- 007-gholam-chats.sql
--
-- Persistent chat history for the Gholam twin (§1 of docs/GENERATIVE.md).
--
-- `gholam_chats`         — one row per conversation. `kind` mirrors the
--                          origin (user click / priority queue mirror). State
--                          follows the SDK session lifecycle plus three
--                          deck-only values (paused, awaiting_user, awaiting_tool).
-- `gholam_chat_messages` — append-only message log. Per-chat `seq` is monotonic
--                          and dense so a UI can `since=<seq>` for deltas.
--
-- Conventions follow the rest of the db: TEXT ids (ULID-ish from `db/index.ts`),
-- ISO-8601 TEXT timestamps, snake_case columns, ON DELETE CASCADE so a chat
-- delete is one statement. Soft-delete (`deleted_at`) keeps the row out of
-- the default list view but preserves its messages for a `--include-deleted`
-- audit. `usage_json` accumulates {tokens_in, tokens_out, cost_microcents}
-- across every assistant message in the chat for cost telemetry.

CREATE TABLE IF NOT EXISTS gholam_chats (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('user','auto','priority')),
    cwd         TEXT NOT NULL,
    model       TEXT,
    state       TEXT NOT NULL CHECK (state IN
                    ('running','paused','awaiting_user','awaiting_tool','completed','failed')),
    summary     TEXT,
    priority_id TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT,
    usage_json  TEXT
);

CREATE INDEX IF NOT EXISTS idx_gholam_chats_updated
    ON gholam_chats(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gholam_chats_kind
    ON gholam_chats(kind, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gholam_chats_cwd
    ON gholam_chats(cwd, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS gholam_chat_messages (
    id          TEXT PRIMARY KEY,
    chat_id     TEXT NOT NULL REFERENCES gholam_chats(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    role        TEXT NOT NULL CHECK (role IN
                    ('user','assistant','tool_call','tool_result','system','note')),
    content     TEXT NOT NULL,
    meta_json   TEXT,
    created_at  TEXT NOT NULL,
    UNIQUE(chat_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_gholam_msgs_chat_seq
    ON gholam_chat_messages(chat_id, seq);
