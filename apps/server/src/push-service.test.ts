import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { closeDb, openDb } from "./db/index.ts";
import {
	getVapidKeys,
	listSubscriptions,
	removeSubscription,
	saveSubscription,
	subscriptionCount,
} from "./push-service.ts";

let dir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-push-"));
	openDb({ path: path.join(dir, "deck.db") });
	savedDataDir = process.env.OMP_DECK_DATA_DIR;
	process.env.OMP_DECK_DATA_DIR = dir;
});

afterEach(() => {
	closeDb();
	if (savedDataDir === undefined) delete process.env.OMP_DECK_DATA_DIR;
	else process.env.OMP_DECK_DATA_DIR = savedDataDir;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("VAPID keys", () => {
	// getVapidKeys() caches at module scope for the life of the process — by
	// design (see the docblock: regenerating would invalidate every existing
	// browser subscription). That means only the FIRST call in this test
	// file's lifetime actually touches disk; every later call, even against a
	// different OMP_DECK_DATA_DIR from a later beforeEach, returns the same
	// cached pair. One thorough test rather than several that would silently
	// stop testing what they claim to once the cache is warm.
	test("generates a keypair once, persists it, and keeps returning the same pair", () => {
		const first = getVapidKeys();
		expect(first.publicKey.length).toBeGreaterThan(0);
		expect(first.privateKey.length).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(dir, "vapid-keys.json"))).toBe(true);

		const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "vapid-keys.json"), "utf8"));
		expect(onDisk).toEqual(first);

		const second = getVapidKeys();
		expect(second).toEqual(first);
	});
});

describe("subscriptions", () => {
	const sub = {
		endpoint: "https://push.example.com/abc123",
		keys: { p256dh: "p256dh-value", auth: "auth-value" },
	};

	test("saveSubscription then listSubscriptions round-trips", () => {
		saveSubscription(sub, "test-agent");
		const all = listSubscriptions();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({ endpoint: sub.endpoint, p256dh: "p256dh-value", auth: "auth-value" });
	});

	test("re-subscribing the same endpoint upserts rather than duplicating", () => {
		saveSubscription(sub);
		saveSubscription({ ...sub, keys: { p256dh: "new-p256dh", auth: "new-auth" } });
		const all = listSubscriptions();
		expect(all).toHaveLength(1);
		expect(all[0]?.p256dh).toBe("new-p256dh");
	});

	test("removeSubscription deletes by endpoint", () => {
		saveSubscription(sub);
		expect(subscriptionCount()).toBe(1);
		removeSubscription(sub.endpoint);
		expect(subscriptionCount()).toBe(0);
	});

	test("removing an unknown endpoint is a no-op, not an error", () => {
		expect(() => removeSubscription("https://never-existed.example.com")).not.toThrow();
	});
});
