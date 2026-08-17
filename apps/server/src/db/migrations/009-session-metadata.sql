-- 009-session-metadata.sql
-- Deck-managed session metadata. The omp SDK persists transcript data on
-- disk but keeps no UI-shaped flags; this table is the home for the ones
-- the deck UI needs to render grouping/filtering affordances:
-- archived, urgency, importance, status, plus an optional binding to a
-- managed repo + worktree.
--
-- The PK is the session id (ULID-shaped string emitted by the SDK). Rows
-- are inserted lazily on first metadata write for a session — sessions
-- that have never been touched are simply absent from this table, and
-- callers treat absence as "all defaults" (archived=0, urgency/importance
-- ='normal', status='active').
--
-- This table is intentionally not in 001-init.sql because we don't want
-- to bootstrap it before the SDK has had a chance to assign session ids.

CREATE TABLE IF NOT EXISTS session (
    id          TEXT PRIMARY KEY,
    archived    INTEGER NOT NULL DEFAULT 0,
    urgency     TEXT    NOT NULL DEFAULT 'normal',
    importance  TEXT    NOT NULL DEFAULT 'normal',
    status      TEXT    NOT NULL DEFAULT 'active',
    repo_id     TEXT,
    worktree    TEXT,
    updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_archived ON session(archived);
CREATE INDEX IF NOT EXISTS idx_session_repo ON session(repo_id);
CREATE INDEX IF NOT EXISTS idx_session_status ON session(status);
CREATE INDEX IF NOT EXISTS idx_session_urgency ON session(urgency);
