import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	GuardError,
	NoAgentDirError,
	applyStagedImport,
	deleteAgentPath,
	discardStagedImport,
	listAgentDir,
	listBackups,
	readAgentFile,
	restoreBackup,
	stageImport,
	writeAgentFile,
} from "./agent-config-service.ts";

let agentDir: string;
let savedEnv: string | undefined;

async function zipDir(srcDir: string, zipPath: string): Promise<void> {
	const proc = Bun.spawn(["zip", "-r", "-q", zipPath, "."], { cwd: srcDir, stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new Error(`zip failed: ${stderr}`);
}

beforeEach(() => {
	agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-"));
	fs.mkdirSync(path.join(agentDir, "agents"));
	fs.writeFileSync(path.join(agentDir, "agents", "backend.md"), "# backend agent");
	fs.writeFileSync(path.join(agentDir, "config.yml"), "theme: dark\n");
	fs.writeFileSync(path.join(agentDir, "agent.db"), Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65])); // fake sqlite header
	savedEnv = process.env.OMP_AGENT_DIR;
	process.env.OMP_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.OMP_AGENT_DIR;
	else process.env.OMP_AGENT_DIR = savedEnv;
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(`${agentDir}.staged`, { recursive: true, force: true });
	// Backups land as siblings of agentDir (same mkdtemp parent) — sweep any
	// this test created so parallel test files don't see stale directories.
	const parent = path.dirname(agentDir);
	const base = path.basename(agentDir);
	for (const name of fs.readdirSync(parent)) {
		if (name.startsWith(`${base}.backup-`)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
	}
});

describe("browse and edit", () => {
	test("listAgentDir lists top-level entries and flags the database file", async () => {
		const result = await listAgentDir("");
		const names = result.entries.map((e) => e.name);
		expect(names).toContain("agents");
		expect(names).toContain("config.yml");
		const db = result.entries.find((e) => e.name === "agent.db");
		expect(db?.isDatabase).toBe(true);
	});

	test("listAgentDir accepts the absolute path a prior listing returned, for a subdirectory", async () => {
		// The web client's file tree always re-lists using the `path` value a
		// previous entry gave it — an absolute path, not a path relative to the
		// agent dir. listAgentDir must treat its argument the same way
		// files-service.listDir does, or every second-level expand 404s.
		const root = await listAgentDir("");
		const agentsDir = root.entries.find((e) => e.name === "agents");
		expect(agentsDir).toBeDefined();
		const nested = await listAgentDir(agentsDir!.path);
		expect(nested.entries.map((e) => e.name)).toEqual(["backend.md"]);
	});

	test("readAgentFile reads a text file", async () => {
		const result = await readAgentFile(path.join(agentDir, "config.yml"));
		expect(result.content).toBe("theme: dark\n");
	});

	test("readAgentFile refuses a database file", async () => {
		await expect(readAgentFile(path.join(agentDir, "agent.db"))).rejects.toThrow(GuardError);
	});

	test("writeAgentFile writes a new file", async () => {
		await writeAgentFile(path.join(agentDir, "RULES.md"), "be nice");
		expect(fs.readFileSync(path.join(agentDir, "RULES.md"), "utf8")).toBe("be nice");
	});

	test("writeAgentFile refuses to overwrite a database file", async () => {
		await expect(writeAgentFile(path.join(agentDir, "agent.db"), "nope")).rejects.toThrow(GuardError);
	});

	test("deleteAgentPath refuses to delete the agent dir itself", async () => {
		await expect(deleteAgentPath(agentDir)).rejects.toThrow(GuardError);
	});

	test("paths outside OMP_AGENT_DIR are rejected even if they exist on disk", async () => {
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-outside-"));
		try {
			await expect(readAgentFile(path.join(elsewhere, "whatever"))).rejects.toThrow();
		} finally {
			fs.rmSync(elsewhere, { recursive: true, force: true });
		}
	});

	test("fails closed when OMP_AGENT_DIR is unset", async () => {
		delete process.env.OMP_AGENT_DIR;
		await expect(listAgentDir("")).rejects.toThrow(NoAgentDirError);
	});
});

describe("import: merge mode", () => {
	test("stageImport computes an add/modify plan without touching the live directory", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src-"));
		fs.mkdirSync(path.join(src, "agents"));
		fs.writeFileSync(path.join(src, "agents", "backend.md"), "# UPDATED backend agent"); // modify
		fs.writeFileSync(path.join(src, "RULES.md"), "new rules"); // add
		const zipPath = path.join(src, "..", "import.zip");
		await zipDir(src, zipPath);

		const plan = await stageImport(fs.readFileSync(zipPath), "merge");
		expect(plan.addedCount).toBe(1);
		expect(plan.modifiedCount).toBe(1);
		expect(plan.removedCount).toBe(0);
		expect(plan.touchesDatabase).toBe(false);
		// Live directory untouched until apply.
		expect(fs.readFileSync(path.join(agentDir, "agents", "backend.md"), "utf8")).toBe("# backend agent");

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
		await discardStagedImport(plan.stagingId);
	});

	test("applyStagedImport merges new files while preserving files not in the archive", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src2-"));
		fs.mkdirSync(path.join(src, "agents"));
		fs.writeFileSync(path.join(src, "agents", "backend.md"), "# UPDATED");
		fs.writeFileSync(path.join(src, "RULES.md"), "new rules");
		const zipPath = path.join(src, "..", "import2.zip");
		await zipDir(src, zipPath);

		const plan = await stageImport(fs.readFileSync(zipPath), "merge");
		const result = await applyStagedImport(plan.stagingId);

		// Updated file changed.
		expect(fs.readFileSync(path.join(agentDir, "agents", "backend.md"), "utf8")).toBe("# UPDATED");
		// New file added.
		expect(fs.readFileSync(path.join(agentDir, "RULES.md"), "utf8")).toBe("new rules");
		// Untouched file (config.yml) survived the merge.
		expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")).toBe("theme: dark\n");
		// The database file — never in the archive — survived byte-for-byte.
		expect(fs.existsSync(path.join(agentDir, "agent.db"))).toBe(true);
		// Backup of the pre-import state exists and has the ORIGINAL content.
		expect(fs.existsSync(result.backupPath)).toBe(true);
		expect(fs.readFileSync(path.join(result.backupPath, "agents", "backend.md"), "utf8")).toBe("# backend agent");

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
	});
});

describe("import: full-reset mode", () => {
	test("stageImport plans removal of files absent from the archive", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src3-"));
		fs.writeFileSync(path.join(src, "ONLY-FILE.md"), "the only survivor");
		const zipPath = path.join(src, "..", "import3.zip");
		await zipDir(src, zipPath);

		const plan = await stageImport(fs.readFileSync(zipPath), "full-reset");
		const removedPaths = plan.entries.filter((e) => e.change === "remove").map((e) => e.path);
		expect(removedPaths).toContain("config.yml");
		expect(removedPaths).toContain(path.join("agents", "backend.md"));
		// agent.db is not in the archive either, so a full-reset plan marks it
		// for removal too — and flags touchesDatabase so the UI can warn loudly.
		expect(removedPaths).toContain("agent.db");
		expect(plan.touchesDatabase).toBe(true);

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
		await discardStagedImport(plan.stagingId);
	});

	test("applyStagedImport replaces the directory wholesale", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src4-"));
		fs.writeFileSync(path.join(src, "ONLY-FILE.md"), "the only survivor");
		const zipPath = path.join(src, "..", "import4.zip");
		await zipDir(src, zipPath);

		const plan = await stageImport(fs.readFileSync(zipPath), "full-reset");
		const result = await applyStagedImport(plan.stagingId);

		expect(fs.readFileSync(path.join(agentDir, "ONLY-FILE.md"), "utf8")).toBe("the only survivor");
		expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(false);
		expect(fs.existsSync(path.join(agentDir, "agent.db"))).toBe(false);
		// Nothing was permanently lost — it's all in the backup.
		expect(fs.readFileSync(path.join(result.backupPath, "config.yml"), "utf8")).toBe("theme: dark\n");
		expect(fs.existsSync(path.join(result.backupPath, "agent.db"))).toBe(true);

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
	});
});

describe("discard and expiry", () => {
	test("discardStagedImport removes the staging directory and the id becomes invalid", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src5-"));
		fs.writeFileSync(path.join(src, "x.md"), "x");
		const zipPath = path.join(src, "..", "import5.zip");
		await zipDir(src, zipPath);

		const plan = await stageImport(fs.readFileSync(zipPath), "merge");
		await discardStagedImport(plan.stagingId);
		await expect(applyStagedImport(plan.stagingId)).rejects.toThrow();

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
	});

	test("applying an unknown staging id fails clearly", async () => {
		await expect(applyStagedImport("not-a-real-id")).rejects.toThrow();
	});
});

describe("backups", () => {
	test("listBackups finds a backup created by an apply, and restoreBackup undoes it", async () => {
		const src = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-src6-"));
		fs.writeFileSync(path.join(src, "NEW.md"), "new content");
		const zipPath = path.join(src, "..", "import6.zip");
		await zipDir(src, zipPath);
		const plan = await stageImport(fs.readFileSync(zipPath), "merge");
		const applied = await applyStagedImport(plan.stagingId);

		const backups = await listBackups();
		expect(backups.some((b) => b.path === applied.backupPath)).toBe(true);

		// Undo: restore should bring back the pre-import config.yml.
		expect(fs.existsSync(path.join(agentDir, "config.yml"))).toBe(true); // survived merge, still verify restore round-trips
		await restoreBackup(applied.backupPath);
		expect(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8")).toBe("theme: dark\n");
		expect(fs.existsSync(path.join(agentDir, "NEW.md"))).toBe(false);

		fs.rmSync(src, { recursive: true, force: true });
		fs.rmSync(zipPath, { force: true });
	});

	test("restoreBackup rejects a path that isn't a recognized backup", async () => {
		const rogue = fs.mkdtempSync(path.join(os.tmpdir(), "omp-deck-agentcfg-rogue-"));
		try {
			await expect(restoreBackup(rogue)).rejects.toThrow(GuardError);
		} finally {
			fs.rmSync(rogue, { recursive: true, force: true });
		}
	});
});
