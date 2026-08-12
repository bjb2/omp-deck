/**
 * Authentication tests.
 *
 * These lean on the properties that actually keep the deck safe rather than on
 * implementation detail: a wrong password never authenticates, a revoked or
 * expired session stops working immediately, and the mode resolver refuses to
 * leave a publicly-bound deck open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, getDb, openDb } from "../db/index.ts";
import { loadAuthConfig } from "./config.ts";
import { isAllowedOrigin, isPublicApiPath, parseCookies, resolvePrincipal } from "./guard.ts";
import {
	createSession,
	createUser,
	deleteSessionById,
	pruneExpiredSessions,
	resolveSessionToken,
	setPassword,
	verifyPassword,
} from "./store.ts";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-auth-"));
	openDb({ path: path.join(dir, "deck.db") });
});

afterEach(() => {
	closeDb();
	fs.rmSync(dir, { recursive: true, force: true });
});

const baseCfg = () => loadAuthConfig("0.0.0.0");

describe("passwords", () => {
	test("correct password authenticates, wrong password does not", async () => {
		await createUser({ username: "ada", password: "correct-horse-battery" });
		expect(await verifyPassword("ada", "correct-horse-battery")).not.toBeNull();
		expect(await verifyPassword("ada", "wrong")).toBeNull();
	});

	test("username match is case-insensitive", async () => {
		await createUser({ username: "Ada", password: "correct-horse-battery" });
		expect(await verifyPassword("ADA", "correct-horse-battery")).not.toBeNull();
	});

	test("unknown user returns null rather than throwing", async () => {
		expect(await verifyPassword("nobody", "whatever")).toBeNull();
	});

	test("plaintext is never stored", async () => {
		await createUser({ username: "ada", password: "correct-horse-battery" });
		const row = getDb().query("SELECT password_hash FROM deck_users").get() as { password_hash: string };
		expect(row.password_hash).not.toContain("correct-horse-battery");
		expect(row.password_hash.startsWith("$argon2")).toBe(true);
	});
});

describe("sessions", () => {
	test("a fresh token resolves to its user", async () => {
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const { token } = createSession({ userId: user.id, ttlMs: 60_000 });
		expect(resolveSessionToken(token)?.user.id).toBe(user.id);
	});

	test("the raw token is not stored", async () => {
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const { token } = createSession({ userId: user.id, ttlMs: 60_000 });
		const row = getDb().query("SELECT token_hash FROM deck_sessions").get() as { token_hash: string };
		expect(row.token_hash).not.toBe(token);
	});

	test("an expired session stops resolving and is swept", async () => {
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const { token } = createSession({ userId: user.id, ttlMs: -1_000 });
		expect(resolveSessionToken(token)).toBeNull();
		expect(pruneExpiredSessions()).toBe(0); // resolve already dropped the row
	});

	test("a deleted session stops resolving", async () => {
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const issued = createSession({ userId: user.id, ttlMs: 60_000 });
		deleteSessionById(issued.session.id);
		expect(resolveSessionToken(issued.token)).toBeNull();
	});

	test("changing the password revokes existing sessions", async () => {
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const { token } = createSession({ userId: user.id, ttlMs: 60_000 });
		await setPassword(user.id, "a-different-password");
		expect(resolveSessionToken(token)).toBeNull();
	});

	test("a garbage token resolves to nothing", () => {
		expect(resolveSessionToken("not-a-real-token")).toBeNull();
		expect(resolveSessionToken("")).toBeNull();
	});
});

describe("request gate", () => {
	function req(headers: Record<string, string> = {}, init: RequestInit = {}): Request {
		return new Request("http://deck.example.com/api/tasks", { headers, ...init });
	}

	test("no credential means no principal", () => {
		expect(resolvePrincipal(req(), baseCfg())).toBeNull();
	});

	test("a valid session cookie authenticates", async () => {
		const cfg = baseCfg();
		const user = await createUser({ username: "ada", password: "correct-horse-battery" });
		const { token } = createSession({ userId: user.id, ttlMs: 60_000 });
		const principal = resolvePrincipal(req({ cookie: `${cfg.cookieName}=${token}` }), cfg);
		expect(principal?.kind).toBe("user");
	});

	test("a bearer token authenticates only when it matches exactly", () => {
		const cfg = { ...baseCfg(), apiToken: "s3cret-token" };
		expect(resolvePrincipal(req({ authorization: "Bearer s3cret-token" }), cfg)?.kind).toBe("api-token");
		expect(resolvePrincipal(req({ authorization: "Bearer s3cret-toke" }), cfg)).toBeNull();
		expect(resolvePrincipal(req({ authorization: "Bearer wrong" }), cfg)).toBeNull();
	});

	test("auth endpoints and health are public; everything else is not", () => {
		expect(isPublicApiPath("/api/auth/login")).toBe(true);
		expect(isPublicApiPath("/auth/login")).toBe(true);
		expect(isPublicApiPath("/api/health")).toBe(true);
		expect(isPublicApiPath("/api/tasks")).toBe(false);
		expect(isPublicApiPath("/api/auth/oauth/anthropic/start")).toBe(false);
		// Guard against a prefix match letting through a lookalike path.
		expect(isPublicApiPath("/api/healthz-internal")).toBe(false);
	});

	test("cookies parse, including values containing '='", () => {
		const jar = parseCookies("a=1; omp_deck_session=abc=def; other=2");
		expect(jar.get("omp_deck_session")).toBe("abc=def");
		expect(jar.get("a")).toBe("1");
		expect(parseCookies(null).size).toBe(0);
	});
});

describe("cross-origin writes", () => {
	const cfg = () => ({ ...baseCfg(), trustedOrigins: ["https://trusted.example.com"] });
	const write = (headers: Record<string, string>) =>
		new Request("http://deck.example.com/api/tasks", { method: "POST", headers });

	test("same-origin writes are allowed", () => {
		expect(
			isAllowedOrigin(write({ origin: "http://deck.example.com", host: "deck.example.com" }), cfg()),
		).toBe(true);
	});

	test("a foreign origin is rejected", () => {
		expect(isAllowedOrigin(write({ origin: "https://evil.example.com", host: "deck.example.com" }), cfg())).toBe(
			false,
		);
	});

	test("the configured public URL is accepted", () => {
		expect(
			isAllowedOrigin(
				write({ origin: "https://omp.example.net", host: "internal:8787" }),
				cfg(),
				"https://omp.example.net",
			),
		).toBe(true);
	});

	test("an explicitly trusted origin is accepted", () => {
		expect(isAllowedOrigin(write({ origin: "https://trusted.example.com", host: "deck" }), cfg())).toBe(true);
	});

	test("no Origin header is allowed — non-browser clients don't send one", () => {
		expect(isAllowedOrigin(write({ host: "deck.example.com" }), cfg())).toBe(true);
	});

	test("reads are never blocked", () => {
		const read = new Request("http://deck.example.com/api/tasks", {
			headers: { origin: "https://evil.example.com" },
		});
		expect(isAllowedOrigin(read, cfg())).toBe(true);
	});
});

describe("mode resolution", () => {
	const withEnv = <T,>(env: Record<string, string | undefined>, fn: () => T): T => {
		const saved = new Map<string, string | undefined>();
		for (const [k, v] of Object.entries(env)) {
			saved.set(k, process.env[k]);
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		try {
			return fn();
		} finally {
			for (const [k, v] of saved) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	};

	test("a public bind requires auth even with no credentials configured", () => {
		withEnv({ OMP_DECK_AUTH_MODE: undefined, OMP_DECK_AUTH_PASSWORD: undefined }, () => {
			expect(loadAuthConfig("0.0.0.0").enabled).toBe(true);
		});
	});

	test("a public bind ignores an attempt to turn auth off", () => {
		withEnv({ OMP_DECK_AUTH_MODE: "off" }, () => {
			expect(loadAuthConfig("0.0.0.0").enabled).toBe(true);
			expect(loadAuthConfig("192.168.1.10").enabled).toBe(true);
		});
	});

	test("loopback with no credentials stays open, preserving the local dev flow", () => {
		withEnv({ OMP_DECK_AUTH_MODE: undefined, OMP_DECK_AUTH_PASSWORD: undefined }, () => {
			expect(loadAuthConfig("127.0.0.1").enabled).toBe(false);
		});
	});

	test("configuring a password turns auth on even on loopback", () => {
		withEnv({ OMP_DECK_AUTH_MODE: undefined, OMP_DECK_AUTH_PASSWORD: "hunter2hunter2" }, () => {
			expect(loadAuthConfig("127.0.0.1").enabled).toBe(true);
		});
	});

	test("mode=on forces auth on loopback", () => {
		withEnv({ OMP_DECK_AUTH_MODE: "on", OMP_DECK_AUTH_PASSWORD: undefined }, () => {
			expect(loadAuthConfig("127.0.0.1").enabled).toBe(true);
		});
	});
});
