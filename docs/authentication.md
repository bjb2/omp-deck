# Authentication

The deck ships with username + password authentication. It is on by default
whenever the server is bound to anything other than loopback, which is to say:
whenever self-hosting it on a real hostname.

This matters more than it does for a typical web app. The deck drives a coding
agent with a shell, filesystem access to your workspace, and your provider
credentials. An unauthenticated deck on a public hostname is a remote shell for
whoever finds the URL.

## How the mode is decided

`OMP_DECK_AUTH_MODE` takes `auto` (default), `on`, or `off`.

| Bind host | Credentials configured | `auto` result |
|---|---|---|
| `127.0.0.1` | no | **off** — nothing outside the machine can connect |
| `127.0.0.1` | yes | **on** |
| anything else | either | **on** |

`off` is honored only on a loopback bind. On a public bind it is ignored and the
server logs why: one stale environment variable should not be able to publish an
unauthenticated agent to the internet.

## First boot

Two ways to get an account.

**Configure it in the environment** (preferred for containers) — the deck comes
up already protected, with no window in which it is reachable and unclaimed:

```bash
OMP_DECK_AUTH_USERNAME=you
OMP_DECK_AUTH_PASSWORD='a long password'
```

Better still, keep the plaintext out of the environment by supplying a digest.
Generate one with Bun:

```bash
bun -e 'console.log(await Bun.password.hash(process.argv[1], "argon2id"))' 'a long password'
```

```bash
OMP_DECK_AUTH_PASSWORD_HASH='$argon2id$v=19$m=65536,t=2,p=1$...'
```

**Or use the first-run screen.** With no credentials configured, the deck serves
a "create the account that will control this deck" form instead of the app. It
only works while zero accounts exist, so it cannot be used to add an admin later
— but on a public URL there is a window between first boot and your first visit.
Close it with `OMP_DECK_AUTH_SETUP_TOKEN=<random string>`, which the form then
requires.

`OMP_DECK_AUTH_PASSWORD` is re-read on every boot. Changing it resets that
account's password and signs out every device — the recovery path when you have
forgotten the password on a headless box. `OMP_DECK_AUTH_PASSWORD_HASH` is
applied only at account creation.

## What is protected

Gated: the REST API, the WebSocket (`/ws`), uploaded files (`/uploads/*`), and
the OAuth landing route.

Not gated: static assets and the SPA bundle. They contain no secrets, and
serving them anonymously is what lets the login screen render. `/api/health`
stays open so container health checks don't need a credential.

## Non-browser callers

Scripts, the agent's own `curl` calls, and the Telegram bridge can't hold a
cookie. They use a bearer token:

```bash
curl -s -H "Authorization: Bearer $OMP_DECK_API_TOKEN" http://127.0.0.1:8787/api/tasks
```

Set `OMP_DECK_API_TOKEN` yourself, or let the deck generate one on first boot
and persist it to `<dataDir>/api-token` (mode `0600`). Either way it is exported
into the environment of every agent session and child process, so an agent can
call the deck's API without being handed a credential explicitly — the built-in
prelude tells it about the header.

Routine `http` steps aimed at loopback keep working untouched: they already mint
a per-run HMAC token, and the gate now verifies it.

## Sessions

Session records live in the deck's SQLite database; the cookie carries a random
256-bit token and only its SHA-256 is stored, so a copy of the database cannot
be replayed as a live login. The cookie is `HttpOnly`, `SameSite=Lax`, and
`Secure` whenever the request arrived over HTTPS — including via a proxy that
sets `X-Forwarded-Proto`.

Because sessions are server-side rows, revocation is real: changing your
password ends every other session immediately, and Settings → Account has a
sign-out control.

Cross-origin `POST`/`PATCH`/`DELETE` requests are rejected unless their `Origin`
matches the request host, `OMP_DECK_PUBLIC_URL`, or an entry in
`OMP_DECK_TRUSTED_ORIGINS`. Requests with no `Origin` header are allowed — that
is the non-browser case, which authenticates with a bearer token an attacker's
page cannot read.

Failed sign-ins are throttled per username + IP: `OMP_DECK_AUTH_MAX_ATTEMPTS`
(default 8) then a lockout of `OMP_DECK_AUTH_LOCKOUT_MS` (default 15 minutes).

## Variables

| Key | Default | Purpose |
|---|---|---|
| `OMP_DECK_AUTH_MODE` | `auto` | `auto` / `on` / `off` |
| `OMP_DECK_AUTH_USERNAME` | `admin` | Bootstrap account name |
| `OMP_DECK_AUTH_PASSWORD` | — | Bootstrap password; re-read each boot |
| `OMP_DECK_AUTH_PASSWORD_HASH` | — | argon2id digest; applied at creation |
| `OMP_DECK_AUTH_SETUP_TOKEN` | — | Required by the first-run form |
| `OMP_DECK_AUTH_SESSION_TTL_MS` | 30 days | Session lifetime |
| `OMP_DECK_AUTH_COOKIE_NAME` | `omp_deck_session` | Change when two decks share a hostname |
| `OMP_DECK_AUTH_SECURE_COOKIE` | off | Force `Secure` when the proxy sets no `X-Forwarded-Proto` |
| `OMP_DECK_AUTH_MAX_ATTEMPTS` | `8` | Failed sign-ins before lockout |
| `OMP_DECK_AUTH_LOCKOUT_MS` | `900000` | Lockout duration |
| `OMP_DECK_TRUSTED_ORIGINS` | — | Extra origins allowed to write |
| `OMP_DECK_API_TOKEN` | generated | Bearer token for non-browser callers |

## Recovering a locked-out deck

Set `OMP_DECK_AUTH_PASSWORD` to a new value and restart. The account's password
is reset and every session is revoked.

To start over completely, delete the accounts and let first-run setup return:

```sql
-- against the deck database (OMP_DECK_DB_PATH)
DELETE FROM deck_sessions;
DELETE FROM deck_users;
```
