-- 010-gholam-model-used.sql
--
-- Adds the per-chat `(modelId, role)` picker payload to `gholam_chats`.
--
-- `model_used_json` stores a JSON object `{ modelId, role }` so we don't
-- widen the table for every new model role id. Nullable so existing rows
-- survive untouched; backfill defaults handled in app code (`rowToChat`
-- returns `undefined` when absent).
--
-- Additive only: no DROP / RENAME / CHECK changes. Migration runner records
-- the file in `schema_migrations` so it won't run twice.

ALTER TABLE gholam_chats ADD COLUMN model_used_json TEXT;
