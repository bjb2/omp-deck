-- 005-auth.sql
--
-- Deck user authentication. Until now the deck had no notion of a user: every
-- request that reached the port was trusted, which is only defensible for a
-- loopback-bound process. Self-hosted deployments put the deck on a public
-- hostname, so the port is the perimeter and it needs a real one.
--
-- Two tables:
--
--   deck_users     — one row per human who can sign in. `password_hash` is an
--                    argon2id digest produced by Bun.password; the plaintext is
--                    never stored and never logged.
--   deck_sessions  — server-side session records. The cookie carries a random
--                    256-bit token; we store only its SHA-256 so a database
--                    leak cannot be replayed as a live session. Server-side
--                    rows (rather than a stateless signed cookie) are what make
--                    "sign out everywhere" and password-change revocation
--                    actually revoke.
--
-- `password_changed_at` is the revocation epoch: sessions minted before it are
-- rejected, so changing a password invalidates every other device without a
-- separate delete pass.

CREATE TABLE IF NOT EXISTS deck_users (
    id                  TEXT PRIMARY KEY,
    username            TEXT NOT NULL,
    username_lower      TEXT NOT NULL UNIQUE,
    password_hash       TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    password_changed_at TEXT NOT NULL,
    last_login_at       TEXT
);

CREATE TABLE IF NOT EXISTS deck_sessions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES deck_users(id) ON DELETE CASCADE,
    token_hash    TEXT NOT NULL UNIQUE,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    user_agent    TEXT,
    ip            TEXT
);

CREATE INDEX IF NOT EXISTS idx_deck_sessions_user ON deck_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_deck_sessions_expiry ON deck_sessions(expires_at);
