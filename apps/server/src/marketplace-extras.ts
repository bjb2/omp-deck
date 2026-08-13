/**
 * Marketplace extensions — search, featured, popular, and the SSL cert fix.
 *
 * Search/featured/popular piggy-back on `MarketplaceManager.listAvailablePlugins`
 * plus a local scoring layer. The SDK exposes every catalog row uniformly; we
 * add the curation signals the deck wants (text score, install-count estimate,
 * featured flag) without round-tripping a separate service.
 *
 * SSL fix: the upstream `MarketplaceManager` clones git sources through Bun's
 * embedded git binary. On hosts where the system CA bundle is missing or out
 * of date, the clone aborts with `Problem with the SSL CA cert`. We resolve
 * the CA path explicitly (env override → system → openssl probe) and inject it
 * into process.env so the bundled git picks it up automatically. The fix is
 * idempotent and runs once at boot.
 */
import { existsSync, promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { logger } from "./log.ts";
import { getMarketplace } from "./marketplace-service.ts";

const log = logger("marketplace:extras");

let sslFixApplied = false;
let sslFixBundle: string | undefined;

interface ScoredEntry {
	id: string;
	name: string;
	marketplace: string;
	description?: string;
	category?: string;
	tags?: string[];
	featured?: boolean;
	popularity?: number;
	score?: number;
	installed?: boolean;
	version?: string;
}

function scoreQuery(text: string, query: string): number {
	if (!query) return 0;
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	if (t === q) return 1000;
	if (t.startsWith(q)) return 500;
	const idx = t.indexOf(q);
	if (idx >= 0) return 200 - idx;
	return 0;
}

export const marketplaceExtras = {
	async search(opts: {
		query: string;
		featured?: boolean;
		limit?: number;
	}): Promise<ScoredEntry[]> {
		const limit = opts.limit ?? 50;
		const catalog = await getMarketplace().listCatalog();
		const results: ScoredEntry[] = [];
		for (const entry of catalog.catalog) {
			const score =
				scoreQuery(entry.name, opts.query) +
				scoreQuery(entry.description ?? "", opts.query) * 0.5 +
				scoreQuery(entry.category ?? "", opts.query) * 0.3 +
				(entry.keywords ?? []).reduce((a, k) => a + scoreQuery(k, opts.query) * 0.4, 0) +
				(entry.tags ?? []).reduce((a, k) => a + scoreQuery(k, opts.query) * 0.4, 0);
			const featured = isFeatured(entry);
			const popularity = estimatePopularity(entry);
			if (opts.featured && !featured) continue;
			if (opts.query && score === 0) continue;
			results.push({
				id: entry.id,
				name: entry.name,
				marketplace: entry.marketplace,
				...(entry.description ? { description: entry.description } : {}),
				...(entry.category ? { category: entry.category } : {}),
				...(entry.tags ? { tags: entry.tags } : {}),
				featured,
				popularity,
				score,
				installed: Boolean(entry.installed),
				...(entry.version ? { version: entry.version } : {}),
			});
		}
		results.sort((a, b) => {
			const fs = (a.featured ? 100 : 0) - (b.featured ? 100 : 0);
			if (fs !== 0) return -fs;
			return (b.score ?? 0) - (a.score ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0);
		});
		return results.slice(0, limit);
	},

	async featured(limit: number): Promise<ScoredEntry[]> {
		return this.search({ query: "", featured: true, limit });
	},

	async popular(limit: number): Promise<ScoredEntry[]> {
		const all = await this.search({ query: "", limit: 200 });
		all.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
		return all.slice(0, limit);
	},

	/**
	 * Resolves a CA bundle path for `GIT_SSL_CAINFO`. Caller is expected to
	 * invoke this once at boot and propagate the resulting path to the SDK.
	 */
	resolveCABundle(): string | undefined {
		const env = process.env.GIT_SSL_CAINFO ?? process.env.SSL_CERT_FILE;
		if (env && existsSync(env)) return env;
		// Common system locations by platform.
		const candidates: string[] = [];
		if (process.platform === "win32") {
			candidates.push(
				"C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt",
				"C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt",
			);
		} else if (process.platform === "darwin") {
			candidates.push(
				"/etc/ssl/cert.pem",
				"/usr/local/etc/openssl/cert.pem",
				"/opt/homebrew/etc/openssl@3/cert.pem",
			);
		} else {
			candidates.push(
				"/etc/ssl/certs/ca-certificates.crt",
				"/etc/pki/tls/certs/ca-bundle.crt",
				"/etc/ssl/cert.pem",
			);
		}
		for (const c of candidates) if (existsSync(c)) return c;
		try {
			const out = execFileSync("openssl", ["version", "-d"], { encoding: "utf-8" });
			const m = /OPENSSLDIR\s*:\s*"?([^"\s]+)"?/.exec(out);
			if (m) {
				const dir = m[1]!.trim();
				const probe = path.join(dir, "cert.pem");
				if (existsSync(probe)) return probe;
			}
		} catch {
			// openssl absent — fall through.
		}
		return undefined;
	},

	applySslFix(): { applied: boolean; bundle?: string; note?: string } {
		if (sslFixApplied) return { applied: true, bundle: sslFixBundle };
		// Honor explicit user choice: if they forced `GIT_SSL_NO_VERIFY=true`,
		// skip the CA injection and document why.
		if (process.env.GIT_SSL_NO_VERIFY === "true") {
			sslFixApplied = true;
			return { applied: true, note: "user opted out via GIT_SSL_NO_VERIFY" };
		}
		const bundle = this.resolveCABundle();
		if (!bundle) {
			sslFixApplied = true;
			return { applied: true, note: "no system CA bundle located" };
		}
		// Inject both the conventional `git` env var and `NODE_EXTRA_CA_CERTS`
		// so Node TLS-using clients in the same process pick it up too.
		process.env.GIT_SSL_CAINFO = bundle;
		if (!process.env.NODE_EXTRA_CA_CERTS) {
			process.env.NODE_EXTRA_CA_CERTS = bundle;
		}
		sslFixApplied = true;
		sslFixBundle = bundle;
		log.info(`SSL CA bundle wired: ${bundle}`);
		return { applied: true, bundle };
	},
};

function isFeatured(entry: { name: string; keywords?: string[]; tags?: string[]; category?: string }): boolean {
	const haystack = [entry.name, entry.category ?? "", ...(entry.keywords ?? []), ...(entry.tags ?? [])]
		.join(" ")
		.toLowerCase();
	// Curated keyword allowlist — matches the SDK's bundled popular packs.
	return /(featured|essential|recommended|top|core)/.test(haystack);
}

function estimatePopularity(entry: { keywords?: string[]; tags?: string[]; description?: string }): number {
	let score = 0;
	const text = `${entry.description ?? ""} ${(entry.keywords ?? []).join(" ")} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
	if (/official/.test(text)) score += 100;
	if (/popular|trending|top|essential|recommended/.test(text)) score += 50;
	if (/devtools?/.test(text)) score += 10;
	if (/test/.test(text)) score += 5;
	return score;
}

export type { ScoredEntry };
