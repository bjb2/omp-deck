---
name: vitest-db-integration-tests
description: "Use when setting up integration tests in a TypeScript project that need a real database (Postgres, MySQL, etc.) alongside an existing fast/hermetic vitest unit-test suite, especially when the DB client connects eagerly at module-import time."
---

## Problem

A DB client module (e.g. `db/client.ts`) that connects eagerly — `postgres(requireEnv('DATABASE_URL'), ...)` at the top level, not inside a function — throws the moment any test file transitively imports it, if `DATABASE_URL` isn't set. That makes it unsafe to let DB-backed tests share the default `*.test.ts` glob: every contributor and every CI job for the *unit* suite would suddenly need a live database just to typecheck-equivalent tests.

## Fix: two lanes, one extra config file

1. **Naming convention.** DB-backed tests live in `*.integration.test.ts`, not `*.test.ts`.
2. **Default config excludes them.** In the existing `vitest.config.ts`:
   ```ts
   test: {
     include: ['src/**/*.test.ts'],
     exclude: ['src/**/*.integration.test.ts'],
   }
   ```
3. **New `vitest.integration.config.ts`** — same resolve/alias block, `include: ['src/**/*.integration.test.ts']`, and critically:
   ```ts
   test: {
     include: ['src/**/*.integration.test.ts'],
     fileParallelism: false, // see "the race" below
   }
   ```
4. **New npm script**: `"test:integration": "vitest run --config vitest.integration.config.ts"`. Leave `"test": "vitest run"` untouched — it must stay fast and DB-free, unconditionally.

## The race `fileParallelism: false` prevents

Vitest runs test **files** in parallel (multiple workers) by default. Tests *within* one file already run sequentially by default (no `test.concurrent`), so that's never the problem. The problem is: if two or more integration test files each reset the *same physical database* wholesale in `beforeEach` (a `TRUNCATE ... CASCADE` across every application table, or equivalent), running those files concurrently means file A's reset can wipe file B's just-inserted fixtures mid-test. This surfaces as **foreign-key violation errors that look unrelated to the actual assertions** — e.g. "insert into episode violates FK constraint episode_persona_id_persona_id_fk" when the test never touched another file's persona row directly. If you see FK violations on rows *your own test just inserted*, and only some tests fail non-deterministically, suspect this race before suspecting your query logic.

Fix is one line: `fileParallelism: false` in the integration config only (never the default unit config — no reason to slow that one down).

## Shared fixture helper

Build one `db/testFixtures.ts` (or equivalent) used by every integration test file, not copy-pasted per file:
- A `resetDatabase()` that truncates every application table with `RESTART IDENTITY CASCADE` in one statement (table order inside the statement doesn't matter — CASCADE resolves FK dependencies across every table listed).
- A `createTest<Entity>()` fixture builder for whatever root entity everything else foreign-keys to (e.g. a tenant/persona/org row), returning its id.
- If the schema has vector/embedding columns, a deterministic embedding function — e.g. a bag-of-words hash into a fixed-dimension vector, normalized — so cosine-similarity-based queries are testable without a live embeddings API. Export the raw synchronous hashing function too (not just wrapped in an async provider interface), because tests that insert rows directly (bypassing the app's normal embed-then-insert code path) need to construct a matching vector by hand. Do NOT duplicate the hash logic inline in each test file — that's exactly the kind of near-miss duplication a codebase-cohesion pass would flag; write it once in the shared fixture module.

## Verification

1. `docker compose up -d` (or equivalent) to bring up the real DB.
2. Apply migrations against it.
3. Run `DATABASE_URL=... npm run test:integration` for real — do not stop at `tsc --noEmit` passing. Typechecking a fake `EmbeddingProvider`/mock object structurally matching an interface proves nothing about whether the actual SQL (joins, cosine distance, transactions, cascading deletes) behaves as intended. Actually running against a real instance is what catches both the cross-file race above and any mismatch between your mental model of the code's counters/return shapes and its real behavior.
4. Confirm the default `npm test` lane is unchanged (same file count, same test count, same duration ballpark) — the whole point of the split is that adding DB integration tests must not cost the fast lane anything.
