-- 006-push-subscriptions.sql
--
-- Web Push subscriptions, so notifications reach the deck when it isn't open
-- in a foreground tab — the case that matters most for the mobile PWA the
-- browser-only WS-broadcast channel (notifications/channels/browser.ts)
-- can't cover at all: a closed tab has no socket to broadcast to.
--
-- One row per (browser, device) subscription — the same person opening the
-- deck on a phone and a laptop gets two rows, both delivered to. `endpoint`
-- is unique because the browser mints a fresh subscription object per
-- origin+device; re-subscribing (permission re-granted, service worker
-- re-registered) naturally upserts on it rather than duplicating.

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          TEXT PRIMARY KEY,
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    user_agent  TEXT,
    created_at  TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);
