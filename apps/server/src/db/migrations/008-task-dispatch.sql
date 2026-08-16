-- 008-task-dispatch.sql
-- Phase 1 of local://solo-capabilities-plan.md: task-scoped worktree fan-out.
-- Adds the storage for a `TaskDispatch` payload (the fan-out state for one
-- dispatch) and a free-form energy tag the UI surfaces to the agent prompt.
--
--   dispatch_json : serialized TaskDispatch (see packages/protocol/src/index.ts).
--                   Nullable because legacy rows were authored before the fan-out
--                   feature shipped and only some tasks are ever dispatched.
--   energy_tag    : "low" | "medium" | "high" — user-supplied sizing hint that
--                   downstream prompts (dispatch initial prompt, deck-managed
--                   start-command) read to scale the agent's effort.
--                   Nullable + CHECK because every task is *allowed* to omit it.

ALTER TABLE tasks ADD COLUMN dispatch_json TEXT;
ALTER TABLE tasks ADD COLUMN energy_tag TEXT CHECK (energy_tag IN ('low','medium','high'));
