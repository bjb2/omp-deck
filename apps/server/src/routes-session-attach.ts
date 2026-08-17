import { Hono } from "hono";

type AttachRecord = {
	sessionId: string;
	expiresAt: number;
	url: string;
	createdAt: string;
};

type AttachHistoryEntry = {
	token: string;
	sessionId: string;
	url: string;
	createdAt: string;
	expiresAt: number;
};

const tokenMap = new Map<string, AttachRecord>();
const historyRing: AttachHistoryEntry[] = [];
const HISTORY_CAP = 50;

function deriveOrigin(c: { req: { header: (k: string) => string | undefined; url: string } }): string {
	const host = c.req.header("host");
	if (host) {
		const proto = c.req.header("x-forwarded-proto") ?? "http";
		return `${proto}://${host}`;
	}
	try {
		return new URL(c.req.url).origin;
	} catch {
		return "";
	}
}

export function buildSessionAttachRouter(): Hono {
	const app = new Hono();

	app.post("/sessions/:id/attach-token", (c) => {
		const sessionId = c.req.param("id");
		const token = crypto.randomUUID();
		const expiresAt = Date.now() + 10 * 60 * 1000;
		const createdAt = new Date().toISOString();
		const origin = deriveOrigin(c);
		const url = `${origin}/attach/${token}`;
		tokenMap.set(token, { sessionId, expiresAt, url, createdAt });
		historyRing.push({ token, sessionId, url, createdAt, expiresAt });
		while (historyRing.length > HISTORY_CAP) historyRing.shift();
		return c.json({ token, url });
	});

	app.get("/sessions/attach-history", (c) => c.json({ history: historyRing }));

	return app;
}

export function buildSessionAttachWebRouter(): Hono {
	const app = new Hono();

	app.get("/:token", (c) => {
		const token = c.req.param("token");
		const record = tokenMap.get(token);
		const valid = record && Date.now() < record.expiresAt ? record : undefined;
		if (!valid) {
			return c.html(
				`<html><body style="font-family:sans-serif;padding:2rem;text-align:center;"><h2>Link Expired</h2><p>This phone attach link has expired or is invalid.</p></body></html>`,
			);
		}
		const sessionId = valid.sessionId;
		return c.html(
			`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Attach</title></head><body><script>window.location.replace('/?attachSession=${sessionId}')</script></body></html>`,
		);
	});

	return app;
}
