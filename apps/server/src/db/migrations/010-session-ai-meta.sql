-- 010-session-ai-meta.sql
-- AI-generated session metadata columns. Populated lazily by the
-- session-meta-ai service (`POST /api/sessions/:id/regenerate-meta`).
--
-- The schema_migrations table tracks that this file has run once, so the
-- bare ALTER statements below only execute on a fresh DB. If you need to
-- rebuild an existing deck with these columns missing, remove the row
-- `010-session-ai-meta.sql` from `schema_migrations` and restart.
--
-- ai_summary     — free-form one-sentence description from the model
-- ai_tags        — JSON array string (max 5 short tokens)
-- ai_generated_at — ISO timestamp the AI run completed (for staleness checks)
ALTER TABLE session ADD COLUMN ai_summary     TEXT;
ALTER TABLE session ADD COLUMN ai_tags        TEXT;
ALTER TABLE session ADD COLUMN ai_generated_at TEXT;